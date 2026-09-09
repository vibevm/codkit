// imageset raster work: Lanczos resampling invariants and palette
// quantisation (PROP-007 ##IMAGESET-RASTER).

import { describe, expect, it } from 'vitest';
import { rgba } from '../../src/lib/imagesetPng.ts';
import { nearestPaletteIndex, quantisePalette, resizeRgba } from '../../src/lib/imagesetRaster.ts';

describe('resizeRgba', () => {
	it('keeps a constant image constant', () => {
		const small = resizeRgba(rgba(64, 64, [10, 20, 30, 255]), 16, 16);
		for (let at = 0; at < small.data.length; at += 4) {
			expect([...small.data.subarray(at, at + 4)]).toEqual([10, 20, 30, 255]);
		}
	});

	it('returns equal pixels for an identity resize', () => {
		const image = rgba(12, 9);
		for (let at = 0; at < image.data.length; at += 4) {
			image.data[at] = (at * 11) % 256;
			image.data[at + 1] = (at * 17) % 256;
			image.data[at + 2] = (at * 23) % 256;
			image.data[at + 3] = 255;
		}
		const same = resizeRgba(image, 12, 9);
		expect(Buffer.from(same.data).equals(Buffer.from(image.data))).toBe(true);
	});

	it('keeps an opaque interior opaque and a transparent exterior transparent', () => {
		const image = rgba(16, 16);
		for (let y = 4; y < 12; y += 1) {
			for (let x = 4; x < 12; x += 1) {
				const at = (y * 16 + x) * 4;
				image.data[at] = 200;
				image.data[at + 1] = 100;
				image.data[at + 2] = 50;
				image.data[at + 3] = 255;
			}
		}
		const small = resizeRgba(image, 8, 8);
		const center = (4 * 8 + 4) * 4;
		expect(small.data[center + 3]).toBe(255);
		// The filter blends a little of the transparent margin in; the colour
		// must stay recognisably the interior one, not drift to the halo.
		const expected = [200, 100, 50];
		for (let channel = 0; channel < 3; channel += 1) {
			expect(Math.abs((small.data[center + channel] ?? 0) - (expected[channel] ?? 0))).toBeLessThanOrEqual(8);
		}
		expect(small.data[3]).toBe(0);
	});

	it('resizes non-uniformly to the exact requested dimensions', () => {
		const weird = resizeRgba(rgba(20, 10, [1, 2, 3, 255]), 7, 13);
		expect(weird.width).toBe(7);
		expect(weird.height).toBe(13);
	});
});

describe('quantisePalette', () => {
	it('keeps flat art exact and small', () => {
		const image = rgba(8, 8);
		for (let at = 0; at < image.data.length; at += 4) {
			const corner = (at / 4) % 2 === 0;
			image.data[at] = corner ? 22 : 250;
			image.data[at + 1] = corner ? 122 : 250;
			image.data[at + 2] = corner ? 191 : 250;
			image.data[at + 3] = 255;
		}
		const palette = quantisePalette(image, 92);
		expect(palette.length).toBe(2);
	});

	it('adds exactly one transparent entry for transparent pixels', () => {
		const image = rgba(4, 4, [9, 9, 9, 0]);
		const palette = quantisePalette(image, 92);
		expect(palette.filter((color) => color.transparent)).toHaveLength(1);
		expect(nearestPaletteIndex(image, 0, palette)).toBe(palette.findIndex((color) => color.transparent));
	});

	it('bounds the palette when the image really has more colours', () => {
		const image = rgba(32, 32);
		for (let at = 0; at < image.data.length; at += 4) {
			image.data[at] = at % 256;
			image.data[at + 1] = (at * 3) % 256;
			image.data[at + 2] = (at * 7) % 256;
			image.data[at + 3] = 255;
		}
		const palette = quantisePalette(image, 16);
		expect(palette.length).toBeLessThanOrEqual(16);
		expect(palette.length).toBeGreaterThan(1);
	});
});
