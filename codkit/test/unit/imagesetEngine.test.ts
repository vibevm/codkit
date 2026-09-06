// The imageset engine on the fixture pair: seeding, the resource-map update,
// refusal before the first write, per-size overrides - and the round-trip
// acceptance of PROP-007 ##IMAGESET-ROUND-TRIP: the regenerated containers
// are compared structurally against the COMMITTED shipped binaries (written
// by a foreign encoder), never against a file this pipeline just wrote.
//
// The mutation proof lives against exactly the structural assertions below:
// corrupt an encoder (drop a frame, shift a dimension, skip an element type)
// and these comparisons go red, because the expectation side is a fixed
// committed binary.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { brandArtifactId, guardTestId, runImageset } from '../../src/lib/imagesetEngine.ts';
import { decodeBmp, parseBmp } from '../../src/lib/imagesetBmp.ts';
import { parseIcns } from '../../src/lib/imagesetIcns.ts';
import { parseIco } from '../../src/lib/imagesetIco.ts';
import { decodePng, encodePng, rgba } from '../../src/lib/imagesetPng.ts';
import { parseXpm } from '../../src/lib/imagesetXpm.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { loadResourceMap } from '../../src/lib/layers/resource.ts';
import { makeImagesetPatchSet, makeImagesetTree, shippedIconBytes } from '../support/imagesetFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

function failure(run: () => unknown): { code: string; message: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return { code: error.code, message: error.message };
		}
		throw error;
	}
	throw new Error('expected the call to fail');
}

/** A run with the default branding directory and captured reports. */
function run(label: string, options: Partial<Parameters<typeof runImageset>[0]> = {}) {
	const tree = makeImagesetTree(`${label}-tree`);
	const patchset = makeImagesetPatchSet(`${label}-patchset`, tree);
	const info: string[] = [];
	const warnings: string[] = [];
	const brandingDir = options.brandingDir ?? join(patchset.dir, 'branding');
	const result = runImageset({
		patchesDir: patchset.dir,
		treeDir: tree.dir,
		brandingDir,
		pin: tree.pin,
		dryRun: false,
		onInfo: (text) => info.push(text),
		onWarn: (text) => warnings.push(text),
		...options
	});
	return { tree, patchset, brandingDir, info, warnings, ...result };
}

const filesRoot = (patchsetDir: string) => join(patchsetDir, 'delta', 'resources', 'files');
const artifactOf = (patchsetDir: string, target: string) => join(filesRoot(patchsetDir), ...target.split('/'));

describe('runImageset', () => {
	it('seeds the branding directory, writes artifacts and map entries, and reports', () => {
		const { exitCode, patchset, info, warnings } = run('engine-first');
		expect(exitCode).toBe(0);
		expect(warnings).toEqual([]);
		expect(info.some((line) => line.startsWith('seeded branding/icon.png'))).toBe(true);
		const map = loadResourceMap(patchset.dir);
		expect(map?.entries.map((entry) => entry.target)).toEqual([
			'resources/darwin/code.icns',
			'resources/linux/code.png',
			'resources/linux/rpm/code.xpm',
			'resources/win32/code.ico',
			'resources/win32/code_70x70.png',
			'resources/win32/inno-big-100.bmp',
			'resources/win32/inno-big-125.bmp',
			'resources/win32/inno-small-100.bmp'
		]);
		const icoEntry = map?.entries.find((entry) => entry.target === 'resources/win32/code.ico');
		expect(icoEntry?.owner).toBe('product');
		expect(icoEntry?.contractTests).toEqual([guardTestId('icon')]);
		expect(icoEntry?.pin).toBe(`t1@${icoEntry?.pin?.split('@')[1]}`);
		expect(icoEntry?.source).toBe('delta/resources/files/resources/win32/code.ico');
		expect(icoEntry?.id).toBe(brandArtifactId('resources/win32/code.ico'));
		for (const entry of map?.entries ?? []) {
			expect(existsSync(join(patchset.dir, ...entry.source.split('/')))).toBe(true);
		}
	});

	it('is deterministic: a second run rewrites byte-identical artifacts', () => {
		const { tree, patchset, brandingDir } = run('engine-twice');
		const before = readFileSync(artifactOf(patchset.dir, 'resources/win32/code.ico'));
		const mapBefore = readFileSync(join(patchset.dir, 'delta', 'resources', 'map.json'));
		const second = runImageset({
			patchesDir: patchset.dir,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun: false,
			onInfo: () => {},
			onWarn: () => {}
		});
		expect(second.exitCode).toBe(0);
		expect(readFileSync(artifactOf(patchset.dir, 'resources/win32/code.ico')).equals(before)).toBe(true);
		expect(readFileSync(join(patchset.dir, 'delta', 'resources', 'map.json')).equals(mapBefore)).toBe(true);
	});

	it('writes nothing under --dry-run, not even the branding directory', () => {
		const tree = makeImagesetTree('engine-dry-tree');
		const patchset = makeImagesetPatchSet('engine-dry-patchset', tree);
		const brandingDir = join(patchset.dir, 'branding');
		const info: string[] = [];
		const outcome = runImageset({
			patchesDir: patchset.dir,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun: true,
			onInfo: (text) => info.push(text),
			onWarn: () => {}
		});
		expect(outcome.exitCode).toBe(0);
		expect(existsSync(brandingDir)).toBe(false);
		expect(existsSync(join(patchset.dir, 'delta', 'resources', 'map.json'))).toBe(false);
		expect(existsSync(filesRoot(patchset.dir))).toBe(false);
		expect(info).toContain('dry run: nothing written');
		expect(info.some((line) => line.startsWith('would seed'))).toBe(true);
	});

	it('refuses new entries without a declared guard, before writing anything', () => {
		const tree = makeImagesetTree('engine-guard-tree');
		const patchset = makeImagesetPatchSet('engine-guard-patchset', tree);
		patchset.withoutGuards();
		const brandingDir = join(patchset.dir, 'branding');
		const verdict = failure(() =>
			runImageset({
				patchesDir: patchset.dir,
				treeDir: tree.dir,
				brandingDir,
				pin: tree.pin,
				dryRun: false,
				onInfo: () => {},
				onWarn: () => {}
			})
		);
		expect(verdict.code).toBe('GUARD-MISSING');
		// The branding directory exists (seeding is a reportable side effect of
		// discovery), but no artifact and no map was written.
		expect(existsSync(filesRoot(patchset.dir))).toBe(false);
		expect(existsSync(join(patchset.dir, 'delta', 'resources', 'map.json'))).toBe(false);
	});

	it('skips families without a master, warns, and exits 1', () => {
		const tree = makeImagesetTree('engine-skip-tree');
		const patchset = makeImagesetPatchSet('engine-skip-patchset', tree);
		const brandingDir = join(patchset.dir, 'branding');
		mkdirSync(brandingDir, { recursive: true });
		writeFileSync(join(brandingDir, 'icon.png'), encodePng(rgba(16, 16, [1, 2, 3, 255])));
		const warnings: string[] = [];
		const outcome = runImageset({
			patchesDir: patchset.dir,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun: false,
			onInfo: () => {},
			onWarn: (text) => warnings.push(text)
		});
		expect(outcome.exitCode).toBe(1);
		expect(warnings.some((line) => line.includes('inno-big-100.bmp') && line.includes('no installer-big master'))).toBe(true);
		const map = loadResourceMap(patchset.dir);
		expect(map?.entries.some((entry) => entry.target === 'resources/win32/code.ico')).toBe(true);
		expect(map?.entries.some((entry) => entry.target.startsWith('resources/win32/inno-'))).toBe(false);
	});

	it('uses a per-size raster override verbatim for exactly that frame', () => {
		const tree = makeImagesetTree('engine-override-tree');
		const patchset = makeImagesetPatchSet('engine-override-patchset', tree);
		const brandingDir = join(patchset.dir, 'branding');
		mkdirSync(brandingDir, { recursive: true });
		const override = rgba(16, 16, [200, 10, 10, 255]);
		writeFileSync(join(brandingDir, 'icon.png'), encodePng(rgba(128, 128, [1, 2, 3, 255])));
		writeFileSync(join(brandingDir, 'icon-16.png'), encodePng(override));
		writeFileSync(join(brandingDir, 'installer-big.png'), encodePng(rgba(40, 20, [1, 2, 3, 255])));
		writeFileSync(join(brandingDir, 'installer-small.png'), encodePng(rgba(12, 12, [1, 2, 3, 255])));
		const info: string[] = [];
		const { exitCode } = runImageset({
			patchesDir: patchset.dir,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun: false,
			onInfo: (text) => info.push(text),
			onWarn: () => {}
		});
		expect(exitCode).toBe(0);
		expect(info.some((line) => line.includes('override icon-16.png verbatim at 16x16'))).toBe(true);
		const regenerated = readFileSync(artifactOf(patchset.dir, 'resources/win32/code.ico'));
		const frames = extractIcoPngFrames(regenerated);
		expect(frames.length).toBe(2);
		const decoded = decodePng(frames[0] ?? new Uint8Array());
		expect([decoded.width, decoded.height]).toEqual([16, 16]);
		expect(decoded.data[0]).toBe(200);
		expect(decoded.data[1]).toBe(10);
	});

	it('reports files in the branding directory that match no convention', () => {
		const tree = makeImagesetTree('engine-ignored-tree');
		const patchset = makeImagesetPatchSet('engine-ignored-patchset', tree);
		const brandingDir = join(patchset.dir, 'branding');
		mkdirSync(brandingDir, { recursive: true });
		writeFileSync(join(brandingDir, 'icon.png'), encodePng(rgba(16, 16, [1, 2, 3, 255])));
		writeFileSync(join(brandingDir, 'sketch.jpeg'), 'not a master');
		const warnings: string[] = [];
		runImageset({
			patchesDir: patchset.dir,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun: false,
			onInfo: () => {},
			onWarn: (text) => warnings.push(text)
		});
		expect(warnings.some((line) => line.includes('sketch.jpeg'))).toBe(true);
	});
});

describe('round trip against the shipped binaries (IMAGESET-ROUND-TRIP)', () => {
	it('reproduces each container structure exactly, frame for frame', () => {
		const { patchset } = run('engine-roundtrip');
		// ICO: same frame count, same sizes, same order as the shipped file.
		const shippedIco = parseIco(shippedIconBytes('code.ico'));
		const oursIco = parseIco(readFileSync(artifactOf(patchset.dir, 'resources/win32/code.ico')));
		expect(oursIco.frames).toEqual(shippedIco.frames);
		// ICNS: the PNG-capable elements at the same types and sizes, in order;
		// the legacy chunk is carried in the report, not in the file.
		const shippedIcns = parseIcns(shippedIconBytes('code.icns'));
		const oursIcns = parseIcns(readFileSync(artifactOf(patchset.dir, 'resources/darwin/code.icns')));
		expect(oursIcns.elements.map((element) => [element.type, element.width, element.height])).toEqual(
			shippedIcns.elements.filter((element) => element.pngCapable).map((element) => [element.type, element.width, element.height])
		);
		expect(oursIcns.legacyTypes).toEqual([]);
		// XPM, PNG, BMP: same dimensions as shipped.
		expect(parseXpm(readFileSync(artifactOf(patchset.dir, 'resources/linux/rpm/code.xpm'), 'utf8')).width).toBe(
			parseXpm(shippedIconBytes('code.xpm').toString('utf8')).width
		);
		expect(decodePng(readFileSync(artifactOf(patchset.dir, 'resources/linux/code.png'))).width).toBe(
			decodePng(shippedIconBytes('code.png')).width
		);
		expect(parseBmp(readFileSync(artifactOf(patchset.dir, 'resources/win32/inno-big-100.bmp')))).toEqual(
			parseBmp(shippedIconBytes('inno-big-100.bmp'))
		);
	});

	it('carries the artwork within the measured tolerance bands', () => {
		const { patchset } = run('engine-pixels');
		// Every reference below is a committed fixture binary written by the
		// foreign generator, at the same size as the regenerated image.
		const oursIcns = parseIcns(readFileSync(artifactOf(patchset.dir, 'resources/darwin/code.icns')));
		const shippedIcns = parseIcns(shippedIconBytes('code.icns'));
		const ours32 = icnsPayload(readFileSync(artifactOf(patchset.dir, 'resources/darwin/code.icns')), 'ic11');
		const shipped32 = icnsPayload(shippedIconBytes('code.icns'), 'ic11');
		expect(oursIcns.elements.map((element) => element.type)).toContain('ic11');
		expect(shippedIcns.elements.map((element) => element.type)).toContain('ic11');
		// 32x32 band: the shipped layer and the resampled master differ by
		// resampling only; the measured round trip on the real distribution
		// gives ~15/255 in this band, the fixture stays well under it.
		expect(meanDifference(decodePng(ours32), decodePng(shipped32))).toBeLessThanOrEqual(40);
		// 64x64 band, through the palette-encoded shipped PNG.
		const ours64 = decodePng(readFileSync(artifactOf(patchset.dir, 'resources/linux/code.png')));
		const shipped64 = decodePng(shippedIconBytes('code.png'));
		expect(meanDifference(ours64, shipped64)).toBeLessThanOrEqual(20);
		// Installer art resampled one scale step down from the seeded master.
		const oursBanner = decodeBmpBytes(readFileSync(artifactOf(patchset.dir, 'resources/win32/inno-big-100.bmp')));
		const shippedBanner = decodeBmpBytes(shippedIconBytes('inno-big-100.bmp'));
		expect(meanDifference(oursBanner, shippedBanner)).toBeLessThanOrEqual(20);
	});
});

/** PNG payloads of an .ico written by our encoder (every frame is a PNG). */
function extractIcoPngFrames(bytes: Uint8Array): Uint8Array[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint16(4, true);
	const frames: Uint8Array[] = [];
	for (let index = 0; index < count; index += 1) {
		const at = 6 + index * 16;
		const size = view.getUint32(at + 8, true);
		const offset = view.getUint32(at + 12, true);
		frames.push(bytes.subarray(offset, offset + size));
	}
	return frames;
}

function meanDifference(
	left: { width: number; height: number; data: Uint8Array },
	right: { width: number; height: number; data: Uint8Array }
): number {
	if (left.width !== right.width || left.height !== right.height) {
		return Number.POSITIVE_INFINITY;
	}
	let total = 0;
	for (let at = 0; at < left.data.length; at += 4) {
		total += Math.abs((left.data[at] ?? 0) - (right.data[at] ?? 0));
		total += Math.abs((left.data[at + 1] ?? 0) - (right.data[at + 1] ?? 0));
		total += Math.abs((left.data[at + 2] ?? 0) - (right.data[at + 2] ?? 0));
	}
	return total / (left.width * left.height * 3);
}

/** The payload of one element type of an .icns. */
function icnsPayload(bytes: Uint8Array, type: string): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let at = 8;
	while (at + 8 <= bytes.length) {
		const length = view.getUint32(at + 4);
		const current = String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
		if (current === type) {
			return bytes.subarray(at + 8, at + length);
		}
		at += length;
	}
	throw new Error(`no ${type} element in the icns`);
}

/** 24-bit BMP to RGBA through the production decoder (seeding path). */
function decodeBmpBytes(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
	return decodeBmp(bytes);
}
