// The imageset verification: the metric, the bands, and the round trip itself
// (PROP-007 ##IMAGESET-VERIFY, ##DECISION-IMAGESET-ACCEPTANCE-CRITERION,
// ##IMAGESET-ROUND-TRIP).
//
// The containers are reached only through the codecs of the project type, the
// way the verifier itself reaches them; what a container does with the bytes is
// proved in the suite of the package that answers for it.
//
// The round-trip tests build trees whose layers are DIFFERENT drawings on
// purpose: a comparison that read back its own regenerated pixels, or that
// took its master from another file, would measure zero where these expect a
// large number, and would go red here.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePng, rgba } from '@codkit/type-api';
import type { Rgba } from '@codkit/type-api';
import { containerOf, namedFrame, sizedFrame } from '../support/imagesetCodecs.ts';
import { resizeRgba } from '../../src/lib/imagesetRaster.ts';
import {
	bandFor,
	meanAbsoluteRgbDifference,
	renderImagesetVerification,
	verificationData,
	verificationExitCode,
	verifyImageset
} from '../../src/lib/imagesetVerify.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

afterAll(cleanupTempRoots);

/** A flat drawing: a filled square of one colour on a transparent ground. */
function block(size: number, color: readonly [number, number, number]): Rgba {
	const image = rgba(size, size);
	const inset = Math.max(1, Math.round(size / 8));
	for (let y = inset; y < size - inset; y += 1) {
		for (let x = inset; x < size - inset; x += 1) {
			const at = (y * size + x) * 4;
			image.data[at] = color[0];
			image.data[at + 1] = color[1];
			image.data[at + 2] = color[2];
			image.data[at + 3] = 255;
		}
	}
	return image;
}

function writeTarget(treeDir: string, relative: string, bytes: Uint8Array): void {
	const absolute = join(treeDir, ...relative.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, bytes);
}

function icns(elements: readonly { type: string; image: Rgba }[]): Uint8Array {
	return containerOf(
		'icns',
		elements.map((element) => ({ frame: namedFrame(element.type, element.image), image: element.image }))
	);
}

function ico(frames: readonly Rgba[]): Uint8Array {
	return containerOf(
		'ico',
		frames.map((image) => ({ frame: sizedFrame(image), image }))
	);
}

function verify(treeDir: string) {
	const verification = verifyImageset({ type: vscodeType, treeDir, brandingDir: join(treeDir, 'never-read'), onReport: () => {} });
	return { verification, exitCode: verificationExitCode(verification) };
}

const targetOf = (verification: ReturnType<typeof verify>['verification'], target: string) =>
	verification.targets.find((candidate) => candidate.target === target);

describe('the metric', () => {
	it('averages the three RGB channels and leaves alpha out of it', () => {
		const left = rgba(2, 2, [10, 20, 30, 255]);
		const right = rgba(2, 2, [16, 20, 30, 0]);
		// Only the red channel differs, by 6, over three averaged channels.
		expect(meanAbsoluteRgbDifference(left, right)).toBeCloseTo(2, 10);
	});

	it('does not composite: a fully transparent pixel still contributes its RGB', () => {
		const left = rgba(1, 1, [255, 255, 255, 0]);
		const right = rgba(1, 1, [0, 0, 0, 0]);
		expect(meanAbsoluteRgbDifference(left, right)).toBe(255);
	});
});

describe('the bands', () => {
	it('asserts 10/255 from 256 px, 25/255 from 64 px, and nothing below that', () => {
		expect([1024, 512, 256].map((size) => bandFor(size).ceiling)).toEqual([10, 10, 10]);
		expect([255, 128, 64].map((size) => bandFor(size).ceiling)).toEqual([25, 25, 25]);
		expect([63, 48, 32, 16].map((size) => bandFor(size).ceiling)).toEqual([null, null, null, null]);
	});
});

describe('codkit imageset verify', () => {
	it('regenerates every layer from the largest layer of the same container', () => {
		const treeDir = makeTempRoot('verify-pass');
		const master = block(512, [20, 120, 190]);
		writeTarget(
			treeDir,
			'resources/darwin/code.icns',
			icns([
				{ type: 'ic09', image: master },
				{ type: 'ic13', image: resizeRgba(master, 256, 256) },
				{ type: 'ic07', image: resizeRgba(master, 128, 128) }
			])
		);
		const { verification, exitCode } = verify(treeDir);
		const target = targetOf(verification, 'resources/darwin/code.icns');

		expect(exitCode).toBe(0);
		expect(target?.master).toBe('ic09');
		expect(target?.structure?.matches).toBe(true);
		expect(target?.layers.map((layer) => layer.verdict)).toEqual(['master', 'inside', 'inside']);
		expect(verification.totals.outside).toBe(0);
		expect(verification.totals.inside).toBe(2);
	});

	it('exits 1 and names the layer when a regenerated layer leaves its band', () => {
		const treeDir = makeTempRoot('verify-fail');
		const master = block(512, [20, 120, 190]);
		writeTarget(
			treeDir,
			'resources/darwin/code.icns',
			icns([
				{ type: 'ic09', image: master },
				{ type: 'ic13', image: resizeRgba(master, 256, 256) },
				// A different drawing at 128, the way a wrong layer would ship.
				{ type: 'ic07', image: block(128, [240, 30, 10]) }
			])
		);
		const { verification, exitCode } = verify(treeDir);
		const target = targetOf(verification, 'resources/darwin/code.icns');
		const outside = target?.layers.find((layer) => layer.verdict === 'outside');

		expect(exitCode).toBe(1);
		expect(outside?.label).toBe('ic07');
		expect(outside?.band.ceiling).toBe(25);
		expect(outside?.measured ?? 0).toBeGreaterThan(25);
		expect(verification.totals.outside).toBe(1);
		// The layer that does match still measures inside: one bad layer fails
		// the run without smearing over the rest of the report.
		expect(target?.layers.find((layer) => layer.label === 'ic13')?.verdict).toBe('inside');
	});

	it('never takes the master from another container, even a larger one', () => {
		const treeDir = makeTempRoot('verify-cross');
		const macos = block(512, [20, 120, 190]);
		const windows = block(256, [240, 30, 10]);
		writeTarget(
			treeDir,
			'resources/darwin/code.icns',
			icns([
				{ type: 'ic09', image: macos },
				{ type: 'ic13', image: resizeRgba(macos, 256, 256) }
			])
		);
		writeTarget(treeDir, 'resources/win32/code.ico', ico([windows, resizeRgba(windows, 128, 128)]));
		const { verification, exitCode } = verify(treeDir);

		// The two files are different drawings: their 256 layers are 42/255
		// apart. A run that chose one master for the whole tree - or compared
		// across containers - could not be green here.
		expect(meanAbsoluteRgbDifference(resizeRgba(macos, 256, 256), windows)).toBeGreaterThan(25);
		expect(exitCode).toBe(0);
		expect(targetOf(verification, 'resources/win32/code.ico')?.master).toBe('256x256');
		expect(targetOf(verification, 'resources/darwin/code.icns')?.master).toBe('ic09');
	});

	it('reports a single-layer target as unverifiable and never as passed', () => {
		const treeDir = makeTempRoot('verify-single');
		writeTarget(treeDir, 'resources/linux/code.png', encodePng(block(256, [20, 120, 190])));
		writeTarget(treeDir, 'resources/win32/code.ico', ico([block(64, [20, 120, 190])]));
		const { verification, exitCode } = verify(treeDir);

		expect(exitCode).toBe(0);
		expect(verification.totals.verified).toBe(0);
		expect(verification.totals.unverifiable).toBe(2);
		expect(verification.totals.comparisons).toBe(0);
		expect(targetOf(verification, 'resources/linux/code.png')?.reason).toContain('exactly one layer');
		expect(targetOf(verification, 'resources/win32/code.ico')?.reason).toContain('single layer');
		expect(renderImagesetVerification(verification)).toContain('NOT counted as passed');
	});

	it('renders the same measured numbers into Markdown and into --json', () => {
		const treeDir = makeTempRoot('verify-one-model');
		const master = block(256, [20, 120, 190]);
		writeTarget(treeDir, 'resources/win32/code.ico', ico([master, block(128, [240, 30, 10])]));
		const { verification } = verify(treeDir);
		const data = verificationData(verification) as {
			totals: { outside: number };
			targets: { target: string; layers: { label: string; measured: number | null; verdict: string }[] }[];
		};
		const layer = data.targets[0]?.layers.find((candidate) => candidate.label === '128x128');
		const markdown = renderImagesetVerification(verification);

		expect(data.totals.outside).toBe(1);
		expect(layer?.verdict).toBe('outside');
		expect(markdown).toContain(`| ${(layer?.measured ?? 0).toFixed(2)} | OUTSIDE the band |`);
		expect(markdown).toContain('| `128x128` | 128x128 | at most 25/255 |');
	});
});
