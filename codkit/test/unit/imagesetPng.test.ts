// imageset PNG codec: round trip, the palette path of the distribution's own
// linux icon, and the refusals (PROP-007 ##IMAGESET-CONTAINERS).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, isPng, pngSize, rgba } from '../../src/lib/imagesetPng.ts';
import { isCkError } from '../../src/lib/messages.ts';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'imageset');

function failure(run: () => unknown): { code: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return { code: error.code };
		}
		throw error;
	}
	throw new Error('expected the call to fail');
}

describe('encodePng and decodePng', () => {
	it('round-trips arbitrary RGBA bytes exactly', () => {
		const image = rgba(9, 5);
		for (let at = 0; at < image.data.length; at += 4) {
			image.data[at] = (at * 7) % 256;
			image.data[at + 1] = (at * 13) % 256;
			image.data[at + 2] = (at * 29) % 256;
			image.data[at + 3] = (at * 3) % 256;
		}
		const back = decodePng(encodePng(image));
		expect(back.width).toBe(9);
		expect(back.height).toBe(5);
		expect(Buffer.from(back.data).equals(Buffer.from(image.data))).toBe(true);
	});

	it('is deterministic: the same pixels encode to the same bytes', () => {
		const image = rgba(4, 4, [9, 8, 7, 255]);
		expect(Buffer.from(encodePng(image)).equals(Buffer.from(encodePng(image)))).toBe(true);
	});

	it('decodes the palette PNG the fixture ships as the distribution linux icon', () => {
		const image = decodePng(readFileSync(join(fixtureRoot, 'code.png')));
		expect(image.width).toBe(64);
		expect(image.height).toBe(64);
		expect(image.data.length).toBe(64 * 64 * 4);
		expect(image.data[3]).toBeGreaterThanOrEqual(0);
	});

	it('decodes tRNS transparency of a palette image', () => {
		const image = decodePng(readFileSync(join(fixtureRoot, 'code.png')));
		let transparent = 0;
		for (let at = 3; at < image.data.length; at += 4) {
			if (image.data[at] === 0) {
				transparent += 1;
			}
		}
		// The fixture artwork has a transparent margin around the rounded square.
		expect(transparent).toBeGreaterThan(0);
	});

	it('reads header dimensions without decoding pixels', () => {
		const size = pngSize(readFileSync(join(fixtureRoot, 'code_70x70.png')));
		expect(size).toEqual({ width: 70, height: 70 });
	});

	it('refuses interlaced images instead of guessing', () => {
		const image = rgba(2, 2, [1, 2, 3, 255]);
		const png = encodePng(image);
		png[28] = 1; // interlace byte of IHDR
		const verdict = failure(() => decodePng(png));
		expect(verdict.code).toBe('ARTIFACT-BROKEN');
	});

	it('recognises the signature', () => {
		expect(isPng(readFileSync(join(fixtureRoot, 'code.png')))).toBe(true);
		expect(isPng(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
	});
});
