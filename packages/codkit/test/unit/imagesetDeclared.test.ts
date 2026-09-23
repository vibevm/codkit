// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the
// targets and masters below are that family's.
// A product that declares its image set (PROP-007 ##IMAGESET-DECLARATION,
// ##IMAGESET-DECLARED-FRAMES, ##IMAGESET-DECLARED-SOURCES,
// ##IMAGESET-FRAME-SOURCES-REPORTED): the executable icon of the pin ships 16,
// 32, 128 and 256 px; the product declares nine frames, those up to 64 px from
// a separate taskbar drawing, the larger ones from its main icon. The frames
// are generated exactly, each from its key, the rest of the brand surface is
// untouched, and gen, its dry run and the index say the same thing about
// every frame.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decodePng } from '@codkit/type-api';
import type { Rgba } from '@codkit/type-api';
import { indexData, renderImagesetIndex } from '../../src/lib/imagesetIndex.ts';
import type { ImagesetReport } from '../../src/lib/imagesetEngine.ts';
import { renderSvgToRgba } from '../../src/lib/imagesetRender.ts';
import { framesOf, imagesOf } from '../support/imagesetCodecs.ts';
import {
	CODE_ICO,
	DECLARED_SIZES,
	ICON_SVG,
	TASKBAR_16,
	TASKBAR_32,
	TASKBAR_SVG,
	SAMPLE_DECLARATION,
	declaredPolygon
} from '../support/imagesetDeclared.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const LETTERPRESS = 'src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg';
const LETTERPRESS_SVG = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'type-vscode', 'test', 'fixtures', 'imageset', 'letterpress.svg')
);
/** The masters the rest of the whole brand surface needs, so that no target is skipped. */
const EXTENDED_MASTERS = { 'filetype/json.png': TASKBAR_32, 'filetype/yaml.png': TASKBAR_32, 'letterpress/dark.svg': LETTERPRESS_SVG };
const DECLARED = 'from the declared key taskbar';

/** Where each of the nine frames comes from, and what the reports say about it. */
const EXPECTED_FRAMES = [
	{
		size: 16,
		key: 'taskbar',
		keyDeclared: true,
		master: 'taskbar-16.png',
		origin: 'override',
		source: `override taskbar-16.png verbatim at 16x16, ${DECLARED}`
	},
	{
		size: 20,
		key: 'taskbar',
		keyDeclared: true,
		master: 'taskbar.svg',
		origin: 'vector',
		source: `rendered taskbar.svg at 20x20, ${DECLARED}`
	},
	{
		size: 24,
		key: 'taskbar',
		keyDeclared: true,
		master: 'taskbar.svg',
		origin: 'vector',
		source: `rendered taskbar.svg at 24x24, ${DECLARED}`
	},
	{
		size: 32,
		key: 'taskbar',
		keyDeclared: true,
		master: 'taskbar-32.png',
		origin: 'override',
		source: `override taskbar-32.png verbatim at 32x32, ${DECLARED}`
	},
	{
		size: 40,
		key: 'taskbar',
		keyDeclared: true,
		master: 'taskbar.svg',
		origin: 'vector',
		source: `rendered taskbar.svg at 40x40, ${DECLARED}`
	},
	{
		size: 48,
		key: 'taskbar',
		keyDeclared: true,
		master: 'taskbar.svg',
		origin: 'vector',
		source: `rendered taskbar.svg at 48x48, ${DECLARED}`
	},
	{
		size: 64,
		key: 'taskbar',
		keyDeclared: true,
		master: 'taskbar.svg',
		origin: 'vector',
		source: `rendered taskbar.svg at 64x64, ${DECLARED}`
	},
	{ size: 128, key: 'icon', keyDeclared: false, master: 'icon.svg', origin: 'vector', source: 'rendered icon.svg at 128x128' },
	{ size: 256, key: 'icon', keyDeclared: false, master: 'icon.svg', origin: 'vector', source: 'rendered icon.svg at 256x256' }
] as const;

const targetOf = (report: ImagesetReport, target: string) => report.targets.find((candidate) => candidate.target === target);
const artifact = (patchsetDir: string, target: string) =>
	readFileSync(join(patchsetDir, 'delta', 'resources', 'files', ...target.split('/')));

/** The pixels a frame of the given key must carry, drawn the way the pipeline draws them. */
function expectedPixels(size: number): Rgba {
	if (size === 16) return decodePng(TASKBAR_16);
	if (size === 32) return decodePng(TASKBAR_32);
	return renderSvgToRgba(size <= 64 ? TASKBAR_SVG : ICON_SVG, size, size).image;
}

describe('a declared frame set with a declared source', () => {
	it('writes exactly the declared frames, in the declared order, each from its own key', () => {
		const { patchset, run } = declaredPolygon('declared-exact', { declaration: SAMPLE_DECLARATION });
		const performed = run(false);
		expect(performed.exitCode).toBe(0);
		const bytes = artifact(patchset.dir, CODE_ICO);
		expect(framesOf('ico', bytes).map((frame) => `${frame.width}x${frame.height}`)).toEqual(
			DECLARED_SIZES.map((size) => `${size}x${size}`)
		);
		const images = imagesOf('ico', bytes);
		DECLARED_SIZES.forEach((size, at) => {
			const expected = expectedPixels(size);
			expect(Buffer.from(images[at]?.data ?? []).equals(Buffer.from(expected.data)), `pixels of the ${size}x${size} frame`).toBe(true);
		});
		const target = targetOf(performed.report, CODE_ICO);
		expect(target?.framesDeclared).toBe(true);
		expect(target?.frames).toEqual(
			EXPECTED_FRAMES.map((frame) => ({
				width: frame.size,
				height: frame.size,
				source: frame.source,
				stretch:
					frame.origin === 'vector'
						? { master: frame.key === 'taskbar' ? { width: 64, height: 64 } : { width: 128, height: 128 }, percent: 0, stretched: false }
						: null,
				reduced: false,
				key: frame.key,
				keyDeclared: frame.keyDeclared,
				master: frame.master,
				origin: frame.origin
			}))
		);
		expect(performed.info).toContain(
			`regenerated ${CODE_ICO}: ${EXPECTED_FRAMES.map((frame) => `${frame.size}x${frame.size} (${frame.source})`).join(', ')}`
		);
		expect(performed.warnings).toEqual([]);
	});

	it('leaves every other target alone: favicon.ico and the rest of the family come out byte for byte as without the declaration', () => {
		const declared = declaredPolygon('declared-others', { declaration: SAMPLE_DECLARATION, extended: true, masters: EXTENDED_MASTERS });
		const plain = declaredPolygon('declared-others-plain', { extended: true, masters: EXTENDED_MASTERS });
		const withDeclaration = declared.run(false);
		const without = plain.run(false);
		expect(withDeclaration.exitCode).toBe(0);
		expect(without.exitCode).toBe(0);
		expect(withDeclaration.report.written.length).toBe(without.report.written.length);
		const others = withDeclaration.report.targets.map((target) => target.target).filter((target) => target !== CODE_ICO);
		expect(others).toContain('resources/server/favicon.ico');
		for (const target of others) {
			expect(artifact(declared.patchset.dir, target).equals(artifact(plain.patchset.dir, target)), target).toBe(true);
			expect(targetOf(withDeclaration.report, target)?.frames).toEqual(targetOf(without.report, target)?.frames);
		}
		const favicon = targetOf(withDeclaration.report, 'resources/server/favicon.ico');
		expect(favicon?.framesDeclared).toBe(false);
		expect(favicon?.frames.map((frame) => [frame.width, frame.key, frame.keyDeclared])).toEqual([
			[16, 'icon', false],
			[32, 'icon', false]
		]);
		expect(artifact(declared.patchset.dir, CODE_ICO).equals(artifact(plain.patchset.dir, CODE_ICO))).toBe(false);
	});

	it('is said the same way by gen, its dry run and the index', () => {
		const { run, index } = declaredPolygon('declared-agree', { declaration: SAMPLE_DECLARATION });
		const plan = run(true);
		const performed = run(false);
		expect(plan.exitCode).toBe(0);
		expect(plan.report.targets.map((target) => [target.target, target.framesDeclared, target.frames])).toEqual(
			performed.report.targets.map((target) => [target.target, target.framesDeclared, target.frames])
		);
		expect(plan.info).toContain(
			`would regenerate ${CODE_ICO}: 9 frame(s) ${DECLARED_SIZES.map((size) => `${size}x${size}`).join(',')}, declared in imageset.json in place of the shipped 16x16,32x32,128x128,256x256`
		);
		for (const frame of EXPECTED_FRAMES) {
			expect(plan.info).toContain(`  ${frame.size}x${frame.size}: ${frame.source}`);
		}
		const built = index();
		const data = indexData(built) as {
			declaration: string | null;
			targets: {
				target: string;
				framesDeclared: boolean;
				shippedFrames: { width: number }[];
				sizes: { width: number; from: string | null; key: string; keyDeclared: boolean; origin: string | null }[];
			}[];
		};
		const ico = data.targets.find((target) => target.target === CODE_ICO);
		expect(ico?.framesDeclared).toBe(true);
		expect(ico?.shippedFrames.map((frame) => frame.width)).toEqual([16, 32, 128, 256]);
		const frames = targetOf(performed.report, CODE_ICO)?.frames ?? [];
		expect(ico?.sizes.map((size) => [size.width, size.key, size.keyDeclared, size.from, size.origin])).toEqual(
			frames.map((frame) => [frame.width, frame.key, frame.keyDeclared, frame.master, frame.origin])
		);
		expect(data.declaration).toBe(join(built.brandingDir, 'imageset.json'));
		const markdown = renderImagesetIndex(built).split('\n');
		expect(markdown).toContain(
			'- Frames: declared in imageset.json - 16x16, 20x20, 24x24, 32x32, 40x40, 48x48, 64x64, 128x128, 256x256; the shipped file carries 16x16, 32x32, 128x128, 256x256'
		);
		expect(markdown).toContain('| 16x16 | - | `master` | `taskbar-16.png`, used verbatim, from the declared key `taskbar` |');
		expect(markdown).toContain('| 20x20 | - | `generated` | rendered at this size from `taskbar.svg`, from the declared key `taskbar` |');
		expect(markdown).toContain('| 128x128 | - | `generated` | rendered at this size from `icon.svg` |');
		expect(markdown).toContain(
			'Declared: `imageset.json` sets the frames or the master keys of 1 target(s) - below, per target and per size.'
		);
	});

	it('recognises the declaration and the masters of the key it names, which are otherwise ignored', () => {
		const declared = declaredPolygon('declared-recognised', { declaration: SAMPLE_DECLARATION });
		const plain = declaredPolygon('declared-recognised-plain');
		expect(declared.run(true).warnings.filter((line) => line.includes('ignored'))).toEqual([]);
		expect(plain.run(true).warnings.filter((line) => line.includes('ignored'))).toEqual([
			'branding file matches no master convention and was ignored: taskbar-16.png',
			'branding file matches no master convention and was ignored: taskbar-32.png',
			'branding file matches no master convention and was ignored: taskbar.svg'
		]);
		const built = declared.index();
		expect(built.ignored).toEqual([]);
		expect(built.masters).toContain('taskbar.svg');
		expect(built.masters).not.toContain('imageset.json');
	});
});

describe('a declared source without a declared frame set', () => {
	it('keeps the frames the shipped file carries and gives the listed sizes to the key', () => {
		const { run } = declaredPolygon('declared-sources-only', {
			declaration: { codkitImageset: 1, targets: { [CODE_ICO]: { sources: [{ key: 'taskbar', sizes: [16, 32] }] } } }
		});
		const performed = run(false);
		expect(performed.exitCode).toBe(0);
		const target = targetOf(performed.report, CODE_ICO);
		expect(target?.framesDeclared).toBe(false);
		expect(target?.frames.map((frame) => [frame.width, frame.key, frame.keyDeclared, frame.master])).toEqual([
			[16, 'taskbar', true, 'taskbar-16.png'],
			[32, 'taskbar', true, 'taskbar-32.png'],
			[128, 'icon', false, 'icon.svg'],
			[256, 'icon', false, 'icon.svg']
		]);
	});

	it('takes a key whose only masters are per-size overrides', () => {
		const { run } = declaredPolygon('declared-overrides-only', {
			masters: { 'tray-16.png': TASKBAR_16 },
			declaration: { codkitImageset: 1, targets: { [CODE_ICO]: { sources: [{ key: 'tray', sizes: [16] }] } } }
		});
		const frames = targetOf(run(true).report, CODE_ICO)?.frames ?? [];
		expect(frames.map((frame) => [frame.width, frame.key, frame.master, frame.origin])).toEqual([
			[16, 'tray', 'tray-16.png', 'override'],
			[32, 'icon', 'icon.svg', 'vector'],
			[128, 'icon', 'icon.svg', 'vector'],
			[256, 'icon', 'icon.svg', 'vector']
		]);
	});

	it('selects by a range from its lower bound', () => {
		const { run } = declaredPolygon('declared-range-from', {
			declaration: { codkitImageset: 1, targets: { [CODE_ICO]: { sources: [{ key: 'taskbar', minSize: 128 }] } } }
		});
		const frames = targetOf(run(true).report, CODE_ICO)?.frames ?? [];
		expect(frames.map((frame) => [frame.width, frame.key])).toEqual([
			[16, 'icon'],
			[32, 'icon'],
			[128, 'taskbar'],
			[256, 'taskbar']
		]);
	});

	it('gives the frame of a vector target to another key, which is emitted unchanged', () => {
		const { patchset, run } = declaredPolygon('declared-vector', {
			extended: true,
			masters: { 'letterpress/light.svg': LETTERPRESS_SVG, 'filetype/json.png': TASKBAR_32, 'filetype/yaml.png': TASKBAR_32 },
			declaration: { codkitImageset: 1, targets: { [LETTERPRESS]: { sources: [{ key: 'letterpress/light', sizes: [64] }] } } }
		});
		const performed = run(false);
		expect(performed.exitCode).toBe(0);
		expect(targetOf(performed.report, LETTERPRESS)?.frames).toEqual([
			{
				width: 64,
				height: 64,
				source: 'emitted letterpress/light.svg unchanged at 64x64, from the declared key letterpress/light',
				stretch: null,
				reduced: false,
				key: 'letterpress/light',
				keyDeclared: true,
				master: 'letterpress/light.svg',
				origin: 'vector'
			}
		]);
		expect(artifact(patchset.dir, LETTERPRESS).equals(LETTERPRESS_SVG)).toBe(true);
	});
});
