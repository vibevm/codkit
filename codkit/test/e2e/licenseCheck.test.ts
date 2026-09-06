// PROP-013 ##E2E-STANDARDS-SURFACE: `codkit license check` through the real
// launcher. FEAT-002 ##S29 - the report, the exit codes and the fact that the
// command needs no patch set at all (##COMP-ROOTS-NONE).

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Envelope } from '../support/cliFixture.ts';
import { runCli } from '../support/cliFixture.ts';
import { makeLicensePackage } from '../fixtures/makeLicensePackage.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/**
 * A cwd that is not a patch set and holds no codkit.json: the command must run
 * there, which is the point of `roots: 'none'`.
 */
function foreignCwd(label: string): string {
	const root = makeTempRoot(`lic-cwd-${label}`);
	mkdirSync(root, { recursive: true });
	return root;
}

describe('codkit license check', () => {
	it('passes a clean package and needs no patch set', () => {
		const cwd = foreignCwd('clean');
		const pkg = makeLicensePackage(makeTempRoot('lic-e2e-clean'));
		const run = runCli(cwd, ['license', 'check', pkg]);

		expect(run.status).toBe(0);
		expect(run.stdout).toContain('4 files checked, 0 problems');
		expect(run.stderr).not.toContain('patches:');
	});

	it('emits the report structurally under --json', () => {
		const cwd = foreignCwd('json');
		const pkg = makeLicensePackage(makeTempRoot('lic-e2e-json'));
		const run = runCli(cwd, ['--json', 'license', 'check', pkg]);
		const envelope = JSON.parse(run.stdout) as Envelope;

		expect(run.status).toBe(0);
		expect(envelope.ok).toBe(true);
		const data = envelope.data as {
			dir: string;
			checked: readonly { path: string; carrier: string; kind: string; license: string }[];
			problems: readonly unknown[];
			policy: { ownLicense: string };
		};
		expect(data.dir).toBe(pkg);
		expect(data.problems).toEqual([]);
		expect(data.policy.ownLicense).toBe('UPL-1.0');
		expect(data.checked.map((file) => file.path)).toEqual([...data.checked.map((file) => file.path)].sort());
		expect(data.checked.find((file) => file.path === 'assets/codkit.png')?.carrier).toBe('sidecar');
		expect(data.checked.every((file) => file.kind === 'own')).toBe(true);
	});

	it('fails with the code of the defect and names the file', () => {
		const cwd = foreignCwd('defect');
		const pkg = makeLicensePackage(makeTempRoot('lic-e2e-defect'));
		rmSync(join(pkg, 'assets', 'codkit.png.license'));
		const run = runCli(cwd, ['license', 'check', pkg]);

		expect(run.status).toBe(1);
		expect(run.stderr).toContain('error CK-E-LICENSE-HEADER: assets/codkit.png: binary file without a .license sidecar');
		expect(run.stdout).toContain('problems');
	});

	it('reports a package-level defect under its own code', () => {
		const cwd = foreignCwd('package');
		const pkg = makeLicensePackage(makeTempRoot('lic-e2e-package'));
		writeFileSync(join(pkg, 'vibe.toml'), '# no licence field here\n[package]\nname = "x"\n', 'utf8');
		const run = runCli(cwd, ['license', 'check', pkg]);

		expect(run.status).toBe(1);
		expect(run.stderr).toContain('error CK-E-LICENSE-PACKAGE: vibe.toml: license field must be "UPL-1.0"');
	});

	it('refuses a path that is not a directory with exit 2', () => {
		const cwd = foreignCwd('missing');
		const run = runCli(cwd, ['license', 'check', join(cwd, 'nowhere')]);

		expect(run.status).toBe(2);
		expect(run.stderr).toContain('CK-E-CONFIG');
		expect(run.stderr).toContain('no such directory');
	});

	it('accepts a copyright-looking table row below the SPDX line (S29 s)', () => {
		const cwd = foreignCwd('table');
		const pkg = makeLicensePackage(makeTempRoot('lic-e2e-table'));
		// ##LIC-HEADER-BLOCK-ENDS-AT-SPDX: this row matches the copyright
		// pattern, and it is content because it sits below the SPDX line.
		writeFileSync(join(pkg, 'README.md'), '\n| Path | Copyright | License |\n', { flag: 'a' });
		const run = runCli(cwd, ['license', 'check', pkg]);

		expect(run.status).toBe(0);
	});
});
