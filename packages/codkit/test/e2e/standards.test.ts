// PROP-013 ##E2E-STANDARDS-SURFACE: `codkit standards` through the real
// launcher. FEAT-002 ##S30-##S37, ##S41, ##S56-##S58 and ##S60.
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

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shippedPackage = join(packageRoot, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards', 'v1.0.0');
const shippedSkills = join(packageRoot, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'agent-skills', 'v1.0.0');
const shippedSeams = join(packageRoot, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'seams-vscode', 'v1.0.0');
const shippedNotice = join(packageRoot, 'config', 'LICENSE-CODKIT.md');
const INSTALLED = 'vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0';
const SKILLS_INSTALLED = 'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v1.0.0';
/** ##STD-PACKAGES-OF-THE-TYPE: the package the fixture's `vscode` type names. */
const SEAMS_INSTALLED = 'vibevm/vibepacks/org.vibevm.codkit/seams-vscode/v1.0.0';
const SKILL_NAMES = ['ck-orient', 'ck-intervene', 'ck-review-intervention', 'ck-resolve'];

/** ##STD-NOTICE-COMPONENTS-BLOCK: the whole shipped set, by name. */
const COMPONENTS = [
	{ name: 'agent-skills', version: '1.0.0', path: `${SKILLS_INSTALLED}/` },
	{ name: 'seams-vscode', version: '1.0.0', path: `${SEAMS_INSTALLED}/` },
	{ name: 'standards', version: '1.0.0', path: `${INSTALLED}/` }
];

/**
 * A patch set with a vibevm manifest and a codkit.json - and no fork tree at
 * all. The configuration is there for one reason: the packages delivered are
 * the universal ones plus the ones this patch set's project type names
 * (##STD-PACKAGES-OF-THE-TYPE), so `load` and `check` have to know the type.
 */
function makePatchSet(label: string, manifest = '[project]\nname = "fixture"\nversion = "0.0.1"\n'): string {
	const root = makeTempRoot(`std-${label}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'vibe.toml'), manifest, 'utf8');
	writeConfig(root, 'vscode');
	return root;
}

/** The smallest schema-2 configuration a patch set of `type` can carry. */
function writeConfig(root: string, type: string): void {
	writeFileSync(
		join(root, 'codkit.json'),
		`${JSON.stringify(
			{
				codkitConfig: 2,
				pin: { tag: '1.0.0', sha: 'a'.repeat(40), date: '2026-01-02' },
				upstreamAnchorCommit: 'b'.repeat(40),
				type,
				typeConfig: type === 'vscode' ? { ownRoot: 'src/vs/patchset' } : { ownRoot: 'src/own' },
				generatedBranchPrefix: 'codkit/applied/',
				cycleBranchPrefix: 'codkit/cycle/',
				releaseRefPrefix: 'codkit/release/',
				publishRemoteUrl: null,
				buildWatchFile: null,
				conventionsExtensionFile: null
			},
			null,
			'\t'
		)}\n`,
		'utf8'
	);
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
		expect(readdirSync(patchesDir).sort()).toEqual(['codkit.json', 'vibe.toml']);

		const loaded = run(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		expect(sameTree(shippedPackage, join(patchesDir, ...INSTALLED.split('/')))).toBe(true);
		// ##STD-NOTICE-TARGETS: both copies are the template rendered with the components block.
		const expectedNotice = renderNotice(readFileSync(shippedNotice, 'utf8'), COMPONENTS);
		expect(readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8')).toBe(expectedNotice);
		expect(readFileSync(join(patchesDir, 'delta', 'own', 'codkit', 'LICENSE-CODKIT.md'), 'utf8')).toBe(expectedNotice);
		expect(expectedNotice).toContain('standards  1.0.0  vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/');

		// The manifest keeps its own bytes and gains the block at the end.
		const manifest = readFileSync(join(patchesDir, 'vibe.toml'), 'utf8');
		expect(manifest.startsWith('[project]\nname = "fixture"\nversion = "0.0.1"\n')).toBe(true);
		expect(manifest).toContain('[requires.packages."org.vibevm.codkit/standards"]');
		expect(manifest).toContain('version = "=1.0.0"');
		expect(manifest).toContain('link = "static"');

		// ##STD-LOAD-LICENCE-NOTE: four lines, verbatim, after the summary.
		expect(loaded.stdout.split('\n').filter((line) => line.startsWith('licence note:'))).toHaveLength(4);
		expect(loaded.stdout).toContain('next: vibe install --offline');
		expect(loaded.stdout).toContain('licence notice file: LICENSE-CODKIT.md');
		expect(loaded.stdout).toContain('----- LICENSE-CODKIT.md (verbatim) -----');
		expect(readdirSync(join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards'))).toEqual(['v1.0.0']);
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
		const materialised = join(patchesDir, 'vibevm', 'vibedeps', 'org.vibevm.codkit.standards', '1.0.0');
		for (const relative of ['LICENSE', 'vibe.toml', 'README.md', 'assets/codkit.png', 'assets/codkit.png.license']) {
			expect(sha256(join(materialised, ...relative.split('/'))), relative).toBe(sha256(join(shippedPackage, ...relative.split('/'))));
		}
		const check = spawnSync('vibe', ['check', '--quiet'], { cwd: patchesDir, encoding: 'utf8' });
		expect(check.status, check.stdout + check.stderr).toBe(0);

		// ##S57: the skills package is projected into the harness directories,
		// each skill body copied as it is.
		const listed = spawnSync('vibe', ['skill', 'list'], { cwd: patchesDir, encoding: 'utf8' });
		expect(listed.status, listed.stderr).toBe(0);
		for (const name of SKILL_NAMES) expect(listed.stdout, name).toContain(name);

		const projected = spawnSync('vibe', ['skill', 'install', '--assume-yes'], { cwd: patchesDir, encoding: 'utf8' });
		expect(projected.status, projected.stderr).toBe(0);
		for (const name of SKILL_NAMES) {
			const body = join(patchesDir, '.claude', 'skills', name, 'SKILL.md');
			expect(sha256(body), name).toBe(sha256(join(shippedSkills, 'vibevm', 'vibespecs', 'skills', name, 'SKILL.md')));
			// The harness reads the frontmatter from the first bytes of the file.
			expect(readFileSync(body, 'utf8').startsWith('---\n'), name).toBe(true);
		}
		expect(existsSync(join(patchesDir, '.claude', 'skills', 'ck-resolve', 'scripts', 'append-journal.mjs'))).toBe(true);
	});
});

describe('S56 - one run delivers every package codkit ships', () => {
	it('writes both directories, one block with two tables and both next steps', () => {
		const patchesDir = makePatchSet('s56');

		const loaded = json(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		expect(sameTree(shippedPackage, join(patchesDir, ...INSTALLED.split('/')))).toBe(true);
		expect(sameTree(shippedSkills, join(patchesDir, ...SKILLS_INSTALLED.split('/')))).toBe(true);
		expect(sameTree(shippedSeams, join(patchesDir, ...SEAMS_INSTALLED.split('/')))).toBe(true);

		// ##STD-LOAD-ALL-PACKAGES: `standards` first, then the rest by name.
		const data = loaded.envelope.data as {
			packages: readonly { name: string; version: string; state: string; declaresSkills: boolean }[];
			nextSteps: readonly string[];
		};
		expect(data.packages.map((entry) => entry.name)).toEqual(['standards', 'agent-skills', 'seams-vscode']);
		expect(data.packages.map((entry) => entry.state)).toEqual(['created', 'created', 'created']);
		expect(data.packages.map((entry) => entry.declaresSkills)).toEqual([false, true, false]);
		expect(data.nextSteps).toEqual(['vibe install --offline', 'vibe skill install']);

		// One block, one table per package, in the same order.
		const manifest = readFileSync(join(patchesDir, 'vibe.toml'), 'utf8');
		const block = manifest.slice(manifest.indexOf('# codkit:begin standards'), manifest.indexOf('# codkit:end standards'));
		expect(block).toContain('[requires.packages."org.vibevm.codkit/standards"]');
		expect(block).toContain('version = "=1.0.0"');
		expect(block).toContain('[requires.packages."org.vibevm.codkit/agent-skills"]');
		expect(block).toContain('[requires.packages."org.vibevm.codkit/seams-vscode"]');
		expect(block).toContain('version = "=1.0.0"');
		expect(manifest.split('# codkit:begin standards')).toHaveLength(2);

		// ##STD-NOTICE-COMPONENTS-BLOCK: the notice names both installed packages.
		const notice = readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8');
		expect(notice).toContain(`agent-skills  1.0.0  ${SKILLS_INSTALLED}/`);
		expect(notice).toContain(`seams-vscode  1.0.0  ${SEAMS_INSTALLED}/`);
		expect(notice).toContain(`standards  1.0.0  ${INSTALLED}/`);

		const human = run(patchesDir, ['standards', 'load']);
		expect(human.status).toBe(0);
		expect(human.stdout).toContain('next: vibe install --offline');
		expect(human.stdout).toContain('next: vibe skill install');
		// One summary per package, in the delivery order (##STD-LOAD-ALL-PACKAGES).
		const summaries = human.stdout.split('\n').filter((line) => line.startsWith('package: ') || line.startsWith('files: '));
		expect(summaries).toHaveLength(6);
		expect(summaries[0]).toBe(`package: standards 1.0.0 -> ${INSTALLED}`);
		expect(summaries[1]).toMatch(/^files: \d+ unchanged \(up to date\)$/u);
		expect(summaries[2]).toBe(`package: agent-skills 1.0.0 -> ${SKILLS_INSTALLED}`);
		expect(summaries[3]).toMatch(/^files: \d+ unchanged \(up to date\)$/u);
		expect(summaries[4]).toBe(`package: seams-vscode 1.0.0 -> ${SEAMS_INSTALLED}`);
		expect(summaries[5]).toMatch(/^files: \d+ unchanged \(up to date\)$/u);
		expect((json(patchesDir, ['standards', 'load']).envelope.data as { files: { created: number } }).files.created).toBe(0);
	});
});

describe("S68 - the packages a patch set is delivered are its type's", () => {
	it('gives a generic patch set the universal set and nothing of another family', () => {
		const patchesDir = makePatchSet('s68-generic');
		writeConfig(patchesDir, 'generic');

		const loaded = json(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		const data = loaded.envelope.data as { packages: readonly { name: string }[] };
		expect(data.packages.map((entry) => entry.name)).toEqual(['standards', 'agent-skills']);
		expect(existsSync(join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'seams-vscode'))).toBe(false);
		// A package no type named is not a missing package: `check` is clean.
		expect(run(patchesDir, ['standards', 'check']).status).toBe(0);
		expect(readFileSync(join(patchesDir, 'vibe.toml'), 'utf8')).not.toContain('seams-vscode');
		expect(readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8')).not.toContain('seams-vscode');
	});

	it('refuses a patch set with no configuration, before any write', () => {
		const patchesDir = makePatchSet('s68-no-config');
		rmSync(join(patchesDir, 'codkit.json'));

		const refused = json(patchesDir, ['standards', 'load']);
		expect(refused.status).toBe(2);
		expect(refused.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(refused.envelope.errors[0]?.message).toContain('no project type to ask');
		expect(readdirSync(patchesDir).sort()).toEqual(['vibe.toml']);
		expect(json(patchesDir, ['standards', 'check']).status).toBe(2);
	});
});

describe('S58 - the second package drifts like the first', () => {
	it('names the package and the path, refuses the load and recovers on deletion', () => {
		const patchesDir = makePatchSet('s58');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		const skill = join(patchesDir, ...SKILLS_INSTALLED.split('/'), 'vibevm', 'vibespecs', 'skills', 'ck-orient', 'SKILL.md');
		writeFileSync(skill, `${readFileSync(skill, 'utf8')}mine\n`, 'utf8');

		const checked = json(patchesDir, ['standards', 'check']);
		expect(checked.status).toBe(1);
		const packages = (checked.envelope.data as { packages: readonly { name: string; target: { state: string; paths: string[] } }[] })
			.packages;
		expect(packages.find((entry) => entry.name === 'standards')?.target.state).toBe('identical');
		expect(packages.find((entry) => entry.name === 'agent-skills')?.target.state).toBe('drift');
		expect(packages.find((entry) => entry.name === 'agent-skills')?.target.paths).toEqual(['vibevm/vibespecs/skills/ck-orient/SKILL.md']);

		const refused = run(patchesDir, ['standards', 'check']);
		expect(refused.stderr).toContain('CK-E-STANDARDS-DRIFT');
		expect(refused.stderr).toContain('agent-skills: modified vibevm/vibespecs/skills/ck-orient/SKILL.md');

		const load = run(patchesDir, ['standards', 'load']);
		expect(load.status).toBe(1);
		expect(load.stderr).toContain('CK-E-STANDARDS-DRIFT');
		expect(load.stderr).toContain('agent-skills: modified');

		rmSync(join(patchesDir, ...SKILLS_INSTALLED.split('/')), { recursive: true });
		const again = run(patchesDir, ['standards', 'load']);
		expect(again.status, again.stderr).toBe(0);
		expect(sameTree(shippedSkills, join(patchesDir, ...SKILLS_INSTALLED.split('/')))).toBe(true);
		expect(run(patchesDir, ['standards', 'check']).status).toBe(0);
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
		expect(readdirSync(parent)).toEqual(['v1.0.0']);
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
		cpSync(shippedPackage, join(source, 'v1.0.0'), { recursive: true });
		rmSync(join(source, 'v1.0.0', 'assets', 'codkit.png.license'));

		const refused = runCli(patchesDir, ['--patches-dir', patchesDir, 'standards', 'load'], {
			CODKIT_E2E_TEST_BUILD: '1',
			CODKIT_TEST_STANDARDS_SOURCE: source
		});
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('CK-E-LICENSE-HEADER');
		expect(readdirSync(patchesDir).sort()).toEqual(['codkit.json', 'vibe.toml']);
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
		writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('version = "=1.0.0"', 'version = "=0.0.9"'), 'utf8');

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
		expect(text).toContain('standards  1.0.0  vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/');
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

describe('S53 - a new edition lands beside an installed older one', () => {
	it('keeps the old directory, moves the block and lists both versions in the notice', () => {
		const patchesDir = makePatchSet('s53');
		const old = join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards', 'v0.1.0');
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, 'vibe.toml'), '[package]\nname = "standards"\nversion = "0.1.0"\n', 'utf8');

		const loaded = json(patchesDir, ['standards', 'load']);
		expect(loaded.status).toBe(0);
		expect((loaded.envelope.data as { otherVersions: readonly string[] }).otherVersions).toEqual(['v0.1.0']);
		expect(readdirSync(join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards')).sort()).toEqual(['v0.1.0', 'v1.0.0']);
		expect(readFileSync(join(patchesDir, 'vibe.toml'), 'utf8')).toContain('version = "=1.0.0"');
		const notice = readFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'utf8');
		expect(notice).toContain('standards  0.1.0  vibevm/vibepacks/org.vibevm.codkit/standards/v0.1.0/');
		expect(notice).toContain('standards  1.0.0  vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/');
		// ##STD-PACKAGES-OF-THE-TYPE: the catalogue is the type's package now, and
		// the standards package no longer carries it.
		expect(existsSync(join(patchesDir, INSTALLED, 'vibevm', 'vibespecs', 'flows', 'standards', 'seam-catalogue.xml'))).toBe(false);
		expect(existsSync(join(patchesDir, SEAMS_INSTALLED, 'vibevm', 'vibespecs', 'flows', 'standards', 'seam-catalogue.xml'))).toBe(true);
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

describe('S60 - the same edition number, extended in place', () => {
	it('is drift, refuses without the flag, and is replaced by standards load --upgrade', () => {
		const patchesDir = makePatchSet('s60');
		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);

		// A tool whose edition 1.0.0 carries new bytes (##DECISION-STD-MUTABLE-EDITION).
		const source = makeTempRoot('s60-source');
		cpSync(shippedPackage, join(source, 'v1.0.0'), { recursive: true });
		const readme = join(source, 'v1.0.0', 'README.md');
		writeFileSync(readme, `${readFileSync(readme, 'utf8')}\nOne more norm.\n`, 'utf8');
		const added = join(source, 'v1.0.0', 'vibevm', 'vibespecs', 'flows', 'standards', 'extra.xml');
		writeFileSync(added, readFileSync(join(source, 'v1.0.0', 'vibevm', 'vibespecs', 'flows', 'standards', 'minimal-intervention.xml')));
		const seam = { CODKIT_E2E_TEST_BUILD: '1', CODKIT_TEST_STANDARDS_SOURCE: source };
		const withSeam = (args: readonly string[]) => runCli(patchesDir, ['--patches-dir', patchesDir, ...args], seam);

		const checked = withSeam(['standards', 'check']);
		expect(checked.status).toBe(1);
		expect(checked.stderr).toContain('standards: modified README.md');
		expect(checked.stderr).toContain('standards: missing vibevm/vibespecs/flows/standards/extra.xml');
		expect(checked.stderr).toContain('run codkit standards load --upgrade to take the shipped copy');

		const refused = withSeam(['standards', 'load']);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain('CK-E-STANDARDS-DRIFT');
		expect(sha256(join(patchesDir, ...INSTALLED.split('/'), 'README.md'))).toBe(sha256(join(shippedPackage, 'README.md')));

		const planned = withSeam(['standards', 'load', '--upgrade', '--dry-run']);
		expect(planned.status, planned.stderr).toBe(0);
		expect(planned.stdout).toContain('replace README.md');
		expect(planned.stdout).toContain('replace vibevm/vibespecs/flows/standards/extra.xml');
		expect(sha256(join(patchesDir, ...INSTALLED.split('/'), 'README.md'))).toBe(sha256(join(shippedPackage, 'README.md')));

		const upgraded = withSeam(['--json', 'standards', 'load', '--upgrade']);
		expect(upgraded.status, upgraded.stderr).toBe(0);
		expect(sameTree(join(source, 'v1.0.0'), join(patchesDir, ...INSTALLED.split('/')))).toBe(true);
		const data = (JSON.parse(upgraded.stdout) as Envelope).data as {
			packages: readonly { name: string; state: string }[];
			manifest: { action: string };
			nextSteps: readonly string[];
		};
		expect(data.packages.find((entry) => entry.name === 'standards')?.state).toBe('upgraded');
		expect(data.manifest.action).toBe('unchanged');
		expect(data.nextSteps).toEqual(['vibe install --offline --force', 'vibe skill install']);
		expect(withSeam(['standards', 'check']).status).toBe(0);
	});

	it('drops a superseded version directory only when the flag says so', () => {
		const patchesDir = makePatchSet('s60-old');
		const old = join(patchesDir, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards', 'v0.1.0');
		mkdirSync(old, { recursive: true });
		writeFileSync(join(old, 'vibe.toml'), '[package]\nname = "standards"\nversion = "0.1.0"\n', 'utf8');

		expect(run(patchesDir, ['standards', 'load']).status).toBe(0);
		expect(existsSync(old)).toBe(true);

		const upgraded = json(patchesDir, ['standards', 'load', '--upgrade']);
		expect(upgraded.status).toBe(0);
		expect(existsSync(old)).toBe(false);
		expect(
			(upgraded.envelope.data as { packages: readonly { name: string; removedVersions: readonly string[] }[] }).packages.find(
				(entry) => entry.name === 'standards'
			)?.removedVersions
		).toEqual(['v0.1.0']);
	});
});
