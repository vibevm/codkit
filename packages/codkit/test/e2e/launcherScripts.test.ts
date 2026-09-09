// User-facing launchers: Bash and PowerShell are thin surfaces over the Node
// launcher. Bash is exercised end to end on this host; the PowerShell surface
// is structurally checked here and runs natively in the Windows matrix.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { makeCliFixture, STUB_TYPE_ENV, TEST_BUILD_CONDITION, testBuildNodeDir } from '../support/cliFixture.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bashLauncher = join(repoRoot, 'bin', 'codkit');
const powershellLauncher = join(repoRoot, 'bin', 'codkit.ps1');
const nodeLauncher = join(packageRoot, 'bin', 'codkit.mjs');

afterAll(() => {
	cleanupTempRoots();
});

function inheritedEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	// The launchers run `node <launcher>`, and the stub type is reachable only
	// in a test build, so the `node` these scenarios find is the shim of the
	// fixture (##TYPE-TEST-SEAM); nothing else about the run changes.
	env['PATH'] = `${testBuildNodeDir('launcher')}${delimiter}${env['PATH'] ?? ''}`;
	return Object.assign(env, STUB_TYPE_ENV, extra);
}

describe('bin/codkit', () => {
	it('runs from an unrelated cwd and forwards argv to the Node launcher', () => {
		const fixture = makeCliFixture('launcher-bash');
		const result = spawnSync(bashLauncher, ['--json', '--fork-dir', fixture.treeDir, 'where'], {
			cwd: makeTempRoot('launcher-cwd'),
			env: inheritedEnv({ CODKIT_PATCHES_DIR: fixture.patchesDir }),
			encoding: 'utf8'
		});

		expect(result.status, result.stderr).toBe(0);
		const envelope = JSON.parse(result.stdout) as { roots: { fork: { path: string; source: string } } };
		expect(envelope.roots.fork).toMatchObject({ path: fixture.treeDir, source: 'flag' });
	});

	it('forwards a non-zero exit code', () => {
		const fixture = makeCliFixture('launcher-bash-error');
		const result = spawnSync(bashLauncher, ['--fork-dir', fixture.treeDir, 'no-such-command'], {
			cwd: makeTempRoot('launcher-error-cwd'),
			env: inheritedEnv({ CODKIT_PATCHES_DIR: fixture.patchesDir }),
			encoding: 'utf8'
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toContain('unknown command');
	});

	it('is executable', () => {
		expect(statSync(bashLauncher).mode & 0o111).not.toBe(0);
	});
});

describe('bin/codkit.ps1', () => {
	it('is cwd-independent and forwards argv and the exit code', () => {
		const text = readFileSync(powershellLauncher, 'utf8');
		expect(text).toContain('$PSScriptRoot');
		expect(text).toContain("'packages/codkit/bin/codkit.mjs'");
		expect(text).toContain('@args');
		expect(text).toContain('exit $LASTEXITCODE');
		expect(text).not.toContain('Get-Location');
	});
});

describe('npm bin launcher', () => {
	it('is a cwd-independent Node entry point', () => {
		const fixture = makeCliFixture('launcher-node');
		const result = spawnSync(process.execPath, [TEST_BUILD_CONDITION, nodeLauncher, '--json', '--fork-dir', fixture.treeDir, 'where'], {
			cwd: makeTempRoot('launcher-node-cwd'),
			env: inheritedEnv({ CODKIT_PATCHES_DIR: fixture.patchesDir }),
			encoding: 'utf8'
		});

		expect(result.status, result.stderr).toBe(0);
		const envelope = JSON.parse(result.stdout) as { roots: { fork: { path: string; source: string } } };
		expect(envelope.roots.fork).toMatchObject({ path: fixture.treeDir, source: 'flag' });
	});

	it('has a Node shebang for npm-generated POSIX and Windows shims', () => {
		expect(readFileSync(nodeLauncher, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/);
	});
});
