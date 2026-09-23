// imageset container codecs against the committed fixture binaries - the
// "shipped" icon set of a distribution - and their own round trips
// (PROP-007 ##IMAGESET-CONTAINERS, ##IMAGESET-ROUND-TRIP).
//
// The fixtures are written by fixtures/imageset/generate.mjs, an implementation
// that shares no code with these codecs and deliberately encodes differently
// (raw BGRA ICO frames, palette and Sub-filtered PNGs, two-character XPM
// codes). A pass here is therefore a comparison against a foreign encoder's
// output, not a read-back of our own.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, isBrokenArtifact, rgba } from '@codkit/type-api';
import { decodeBmp, encodeBmp24, parseBmp } from '../src/imageset/bmp.ts';
import { encodeIcns, icnsElementPayloads, parseIcns } from '../src/imageset/icns.ts';
import { encodeIco, icoFramePayloads, parseIco } from '../src/imageset/ico.ts';
import { encodeXpm, parseXpm } from '../src/imageset/xpm.ts';
import { codecs } from '../src/imageset/codecs.ts';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'imageset');
const shipped = (name: string) => readFileSync(join(fixtureRoot, name));
const codecOf = (kind: string) => codecs.find((codec) => codec.kind === kind) ?? fail(kind);

function fail(kind: string): never {
	throw new Error(`no codec for ${kind}`);
}

function refusal(run: () => unknown): { message: string; hint: string } {
	try {
		run();
	} catch (error) {
		if (isBrokenArtifact(error)) {
			return { message: error.message, hint: error.hint };
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
		expect(refusal(() => parseIco(shipped('code.ico').subarray(0, 20))).message).toMatch(/^ICO: /);
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
		expect(refusal(() => encodeIcns([{ type: 'ic04', png: encodePng(rgba(2, 2)) }])).message).toMatch(/^ICNS: /);
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

describe('the codecs the engine sees', () => {
	it('gives the ICO frames back as PNG payloads, whatever the shipped file stores', () => {
		const bytes = shipped('code.ico');
		const frames = codecOf('ico').parse(bytes);
		const payloads = codecOf('ico').extract(bytes);
		expect(frames.map((frame) => [frame.width, frame.height])).toEqual([
			[16, 16],
			[32, 32]
		]);
		expect(payloads.length).toBe(frames.length);
		for (const payload of payloads) {
			expect(payload).not.toBeNull();
		}
		expect(icoFramePayloads(bytes).map((frame) => frame.width)).toEqual([16, 32]);
	});

	it('gives the ICNS elements back verbatim and names the legacy ones', () => {
		const bytes = shipped('code.icns');
		expect(
			codecOf('icns')
				.parse(bytes)
				.map((frame) => frame.type)
		).toEqual(['ic11', 'ic07']);
		expect(codecOf('icns').legacyTypes(bytes)).toEqual(['info']);
		expect(icnsElementPayloads(bytes).map((element) => element.type)).toEqual(['ic11', 'ic07']);
	});

	it('says which containers seed a master and which are vector', () => {
		expect(
			codecs
				.filter((codec) => codec.seedsMasters)
				.map((codec) => codec.kind)
				.sort()
		).toEqual(['bmp', 'icns', 'png', 'svg']);
		expect(codecs.filter((codec) => codec.vector).map((codec) => codec.kind)).toEqual(['svg']);
	});

	it('writes a single-frame container from the payload the engine rendered', () => {
		const image = rgba(3, 3, [7, 8, 9, 255]);
		const png = encodePng(image);
		const frame = { width: 3, height: 3, type: null, pngCapable: true };
		expect(Buffer.from(codecOf('png').encode([{ frame, png }], 'code')).equals(Buffer.from(png))).toBe(true);
		expect(parseBmp(codecOf('bmp').encode([{ frame, png }], 'code'))).toEqual({ width: 3, height: 3, bitsPerPixel: 24 });
		expect(new TextDecoder().decode(codecOf('xpm').encode([{ frame, png }], 'code'))).toContain('static char * code_xpm[] = {');
	});

	it('refuses to encode a vector target, whose master is copied instead', () => {
		expect(refusal(() => codecOf('svg').encode([], 'letterpress-dark')).message).toMatch(/^SVG: /);
	});

	it('reads the size of a vector document out of its bytes', () => {
		expect(codecOf('svg').parse(shipped('letterpress.svg'))).toEqual([{ width: 64, height: 64, type: null, pngCapable: false }]);
	});

	it('takes a declared frame set for ICO alone, in the declared order, and says why it refuses one', () => {
		// spec://codkit/modules/vscode/PROP-006#IMAGESET-ICO-FRAME-SET
		expect(codecs.filter((codec) => codec.declaredFrames !== undefined).map((codec) => codec.kind)).toEqual(['ico']);
		const declared = codecOf('ico').declaredFrames;
		expect(declared?.problem([256, 16, 40])).toBeNull();
		expect(declared?.frames([256, 16, 40])).toEqual([
			{ width: 256, height: 256, type: null, pngCapable: true },
			{ width: 16, height: 16, type: null, pngCapable: true },
			{ width: 40, height: 40, type: null, pngCapable: true }
		]);
		expect(declared?.problem([])).toBe('an ICO carries at least one frame, and the list is empty');
		expect(declared?.problem([16, 300])).toBe('an ICO frame is square, 1 to 256 pixels a side, and 300 is not');
		expect(declared?.problem([1, 256])).toBeNull();
		expect(declared?.problem([24, 24])).toBe('the size 24 is listed twice, and an ICO carries one frame of a size');
		// An added frame is written like a kept one: a PNG payload in list order.
		const frames = declared?.frames([48, 20]) ?? [];
		const bytes = codecOf('ico').encode(
			frames.map((frame) => ({ frame, png: encodePng(rgba(frame.width, frame.height, [1, 2, 3, 255])) })),
			'code'
		);
		expect(parseIco(bytes).frames).toEqual([
			{ width: 48, height: 48 },
			{ width: 20, height: 20 }
		]);
		expect(icoFramePayloads(bytes).every((frame) => decodePng(frame.png).width === frame.width)).toBe(true);
	});
});

describe('the pixels a container gives back', () => {
	it('decodes a raw DIB frame into the pixels a foreign encoder drew', () => {
		const frames = icoFramePayloads(shipped('code.ico'));
		const elements = icnsElementPayloads(shipped('code.icns'));
		const frame32 = frames.find((frame) => frame.width === 32);
		const element32 = elements.find((element) => element.type === 'ic11');

		// Same artwork, two unrelated encodings: a bottom-up BGRA DIB with an
		// AND mask, and a top-down RGBA PNG. Decoded, they must be identical.
		const left = decodePng(frame32?.png ?? new Uint8Array());
		const right = decodePng(element32?.png ?? new Uint8Array());
		expect(left.width).toBe(32);
		expect(Buffer.from(left.data)).toEqual(Buffer.from(right.data));
	});

	it('halves the doubled DIB height instead of reading the AND mask as pixels', () => {
		const frames = icoFramePayloads(shipped('code.ico'));
		expect(frames.map((frame) => `${frame.width}x${frame.height}`)).toEqual(['16x16', '32x32']);
		for (const frame of frames) {
			const image = decodePng(frame.png);
			expect(image.height).toBe(frame.height);
			expect(image.data.length).toBe(frame.width * frame.height * 4);
		}
	});

	it('reads a PNG frame through the same door', () => {
		const drawing = rgba(64, 64, [10, 20, 30, 255]);
		const bytes = encodeIco([{ width: 64, height: 64, png: encodePng(drawing) }]);
		expect(Buffer.from(decodePng(icoFramePayloads(bytes)[0]?.png ?? new Uint8Array()).data)).toEqual(Buffer.from(drawing.data));
	});

	it('refuses a frame whose DIB height is neither its own nor twice it', () => {
		const bytes = Buffer.from(shipped('code.ico'));
		const offset = bytes.readUInt32LE(6 + 12);
		bytes.writeInt32LE(17, offset + 8);
		expect(refusal(() => icoFramePayloads(bytes)).message).toMatch(/^ICO: /);
	});
});
