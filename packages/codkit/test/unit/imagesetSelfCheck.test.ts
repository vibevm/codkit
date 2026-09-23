// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the icon
// and banner masters below are that family's.
// The self-check reads the masters it vouches for (PROP-007
// ##IMAGESET-SELF-CHECK-READS-MASTERS): `gen --dry-run` and `index` read every
// master the run would read, with the run's own code, so they refuse what the
// run refuses, skip what it skips, and report a 16-bit master as reduced to 8
// bits the way the run does - and read nothing the run would not.
//
// The polygon's icon targets are code.icns (32x32, 128x128) and code.ico
// (16x16, 32x32), taken in that order; every other icon target is served by
// the base master icon.png.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePng, rgba } from '@codkit/type-api';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { runImageset } from '../../src/lib/imagesetEngine.ts';
import type { ImagesetReport } from '../../src/lib/imagesetEngine.ts';
import { buildImagesetIndex, indexData, renderImagesetIndex } from '../../src/lib/imagesetIndex.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { makeImagesetPatchSet, makeImagesetTree } from '../support/imagesetFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { writePng } from '../../../type-api/test/support/pngVariants.ts';

afterAll(cleanupTempRoots);

const REDUCED = 'reduced from 16 to 8 bits per channel';
const LETTERPRESS = 'src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg';

/** A master of the given size at 16 bits per channel. */
function sixteenBit(width: number, height: number): Uint8Array {
	return writePng(width, height, { colorType: 6, bitDepth: 16 }, () => [65535, 32768, 0, 65535]);
}

/** A PNG whose header declares RGB at 4 bits, a depth the format does not define for RGB. */
function malformed(): Uint8Array {
	const bytes = encodePng(rgba(16, 16, [1, 2, 3, 255]));
	bytes[24] = 4;
	bytes[25] = 2;
	return bytes;
}

/**
 * The polygon with 8-bit base masters for every family of the small tree, plus
 * the masters a test adds or replaces; `extended` adds the rest of the brand
 * surface, a vector watermark among it.
 */
function polygon(label: string, masters: Readonly<Record<string, Uint8Array | string>>, extended = false) {
	const tree = makeImagesetTree(`${label}-tree`, { extended });
	const patchset = makeImagesetPatchSet(`${label}-patchset`, tree);
	const brandingDir = join(patchset.dir, 'branding');
	const base: Record<string, Uint8Array | string> = {
		'icon.png': encodePng(rgba(128, 128, [22, 122, 191, 255])),
		'installer-big.png': encodePng(rgba(40, 20, [22, 122, 191, 255])),
		'installer-small.png': encodePng(rgba(12, 12, [22, 122, 191, 255]))
	};
	for (const [file, bytes] of Object.entries({ ...base, ...masters })) {
		const path = join(brandingDir, ...file.split('/'));
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, bytes);
	}
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
	const index = () => buildImagesetIndex({ type: vscodeType, treeDir: tree.dir, brandingDir, onReport: () => {} });
	return { patchset, brandingDir, run, index };
}

/** The error a call throws, as the command would report it; null when it does not throw. */
function refusalOf(call: () => unknown): { code: string; message: string; hint: string | null } | null {
	try {
		call();
	} catch (error) {
		if (!isCkError(error)) throw error;
		return { code: error.code, message: error.message, hint: error.hint ?? null };
	}
	return null;
}

const targetOf = (report: ImagesetReport, target: string) => report.targets.find((candidate) => candidate.target === target);

type IndexJson = {
	targets: { target: string; skipped: string | null; sizes: { width: number; height: number; reducedFrom16Bit: boolean }[] }[];
};
const indexTargetOf = (data: unknown, target: string) => (data as IndexJson).targets.find((candidate) => candidate.target === target);

describe('a master the run refuses', () => {
	it('fails the dry run and the index with the very refusal of the run', () => {
		const { patchset, run, index } = polygon('self-refuse', { 'icon-16.png': malformed() });
		const expected = {
			code: 'ARTIFACT-BROKEN',
			message: 'icon-16.png: PNG: RGB at 4 bits is not a PNG variant: RGB comes at 8, 16 bits',
			hint: 'export the master as an 8-bit RGBA PNG'
		};
		expect(refusalOf(() => run(false))).toEqual(expected);
		expect(refusalOf(() => run(true))).toEqual(expected);
		expect(refusalOf(index)).toEqual(expected);
		expect(existsSync(join(patchset.dir, 'delta', 'resources'))).toBe(false);
	});
});

describe('a master with 16 bits per channel', () => {
	it('is reported as reduced to 8 bits by the run and by its plan, and by nothing else', () => {
		// The banner master is grey at 4 bits: expanded to 8 without a loss, it
		// is not reported.
		const { run } = polygon('self-sixteen-gen', {
			'icon-16.png': sixteenBit(16, 16),
			'installer-small.png': sixteenBit(12, 12),
			'installer-big.png': writePng(40, 20, { colorType: 0, bitDepth: 4 }, () => [9])
		});
		const plan = run(true);
		const performed = run(false);
		expect(plan.exitCode).toBe(0);
		expect(performed.exitCode).toBe(0);
		expect(targetOf(performed.report, 'resources/win32/code.ico')?.frames).toEqual([
			{ width: 16, height: 16, source: `override icon-16.png verbatim at 16x16, ${REDUCED}`, stretch: null, reduced: true },
			{ width: 32, height: 32, source: 'resampled icon.png to 32x32', stretch: null, reduced: false }
		]);
		expect(targetOf(performed.report, 'resources/win32/inno-small-100.bmp')?.frames).toEqual([
			{ width: 12, height: 12, source: `resampled installer-small.png to 12x12, ${REDUCED}`, stretch: null, reduced: true }
		]);
		expect(targetOf(performed.report, 'resources/win32/inno-big-100.bmp')?.frames).toEqual([
			{ width: 32, height: 16, source: 'resampled installer-big.png to 32x16', stretch: null, reduced: false }
		]);
		// The plan says it of the same frames, and of no others.
		expect(plan.report.targets.map((target) => target.frames)).toEqual(performed.report.targets.map((target) => target.frames));
		expect(performed.report.targets.flatMap((target) => target.frames).filter((frame) => frame.reduced)).toHaveLength(2);
		expect(plan.info).toContain(`  16x16: override icon-16.png verbatim at 16x16, ${REDUCED}`);
		expect(performed.info).toContain(
			`regenerated resources/win32/code.ico: 16x16 (override icon-16.png verbatim at 16x16, ${REDUCED}), 32x32 (resampled icon.png to 32x32)`
		);
		// Information, not a warning: nothing the delivered images could hold is lost.
		expect(plan.warnings).toEqual([]);
		expect(performed.warnings).toEqual([]);
	});

	it('is reported as reduced by the index, in the Markdown and in the envelope', () => {
		const { index } = polygon('self-sixteen-index', { 'icon-16.png': sixteenBit(16, 16), 'installer-small.png': sixteenBit(12, 12) });
		const built = index();
		const markdown = renderImagesetIndex(built).split('\n');
		expect(markdown).toContain(`| 16x16 | - | \`master\` | \`icon-16.png\`, used verbatim, ${REDUCED} |`);
		expect(markdown).toContain(`| 12x12 | - | \`generated\` | resampled to this size from \`installer-small.png\`, ${REDUCED} |`);
		expect(markdown.filter((line) => line.includes(REDUCED))).toHaveLength(2);
		const data = indexData(built);
		expect(indexTargetOf(data, 'resources/win32/code.ico')?.sizes).toMatchObject([
			{ width: 16, height: 16, reducedFrom16Bit: true },
			{ width: 32, height: 32, reducedFrom16Bit: false }
		]);
		expect(indexTargetOf(data, 'resources/win32/inno-small-100.bmp')?.sizes).toMatchObject([{ reducedFrom16Bit: true }]);
		expect((data as IndexJson).targets.every((target) => target.skipped === null)).toBe(true);
	});
});

describe('a per-size override of the wrong size', () => {
	it('makes the dry run skip the target as the run does, and the index say why', () => {
		const { run, index } = polygon('self-override-size', { 'icon-16.png': encodePng(rgba(32, 32, [22, 122, 191, 255])) });
		const reason = 'the per-size override icon-16.png does not cover 16x16';
		const performed = run(false);
		const plan = run(true);
		expect(performed.exitCode).toBe(1);
		expect(performed.warnings).toEqual([`skipped resources/win32/code.ico: ${reason}`]);
		expect(plan.exitCode).toBe(1);
		expect(plan.warnings).toEqual(performed.warnings);
		expect(targetOf(plan.report, 'resources/win32/code.ico')).toMatchObject({ frames: [], skipped: reason });
		expect(plan.info.some((line) => line.startsWith('would regenerate resources/win32/code.ico'))).toBe(false);
		const built = index();
		const markdown = renderImagesetIndex(built).split('\n');
		expect(markdown).toContain(`| 16x16 | - | \`master\` | ${reason}; the run skips this target and exits 1 |`);
		expect(markdown).toContain('| 32x32 | - | `generated` | resampled to this size from `icon.png` |');
		expect(indexTargetOf(indexData(built), 'resources/win32/code.ico')?.skipped).toBe(reason);
		expect(indexTargetOf(indexData(built), 'resources/darwin/code.icns')?.skipped).toBeNull();
	});
});

describe('a vector target whose master has another size', () => {
	it('makes the dry run skip the target as the run does, and the index say why', () => {
		const small = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#167abf"/></svg>';
		const { run, index } = polygon('self-vector-size', { 'letterpress/dark.svg': small }, true);
		const reason = `letterpress/dark.svg is 48x48 but ${LETTERPRESS} ships 64x64`;
		const performed = run(false);
		const plan = run(true);
		expect(performed.warnings).toContain(`skipped ${LETTERPRESS}: ${reason}`);
		expect(plan.warnings).toEqual(performed.warnings);
		expect(plan.exitCode).toBe(performed.exitCode);
		expect(targetOf(plan.report, LETTERPRESS)).toMatchObject({ frames: [], skipped: reason });
		const built = index();
		expect(renderImagesetIndex(built).split('\n')).toContain(
			`| 64x64 | - | \`generated\` | ${reason}; the run skips this target and exits 1 |`
		);
		expect(indexTargetOf(indexData(built), LETTERPRESS)?.skipped).toBe(reason);
	});
});

describe('a master the run never opens', () => {
	it('cannot fail the check: a target is read no further than the frame the run gives it up at', () => {
		// icon-32.png has the wrong size, so the run gives up code.icns at its
		// first frame and code.ico at its second; icon-128.png serves only the
		// frame of code.icns after that, so the run never opens it. The 16-bit
		// icon-16.png serves the frame of code.ico before the one it is given up
		// at, so the index still says it is reduced.
		const { run, index } = polygon('self-never-opened', {
			'icon-16.png': sixteenBit(16, 16),
			'icon-32.png': encodePng(rgba(16, 16, [22, 122, 191, 255])),
			'icon-128.png': malformed()
		});
		const reason = 'the per-size override icon-32.png does not cover 32x32';
		const performed = run(false);
		expect(performed.exitCode).toBe(1);
		expect(performed.warnings).toEqual([`skipped resources/darwin/code.icns: ${reason}`, `skipped resources/win32/code.ico: ${reason}`]);
		const plan = run(true);
		expect(plan.exitCode).toBe(1);
		expect(plan.warnings).toEqual(performed.warnings);
		const built = index();
		const data = indexData(built);
		expect(indexTargetOf(data, 'resources/darwin/code.icns')?.skipped).toBe(reason);
		expect(indexTargetOf(data, 'resources/win32/code.ico')?.skipped).toBe(reason);
		expect(indexTargetOf(data, 'resources/win32/code.ico')?.sizes).toMatchObject([
			{ width: 16, height: 16, reducedFrom16Bit: true },
			{ width: 32, height: 32, reducedFrom16Bit: false }
		]);
		const markdown = renderImagesetIndex(built).split('\n');
		expect(markdown).toContain(`| 16x16 | - | \`master\` | \`icon-16.png\`, used verbatim, ${REDUCED} |`);
		expect(markdown).toContain(`| 32x32 | - | \`master\` | ${reason}; the run skips this target and exits 1 |`);
	});
});
