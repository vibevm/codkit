// e2e: `codkit imageset` through the real launcher on the imageset fixture
// pair - the namespace and its refusal to work bare, `gen` seeding and the
// resource-layer delivery, `codkit load` materialising the regenerated icons
// into the fork tree, --dry-run, --branding-dir, the read-only `index` in its
// three states, and the honest --help (PROP-007 ##CMD-IMAGESET,
// ##IMAGESET-INDEX and the other IMAGESET-* anchors).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { encodePng } from '@codkit/type-api';
import { runCli } from '../support/cliFixture.ts';
import { makeImagesetPatchSet, makeImagesetTree } from '../support/imagesetFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

/**
 * The imageset fixture triple: unlike makeCliFixture, the upstream here is the
 * distribution tree (the icons must be committed at the pin), so the patchset
 * is the imageset one and the fork tree is a clone detached at that pin.
 */
function makeImagesetFixture(label: string) {
	const tree = makeImagesetTree(label);
	const patchset = makeImagesetPatchSet(label, tree);
	const treeDir = join(makeTempRoot(`${label}-fork`), 'fork-tree');
	mkdirSync(join(treeDir, '..'), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', tree.dir, treeDir], cwd: join(treeDir, '..'), netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', tree.pin.sha], cwd: treeDir });
	const run = (args: readonly string[]) => runCli(patchset.dir, ['--patches-dir', patchset.dir, '--fork-dir', treeDir, ...args]);
	return { tree, patchset, treeDir, run };
}

const artifactOf = (patchsetDir: string, target: string) => join(patchsetDir, 'delta', 'resources', 'files', ...target.split('/'));

describe('codkit imageset gen', () => {
	it('seeds the branding directory, writes the resource layer and exits 0', () => {
		const fixture = makeImagesetFixture('e2e-first');
		const run = fixture.run(['imageset', 'gen', '--json']);
		expect(run.status).toBe(0);
		const envelope = JSON.parse(run.stdout);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.seeded.map((seed: { file: string }) => seed.file).sort()).toEqual([
			'icon.png',
			'installer-big.png',
			'installer-small.png'
		]);
		expect(envelope.data.targets.length).toBe(8);
		const legacy = envelope.data.targets.find((target: { target: string }) => target.target === 'resources/darwin/code.icns');
		expect(legacy.legacyTypes).toEqual(['info']);
		const map = JSON.parse(readFileSync(join(fixture.patchset.dir, 'delta', 'resources', 'map.json'), 'utf8'));
		expect(map.entries).toHaveLength(8);
		expect(map.entries.every((entry: { owner: string }) => entry.owner === 'product')).toBe(true);
		for (const entry of map.entries) {
			expect(existsSync(join(fixture.patchset.dir, ...entry.source.split('/')))).toBe(true);
		}
	});

	it('delivers through the resource layer: codkit load materialises the regenerated icons', () => {
		const fixture = makeImagesetFixture('e2e-load');
		expect(fixture.run(['imageset', 'gen']).status).toBe(0);
		const regenerated = readFileSync(artifactOf(fixture.patchset.dir, 'resources/win32/code.ico'));
		const load = fixture.run(['load']);
		expect(load.status).toBe(0);
		expect(readFileSync(join(fixture.treeDir, 'resources', 'win32', 'code.ico')).equals(regenerated)).toBe(true);
		const banner = readFileSync(artifactOf(fixture.patchset.dir, 'resources/win32/inno-big-100.bmp'));
		expect(readFileSync(join(fixture.treeDir, 'resources', 'win32', 'inno-big-100.bmp')).equals(banner)).toBe(true);
	});

	it('writes nothing under --dry-run, and says what it would do', () => {
		const fixture = makeImagesetFixture('e2e-dry');
		const run = fixture.run(['imageset', 'gen', '--dry-run']);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain('would seed branding/icon.png');
		expect(run.stdout).toContain('dry run: nothing written');
		expect(existsSync(join(fixture.patchset.dir, 'branding'))).toBe(false);
		expect(existsSync(join(fixture.patchset.dir, 'delta', 'resources', 'map.json'))).toBe(false);
	});

	it('renders a vector master from --branding-dir and skips families it has no master for', () => {
		const fixture = makeImagesetFixture('e2e-vector');
		const brandingDir = join(fixture.patchset.dir, 'artwork');
		mkdirSync(brandingDir, { recursive: true });
		writeFileSync(
			join(brandingDir, 'icon.svg'),
			'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#167abf"/><circle cx="64" cy="64" r="28" fill="#ffffff"/></svg>',
			'utf8'
		);
		const run = fixture.run(['imageset', 'gen', '--branding-dir', brandingDir]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain('rendered icon.svg at 32x32');
		expect(run.stderr).toContain('no installer-big master');
		const map = JSON.parse(readFileSync(join(fixture.patchset.dir, 'delta', 'resources', 'map.json'), 'utf8'));
		expect(map.entries.some((entry: { target: string }) => entry.target === 'resources/win32/code.ico')).toBe(true);
	});

	it('answers the tools question honestly in --help, before any root is required, and lists the subcommands', () => {
		const fixture = makeImagesetFixture('e2e-help');
		const run = fixture.run(['imageset', '--help']);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain('Required tools: none, on every supported OS');
		expect(run.stdout).toContain('@resvg/resvg-js');
		expect(run.stdout).toContain('MPL-2.0');
		expect(run.stdout).not.toContain('optional tools');
		expect(run.stdout).toContain('gen [--dry-run] [--branding-dir <path>]');
		expect(run.stdout).toContain('index [--branding-dir <path>]');
	});

	it('refuses a missing fork tree instead of seeding from nothing', () => {
		const tree = makeImagesetTree('e2e-missing-tree');
		const patchset = makeImagesetPatchSet('e2e-missing-patchset', tree);
		const absentFork = join(makeTempRoot('e2e-missing-fork'), 'absent-tree');
		const run = runCli(patchset.dir, ['--patches-dir', patchset.dir, '--fork-dir', absentFork, 'imageset', 'gen']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('CK-E-CONFIG');
		expect(run.stderr).toContain('does not exist');
	});
});

describe('codkit imageset (the bare namespace)', () => {
	it('never generates: it prints the subcommands and exits 2', () => {
		const fixture = makeImagesetFixture('e2e-namespace');
		const run = fixture.run(['imageset']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain("'imageset' is a namespace and does nothing by itself");
		expect(run.stderr).toContain('available: imageset gen, imageset index');
		expect(existsSync(join(fixture.patchset.dir, 'branding'))).toBe(false);
		expect(existsSync(join(fixture.patchset.dir, 'delta', 'resources'))).toBe(false);
	});

	it('sends --help on a subcommand to the one help the family has', () => {
		const fixture = makeImagesetFixture('e2e-namespace-subhelp');
		const run = fixture.run(['imageset', 'gen', '--help']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('run codkit imageset --help');
	});

	it('refuses an unknown subcommand the same way', () => {
		const fixture = makeImagesetFixture('e2e-namespace-unknown');
		const run = fixture.run(['imageset', 'regenerate']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('unknown subcommand: regenerate');
	});
});

describe('codkit imageset index', () => {
	it('reports an unseeded set as missing, names the seeding command, writes nothing and exits 0', () => {
		const fixture = makeImagesetFixture('e2e-index-absent');
		const run = fixture.run(['imageset', 'index']);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain('# Icon set index');
		expect(run.stdout).toContain('codkit imageset gen');
		expect(run.stdout).toContain('`missing`');
		expect(run.stdout).not.toContain('`generated`');
		expect(existsSync(join(fixture.patchset.dir, 'branding'))).toBe(false);
	});

	it('flips exactly one line when a hand-made per-size master appears', () => {
		const fixture = makeImagesetFixture('e2e-index-flip');
		expect(fixture.run(['imageset', 'gen']).status).toBe(0);
		const before = fixture.run(['imageset', 'index']);
		expect(before.status).toBe(0);
		expect(before.stdout).toContain('| 16x16 | - | `generated` | resampled to this size from `icon.png` |');
		writeFileSync(join(fixture.patchset.dir, 'branding', 'icon-16.png'), sixteenPng());
		const after = fixture.run(['imageset', 'index']);
		expect(after.status).toBe(0);
		const beforeLines = before.stdout.split('\n');
		const changed = after.stdout.split('\n').filter((line, at) => line !== beforeLines[at]);
		// Exactly one line of the PER-SIZE table flips. The other differences
		// are the same one fact counted again - the master inventory, the row
		// of the family summary, and the totals - and every one of them is
		// obliged to move, because a count that did not change when a source
		// changed would be the defect. Naming the exact list here, rather than
		// a number, is what stops a future change hiding a second flip behind
		// those counts.
		expect(changed).toEqual([
			'Present: `icon-16.png`, `icon.png`, `installer-big.png`, `installer-small.png`.',
			'| `icon` | 1 | 1 | 6 | 0 |',
			'| 16x16 | - | `master` | `icon-16.png`, used verbatim |',
			'- from a hand-made master: 1',
			'- generated from a base master: 9'
		]);
	});

	it('carries the same per-size sources in the --json envelope', () => {
		const fixture = makeImagesetFixture('e2e-index-json');
		expect(fixture.run(['imageset', 'gen']).status).toBe(0);
		const run = fixture.run(['imageset', 'index', '--json']);
		expect(run.status).toBe(0);
		const envelope = JSON.parse(run.stdout);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.totals).toEqual({ master: 0, generated: 10, missing: 0 });
		const ico = envelope.data.targets.find((target: { target: string }) => target.target === 'resources/win32/code.ico');
		expect(ico.role).toContain('Windows');
		expect(ico.sizes.map((size: { source: string }) => size.source)).toEqual(['generated', 'generated']);
		// The Markdown is not printed to stdout in --json mode; the envelope is.
		expect(run.stdout).not.toContain('# Icon set index');
	});
});

/** A 16x16 hand-made master, encoded by the production PNG encoder. */
function sixteenPng(): Uint8Array {
	const data = new Uint8Array(16 * 16 * 4);
	for (let at = 0; at < data.length; at += 4) {
		data[at] = 10;
		data[at + 1] = 190;
		data[at + 2] = 120;
		data[at + 3] = 255;
	}
	return encodePng({ width: 16, height: 16, data });
}
