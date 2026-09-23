// The PNG interchange of the contract: round trip, the palette path a real
// distribution icon takes, every variant a master may come in, and the
// refusals (PROP-007 ##IMAGESET-CONTAINERS, ##IMAGESET-PNG-MASTERS).
//
// Both fixtures are icon files of the shape a distribution ships - a
// palette-with-tRNS one and a plain one - and every other file below is
// written by `support/pngVariants.ts`, so the decoder is proved against bytes
// written by an encoder that shares no code with it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, isPng, pngHeader, pngSize, rgba } from '../src/png.ts';
import { isBrokenArtifact } from '../src/refusal.ts';
import { writePng } from './support/pngVariants.ts';
import type { SampleSource, Variant } from './support/pngVariants.ts';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const EXPORT_HINT = 'export the master as an 8-bit RGBA PNG';

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

/** The 16-to-8-bit rule of ##IMAGESET-PNG-MASTERS, stated independently of the decoder. */
const from16 = (value: number) => Math.round((value * 255) / 65535);

/** Deterministic samples in [0, max] that differ from pixel to pixel and channel to channel. */
function pattern(channels: number, max: number): SampleSource {
	return (x, y) => Array.from({ length: channels }, (_, channel) => (x * 7919 + y * 104729 + channel * 1299709) % (max + 1));
}

/** The RGBA a variant's samples must decode to, computed from the format's rules. */
function expected(width: number, height: number, variant: Variant, samples: SampleSource): number[] {
	const out: number[] = [];
	const depth = variant.bitDepth;
	const to8 = (value: number) => (depth === 16 ? from16(value) : depth === 8 ? value : (value * 255) / ((1 << depth) - 1));
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const s = samples(x, y);
			if (variant.colorType === 3) {
				const entry = variant.palette?.[s[0] ?? 0] ?? [0, 0, 0];
				const alpha = variant.trns !== undefined && (s[0] ?? 0) < variant.trns.length ? (variant.trns[s[0] ?? 0] ?? 0) : 255;
				out.push(entry[0], entry[1], entry[2], alpha);
				continue;
			}
			const grey = variant.colorType === 0 || variant.colorType === 4;
			const colour = grey ? [s[0], s[0], s[0]] : [s[0], s[1], s[2]];
			out.push(...colour.map((value) => to8(value ?? 0)));
			if (variant.colorType === 4 || variant.colorType === 6) {
				out.push(to8(s[s.length - 1] ?? 0));
				continue;
			}
			const key =
				variant.trns === undefined
					? null
					: Array.from({ length: grey ? 1 : 3 }, (_, i) => ((variant.trns?.[i * 2] ?? 0) << 8) | (variant.trns?.[i * 2 + 1] ?? 0));
			const keyed = key !== null && key.every((value, i) => value === s[i]);
			out.push(keyed ? 0 : 255);
		}
	}
	return out;
}

const decoded = (bytes: Uint8Array) => Array.from(decodePng(bytes).data);

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

	it('decodes a palette PNG of the shape a distribution ships as its linux icon', () => {
		const image = decodePng(readFileSync(join(fixtureRoot, 'palette.png')));
		expect(image.width).toBe(64);
		expect(image.height).toBe(64);
		expect(image.data.length).toBe(64 * 64 * 4);
		expect(image.data[3]).toBeGreaterThanOrEqual(0);
	});

	it('decodes tRNS transparency of a palette image', () => {
		const image = decodePng(readFileSync(join(fixtureRoot, 'palette.png')));
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
		const size = pngSize(readFileSync(join(fixtureRoot, 'tile-70x70.png')));
		expect(size).toEqual({ width: 70, height: 70 });
	});

	it('recognises the signature', () => {
		expect(isPng(readFileSync(join(fixtureRoot, 'palette.png')))).toBe(true);
		expect(isPng(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]))).toBe(false);
	});
});

describe('a master with 16 bits per channel', () => {
	it('is brought to 8 bits by rounding value * 255 / 65535', () => {
		// The edges of the rounding: 128 is under half a step and 129 over it,
		// 32767 and 32768 fall either side of 127.5, 32896 is exactly 128 steps
		// and 65534 is within half a step of the top.
		const values = [0, 128, 129, 32767, 32768, 32896, 65534, 65535];
		const grey = decodePng(writePng(8, 1, { colorType: 0, bitDepth: 16 }, (x) => [values[x] ?? 0]));
		expect(Array.from({ length: 8 }, (_, x) => grey.data[x * 4])).toEqual([0, 0, 1, 127, 128, 128, 255, 255]);
		// Every channel of RGBA, alpha included, follows the same rule.
		const variant: Variant = { colorType: 6, bitDepth: 16 };
		const samples: SampleSource = (x) => [values[x] ?? 0, values[(x + 1) % 8] ?? 0, values[(x + 2) % 8] ?? 0, values[(x + 3) % 8] ?? 0];
		expect(decoded(writePng(8, 1, variant, samples))).toEqual(expected(8, 1, variant, samples));
	});

	it('reads grey, grey with alpha and RGB at 16 bits by the same rule', () => {
		for (const colorType of [0, 2, 4] as const) {
			const variant: Variant = { colorType, bitDepth: 16 };
			const samples = pattern({ 0: 1, 2: 3, 4: 2 }[colorType], 65535);
			expect(decoded(writePng(7, 5, variant, samples)), `colour type ${colorType}`).toEqual(expected(7, 5, variant, samples));
		}
	});
});

describe('grey below 8 bits', () => {
	it('scales a 1, 2 or 4-bit sample to the full 8-bit range', () => {
		for (const bitDepth of [1, 2, 4] as const) {
			const variant: Variant = { colorType: 0, bitDepth };
			const samples = pattern(1, (1 << bitDepth) - 1);
			expect(decoded(writePng(11, 3, variant, samples)), `${bitDepth} bits`).toEqual(expected(11, 3, variant, samples));
		}
		expect(decoded(writePng(4, 1, { colorType: 0, bitDepth: 2 }, (x) => [x]))).toEqual([
			0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255
		]);
	});
});

describe('tRNS', () => {
	it('makes the one grey value it names transparent, at the depth of the file', () => {
		for (const bitDepth of [2, 8, 16] as const) {
			const max = (1 << bitDepth) - 1;
			const key = Math.min(1, max);
			const variant: Variant = { colorType: 0, bitDepth, trns: Uint8Array.from([key >> 8, key & 0xff]) };
			const samples: SampleSource = (x) => [x % 2 === 0 ? key : max];
			const out = decoded(writePng(4, 1, variant, samples));
			expect(out, `${bitDepth} bits`).toEqual(expected(4, 1, variant, samples));
			expect([out[3], out[7]], `${bitDepth} bits`).toEqual([0, 255]);
		}
	});

	it('makes the one RGB colour it names transparent, sample by sample', () => {
		for (const bitDepth of [8, 16] as const) {
			const key = [10, 20, 30];
			const variant: Variant = { colorType: 2, bitDepth, trns: Uint8Array.from(key.flatMap((value) => [value >> 8, value & 0xff])) };
			// The second pixel differs from the key in blue only, and stays opaque.
			const samples: SampleSource = (x) => (x === 0 ? key : [10, 20, 31]);
			const out = decoded(writePng(2, 1, variant, samples));
			expect(out, `${bitDepth} bits`).toEqual(expected(2, 1, variant, samples));
			expect([out[3], out[7]], `${bitDepth} bits`).toEqual([0, 255]);
		}
	});

	it('gives each palette entry its own alpha, at every palette depth', () => {
		const palette = [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[9, 9, 9]
		] as const;
		for (const bitDepth of [2, 4, 8] as const) {
			const variant: Variant = { colorType: 3, bitDepth, palette, trns: Uint8Array.from([0, 128]) };
			const samples: SampleSource = (x, y) => [(x + y) % 4];
			expect(decoded(writePng(9, 3, variant, samples)), `${bitDepth} bits`).toEqual(expected(9, 3, variant, samples));
		}
	});
});

describe('the scanline filters', () => {
	it('undoes all five filter types, at every sample width', () => {
		const filters = [0, 1, 2, 3, 4] as const;
		for (const variant of [
			{ colorType: 6, bitDepth: 8, filters },
			{ colorType: 6, bitDepth: 16, filters },
			{ colorType: 0, bitDepth: 2, filters },
			{ colorType: 2, bitDepth: 16, filters }
		] as const) {
			const samples = pattern({ 0: 1, 2: 3, 6: 4 }[variant.colorType], (1 << variant.bitDepth) - 1);
			expect(decoded(writePng(13, 10, variant, samples)), JSON.stringify(variant)).toEqual(expected(13, 10, variant, samples));
		}
	});
});

describe('Adam7 interlacing', () => {
	it('puts the seven passes back together into the image a plain file carries', () => {
		const palette = Array.from({ length: 16 }, (_, index) => [index * 16, 255 - index * 16, index * 7] as const);
		const variants: Variant[] = [
			{ colorType: 6, bitDepth: 8, filters: [0, 1, 2, 3, 4] },
			{ colorType: 0, bitDepth: 16, filters: [4, 3, 2, 1, 0] },
			{ colorType: 3, bitDepth: 4, palette },
			{ colorType: 0, bitDepth: 1 }
		];
		for (const [width, height] of [
			[1, 1],
			[2, 2],
			[3, 2],
			[5, 9],
			[9, 5],
			[17, 13]
		] as const) {
			for (const variant of variants) {
				const samples = variant.colorType === 3 ? pattern(1, 15) : pattern(variant.colorType === 6 ? 4 : 1, (1 << variant.bitDepth) - 1);
				const label = `${width}x${height} ${JSON.stringify({ ...variant, palette: undefined })}`;
				const interlaced = decoded(writePng(width, height, { ...variant, interlaced: true }, samples));
				expect(interlaced, label).toEqual(decoded(writePng(width, height, variant, samples)));
				expect(interlaced, label).toEqual(expected(width, height, variant, samples));
			}
		}
	});
});

describe('pngHeader', () => {
	it('states the depth, the colour type and the interlacing without decoding a pixel', () => {
		const png = writePng(3, 2, { colorType: 6, bitDepth: 16, interlaced: true }, pattern(4, 65535));
		expect(pngHeader(png)).toEqual({ width: 3, height: 2, bitDepth: 16, colorType: 6, interlaced: true });
		expect(pngHeader(encodePng(rgba(2, 2)))).toEqual({ width: 2, height: 2, bitDepth: 8, colorType: 6, interlaced: false });
		expect(pngHeader(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});

describe('a file that is not a well-formed PNG', () => {
	/** A valid 2x2 RGBA file with one IHDR byte changed; the CRC is not what the decoder checks. */
	const withIhdrByte = (offset: number, value: number) => {
		const png = encodePng(rgba(2, 2, [1, 2, 3, 255]));
		png[16 + offset] = value;
		return png;
	};

	it('is refused with what is wrong with it and what to export instead', () => {
		const cases: [string, Uint8Array, RegExp][] = [
			['no signature', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]), /does not carry the PNG signature/],
			['colour type 5', withIhdrByte(9, 5), /colour type 5 is not one of the PNG colour types/],
			[
				'RGB at 4 bits',
				(() => {
					const png = withIhdrByte(9, 2);
					png[24] = 4;
					return png;
				})(),
				/RGB at 4 bits is not a PNG variant: RGB comes at 8, 16 bits/
			],
			['compression method 1', withIhdrByte(10, 1), /compression method 1 and filter method 0 are not the ones PNG defines/],
			['interlace method 2', withIhdrByte(12, 2), /interlace method 2 is neither none \(0\) nor Adam7 \(1\)/],
			['a palette image without PLTE', withIhdrByte(9, 3), /palette image carries no PLTE chunk/]
		];
		for (const [label, png, message] of cases) {
			const verdict = refusal(() => decodePng(png));
			expect(verdict.message, label).toMatch(message);
			expect(verdict.message.startsWith('PNG: '), label).toBe(true);
			expect(verdict.hint, label).toBe(EXPORT_HINT);
		}
	});

	it('refuses image data that does not fill the passes its header declares', () => {
		// The header says Adam7, the data is laid out as one plain pass: a 2x2
		// image needs 19 bytes interlaced and 18 plain.
		const verdict = refusal(() => decodePng(withIhdrByte(12, 1)));
		expect(verdict.message).toMatch(/holds 18 bytes, fewer than the 19 its dimensions need/);
		expect(verdict.hint).toBe(EXPORT_HINT);
	});

	it('refuses a scanline filter PNG does not define', () => {
		const png = writePng(2, 1, { colorType: 6, bitDepth: 8 }, pattern(4, 255));
		const verdict = refusal(() => decodePng(Uint8Array.from(withFilterByte(png, 5))));
		expect(verdict.message).toMatch(/scanline 0 carries filter type 5, which PNG does not define/);
		expect(verdict.hint).toBe(EXPORT_HINT);
	});
});

/** Rewrite the filter byte of the first scanline, re-deflating the image data. */
function withFilterByte(png: Uint8Array, filter: number): Buffer {
	// Chunks: signature, IHDR (25 bytes), then IDAT.
	const idatAt = 8 + 25;
	const length = Buffer.from(png).readUInt32BE(idatAt);
	const raw = inflateSync(Buffer.from(png.subarray(idatAt + 8, idatAt + 8 + length)));
	raw[0] = filter;
	const body = deflateSync(raw);
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write('IDAT', 4, 'latin1');
	return Buffer.concat([
		Buffer.from(png.subarray(0, idatAt)),
		head,
		body,
		Buffer.alloc(4),
		Buffer.from(png.subarray(idatAt + 12 + length))
	]);
}
