// Real process/generation custody, including bounded waiting without lock stealing.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { acquirePathLock } from '../../src/lib/lock.ts';
import { acquireWorkspaceCoordinationLock } from '../../src/lib/workspaceCoordination.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
const lockModule = new URL('../../dist/lib/lock.js', import.meta.url).href;
const source = `
const { acquirePathLock } = await import(process.argv[1]);
const held = acquirePathLock(process.argv[2], 'other named workspace');
let released = false;
const release = () => { if (released) return; released = true; held.release(); process.disconnect(); };
process.on('message', message => { if (message === 'release') release(); });
process.send({pid:process.pid});
if (process.argv[3] === 'auto') setTimeout(release, 250);
`;

async function heldByChild(path: string, mode: 'auto' | 'hold') {
	const child = spawn(process.execPath, ['--input-type=module', '-e', source, lockModule, path, mode], {
		stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
		windowsHide: true
	});
	const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
	const safety = setTimeout(() => child.kill(), 10_000);
	const ready = await new Promise<number>((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', () => reject(new Error('coordination holder exited before readiness')));
		child.once('message', (value) => {
			const parsed = z.object({ pid: z.number().int().positive() }).safeParse(value);
			if (parsed.success) resolve(parsed.data.pid);
			else reject(new Error('invalid coordination holder readiness'));
		});
	});
	return {
		pid: ready,
		close: async () => {
			if (child.connected) child.send('release');
			await exited;
			clearTimeout(safety);
		}
	};
}

it('waits for an independent live holder and acquires a new generation only after release', async () => {
	const path = join(makeTempRoot('workspace-coordination'), 'guard.lock');
	const child = await heldByChild(path, 'auto');
	try {
		const held = acquireWorkspaceCoordinationLock(path, 'named workspace', (owner) => owner.pid === child.pid);
		try {
			expect(held.info.pid).toBe(process.pid);
			expect(held.info.pid).not.toBe(child.pid);
		} finally {
			held.release();
		}
	} finally {
		await child.close();
	}
});

it('refuses its own process immediately without consulting a waiting permission or changing the holder', () => {
	const path = join(makeTempRoot('workspace-coordination-self'), 'guard.lock');
	const holder = acquirePathLock(path, 'own process');
	const before = readFileSync(path);
	const permission = vi.fn(() => true);
	try {
		expect(() => acquireWorkspaceCoordinationLock(path, 'other command', permission)).toThrow(/another codkit command/);
		expect(permission).not.toHaveBeenCalled();
		expect(readFileSync(path)).toEqual(before);
	} finally {
		holder.release();
	}
});

it('refuses unrelated holders and an expired monotonic deadline without removing a live generation', async () => {
	const path = join(makeTempRoot('workspace-coordination-timeout'), 'guard.lock');
	const child = await heldByChild(path, 'hold');
	const before = readFileSync(path);
	try {
		expect(() => acquireWorkspaceCoordinationLock(path, 'named workspace', () => false)).toThrow(/another codkit command/);
		const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(300_001);
		try {
			expect(() => acquireWorkspaceCoordinationLock(path, 'named workspace', () => true)).toThrow(/another codkit command/);
		} finally {
			clock.mockRestore();
		}
		expect(readFileSync(path)).toEqual(before);
	} finally {
		await child.close();
	}
});
