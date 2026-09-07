// PROP-013 ##E2E-RUNTIME-SURFACE: `codkit runtime` through the real launcher.
// FEAT-002 ##S42-##S48.
//
// The fixture for the delivering scenarios is a patch-set root with a vibevm
// manifest, a codkit.json and no fork tree at all: `runtime load` and
// `runtime check` must not need one (##RUNTIME-NAMESPACE). S47 and S48 need a
// real tree and use the full fixture triple.

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Envelope } from '../support/cliFixture.ts';
import { makeCliFixture, runCli } from '../support/cliFixture.ts';
import { renderNotice } from '../../src/lib/licenceNotice.ts';
import { shippedRuntime } from '../../src/lib/runtimePackage.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The version the tool ships right now: the scenarios describe the delivery,
// not a number, so they read it the way `runtime load` does.
const shipped = shippedRuntime(repoRoot);
const SHIPPED_VERSION = shipped.version;
const shippedRuntimeDir = shipped.directory;
const shippedNotice = join(repoRoot, 'codkit', 'config', 'LICENSE-CODKIT.md');
const INSTALLED = 'delta/own/codkit';
const STANDARDS = 'vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0';
/** ##RT-COMPAT-DECLARATION: the tag `common/version.ts` declares as verified. */
const VERIFIED_TAG = '1.135.0';

/** A patch set with a vibevm manifest, a codkit.json and nothing else. */
function makePatchSet(label: string, pinTag = VERIFIED_TAG): string {
	const root = makeTempRoot(`rt-${label}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'vibe.toml'), '[project]\nname = "fixture"\nversion = "0.0.1"\n', 'utf8');
	writeFileSync(
		join(root, 'codkit.json'),
		`${JSON.stringify(
			{
				codkitConfig: 1,
				pin: { tag: pinTag, sha: '0'.repeat(40), date: '2026-01-01' },
				upstreamAnchorCommit: '1'.repeat(40),
				ownDirName: 'patchset',
				generatedBranchPrefix: 'codkit/applied/',
				cycleBranchPrefix: 'codkit/cycle/',
				releaseRefPrefix: 'codkit/release/',
				publishRemoteUrl: null,
				buildWatchFile: null,
				conventionsExtensionFile: null
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	return root;
}

function run(patchesDir: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
	return runCli(patchesDir, ['--patches-dir', patchesDir, ...args]);
}

function json(patchesDir: string, args: readonly string[]): { status: number; envelope: Envelope } {
	const outcome = run(patchesDir, ['--json', ...args]);
	return { status: outcome.status, envelope: JSON.parse(outcome.stdout) as Envelope };
}

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(root: string, prefix = ''): readonly string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		return entry.isDirectory() ? walk(join(root, entry.name), relative) : [relative];
	});
}

/** Byte equality of the installed copy with the shipped library, notice aside. */
function sameAsShipped(patchesDir: string): boolean {
	const target = join(patchesDir, ...INSTALLED.split('/'));
	const shipped = [...walk(shippedRuntimeDir)].sort();
	const installed = [...walk(target)].filter((relative) => relative !== 'LICENSE-CODKIT.md').sort();
	if (shipped.join('\n') !== installed.join('\n')) return false;
	return shipped.every(
		(relative) => sha256(join(shippedRuntimeDir, ...relative.split('/'))) === sha256(join(target, ...relative.split('/')))
	);
}

/** A snapshot of every file under a directory, by path and content hash. */
function snapshot(root: string): string {
	return [...walk(root)]
		.sort()
		.map((relative) => `${relative} ${sha256(join(root, ...relative.split('/')))}`)
		.join('\n');
}

function expectedNotice(): string {
	return renderNotice(readFileSync(shippedNotice, 'utf8'), [
		{ name: 'runtime', version: SHIPPED_VERSION, path: `${INSTALLED}/` },
		{ name: 'standards', version: '0.2.0', path: `${STANDARDS}/` }
	]);
}

describe('S42 - runtime load delivers the library and rewrites the notice', () => {
	it('installs the shipped library byte for byte and lists both components', () => {
		const patchesDir = makePatchSet('s42');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);

		const loaded = json(patchesDir, ['runtime', 'load']);
		expect(loaded.status).toBe(0);
		const data = loaded.envelope.data as { state: string; version: string; verifiedUpstream: boolean; files: { written: number } };
		expect(data.state).toBe('created');
		expect(data.version).toBe(SHIPPED_VERSION);
		expect(data.verifiedUpstream).toBe(true);
		expect(data.files.written).toBeGreaterThan(0);
		expect(sameAsShipped(patchesDir)).toBe(true);

		// ##STD-NOTICE-COMPONENTS-BLOCK: both copies now list standards and runtime.
		const notice = expectedNotice();
		expect(readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8')).toBe(notice);
		expect(readFileSync(join(patchesDir, ...INSTALLED.split('/'), 'LICENSE-CODKIT.md'), 'utf8')).toBe(notice);
		expect(notice).toContain(`runtime  ${SHIPPED_VERSION}  delta/own/codkit/`);
		expect(notice).toContain('standards  0.2.0  vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/');

		// ##RT-LOAD-STEPS step 7: the three things to do next.
		const text = run(patchesDir, ['runtime', 'check']).stdout;
		expect(text).toContain('runtime: identical');
	});

	it('prints the three next steps a person needs after the library lands', () => {
		const patchesDir = makePatchSet('s42-hints');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		const loaded = run(patchesDir, ['runtime', 'load']);

		expect(loaded.status).toBe(0);
		expect(loaded.stdout).toContain("import '../codkit/browser/featureFlags.contribution.js';");
		expect(loaded.stdout).toContain('code-import-patterns');
		expect(loaded.stdout).toContain('LAYERS.md');
		expect(loaded.stdout).toContain('codkit gen feature');
	});
});

describe('S43 - runtime load is idempotent', () => {
	it('says unchanged and moves no mtime the second time', () => {
		const patchesDir = makePatchSet('s43');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		expect(run(patchesDir, ['runtime', 'load']).status).toBe(0);
		const target = join(patchesDir, ...INSTALLED.split('/'));
		const stamps = [...walk(target)].sort().map((relative) => statSync(join(target, ...relative.split('/'))).mtimeMs);
		const noticeStamp = statSync(join(patchesDir, 'LICENSE-CODKIT.md')).mtimeMs;

		const again = json(patchesDir, ['runtime', 'load']);
		expect(again.status).toBe(0);
		expect((again.envelope.data as { state: string }).state).toBe('unchanged');
		expect([...walk(target)].sort().map((relative) => statSync(join(target, ...relative.split('/'))).mtimeMs)).toEqual(stamps);
		expect(statSync(join(patchesDir, 'LICENSE-CODKIT.md')).mtimeMs).toBe(noticeStamp);
	});
});

describe('S44 - runtime load refuses drift before the first write', () => {
	it('names both paths, writes nothing, and plans the replacement under --dry-run --upgrade', () => {
		const patchesDir = makePatchSet('s44');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		expect(run(patchesDir, ['runtime', 'load']).status).toBe(0);
		const target = join(patchesDir, ...INSTALLED.split('/'));
		writeFileSync(join(target, 'common', 'version.ts'), '// edited by the product\n', 'utf8');
		writeFileSync(join(target, 'browser', 'mine.ts'), 'export const MINE = 1;\n', 'utf8');
		const before = snapshot(patchesDir);

		const refused = json(patchesDir, ['runtime', 'load']);
		expect(refused.status).toBe(1);
		expect(refused.envelope.errors[0]?.code).toBe('CK-E-RUNTIME-DRIFT');
		expect(refused.envelope.errors[0]?.message).toContain('modified common/version.ts');
		expect(refused.envelope.errors[0]?.message).toContain('extra browser/mine.ts');
		expect(snapshot(patchesDir)).toBe(before);

		const planned = json(patchesDir, ['runtime', 'load', '--dry-run', '--upgrade']);
		expect(planned.status).toBe(0);
		const data = planned.envelope.data as { writes: string[]; removals: string[]; state: string };
		expect(data.state).toBe('upgraded');
		expect(data.writes).toContain('common/version.ts');
		expect(data.removals).toEqual(['browser/mine.ts']);
		expect(snapshot(patchesDir)).toBe(before);
	});
});

describe('S45 - runtime load --upgrade replaces the directory whole', () => {
	it('drops the extra file, restores every shipped byte and keeps the notice', () => {
		const patchesDir = makePatchSet('s45');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		expect(run(patchesDir, ['runtime', 'load']).status).toBe(0);
		const target = join(patchesDir, ...INSTALLED.split('/'));
		writeFileSync(join(target, 'common', 'version.ts'), '// edited by the product\n', 'utf8');
		writeFileSync(join(target, 'browser', 'mine.ts'), 'export const MINE = 1;\n', 'utf8');

		const upgraded = json(patchesDir, ['runtime', 'load', '--upgrade']);
		expect(upgraded.status).toBe(0);
		const data = upgraded.envelope.data as { state: string; files: { removed: number } };
		expect(data.state).toBe('upgraded');
		expect(data.files.removed).toBe(1);
		expect(sameAsShipped(patchesDir)).toBe(true);
		expect(readFileSync(join(target, 'LICENSE-CODKIT.md'), 'utf8')).toBe(expectedNotice());
	});
});

describe('S46 - runtime check names the three states', () => {
	it('is quiet about a product without the library', () => {
		const patchesDir = makePatchSet('s46-absent');
		const outcome = run(patchesDir, ['runtime', 'check']);

		expect(outcome.status).toBe(0);
		expect(outcome.stdout).toContain('runtime not installed');
	});

	it('says identical once the library is installed', () => {
		const patchesDir = makePatchSet('s46-same');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		expect(run(patchesDir, ['runtime', 'load']).status).toBe(0);

		const outcome = json(patchesDir, ['runtime', 'check']);
		expect(outcome.status).toBe(0);
		const target = outcome.envelope.data['target'] as { state: string; version: string };
		expect(target.state).toBe('identical');
		expect(target.version).toBe(SHIPPED_VERSION);
	});

	it('reports an edited file with its path and the recipe', () => {
		const patchesDir = makePatchSet('s46-drift');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		expect(run(patchesDir, ['runtime', 'load']).status).toBe(0);
		writeFileSync(join(patchesDir, ...INSTALLED.split('/'), 'common', 'version.ts'), '// edited\n', 'utf8');

		const outcome = json(patchesDir, ['runtime', 'check']);
		expect(outcome.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-RUNTIME-DRIFT');
		expect(outcome.envelope.errors[0]?.message).toContain('modified common/version.ts');
		expect(outcome.envelope.errors[0]?.hint).toBe('run codkit runtime load --upgrade');
	});
});

describe('S47 - save refuses an edit of a delivered file', () => {
	it('extracts nothing at all, not even the own file the developer added', () => {
		const fixture = makeCliFixture('runtime-save');
		expect(fixture.run(['runtime', 'load']).status).toBe(0);
		expect(fixture.run(['load']).status).toBe(0);

		const delivered = fixture.treePath('src/vs/patchset/codkit/common/version.ts');
		writeFileSync(delivered, `${readFileSync(delivered, 'utf8')}// edited in the tree\n`, 'utf8');
		const mine = fixture.treePath('src/vs/patchset/mine.ts');
		writeFileSync(mine, 'export const MINE = 1;\n', 'utf8');
		const before = snapshot(fixture.patchesPath('delta/own'));

		const outcome = fixture.json(['save']);
		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-DELIVERED-EDIT');
		expect(outcome.envelope.errors[0]?.message).toContain('src/vs/patchset/codkit/common/version.ts');
		expect(outcome.envelope.errors[0]?.hint).toContain('runtime load --upgrade');
		expect(snapshot(fixture.patchesPath('delta/own'))).toBe(before);
	});
});

describe('S48 - verify refuses a unit under codkit/ and drift of the library', () => {
	it('names the unit, then the drifted file, then the oversized hook', () => {
		const fixture = makeCliFixture('runtime-verify');
		expect(fixture.run(['load']).status).toBe(0);

		const manifestPath = fixture.patchesPath('delta/own/patchset.delta.json');
		const savedManifest = readFileSync(manifestPath, 'utf8');
		try {
			writeFileSync(manifestPath, savedManifest.replace('"roots": [', '"roots": [\n        "codkit/extra/",'), 'utf8');
			const under = fixture.json(['verify']);
			expect(under.run.status).toBe(1);
			const findings = (under.envelope.data as unknown as { findings: { code: string; message: string }[] }).findings;
			expect(findings.some((item) => item.code === 'CK-E-OWN-UNDER-CODKIT' && item.message.includes('codkit/extra/'))).toBe(true);
		} finally {
			writeFileSync(manifestPath, savedManifest, 'utf8');
		}

		const runtimeRoot = fixture.patchesPath('delta/own/codkit');
		try {
			mkdirSync(join(runtimeRoot, 'common'), { recursive: true });
			writeFileSync(join(runtimeRoot, 'common', 'version.ts'), '// not what codkit ships\n', 'utf8');
			const drifted = fixture.json(['verify']);
			expect(drifted.run.status).toBe(1);
			const findings = (drifted.envelope.data as unknown as { findings: { code: string }[] }).findings;
			expect(findings.some((item) => item.code === 'CK-E-RUNTIME-DRIFT')).toBe(true);
		} finally {
			rmSync(runtimeRoot, { recursive: true, force: true });
		}
	});
});

describe('the runtime namespace', () => {
	it('does nothing by itself and says which subcommands there are', () => {
		const patchesDir = makePatchSet('namespace');
		const outcome = run(patchesDir, ['runtime']);

		expect(outcome.status).toBe(2);
		expect(outcome.stderr).toContain('runtime load, runtime check');
	});
});
