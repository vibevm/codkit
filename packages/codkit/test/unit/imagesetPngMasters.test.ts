// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the icon
// and banner masters below are that family's.
// A PNG master in a variant other than 8-bit RGBA (PROP-007
// ##IMAGESET-PNG-MASTERS): a 16-bit export is taken as it is and rounded to 8
// bits per channel, and a file that is not a well-formed PNG is refused with
// what is wrong with it and what to export instead. The masters are written by
// the contract package's own test writer, which shares no code with the decoder.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePng, rgba } from '@codkit/type-api';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { runImageset } from '../../src/lib/imagesetEngine.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { imagesOf } from '../support/imagesetCodecs.ts';
import { makeImagesetPatchSet, makeImagesetTree } from '../support/imagesetFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { writePng } from '../../../type-api/test/support/pngVariants.ts';

afterAll(cleanupTempRoots);

/** 16-bit samples chosen at the edges of the rounding, and what they round to. */
const SIXTEEN = [0, 128, 129, 32767, 32768, 32896, 65534, 65535] as const;
const ROUNDED = [0, 0, 1, 127, 128, 128, 255, 255] as const;

/** A 16x16 RGBA master at 16 bits per channel; channel c of pixel x is SIXTEEN[(x + c) % 8]. */
function sixteenBitIcon(): Uint8Array {
	return writePng(16, 16, { colorType: 6, bitDepth: 16 }, (x) => [0, 1, 2, 3].map((channel) => SIXTEEN[(x + channel) % 8] ?? 0));
}

/** The polygon with 8-bit base masters and one hand-made icon-16.png. */
function polygon(label: string, icon16: Uint8Array) {
	const tree = makeImagesetTree(`${label}-tree`);
	const patchset = makeImagesetPatchSet(`${label}-patchset`, tree);
	const brandingDir = join(patchset.dir, 'branding');
	mkdirSync(brandingDir, { recursive: true });
	writeFileSync(join(brandingDir, 'icon.png'), encodePng(rgba(128, 128, [22, 122, 191, 255])));
	writeFileSync(join(brandingDir, 'icon-16.png'), icon16);
	writeFileSync(join(brandingDir, 'installer-big.png'), encodePng(rgba(40, 20, [22, 122, 191, 255])));
	writeFileSync(join(brandingDir, 'installer-small.png'), encodePng(rgba(12, 12, [22, 122, 191, 255])));
	const run = () =>
		runImageset({
			patchesDir: patchset.dir,
			type: vscodeType,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun: false,
			onInfo: () => {},
			onWarn: () => {}
		});
	return { patchset, run };
}

describe('a PNG master with 16 bits per channel', () => {
	it('is taken as it is, and every channel is rounded to 8 bits', () => {
		const { patchset, run } = polygon('png16-gen', sixteenBitIcon());
		expect(run().exitCode).toBe(0);
		const ico = readFileSync(join(patchset.dir, 'delta', 'resources', 'files', 'resources', 'win32', 'code.ico'));
		const frame = imagesOf('ico', ico).find((image) => image.width === 16);
		expect(frame).toBeDefined();
		for (let x = 0; x < 16; x += 1) {
			const at = x * 4;
			expect(Array.from(frame?.data.subarray(at, at + 4) ?? []), `pixel ${x}`).toEqual(
				[0, 1, 2, 3].map((channel) => ROUNDED[(x + channel) % 8])
			);
		}
	});
});

describe('a master that is not a well-formed PNG', () => {
	it('is refused with what is wrong with it and what to export instead', () => {
		// RGB at 4 bits per sample: a depth the format does not define for RGB.
		const bytes = encodePng(rgba(16, 16, [1, 2, 3, 255]));
		bytes[24] = 4;
		bytes[25] = 2;
		const { run } = polygon('png-malformed', bytes);
		let caught: unknown = null;
		try {
			run();
		} catch (error) {
			caught = error;
		}
		expect(isCkError(caught)).toBe(true);
		if (!isCkError(caught)) return;
		expect(caught.code).toBe('ARTIFACT-BROKEN');
		expect(caught.message).toBe('icon-16.png: PNG: RGB at 4 bits is not a PNG variant: RGB comes at 8, 16 bits');
		expect(caught.hint).toBe('export the master as an 8-bit RGBA PNG');
	});
});
