// PROP-013 ##E2E-STANDARDS-SURFACE: `codkit standards` through the real
// launcher. FEAT-002 ##S30-##S37 and ##S41.
//
// The fixture is a patch-set root with a vibevm manifest and no fork tree at
// all: these commands must not need one (##STD-LOAD-ROOTS).

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Envelope } from '../support/cliFixture.ts';
import { makeCliFixture, runCli } from '../support/cliFixture.ts';
import { renderNotice } from '../../src/lib/licenceNotice.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shippedPackage = join(repoRoot, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards', 'v0.2.0');
const shippedNotice = join(repoRoot, 'codkit', 'config', 'LICENSE-CODKIT.md');
const INSTALLED = 'vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0';

/** A patch set with a vibevm manifest and nothing else. */
function makePatchSet(label: string, manifest = '[project]\nname = "fixture"\nversion = "0.0.1"\n'): string {
	const root = makeTempRoot(`std-${label}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'vibe.toml'), manifest, 'utf8');
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

function sameTree(left: string, right: string): boolean {
	const walk = (root: string, prefix = ''): readonly string[] =>
		readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			return entry.isDirectory() ? walk(join(root, entry.name), relative) : [relative];
		});
	const files = [...walk(left)].sort();
	if (files.join('\n') !== [...walk(right)].sort().join('\n')) return false;
	return files.every((relative) => sha256(join(left, ...relative.split('/'))) === sha256(join(right, ...relative.split('/'))));
}

describe('S30 - standards load into a fresh product', () => {
	it('plans without writing, then delivers the package, the notices and the block', () => {
		const patchesDir = makePatchSet('s30');
		const before = sha256(join(patchesDir, 'vibe.toml'));

		const dry = json(patchesDir, ['standards', 'load', '--dry-run']);
		expect(dry.status).toBe(0);
		const dryData = dry.envelope.data as { files: { created: number }; manifest: { action: string }; notes: readonly string[] };
		expect(dryData.files.created).toBeGreaterThan(0);
		expect(dryData.manifest.action).toBe('append');
		expect(dryData.notes).toHaveLength(4);
		expect(sha256(join(patchesDir, 'vibe.toml'))).toBe(before);
		expect(readdirSync(patchesDir).sort()).toEqual(['vibe.toml']);

		const loaded = run(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		expect(sameTree(shippedPackage, join(patchesDir, ...INSTALLED.split('/')))).toBe(true);
		// ##STD-NOTICE-TARGETS: both copies are the template rendered with the components block.
		const expectedNotice = renderNotice(readFileSync(shippedNotice, 'utf8'), [
			{ name: 'standards', version: '0.2.0', path: `${INSTALLED}/` }
		]);
		expect(readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8')).toBe(expectedNotice);
		expect(readFileSync(join(patchesDir, 'delta', 'own', 'codkit', 'LICENSE-CODKIT.md'), 'utf8')).toBe(expectedNotice);
		expect(expectedNotice).toContain('standards  0.2.0  vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/');

		// The manifest keeps its own bytes and gains the block at the end.
		const manifest = readFileSync(join(patchesDir, 'vibe.toml'), 'utf8');
		expect(manifest.startsWith('[project]\nname = "fixture"\nversion = "0.0.1"\n')).toBe(true);
		expect(manifest).toContain('[requires.packages."org.vibevm.codkit/standards"]');
		expect(manifest).toContain('version = "=0.2.0"');
		expect(manifest).toContain('link = "static"');

		// ##STD-LOAD-LICENCE-NOTE: four lines, verbatim, after the summary.
		expect(loaded.stdout.split('\n').filter((line) => line.startsWith('licence note:'))).toHaveLength(4);
		expect(loaded.stdout).toContain('next: vibe install --offline');
		expect(loaded.stdout).toContain('licence notice file: LICENSE-CODKIT.md');
		expect(loaded.stdout).toContain('----- LICENSE-CODKIT.md (verbatim) -----');
		expect(readdirSync(join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards'))).toEqual(['v0.2.0']);
	});

	it('materialises through vibe when vibe is on PATH', () => {
		const probe = spawnSync('vibe', ['--version'], { encoding: 'utf8' });
		if (probe.status !== 0) {
			// vibe is not a dependency of codkit, so its absence is not a failure -
			// but a silent skip would look like a pass.
			console.warn('standards e2e: vibe install step SKIPPED - vibe is not on PATH');
			expect(probe.status).not.toBe(0);
			return;
		}
		const patchesDir = makePatchSet('s30-vibe');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		spawnSync('git', ['init', '-q'], { cwd: patchesDir });

		const install = spawnSync('vibe', ['install', '--offline', '--assume-yes'], { cwd: patchesDir, encoding: 'utf8' });
		expect(install.status, install.stderr).toBe(0);
		expect(readFileSync(join(patchesDir, 'vibe.lock'), 'utf8')).toContain('source_kind = "local"');
		// vibe copies the package byte for byte and adds its own slot file, so
		// every shipped file must be present and identical - not more, not less.
		const materialised = join(patchesDir, 'vibevm', 'vibedeps', 'org.vibevm.codkit.standards', '0.2.0');
		for (const relative of ['LICENSE', 'vibe.toml', 'README.md', 'assets/codkit.png', 'assets/codkit.png.license']) {
			expect(sha256(join(materialised, ...relative.split('/'))), relative).toBe(sha256(join(shippedPackage, ...relative.split('/'))));
		}
		const check = spawnSync('vibe', ['check', '--quiet'], { cwd: patchesDir, encoding: 'utf8' });
		expect(check.status, check.stdout + check.stderr).toBe(0);
	});
});

describe('S31 - standards load is idempotent and survives an interruption', () => {
	it('changes not one byte on a second run', () => {
		const patchesDir = makePatchSet('s31');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		const before = sha256(join(patchesDir, 'vibe.toml'));

		const again = json(patchesDir, ['standards', 'load']);
		expect(again.status).toBe(0);
		const data = again.envelope.data as { files: { created: number; unchanged: number }; manifest: { action: string } };
		expect(data.files.created).toBe(0);
		expect(data.manifest.action).toBe('unchanged');
		expect(sha256(join(patchesDir, 'vibe.toml'))).toBe(before);
	});

	it('removes a scratch directory an interrupted run left behind', () => {
		const patchesDir = makePatchSet('s31-scratch');
		const parent = join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards');
		mkdirSync(join(parent, '.codkit-load-999-dead'), { recursive: true });

		const loaded = json(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		expect((loaded.envelope.data as { removedScratch: readonly string[] }).removedScratch).toEqual(['.codkit-load-999-dead']);
		expect(readdirSync(parent)).toEqual(['v0.2.0']);
	});
});

describe('S32 - standards load refuses over edits and over a broken block', () => {
	it('refuses a drifted copy with exit 1 and writes nothing', () => {
		const patchesDir = makePatchSet('s32-drift');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		const target = join(patchesDir, ...INSTALLED.split('/'), 'README.md');
		writeFileSync(target, `${readFileSync(target, 'utf8')}edited\n`, 'utf8');
		const edited = sha256(target);

		const refused = run(patchesDir, ['standards', 'load']);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('CK-E-STANDARDS-DRIFT');
		expect(refused.stderr).toContain('modified README.md');
		expect(sha256(target)).toBe(edited);
	});

	it('refuses a drifted notice copy by name', () => {
		const patchesDir = makePatchSet('s32-notice');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		writeFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'mine\n', 'utf8');

		const refused = run(patchesDir, ['standards', 'load']);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('modified LICENSE-CODKIT.md');
	});

	it('refuses a malformed block and an entry outside it, with the line number', () => {
		const patchesDir = makePatchSet('s32-block');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		const manifest = join(patchesDir, 'vibe.toml');
		writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('# codkit:end standards', ''), 'utf8');

		const malformed = run(patchesDir, ['standards', 'load']);
		expect(malformed.status).toBe(1);
		expect(malformed.stderr).toContain('the codkit block is malformed');

		const outside = makePatchSet(
			's32-outside',
			'[project]\nname = "x"\nversion = "0.0.1"\n\n[requires.packages]\n"org.vibevm.codkit/standards" = "0.1.0"\n'
		);
		const refused = run(outside, ['standards', 'load']);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('sits outside its block');
	});

	it('refuses CRLF and a manifest with no [project] table', () => {
		const crlf = makePatchSet('s32-crlf', '[project]\r\nname = "x"\r\n');
		expect(run(crlf, ['standards', 'load']).stderr).toContain('CK-E-CRLF');

		const noProject = makePatchSet('s32-noproject', '[package]\nname = "x"\n');
		const refused = run(noProject, ['standards', 'load']);
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain('vibe init');
	});
});

describe('S33 - a package that fails the licence check is never copied', () => {
	it('reports the problem, writes nothing, and has no bypass flag', () => {
		const patchesDir = makePatchSet('s33');
		const source = makeTempRoot('s33-source');
		cpSync(shippedPackage, join(source, 'v0.2.0'), { recursive: true });
		rmSync(join(source, 'v0.2.0', 'assets', 'codkit.png.license'));

		const refused = runCli(patchesDir, ['--patches-dir', patchesDir, 'standards', 'load'], {
			CODKIT_E2E_TEST_BUILD: '1',
			CODKIT_TEST_STANDARDS_SOURCE: source
		});
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('CK-E-LICENSE-HEADER');
		expect(readdirSync(patchesDir).sort()).toEqual(['vibe.toml']);
	});

	it('ignores the seam outside the test build', () => {
		const patchesDir = makePatchSet('s33-seam');
		const source = makeTempRoot('s33-seam-source');
		// No test build condition: the variable must not redirect a real run.
		const loaded = runCli(patchesDir, ['--patches-dir', patchesDir, 'standards', 'load'], {
			CODKIT_TEST_STANDARDS_SOURCE: source
		});
		expect(loaded.status).toBe(0);
		expect(sameTree(shippedPackage, join(patchesDir, ...INSTALLED.split('/')))).toBe(true);
	});
});

describe('S34 - standards check names every state', () => {
	it('reports an absent installation, then a clean one', () => {
		const patchesDir = makePatchSet('s34');
		const absent = json(patchesDir, ['standards', 'check']);
		expect(absent.status).toBe(1);
		const absentData = absent.envelope.data as { target: { state: string }; manifest: { state: string }; scrape: { state: string } };
		expect(absentData.target.state).toBe('absent');
		expect(absentData.manifest.state).toBe('absent');
		expect(absentData.scrape.state).toBe('no-contract');

		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		const clean = json(patchesDir, ['standards', 'check']);
		expect(clean.status).toBe(0);
		const cleanData = clean.envelope.data as {
			target: { state: string };
			manifest: { state: string };
			noticeFiles: readonly { path: string; state: string }[];
		};
		expect(cleanData.target.state).toBe('identical');
		expect(cleanData.manifest.state).toBe('current');
		expect(cleanData.noticeFiles.every((notice) => notice.state === 'identical')).toBe(true);
	});

	it('calls a stale block stale rather than rewriting it', () => {
		const patchesDir = makePatchSet('s34-stale');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		const manifest = join(patchesDir, 'vibe.toml');
		writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('version = "=0.2.0"', 'version = "=0.0.9"'), 'utf8');

		const stale = json(patchesDir, ['standards', 'check']);
		expect(stale.status).toBe(1);
		expect((stale.envelope.data as { manifest: { state: string } }).manifest.state).toBe('stale');
	});
});

describe('S35 - standards license prints the file, the advice and the rows', () => {
	it('needs no root and carries the rows structurally', () => {
		const cwd = makeTempRoot('s35-cwd');
		mkdirSync(cwd, { recursive: true });
		const printed = runCli(cwd, ['standards', 'license']);

		expect(printed.status).toBe(0);
		expect(printed.stdout).toContain('----- LICENSE-CODKIT.md (verbatim) -----');
		expect(printed.stdout).toContain('licence notice file: LICENSE-CODKIT.md');
		expect(printed.stdout).toContain('[[classify]]');
		expect(printed.stdout).toContain('kind = "paths-absent-v1"');

		const structured = runCli(cwd, ['--json', 'standards', 'license']);
		const data = (JSON.parse(structured.stdout) as Envelope).data as {
			file: string;
			text: string;
			scrapeContractRows: string;
			recommendations: readonly string[];
			reuseAnnotation: string;
		};
		expect(data.file).toBe('LICENSE-CODKIT.md');
		expect(data.text).toBe(readFileSync(shippedNotice, 'utf8'));
		expect(data.scrapeContractRows).toContain('remove-codkit-licence-notice');
		expect(data.scrapeContractRows).toContain('"LICENSE-CODKIT.md", "delta/own/LICENSE-CODKIT.md", "delta/own/codkit/LICENSE-CODKIT.md"');
		expect(data.recommendations.length).toBeGreaterThan(0);
		// ##STD-LICENSE-PRINTS-REUSE-ROWS
		expect(data.reuseAnnotation).toContain('[[annotations]]');
		expect(data.reuseAnnotation).toContain('"delta/own/codkit/**"');
		expect(data.reuseAnnotation).toContain('SPDX-License-Identifier = "UPL-1.0"');
	});
});

describe('S37 - the scrape contract block', () => {
	it('is appended to an existing contract and left alone afterwards', () => {
		const patchesDir = makePatchSet('s37');
		const contract = join(patchesDir, 'vibevm', 'scrape', 'contract.toml');
		mkdirSync(dirname(contract), { recursive: true });
		const original = '[policy]\nmode = "strict"\n\n[[healthcheck]]\nid = "build"\n';
		writeFileSync(contract, original, 'utf8');

		const first = json(patchesDir, ['standards', 'load']);
		expect(first.status).toBe(0);
		expect((first.envelope.data as { scrape: { action: string } }).scrape.action).toBe('append');
		const written = readFileSync(contract, 'utf8');
		expect(written.startsWith(original)).toBe(true);
		expect(written).toContain('# codkit:begin scrape');
		expect(written).toContain('# codkit:end scrape');
		expect(written).toContain('id = "remove-codkit-licence-notice"');

		const second = json(patchesDir, ['standards', 'load']);
		expect((second.envelope.data as { scrape: { action: string } }).scrape.action).toBe('unchanged');
		expect(readFileSync(contract, 'utf8')).toBe(written);
	});

	it('says what to do when the product has no contract, and writes nothing there', () => {
		const patchesDir = makePatchSet('s37-none');
		const loaded = run(patchesDir, ['standards', 'load']);

		expect(loaded.status).toBe(0);
		expect(loaded.stdout).toContain('scrape contract: none - run vibe scrape contract init');
		expect(readdirSync(join(patchesDir, 'vibevm')).sort()).toEqual(['vibepacks']);
	});
});

describe('S51 - the notice of edition 3: paths, components block, legacy copy', () => {
	it('moves an edition-2 copy under the codkit prefix and keeps the block current', () => {
		const patchesDir = makePatchSet('s51');
		mkdirSync(join(patchesDir, 'delta', 'own'), { recursive: true });
		writeFileSync(join(patchesDir, 'delta', 'own', 'LICENSE-CODKIT.md'), 'edition 2 copy\n', 'utf8');

		const loaded = json(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		expect(existsSync(join(patchesDir, 'delta', 'own', 'LICENSE-CODKIT.md'))).toBe(false);
		expect(existsSync(join(patchesDir, 'delta', 'own', 'codkit', 'LICENSE-CODKIT.md'))).toBe(true);
		expect((loaded.envelope.data as { legacyNoticeMoved: boolean }).legacyNoticeMoved).toBe(true);
		const text = readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8');
		expect(text).toContain('<!-- codkit:begin components -->');
		expect(text).toContain('standards  0.2.0  vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/');
		expect(text).toContain('delta/own/codkit/**');

		// A legacy copy put back by hand is a warning on check, not a finding.
		writeFileSync(join(patchesDir, 'delta', 'own', 'LICENSE-CODKIT.md'), 'edition 2 copy\n', 'utf8');
		const checked = run(patchesDir, ['standards', 'check']);
		expect(checked.status).toBe(0);
		expect(checked.stderr + checked.stdout).toContain('legacy-copy');

		// A copy whose block is out of date is updated, not refused.
		writeFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), readFileSync(shippedNotice, 'utf8'), 'utf8');
		const again = json(patchesDir, ['standards', 'load']);
		expect(again.status).toBe(0);
		const actions = (again.envelope.data as { noticeFiles: readonly { path: string; action: string }[] }).noticeFiles;
		expect(actions).toEqual([
			{ path: 'LICENSE-CODKIT.md', action: 'updated' },
			{ path: 'delta/own/codkit/LICENSE-CODKIT.md', action: 'unchanged' }
		]);
	});
});

describe('S53 - edition 0.2.0 lands beside an installed 0.1.0', () => {
	it('keeps the old directory, moves the block and lists both versions in the notice', () => {
		const patchesDir = makePatchSet('s53');
		const old = join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards', 'v0.1.0');
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, 'vibe.toml'), '[package]\nname = "standards"\nversion = "0.1.0"\n', 'utf8');

		const loaded = json(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		expect((loaded.envelope.data as { otherVersions: readonly string[] }).otherVersions).toEqual(['v0.1.0']);
		expect(readdirSync(join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards')).sort()).toEqual(['v0.1.0', 'v0.2.0']);
		expect(readFileSync(join(patchesDir, 'vibe.toml'), 'utf8')).toContain('version = "=0.2.0"');
		const notice = readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8');
		expect(notice).toContain('standards  0.1.0  vibevm/vibepacks/org.vibevm.codkit/standards/v0.1.0/');
		expect(notice).toContain('standards  0.2.0  vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/');
		expect(existsSync(join(patchesDir, INSTALLED, 'vibevm', 'vibespecs', 'flows', 'standards', 'seam-catalogue.xml'))).toBe(true);
	});
});

describe('S36 - the notice is a delivered own file that needs no unit', () => {
	it('reaches the fork tree with the own code and verify does not ask for a unit', () => {
		// The full fixture: a real patch set with own code and a fork tree.
		const fixture = makeCliFixture('std-s36');
		writeFileSync(fixture.patchesPath('delta/own/LICENSE-CODKIT.md'), readFileSync(shippedNotice, 'utf8'), 'utf8');

		const verified = fixture.run(['verify']);
		expect(verified.stderr).not.toContain('OWN-UNCOVERED');
		expect(verified.status, verified.stderr).toBe(0);

		expect(fixture.run(['load']).status).toBe(0);
		expect(sha256(fixture.treePath('src/vs/patchset/LICENSE-CODKIT.md'))).toBe(sha256(shippedNotice));

		// `save` mirrors it back unchanged, like any other own file.
		const saved = fixture.run(['save']);
		expect(saved.status, saved.stderr).toBe(0);
		expect(sha256(fixture.patchesPath('delta/own/LICENSE-CODKIT.md'))).toBe(sha256(shippedNotice));
	});
});

describe('S41 - the report names the licences it loaded', () => {
	it('lists the own licence, the third-party one and the notices file', () => {
		const patchesDir = makePatchSet('s41');
		const loaded = json(patchesDir, ['standards', 'load']);
		const data = loaded.envelope.data as { licences: { own: readonly string[]; thirdParty: readonly string[]; notices: string | null } };

		expect(data.licences.own).toEqual(['UPL-1.0']);
		expect(data.licences.thirdParty).toEqual(['MIT']);
		expect(data.licences.notices).toBe('THIRD-PARTY-NOTICES.md');
		// The pair of a binary and its sidecar travelled together.
		expect(sha256(join(patchesDir, ...INSTALLED.split('/'), 'assets', 'codkit.png'))).toBe(
			sha256(join(shippedPackage, 'assets', 'codkit.png'))
		);
		expect(sha256(join(patchesDir, ...INSTALLED.split('/'), 'assets', 'codkit.png.license'))).toBe(
			sha256(join(shippedPackage, 'assets', 'codkit.png.license'))
		);
	});
});
