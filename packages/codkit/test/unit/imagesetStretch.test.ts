// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the
// banners and icons below are that family's targets.
// A vector master whose aspect is not the frame's (PROP-007
// ##IMAGESET-STRETCH-REPORTED): the frame is still produced at the exact
// size, and every report of it - gen, its dry run and the index - says it is
// stretched and by how much, from the rasteriser's own reading of the master.
//
// The polygon's large installer banners are 32x16 and 40x20. A 100x55 banner
// master comes out of the rasteriser at 32x18 and 40x22 and is resampled to the
// frame, which stretches the drawing by |16*100 / (32*55) - 1| = 9.1% at both
// sizes. A square icon master fits every square frame exactly, and a raster
// master is not assessed at all.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePng, rgba } from '@codkit/type-api';
import type { ProjectType } from '@codkit/type-api';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { runImageset } from '../../src/lib/imagesetEngine.ts';
import type { ImagesetReport } from '../../src/lib/imagesetEngine.ts';
import { buildImagesetIndex, indexData, renderImagesetIndex } from '../../src/lib/imagesetIndex.ts';
import { renderSvgToRgba, stretchOf, vectorMasterSize } from '../../src/lib/imagesetRender.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { makeImagesetPatchSet, makeImagesetTree } from '../support/imagesetFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const BANNER_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="55"><rect width="100" height="55" fill="#167abf"/><circle cx="50" cy="27.5" r="20" fill="#ffffff"/></svg>';
const ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#167abf"/><circle cx="64" cy="64" r="28" fill="#ffffff"/></svg>';

const STRETCHED_100 = "rendered installer-big.svg at 32x16, stretched 9.1% from the master's aspect";
const STRETCHED_125 = "rendered installer-big.svg at 40x20, stretched 9.1% from the master's aspect";

/** The polygon with a vector banner, a vector icon and a raster small banner. */
function stretchPolygon(label: string) {
	const tree = makeImagesetTree(`${label}-tree`);
	const patchset = makeImagesetPatchSet(`${label}-patchset`, tree);
	const brandingDir = join(patchset.dir, 'branding');
	mkdirSync(brandingDir, { recursive: true });
	writeFileSync(join(brandingDir, 'installer-big.svg'), BANNER_SVG, 'utf8');
	writeFileSync(join(brandingDir, 'icon.svg'), ICON_SVG, 'utf8');
	writeFileSync(join(brandingDir, 'installer-small.png'), encodePng(rgba(12, 12, [200, 30, 30, 255])));
	const run = (dryRun: boolean) => {
		const info: string[] = [];
		const warnings: string[] = [];
		const result = runImageset({
			patchesDir: patchset.dir,
			type: vscodeType,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun,
			onInfo: (text) => info.push(text),
			onWarn: (text) => warnings.push(text)
		});
		return { info, warnings, ...result };
	};
	return { tree, patchset, brandingDir, run };
}

const framesOf = (report: ImagesetReport, target: string) => report.targets.find((candidate) => candidate.target === target)?.frames;

describe('the measure of a stretch', () => {
	it('is |H*w / (W*h) - 1| as a percentage rounded to one decimal', () => {
		expect(stretchOf({ width: 400, height: 800 }, 164, 314)).toEqual({
			master: { width: 400, height: 800 },
			percent: 4.3,
			stretched: true
		});
		// A 1:2 master over the seven sizes of a distribution's large installer
		// banner: every one of them is stretched, the worst by 7.9%.
		const sizes = [
			[164, 314],
			[192, 386],
			[246, 459],
			[273, 556],
			[328, 604],
			[355, 700],
			[410, 797]
		] as const;
		expect(sizes.map(([width, height]) => stretchOf({ width: 400, height: 800 }, width, height).percent)).toEqual([
			4.3, 0.5, 6.7, 1.8, 7.9, 1.4, 2.8
		]);
	});

	it('calls a frame stretched from 0.1% up, and a matching aspect not stretched at all', () => {
		expect(stretchOf({ width: 400, height: 800 }, 164, 328)).toEqual({ master: { width: 400, height: 800 }, percent: 0, stretched: false });
		// 0.05% rounds to 0.0 and is no stretch; 0.15% rounds to 0.1 and is one.
		expect(stretchOf({ width: 1000, height: 2001 }, 500, 1000).stretched).toBe(false);
		expect(stretchOf({ width: 1000, height: 2003 }, 500, 1000)).toMatchObject({ percent: 0.1, stretched: true });
	});
});

describe("the master's size is the rasteriser's own reading", () => {
	it('keeps a fractional size, so a master that fits its frame exactly is not reported stretched', () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32.5" height="65"><rect width="32.5" height="65" fill="#167abf"/></svg>';
		// Rounded to whole pixels this master would read 33x65 and report 1.5%.
		expect(vectorMasterSize(svg)).toEqual({ width: 32.5, height: 65 });
		const rendered = renderSvgToRgba(svg, 164, 328);
		expect([rendered.image.width, rendered.image.height]).toEqual([164, 328]);
		expect(rendered.stretch).toEqual({ master: { width: 32.5, height: 65 }, percent: 0, stretched: false });
	});

	it('resolves the document the way the render does, not the way a second reader would', () => {
		// No height and a 0 0 400 800 viewBox: a 200x800 drawing to the
		// rasteriser, which renders it 164x656 - not the 400x800 of the viewBox.
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" width="200" viewBox="0 0 400 800"><rect width="400" height="800" fill="#167abf"/></svg>';
		expect(vectorMasterSize(svg)).toEqual({ width: 200, height: 800 });
		expect(renderSvgToRgba(svg, 164, 656).stretch.stretched).toBe(false);
	});

	it('gives the render and the prediction one and the same figure', () => {
		const rendered = renderSvgToRgba(BANNER_SVG, 32, 16);
		expect([rendered.image.width, rendered.image.height]).toEqual([32, 16]);
		expect(rendered.stretch).toEqual(stretchOf(vectorMasterSize(BANNER_SVG), 32, 16));
		expect(rendered.stretch).toEqual({ master: { width: 100, height: 55 }, percent: 9.1, stretched: true });
	});
});

describe('gen reports a stretched vector frame', () => {
	it('names the stretch in the origin of the frame and in its fields', () => {
		const { run } = stretchPolygon('stretch-gen');
		const outcome = run(false);
		expect(outcome.exitCode).toBe(0);
		expect(framesOf(outcome.report, 'resources/win32/inno-big-100.bmp')).toEqual([
			{
				width: 32,
				height: 16,
				source: STRETCHED_100,
				stretch: { master: { width: 100, height: 55 }, percent: 9.1, stretched: true },
				reduced: false
			}
		]);
		expect(framesOf(outcome.report, 'resources/win32/inno-big-125.bmp')).toEqual([
			{
				width: 40,
				height: 20,
				source: STRETCHED_125,
				stretch: { master: { width: 100, height: 55 }, percent: 9.1, stretched: true },
				reduced: false
			}
		]);
		expect(outcome.info).toContain(`regenerated resources/win32/inno-big-100.bmp: 32x16 (${STRETCHED_100})`);
	});

	it('prints one warning line per stretched frame, naming the size of the master', () => {
		const { run } = stretchPolygon('stretch-warn');
		const outcome = run(false);
		expect(outcome.warnings).toEqual([
			`resources/win32/inno-big-100.bmp: ${STRETCHED_100} (the master is 100x55)`,
			`resources/win32/inno-big-125.bmp: ${STRETCHED_125} (the master is 100x55)`
		]);
	});

	it('reports a frame the vector master fits without a word about a stretch', () => {
		const { run } = stretchPolygon('stretch-fit');
		const outcome = run(false);
		const ico = framesOf(outcome.report, 'resources/win32/code.ico') ?? [];
		expect(ico.length).toBeGreaterThan(0);
		for (const frame of ico) {
			expect(frame.source).toBe(`rendered icon.svg at ${frame.width}x${frame.height}`);
			expect(frame.stretch).toEqual({ master: { width: 128, height: 128 }, percent: 0, stretched: false });
		}
		// A raster master is not measured: it says `resampled` already.
		expect(framesOf(outcome.report, 'resources/win32/inno-small-100.bmp')).toEqual([
			{ width: 12, height: 12, source: 'resampled installer-small.png to 12x12', stretch: null, reduced: false }
		]);
		expect(outcome.warnings.some((line) => line.includes('icon.svg') || line.includes('installer-small'))).toBe(false);
	});
});

describe('gen --dry-run predicts the stretch without rendering', () => {
	it('states every frame exactly as the run then reports it, and warns the same way', () => {
		const { run, patchset } = stretchPolygon('stretch-dry');
		const plan = run(true);
		expect(existsSync(join(patchset.dir, 'delta', 'resources'))).toBe(false);
		expect(plan.info).toContain(`  32x16: ${STRETCHED_100}`);
		const performed = run(false);
		const framesByTarget = (report: ImagesetReport) => report.targets.map((target) => ({ target: target.target, frames: target.frames }));
		expect(framesByTarget(plan.report)).toEqual(framesByTarget(performed.report));
		expect(plan.warnings).toEqual(performed.warnings);
	});

	it('measures a master the plan has yet to seed from the bytes the seeding would write', () => {
		// A family whose vector file is larger than its raster file seeds a
		// vector master, and the raster target is then rendered from it.
		const tree = makeImagesetTree('stretch-seed-tree');
		mkdirSync(join(tree.dir, 'resources', 'art'), { recursive: true });
		writeFileSync(join(tree.dir, 'resources', 'art', 'mark.svg'), BANNER_SVG, 'utf8');
		writeFileSync(join(tree.dir, 'resources', 'art', 'mark.png'), encodePng(rgba(32, 16, [22, 122, 191, 255])));
		const sha = fixtureCommit(tree.dir, 'fixture: a family with a vector and a raster file', '2026-09-06T00:02:00Z');
		const patchset = makeImagesetPatchSet('stretch-seed-patchset', tree);
		const codecs = vscodeType.brandImages?.codecs ?? [];
		const type: ProjectType = {
			...vscodeType,
			brandImages: {
				codecs,
				familyNotes: [],
				targets: [
					{ family: 'letterpress', path: 'resources/art/mark.svg', glob: false, kind: 'svg', role: 'a vector file of the family' },
					{ family: 'letterpress', path: 'resources/art/mark.png', glob: false, kind: 'png', role: 'a raster file of the family' }
				]
			}
		};
		const brandingDir = join(makeTempRoot('stretch-seed-branding'), 'branding');
		const runOnce = (dryRun: boolean) => {
			const warnings: string[] = [];
			const result = runImageset({
				patchesDir: patchset.dir,
				type,
				treeDir: tree.dir,
				brandingDir,
				pin: { ...tree.pin, sha },
				dryRun,
				onInfo: () => {},
				onWarn: (text) => warnings.push(text)
			});
			return { warnings, ...result };
		};
		const plan = runOnce(true);
		expect(existsSync(brandingDir)).toBe(false);
		expect(plan.report.seeded.map((seed) => seed.file)).toEqual(['letterpress.svg']);
		const planned = framesOf(plan.report, 'resources/art/mark.png');
		expect(planned).toEqual([
			{
				width: 32,
				height: 16,
				source: "rendered letterpress.svg at 32x16, stretched 9.1% from the master's aspect",
				stretch: { master: { width: 100, height: 55 }, percent: 9.1, stretched: true },
				reduced: false
			}
		]);
		const performed = runOnce(false);
		expect(performed.exitCode).toBe(0);
		expect(framesOf(performed.report, 'resources/art/mark.png')).toEqual(planned);
		expect(plan.warnings).toEqual(performed.warnings);
	});
});

describe('imageset index predicts the stretch without rendering', () => {
	it('carries the figure gen reports, in the Markdown and in the envelope', () => {
		const { run, tree, brandingDir } = stretchPolygon('stretch-index');
		const index = buildImagesetIndex({ type: vscodeType, treeDir: tree.dir, brandingDir, onReport: () => {} });
		const performed = run(false);
		const sizeOf = (target: string) => index.targets.find((candidate) => candidate.target === target)?.sizes[0];
		expect(sizeOf('resources/win32/inno-big-100.bmp')?.stretch).toEqual(
			framesOf(performed.report, 'resources/win32/inno-big-100.bmp')?.[0]?.stretch
		);
		expect(sizeOf('resources/win32/inno-big-125.bmp')?.stretch).toEqual(
			framesOf(performed.report, 'resources/win32/inno-big-125.bmp')?.[0]?.stretch
		);
		const markdown = renderImagesetIndex(index).split('\n');
		expect(markdown).toContain(
			"| 32x16 | - | `generated` | rendered at this size from `installer-big.svg`, stretched 9.1% from the master's aspect |"
		);
		expect(markdown).toContain(
			"| 40x20 | - | `generated` | rendered at this size from `installer-big.svg`, stretched 9.1% from the master's aspect |"
		);
		expect(markdown.filter((line) => line.includes('stretched'))).toHaveLength(2);
		const data = indexData(index) as {
			targets: { target: string; sizes: { width: number; stretched: boolean; stretchPercent: number | null }[] }[];
		};
		const sizes = (target: string) => data.targets.find((candidate) => candidate.target === target)?.sizes ?? [];
		expect(sizes('resources/win32/inno-big-100.bmp')).toMatchObject([{ width: 32, stretched: true, stretchPercent: 9.1 }]);
		expect(sizes('resources/win32/code.ico').every((size) => !size.stretched && size.stretchPercent === 0)).toBe(true);
		expect(sizes('resources/win32/inno-small-100.bmp')).toMatchObject([{ stretched: false, stretchPercent: null }]);
	});
});
