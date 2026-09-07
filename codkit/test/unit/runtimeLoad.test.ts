// PROP-013 ##UT-RUNTIME-LOAD: the plan and the run of `runtime load`, and the
// read-only report of `runtime check` (PROP-015 ##RT-LOAD-STEPS, ##RT-LOAD-UPGRADE,
// ##RT-CHECK).
//
// The library under test is synthetic: a directory with the four banner lines
// on every file and the version literal, which is everything the engine reads.
// The real shipped library is proven by `shippedRuntime.test.ts`.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCkError } from '../../src/lib/messages.ts';
import { RUNTIME_VERSION_FILE } from '../../src/lib/runtimePackage.ts';
import { planRuntimeLoad, refuseOnDrift, runRuntimeCheck, runRuntimeLoad, RUNTIME_TARGET_PATH } from '../../src/lib/runtimeLoad.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const BANNER = [
	'// Copyright (c) 2026 Oleg Chirukhin',
	'// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/',
	'// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/',
	'// SPDX-License-Identifier: UPL-1.0',
	''
].join('\n');

function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return isCkError(error) ? error.code : 'not-a-ck-error';
	}
}

function write(root: string, relative: string, body: string): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, body, 'utf8');
}

/** A stand-in library: the banner on every file, and the version literal. */
function makeShipped(label: string, version = '0.1.0'): string {
	const parent = makeTempRoot(`rtload-src-${label}`);
	const dir = join(parent, `v${version}`);
	mkdirSync(dir, { recursive: true });
	write(dir, RUNTIME_VERSION_FILE, `${BANNER}\nexport const CODKIT_RUNTIME_VERSION = '${version}';\n`);
	write(dir, 'browser/featureRegistry.ts', `${BANNER}\nexport const REGISTRY = 1;\n`);
	return parent;
}

function makeProduct(label: string): string {
	const root = makeTempRoot(`rtload-dst-${label}`);
	mkdirSync(join(root, 'delta', 'own'), { recursive: true });
	return root;
}

function targetPath(patchesDir: string, relative: string): string {
	return join(patchesDir, ...RUNTIME_TARGET_PATH.split('/'), ...relative.split('/'));
}

function installedFiles(patchesDir: string): readonly string[] {
	const walk = (dir: string, prefix = ''): readonly string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			return entry.isDirectory() ? walk(join(dir, entry.name), relative) : [relative];
		});
	return [...walk(join(patchesDir, ...RUNTIME_TARGET_PATH.split('/')))].sort();
}

describe('planRuntimeLoad', () => {
	it('classifies an absent target as everything to write', () => {
		const source = makeShipped('absent');
		const patchesDir = makeProduct('absent');
		const plan = planRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source });

		expect(plan.state).toBe('absent');
		expect(plan.writes).toEqual(['browser/featureRegistry.ts', RUNTIME_VERSION_FILE]);
		expect(plan.removals).toEqual([]);
		expect(plan.problems).toEqual([]);
	});

	it('classifies an installed copy that matches as identical, with nothing to do', () => {
		const source = makeShipped('same');
		const patchesDir = makeProduct('same');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });

		const plan = planRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source });
		expect(plan.state).toBe('identical');
		expect(plan.writes).toEqual([]);
		expect(plan.removals).toEqual([]);
	});

	it('names the modified, extra and missing paths of a drifted copy', () => {
		const source = makeShipped('drift');
		const patchesDir = makeProduct('drift');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		writeFileSync(
			targetPath(patchesDir, RUNTIME_VERSION_FILE),
			`${BANNER}\nexport const CODKIT_RUNTIME_VERSION = '0.1.0';\n// edited\n`,
			'utf8'
		);
		write(join(patchesDir, ...RUNTIME_TARGET_PATH.split('/')), 'browser/mine.ts', 'export const MINE = 1;\n');

		const plan = planRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source });
		expect(plan.state).toBe('drift');
		expect(plan.writes).toEqual([RUNTIME_VERSION_FILE]);
		expect(plan.removals).toEqual(['browser/mine.ts']);
	});

	it('does not read the licence notice as a file of the library', () => {
		const source = makeShipped('notice');
		const patchesDir = makeProduct('notice');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });

		expect(readFileSync(targetPath(patchesDir, 'LICENSE-CODKIT.md'), 'utf8')).toContain('codkit:begin components');
		expect(planRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source }).state).toBe('identical');
	});
});

describe('refuseOnDrift', () => {
	it('refuses with CK-E-RUNTIME-DRIFT and names every path', () => {
		const source = makeShipped('refuse');
		const patchesDir = makeProduct('refuse');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		writeFileSync(targetPath(patchesDir, RUNTIME_VERSION_FILE), `${BANNER}\n// edited\n`, 'utf8');

		const plan = planRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source });
		let message = '';
		try {
			refuseOnDrift(plan);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(codeOf(() => refuseOnDrift(plan))).toBe('RUNTIME-DRIFT');
		expect(message).toContain(`modified ${RUNTIME_VERSION_FILE}`);
	});
});

describe('runRuntimeLoad', () => {
	it('writes the library and the notice, and says created', () => {
		const source = makeShipped('create');
		const patchesDir = makeProduct('create');
		const outcome = runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });

		expect(outcome.state).toBe('created');
		expect(outcome.filesWritten).toBe(2);
		expect(outcome.filesRemoved).toBe(0);
		expect(installedFiles(patchesDir)).toEqual(['LICENSE-CODKIT.md', 'browser/featureRegistry.ts', RUNTIME_VERSION_FILE]);
		expect(readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8')).toContain('runtime  0.1.0  delta/own/codkit/');
	});

	it('is a no-op the second time and does not touch a single byte', () => {
		const source = makeShipped('again');
		const patchesDir = makeProduct('again');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		const stamp = statSync(targetPath(patchesDir, RUNTIME_VERSION_FILE)).mtimeMs;

		const second = runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		expect(second.state).toBe('unchanged');
		expect(second.filesWritten).toBe(0);
		expect(second.noticesWritten).toEqual([]);
		expect(statSync(targetPath(patchesDir, RUNTIME_VERSION_FILE)).mtimeMs).toBe(stamp);
	});

	it('refuses drift without --upgrade and writes nothing', () => {
		const source = makeShipped('no-upgrade');
		const patchesDir = makeProduct('no-upgrade');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		writeFileSync(targetPath(patchesDir, RUNTIME_VERSION_FILE), `${BANNER}\n// edited\n`, 'utf8');
		const before = readFileSync(targetPath(patchesDir, RUNTIME_VERSION_FILE), 'utf8');

		expect(codeOf(() => runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false }))).toBe(
			'RUNTIME-DRIFT'
		);
		expect(readFileSync(targetPath(patchesDir, RUNTIME_VERSION_FILE), 'utf8')).toBe(before);
	});

	it('replaces the directory under --upgrade and keeps the notice', () => {
		const source = makeShipped('upgrade');
		const patchesDir = makeProduct('upgrade');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		writeFileSync(targetPath(patchesDir, RUNTIME_VERSION_FILE), `${BANNER}\n// edited\n`, 'utf8');
		write(join(patchesDir, ...RUNTIME_TARGET_PATH.split('/')), 'browser/mine.ts', 'export const MINE = 1;\n');
		const notice = readFileSync(targetPath(patchesDir, 'LICENSE-CODKIT.md'), 'utf8');

		const outcome = runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: true });
		expect(outcome.state).toBe('upgraded');
		expect(outcome.filesRemoved).toBe(1);
		expect(installedFiles(patchesDir)).toEqual(['LICENSE-CODKIT.md', 'browser/featureRegistry.ts', RUNTIME_VERSION_FILE]);
		expect(readFileSync(targetPath(patchesDir, 'LICENSE-CODKIT.md'), 'utf8')).toBe(notice);
	});

	it('writes nothing under --dry-run, plan or no plan', () => {
		const source = makeShipped('dry');
		const patchesDir = makeProduct('dry');
		const outcome = runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: true, upgrade: false });

		expect(outcome.state).toBe('created');
		expect(outcome.filesWritten).toBe(2);
		expect(readdirSync(join(patchesDir, 'delta', 'own'))).toEqual([]);
	});
});

describe('runRuntimeCheck', () => {
	it('says absent for a product that never installed the library', () => {
		const source = makeShipped('check-absent');
		const patchesDir = makeProduct('check-absent');
		const report = runRuntimeCheck({ toolRoot, patchesDir, sourceOverride: source });

		expect(report.targetState).toBe('absent');
		expect(report.findings).toEqual([]);
		expect(report.installedVersion).toBeNull();
	});

	it('says identical for a copy that matches, and reports the version', () => {
		const source = makeShipped('check-same');
		const patchesDir = makeProduct('check-same');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });

		const report = runRuntimeCheck({ toolRoot, patchesDir, sourceOverride: source });
		expect(report.targetState).toBe('identical');
		expect(report.installedVersion).toBe('0.1.0');
		expect(report.findings).toEqual([]);
	});

	it('reports drift as a finding with the path', () => {
		const source = makeShipped('check-drift');
		const patchesDir = makeProduct('check-drift');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		writeFileSync(targetPath(patchesDir, 'browser/featureRegistry.ts'), `${BANNER}\n// edited\n`, 'utf8');

		const report = runRuntimeCheck({ toolRoot, patchesDir, sourceOverride: source });
		expect(report.targetState).toBe('drift');
		expect(report.findings).toEqual([{ code: 'RUNTIME-DRIFT', message: 'modified browser/featureRegistry.ts' }]);
		expect(report.driftPaths).toEqual(['browser/featureRegistry.ts']);
	});

	it('reports an edited notice copy under the standards code', () => {
		const source = makeShipped('check-notice');
		const patchesDir = makeProduct('check-notice');
		runRuntimeLoad({ toolRoot, patchesDir, sourceOverride: source, dryRun: false, upgrade: false });
		writeFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'not the notice\n', 'utf8');

		const report = runRuntimeCheck({ toolRoot, patchesDir, sourceOverride: source });
		expect(report.targetState).toBe('identical');
		expect(report.findings).toEqual([{ code: 'STANDARDS-DRIFT', message: 'LICENSE-CODKIT.md: drift' }]);
	});
});
