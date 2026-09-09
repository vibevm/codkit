// The whole brand surface, not just the application icon: how a target names
// its family and its artwork (modules/vscode/PROP-006 ##IMAGESET-ARTWORK), how masters are
// found under a family folder (##IMAGESET-MASTERS), and how a vector target
// is delivered without being rasterised (##IMAGESET-SVG-PASSTHROUGH).
//
// The fixture tree used here is the extended one: a file type present on both
// platforms, one present on macOS alone, the web client's icons and a vector
// watermark - so the family/artwork split is exercised against a set that
// actually has a family with more than one drawing in it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { guardTestId, runImageset } from '../../src/lib/imagesetEngine.ts';
import { buildImagesetIndex } from '../../src/lib/imagesetIndex.ts';
import { chooseMaster, ignoredMasterFiles, inBranding, seedMasters } from '../../src/lib/imagesetMasters.ts';
import { artworkKey, discoverTargets } from '../../src/lib/imagesetTargets.ts';
import { loadResourceMap } from '../../src/lib/layers/resource.ts';
import { makeImagesetPatchSet, makeImagesetTree, shippedIconBytes } from '../support/imagesetFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

const silent = () => {};

/** The extended fixture tree and its discovered targets, keyed by path. */
function extendedTree(label: string) {
	const tree = makeImagesetTree(label, { extended: true });
	const targets = discoverTargets(tree.dir, silent);
	return { tree, targets, byPath: new Map(targets.map((target) => [target.target, target])) };
}

/** A full run against the extended tree, with reports captured. */
function run(label: string, options: { readonly brandingDir?: string; readonly dryRun?: boolean } = {}) {
	const tree = makeImagesetTree(`${label}-tree`, { extended: true });
	const patchset = makeImagesetPatchSet(`${label}-patchset`, tree);
	const info: string[] = [];
	const warnings: string[] = [];
	const brandingDir = options.brandingDir ?? join(patchset.dir, 'branding');
	const result = runImageset({
		patchesDir: patchset.dir,
		treeDir: tree.dir,
		brandingDir,
		pin: tree.pin,
		dryRun: options.dryRun ?? false,
		onInfo: (text) => info.push(text),
		onWarn: (text) => warnings.push(text)
	});
	return { tree, patchset, brandingDir, info, warnings, ...result };
}

describe('family and artwork', () => {
	it('splits the family from the drawing it wants', () => {
		const { byPath } = extendedTree('families-split');
		const icon = byPath.get('resources/win32/code.ico');
		const json = byPath.get('resources/win32/json.ico');
		expect(icon).toMatchObject({ family: 'icon', artwork: null });
		expect(json).toMatchObject({ family: 'filetype', artwork: 'json' });
		expect(artworkKey(icon!)).toBe('icon');
		expect(artworkKey(json!)).toBe('filetype/json');
	});

	it('keeps the application icon out of the file types the same glob would match', () => {
		const { targets } = extendedTree('families-exclusion');
		const filetypes = targets.filter((target) => target.family === 'filetype').map((target) => target.target);
		expect(filetypes).not.toContain('resources/win32/code.ico');
		expect(filetypes).not.toContain('resources/darwin/code.icns');
		// One file claimed twice would mean two map entries for one path, so
		// the exclusion is what keeps the resource map single-valued.
		expect(new Set(targets.map((target) => target.target)).size).toBe(targets.length);
	});

	it('carries a drawing that only one platform ships', () => {
		const { targets } = extendedTree('families-asymmetric');
		const artworks = new Set(targets.filter((target) => target.family === 'filetype').map((target) => target.artwork));
		expect([...artworks].sort()).toEqual(['json', 'yaml']);
		const yaml = targets.filter((target) => target.artwork === 'yaml').map((target) => target.target);
		expect(yaml).toEqual(['resources/darwin/yaml.icns']);
	});

	it('names a vector watermark by its theme, without repeating the family', () => {
		const { byPath } = extendedTree('families-letterpress');
		const dark = byPath.get('src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg');
		expect(dark).toMatchObject({ family: 'letterpress', artwork: 'dark', kind: 'svg' });
		expect(artworkKey(dark!)).toBe('letterpress/dark');
		expect(dark?.frames).toEqual([{ width: 64, height: 64, type: null, pngCapable: false }]);
	});

	it('gives every target of a family the one guard id of that family', () => {
		const { targets } = extendedTree('families-guard');
		const filetypes = targets.filter((target) => target.family === 'filetype');
		expect(filetypes.length).toBeGreaterThan(1);
		expect(new Set(filetypes.map((target) => guardTestId(target.family)))).toEqual(new Set(['guard.brand.filetype']));
	});
});

describe('masters under a family folder', () => {
	it('looks the artwork up inside its family directory', () => {
		const brandingDir = makeTempRoot('families-master-lookup');
		mkdirSync(join(brandingDir, 'filetype'), { recursive: true });
		writeFileSync(join(brandingDir, 'filetype', 'json.svg'), 'vector');
		expect(chooseMaster(brandingDir, 'filetype/json', 64, 64)).toEqual({ origin: 'vector', file: 'filetype/json.svg' });
		expect(chooseMaster(brandingDir, 'filetype/yaml', 64, 64)).toBeNull();
	});

	it('takes a per-size override inside the family directory too', () => {
		const brandingDir = makeTempRoot('families-master-override');
		mkdirSync(join(brandingDir, 'filetype'), { recursive: true });
		writeFileSync(join(brandingDir, 'filetype', 'json.svg'), 'vector');
		writeFileSync(join(brandingDir, 'filetype', 'json-16.png'), 'override');
		expect(chooseMaster(brandingDir, 'filetype/json', 16, 16)).toEqual({ origin: 'override', file: 'filetype/json-16.png' });
		expect(chooseMaster(brandingDir, 'filetype/json', 32, 32)?.origin).toBe('vector');
	});

	it('walks subdirectories before calling a file unknown', () => {
		const brandingDir = makeTempRoot('families-master-ignored');
		mkdirSync(join(brandingDir, 'filetype'), { recursive: true });
		for (const name of ['icon.svg', 'filetype/json.svg', 'filetype/json-16.png', 'filetype/sketch.txt', 'notes.md']) {
			writeFileSync(inBranding(brandingDir, name), 'x');
		}
		expect(ignoredMasterFiles(brandingDir, ['icon', 'filetype/json'])).toEqual(['filetype/sketch.txt', 'notes.md']);
	});
});

describe('seeding the whole surface', () => {
	it('seeds one master per drawing, into the family directory', () => {
		const { tree, targets } = extendedTree('families-seed');
		const brandingDir = join(makeTempRoot('families-seed-branding'), 'branding');
		const seeded = seedMasters(brandingDir, tree.dir, targets);
		const files = seeded.map((seed) => seed.file).sort();
		expect(files).toContain('filetype/json.png');
		expect(files).toContain('filetype/yaml.png');
		expect(files).toContain('icon.png');
		// Every seeded file is exactly the master the next run will look for.
		for (const seed of seeded) {
			const key = seed.file.replace(/\.(png|svg)$/, '');
			expect(chooseMaster(brandingDir, key, 1, 1)).not.toBeNull();
		}
	});

	it('seeds a vector family as a vector, verbatim', () => {
		const { tree, targets } = extendedTree('families-seed-vector');
		const brandingDir = join(makeTempRoot('families-seed-vector-branding'), 'branding');
		const seeded = seedMasters(brandingDir, tree.dir, targets);
		expect(seeded.map((seed) => seed.file)).toContain('letterpress/dark.svg');
		expect(readFileSync(inBranding(brandingDir, 'letterpress/dark.svg'))).toEqual(
			readFileSync(join(tree.dir, 'src', 'vs', 'workbench', 'browser', 'parts', 'editor', 'media', 'letterpress-dark.svg'))
		);
	});
});

describe('vector targets are delivered, not rendered', () => {
	it('emits the master unchanged and says so', () => {
		const outcome = run('families-passthrough');
		const target = 'src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg';
		const artifact = join(outcome.patchset.dir, 'delta', 'resources', 'files', ...target.split('/'));
		expect(readFileSync(artifact)).toEqual(readFileSync(inBranding(outcome.brandingDir, 'letterpress/dark.svg')));
		expect(outcome.info.some((line) => line.includes('emitted letterpress/dark.svg unchanged'))).toBe(true);
	});

	it('gives the vector target the guard of its own family', () => {
		const outcome = run('families-vector-entry');
		const map = loadResourceMap(outcome.patchset.dir);
		const entry = map?.entries.find((candidate) => candidate.target.endsWith('letterpress-dark.svg'));
		expect(entry?.contractTests).toEqual(['guard.brand.letterpress']);
	});

	it('refuses a raster master instead of rasterising one', () => {
		const brandingDir = makeTempRoot('families-vector-raster');
		mkdirSync(join(brandingDir, 'letterpress'), { recursive: true });
		writeFileSync(inBranding(brandingDir, 'letterpress/dark.png'), shippedIconBytes('code.png'));
		const outcome = run('families-vector-raster-run', { brandingDir });
		expect(outcome.warnings.some((line) => line.includes('is a vector target and needs letterpress/dark.svg'))).toBe(true);
		expect(outcome.exitCode).toBe(1);
	});

	it('refuses a master drawn at the wrong size', () => {
		const brandingDir = makeTempRoot('families-vector-size');
		mkdirSync(join(brandingDir, 'letterpress'), { recursive: true });
		writeFileSync(inBranding(brandingDir, 'letterpress/dark.svg'), '<svg width="80" height="80" viewBox="0 0 80 80"></svg>\n');
		const outcome = run('families-vector-size-run', { brandingDir });
		expect(outcome.warnings.some((line) => line.includes('is 80x80 but') && line.includes('ships 64x64'))).toBe(true);
		expect(outcome.exitCode).toBe(1);
	});
});

describe('the index summarises by family', () => {
	it('counts drawings and sources per family, and the counts add up', () => {
		const { tree } = extendedTree('families-index');
		const brandingDir = join(makeTempRoot('families-index-branding'), 'branding');
		const index = buildImagesetIndex({ treeDir: tree.dir, brandingDir, onReport: silent });
		const families = new Map(index.byFamily.map((entry) => [entry.family, entry]));
		expect([...families.keys()].sort()).toEqual(['filetype', 'icon', 'installer-big', 'installer-small', 'letterpress']);
		expect(families.get('filetype')?.artworks).toBe(2);
		expect(families.get('letterpress')?.artworks).toBe(1);
		const summed = index.byFamily.reduce(
			(total, entry) => ({
				master: total.master + entry.totals.master,
				generated: total.generated + entry.totals.generated,
				missing: total.missing + entry.totals.missing
			}),
			{ master: 0, generated: 0, missing: 0 }
		);
		expect(summed).toEqual(index.totals);
	});
});
