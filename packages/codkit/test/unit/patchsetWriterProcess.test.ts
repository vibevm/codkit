// Independent OS processes, not a shared in-memory lease table.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { acquireLock, lockPath, readLock } from '../../src/lib/lock.ts';
import { PATCHSET_WRITER_LOCK_ID } from '../../src/lib/patchsetWriter.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
const moduleUrl = new URL('../../dist/lib/lock.js', import.meta.url).href;
const source = `
const { acquireLock } = await import(process.argv[1]);
let handle;
process.on('message', message => {
  if (message === 'acquire') {
    try {
      handle = acquireLock(process.argv[2], process.argv[3], 'process-proof');
      process.send({kind:'acquired',pid:process.pid});
    } catch (error) {
      process.send({kind:'refused',pid:process.pid,code:error.code,message:error.message});
    }
  }
  if (message === 'release') { handle?.release(); process.disconnect(); }
});
process.on('disconnect', () => { handle?.release(); });
process.send({kind:'ready',pid:process.pid});
`;
type Message = { kind: 'ready' | 'acquired' | 'refused'; pid: number; code?: string; message?: string };

function message(child: ChildProcess): Promise<Message> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => done(new Error('writer child IPC timeout')), 10000);
		const onMessage = (value: Message) => done(undefined, value);
		const onExit = () => done(new Error('writer child exited before IPC outcome'));
		const done = (error?: Error, value?: Message) => {
			clearTimeout(timer);
			child.off('message', onMessage);
			child.off('exit', onExit);
			child.off('error', done);
			if (error !== undefined) reject(error);
			else resolve(value!);
		};
		child.once('message', onMessage);
		child.once('exit', onExit);
		child.once('error', done);
	});
}

async function race(roots: readonly [string, string]): Promise<readonly Message[]> {
	const children = roots.map((root, i) =>
		spawn(process.execPath, ['--input-type=module', '-e', source, moduleUrl, root, `fork-${i}`], {
			stdio: ['ignore', 'ignore', 'pipe', 'ipc']
		})
	);
	// Exit promises are registered before release so no fast child can be missed.
	const exits = children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
	try {
		const ready = await Promise.all(children.map(message));
		expect(ready.map((value) => value.kind)).toEqual(['ready', 'ready']);
		expect(new Set(ready.map((value) => value.pid)).size).toBe(2);
		const outcomes = children.map(message);
		for (const child of children) child.send('acquire');
		const result = await Promise.all(outcomes);
		for (const root of roots) {
			const owner = readLock(lockPath(root, PATCHSET_WRITER_LOCK_ID));
			expect(result.some((value) => value.kind === 'acquired' && value.pid === owner?.pid)).toBe(true);
		}
		return result;
	} finally {
		for (const child of children) {
			if (child.connected) child.send('release');
			else if (child.exitCode === null) child.kill();
		}
		const timer = setTimeout(() => {
			for (const child of children) if (child.exitCode === null) child.kill();
		}, 10000);
		try {
			await Promise.all(exits);
		} finally {
			clearTimeout(timer);
		}
	}
}

it('admits one independent process through aliases of the same physical checkout', async () => {
	const root = makeTempRoot('writer-process');
	const alias = join(makeTempRoot('writer-process-alias'), 'same');
	symlinkSync(root, alias, 'junction');
	const result = await race([root, alias]);
	expect(result.filter((value) => value.kind === 'acquired')).toHaveLength(1);
	expect(result.filter((value) => value.kind === 'refused')).toMatchObject([{ code: 'LOCKED' }]);
	expect(readLock(lockPath(root, PATCHSET_WRITER_LOCK_ID))).toBeNull();
	const next = acquireLock(alias, 'fork-after-exit', 'next task');
	next.release();
});

it('allows independent processes to write separate physical checkouts concurrently', async () => {
	const roots = [makeTempRoot('writer-independent-a'), makeTempRoot('writer-independent-b')] as const;
	expect((await race(roots)).map((value) => value.kind)).toEqual(['acquired', 'acquired']);
	for (const root of roots) expect(readLock(lockPath(root, PATCHSET_WRITER_LOCK_ID))).toBeNull();
});
