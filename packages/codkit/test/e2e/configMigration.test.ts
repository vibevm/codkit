import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('previews without an adapter or fork, writes explicitly and then becomes a no-op', () => {
	const root = mkdtempSync(join(tmpdir(), 'codkit-migrate-cli-'));
	roots.push(root);
	const patches = join(root, 'patches');
	const fork = join(root, 'fork');
	mkdirSync(patches);
	mkdirSync(fork);
	const path = join(patches, 'codkit.json');
	const config = {
		codkitConfig: 2,
		pin: { tag: 't1', sha: 'a'.repeat(40), date: '2026-01-01' },
		upstreamAnchorCommit: 'b'.repeat(40),
		type: 'uninstalled-type',
		typeConfig: { ownRoot: 'own' },
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/'
	};
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	const before = readFileSync(path);
	const run = (flags: readonly string[]) => {
		const result = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dirname, '../../bin/codkit.mjs'),
				'--patches-dir',
				patches,
				'--fork-dir',
				fork,
				'--json',
				'config',
				'migrate',
				...flags
			],
			{ encoding: 'utf8', timeout: 15_000, windowsHide: true }
		);
		expect(result.status, result.stderr).toBe(0);
		return JSON.parse(result.stdout);
	};
	expect(run([]).data).toMatchObject({ from: 2, to: 4, changed: true, written: false });
	expect(readFileSync(path)).toEqual(before);
	expect(run(['--write']).data).toMatchObject({ changed: true, written: true });
	expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ codkitConfig: 4, discipline: 'minimal-intervention@1' });
	const migrated = readFileSync(path);
	expect(run(['--write']).data).toMatchObject({ changed: false, written: false });
	expect(readFileSync(path)).toEqual(migrated);
});
