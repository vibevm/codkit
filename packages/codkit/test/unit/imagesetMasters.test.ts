// imageset master discovery: the naming convention, the per-size override
// priority, ignored files, and seeding (PROP-007 ##IMAGESET-MASTERS).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chooseMaster, defaultBrandingDir, ignoredMasterFiles, seedMasters } from '../../src/lib/imagesetMasters.ts';
import { discoverTargets } from '../../src/lib/imagesetTargets.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { makeImagesetTree, shippedIconBytes } from '../support/imagesetFixture.ts';

afterAll(() => {
	cleanupTempRoots();
});

describe('chooseMaster', () => {
	it('prefers the exact-size override, then the vector, then the raster master', () => {
		const brandingDir = makeTempRoot('masters-priority');
		writeFileSync(join(brandingDir, 'icon.png'), 'raster');
		writeFileSync(join(brandingDir, 'icon.svg'), 'vector');
		expect(chooseMaster(brandingDir, 'icon', 256, 256)?.origin).toBe('vector');
		writeFileSync(join(brandingDir, 'icon-256.png'), 'override');
		expect(chooseMaster(brandingDir, 'icon', 256, 256)).toEqual({ origin: 'override', file: 'icon-256.png' });
		expect(chooseMaster(brandingDir, 'icon', 128, 128)?.origin).toBe('vector');
	});

	it('uses the WxH spelling for non-square sizes', () => {
		const brandingDir = makeTempRoot('masters-nonsquare');
		writeFileSync(join(brandingDir, 'installer-big-40x20.png'), 'override');
		expect(chooseMaster(brandingDir, 'installer-big', 40, 20)).toEqual({ origin: 'override', file: 'installer-big-40x20.png' });
	});

	it('falls back to the raster master when no vector exists', () => {
		const brandingDir = makeTempRoot('masters-raster');
		writeFileSync(join(brandingDir, 'installer-small.png'), 'raster');
		expect(chooseMaster(brandingDir, 'installer-small', 12, 12)).toEqual({ origin: 'raster', file: 'installer-small.png' });
	});

	it('reports no master when the family has none', () => {
		const brandingDir = makeTempRoot('masters-empty');
		mkdirSync(brandingDir, { recursive: true });
		expect(chooseMaster(brandingDir, 'icon', 16, 16)).toBeNull();
	});

	it('derives the default branding directory from the patchset root', () => {
		expect(defaultBrandingDir('/tmp/x/patchset')).toBe(join('/tmp/x/patchset', 'branding'));
	});
});

describe('ignoredMasterFiles', () => {
	it('names files the convention does not know', () => {
		const brandingDir = makeTempRoot('masters-ignored');
		for (const name of ['icon.svg', 'icon-16.png', 'installer-big-40x20.png', 'notes.txt', 'logo.png']) {
			writeFileSync(join(brandingDir, name), 'x');
		}
		expect(ignoredMasterFiles(brandingDir, ['icon', 'installer-big'])).toEqual(['logo.png', 'notes.txt']);
	});
});

describe('seedMasters', () => {
	it('creates the directory and seeds it from the tree, reporting sources', () => {
		const tree = makeImagesetTree('masters-seed');
		const targets = discoverTargets(tree.dir, () => {});
		const brandingDir = join(makeTempRoot('masters-seed-branding'), 'branding');
		const seeded = seedMasters(brandingDir, tree.dir, targets);
		expect(existsSync(brandingDir)).toBe(true);
		const byFile = new Map(seeded.map((seed) => [seed.file, seed]));
		// The largest icon raster the fixture tree offers is the 128x128 ic07
		// element of the icns, whose payload is written out verbatim.
		expect(byFile.get('icon.png')?.width).toBe(128);
		expect(byFile.get('icon.png')?.from).toContain('code.icns');
		const iconPng = join(brandingDir, 'icon.png');
		// ic07 payload of the fixture icns, verbatim.
		expect(Buffer.compare(readFileSync(iconPng), elementPayload(shippedIconBytes('code.icns'), 1))).toBe(0);
		expect(byFile.get('installer-big.png')?.from).toContain('inno-big-125.bmp');
		expect(byFile.get('installer-small.png')?.from).toContain('inno-small-100.bmp');
	});

	it('never touches an existing directory', () => {
		const tree = makeImagesetTree('masters-exists');
		const targets = discoverTargets(tree.dir, () => {});
		const brandingDir = join(makeTempRoot('masters-exists-branding'), 'branding');
		mkdirSync(brandingDir, { recursive: true });
		writeFileSync(join(brandingDir, 'keep-me'), 'operator content');
		expect(seedMasters(brandingDir, tree.dir, targets)).toEqual([]);
		expect(readFileSync(join(brandingDir, 'keep-me'), 'utf8')).toBe('operator content');
	});

	it('plans without writing under a dry run', () => {
		const tree = makeImagesetTree('masters-dry');
		const targets = discoverTargets(tree.dir, () => {});
		const brandingDir = join(makeTempRoot('masters-dry-branding'), 'branding');
		const seeded = seedMasters(brandingDir, tree.dir, targets, true);
		expect(seeded.length).toBeGreaterThan(0);
		expect(existsSync(brandingDir)).toBe(false);
	});
});
/** The payload of the n-th element of an icns file, header included. */
function elementPayload(bytes: Buffer, index: number): Buffer {
	let at = 8;
	for (let seen = 0; seen < index; seen += 1) {
		at += bytes.readUInt32BE(at + 4);
	}
	const length = bytes.readUInt32BE(at + 4);
	return bytes.subarray(at + 8, at + length);
}
