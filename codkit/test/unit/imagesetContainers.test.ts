// imageset container codecs against the committed fixture binaries - the
// "shipped" icon set of a distribution - and their own round trips
// (PROP-007 ##IMAGESET-CONTAINERS, ##IMAGESET-ROUND-TRIP).
//
// The fixtures are written by test/fixtures/imageset/generate.mjs, an
// implementation that shares no code with these codecs and deliberately
// encodes differently (raw BGRA ICO frames, palette and Sub-filtered PNGs,
// two-character XPM codes). A pass here is therefore a comparison against a
// foreign encoder's output, not a read-back of our own.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeBmp, encodeBmp24, parseBmp } from '../../src/lib/imagesetBmp.ts';
import { encodeIcns, parseIcns } from '../../src/lib/imagesetIcns.ts';
import { encodeIco, parseIco } from '../../src/lib/imagesetIco.ts';
import { encodePng, rgba } from '../../src/lib/imagesetPng.ts';
import { encodeXpm, parseXpm } from '../../src/lib/imagesetXpm.ts';
import { isCkError } from '../../src/lib/messages.ts';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'imageset');
const shipped = (name: string) => readFileSync(join(fixtureRoot, name));

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

describe('ICO', () => {
	it('reads the shipped frame list in directory order', () => {
		expect(parseIco(shipped('code.ico')).frames).toEqual([
			{ width: 16, height: 16 },
			{ width: 32, height: 32 }
		]);
	});

	it('stores 256 in the directory as the zero byte', () => {
		const bytes = encodeIco([{ width: 256, height: 256, png: encodePng(rgba(4, 4, [1, 2, 3, 255])) }]);
		expect(bytes[6]).toBe(0);
		expect(bytes[7]).toBe(0);
		expect(parseIco(bytes).frames).toEqual([{ width: 256, height: 256 }]);
	});

	it('round-trips a multi-frame directory with order preserved', () => {
		const frames = [
			{ width: 16, height: 16, png: encodePng(rgba(16, 16, [1, 2, 3, 255])) },
			{ width: 256, height: 256, png: encodePng(rgba(32, 32, [4, 5, 6, 255])) }
		];
		expect(parseIco(encodeIco(frames)).frames).toEqual([
			{ width: 16, height: 16 },
			{ width: 256, height: 256 }
		]);
	});

	it('refuses a truncated directory', () => {
		expect(failure(() => parseIco(shipped('code.ico').subarray(0, 20))).code).toBe('ARTIFACT-BROKEN');
	});
});

describe('ICNS', () => {
	it('reads the shipped elements and reports the legacy chunk separately', () => {
		const structure = parseIcns(shipped('code.icns'));
		expect(structure.elements.filter((element) => element.pngCapable).map((element) => element.type)).toEqual(['ic11', 'ic07']);
		expect(structure.legacyTypes).toEqual(['info']);
	});

	it('round-trips the PNG-capable types at their fixed dimensions', () => {
		const elements = [
			{ type: 'ic11', png: encodePng(rgba(32, 32, [1, 2, 3, 255])) },
			{ type: 'ic10', png: encodePng(rgba(64, 64, [4, 5, 6, 255])) }
		];
		const structure = parseIcns(encodeIcns(elements));
		expect(structure.elements.map((element) => [element.type, element.width, element.height])).toEqual([
			['ic11', 32, 32],
			['ic10', 1024, 1024]
		]);
		expect(structure.legacyTypes).toEqual([]);
	});

	it('refuses to encode a legacy element type', () => {
		expect(failure(() => encodeIcns([{ type: 'ic04', png: encodePng(rgba(2, 2)) }])).code).toBe('ARTIFACT-BROKEN');
	});
});

describe('BMP', () => {
	it('reads the shipped installer header', () => {
		expect(parseBmp(shipped('inno-big-100.bmp'))).toEqual({ width: 32, height: 16, bitsPerPixel: 24 });
	});

	it('decodes and re-encodes the same raster, with alpha composited away', () => {
		const image = decodeBmp(shipped('inno-big-100.bmp'));
		expect(image.width).toBe(32);
		const reencoded = encodeBmp24(image);
		expect(parseBmp(reencoded)).toEqual({ width: 32, height: 16, bitsPerPixel: 24 });
		const round = decodeBmp(reencoded);
		expect(Buffer.from(round.data).equals(Buffer.from(image.data))).toBe(true);
	});

	it('paints the explicit background under transparent pixels', () => {
		const image = rgba(2, 2, [10, 20, 30, 0]);
		const bytes = encodeBmp24(image, { r: 200, g: 201, b: 202 });
		const back = decodeBmp(bytes);
		expect([...back.data.subarray(0, 4)]).toEqual([200, 201, 202, 255]);
	});
});

describe('XPM', () => {
	it('reads the shipped header, including two-character codes', () => {
		expect(parseXpm(shipped('code.xpm').toString('utf8'))).toEqual({ width: 64, height: 64, colors: 4, charsPerPixel: 2 });
	});

	it('encodes flat art with a small exact palette and one-char codes', () => {
		const image = rgba(6, 6);
		for (let at = 0; at < image.data.length; at += 4) {
			image.data[at] = 22;
			image.data[at + 1] = 122;
			image.data[at + 2] = 191;
			image.data[at + 3] = at % 8 === 0 ? 0 : 255;
		}
		const text = encodeXpm(image, 'code');
		expect(text).toContain('static char * code_xpm[] = {');
		expect(parseXpm(text)).toEqual({ width: 6, height: 6, colors: 2, charsPerPixel: 1 });
		expect(text).toContain('c None');
	});
});
