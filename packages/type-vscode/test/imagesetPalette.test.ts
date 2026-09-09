// Palette quantisation: the raster work the palette container of this family
// needs (PROP-007 ##IMAGESET-RASTER).

import { describe, expect, it } from 'vitest';
import { rgba } from '@codkit/type-api';
import { nearestPaletteIndex, quantisePalette } from '../src/imageset/palette.ts';

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
