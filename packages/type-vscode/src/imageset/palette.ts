/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-RASTER */
// Palette quantisation (IMAGESET-RASTER): the raster work a palette container
// of this family needs, and nothing else needs. Exact colours come first, so a
// flat master keeps the small palette it deserves, and median cut fills the
// budget only when the master really carries more colours than fit.

import type { Rgba } from '@codkit/type-api';

/** A quantised palette entry: colour plus whether it stands for transparency. */
export type PaletteColor = {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly transparent: boolean;
};

/**
 * Build a palette for XPM output. Exact colours come first - a flat master
 * stays exact, like the distribution's own thirteen-colour icon - and median
 * cut fills the rest of the budget only when the image really has more
 * colours. Pixels below the alpha threshold collapse into one transparent
 * entry.
 */
export function quantisePalette(image: Rgba, maxColors: number, alphaThreshold = 128): readonly PaletteColor[] {
	const histogram = new Map<number, number>();
	let transparentPresent = false;
	for (let at = 0; at < image.data.length; at += 4) {
		if ((image.data[at + 3] ?? 0) < alphaThreshold) {
			transparentPresent = true;
			continue;
		}
		const key = ((image.data[at] ?? 0) << 16) | ((image.data[at + 1] ?? 0) << 8) | (image.data[at + 2] ?? 0);
		histogram.set(key, (histogram.get(key) ?? 0) + 1);
	}
	const distinct = [...histogram.entries()].map(([key, count]) => ({ r: (key >> 16) & 0xff, g: (key >> 8) & 0xff, b: key & 0xff, count }));
	distinct.sort((left, right) => left.count - right.count || colorKey(left) - colorKey(right));
	const exact = distinct.slice(-maxColors).map(({ r, g, b }) => ({ r, g, b, transparent: false }));
	const palette: PaletteColor[] = transparentPresent ? [{ r: 0, g: 0, b: 0, transparent: true }, ...exact] : [...exact];
	if (palette.length >= maxColors || distinct.length <= maxColors) {
		return palette;
	}
	const budget = transparentPresent ? maxColors - 1 : maxColors;
	const cut = medianCut(distinct, budget);
	return transparentPresent ? [{ r: 0, g: 0, b: 0, transparent: true }, ...cut] : cut;
}

/** Median cut over weighted colour populations, averaging each box. */
function medianCut(colors: readonly { r: number; g: number; b: number; count: number }[], budget: number): PaletteColor[] {
	type Box = { colors: { r: number; g: number; b: number; count: number }[]; population: number };
	let boxes: Box[] = [{ colors: [...colors], population: colors.reduce((sum, color) => sum + color.count, 0) }];
	while (boxes.length < budget) {
		let splitAt = -1;
		let widest = -1;
		for (let index = 0; index < boxes.length; index += 1) {
			const box = boxes[index];
			if (box === undefined || box.colors.length < 2) {
				continue;
			}
			const range = channelRange(box.colors);
			if (range.width > widest) {
				widest = range.width;
				splitAt = index;
			}
		}
		if (splitAt === -1) {
			break;
		}
		const box = boxes[splitAt];
		if (box === undefined) {
			break;
		}
		const channel = channelRange(box.colors).channel;
		const sorted = [...box.colors].sort((left, right) => left[channel] - right[channel]);
		let cumulative = 0;
		let median = 0;
		const half = box.population / 2;
		while (median < sorted.length - 1 && cumulative + (sorted[median]?.count ?? 0) < half) {
			cumulative += sorted[median]?.count ?? 0;
			median += 1;
		}
		const left = sorted.slice(0, median + 1);
		const right = sorted.slice(median + 1);
		if (left.length === 0 || right.length === 0) {
			break;
		}
		boxes = boxes
			.map((candidate, index) => (index === splitAt ? null : candidate))
			.filter((candidate): candidate is Box => candidate !== null);
		boxes.push(
			{ colors: left, population: left.reduce((sum, color) => sum + color.count, 0) },
			{ colors: right, population: right.reduce((sum, color) => sum + color.count, 0) }
		);
	}
	return boxes.map((box) => {
		let r = 0;
		let g = 0;
		let b = 0;
		let total = 0;
		for (const color of box.colors) {
			r += color.r * color.count;
			g += color.g * color.count;
			b += color.b * color.count;
			total += color.count;
		}
		const weight = total === 0 ? 1 : total;
		return { r: Math.round(r / weight), g: Math.round(g / weight), b: Math.round(b / weight), transparent: false };
	});
}

function channelRange(colors: readonly { r: number; g: number; b: number }[]): { channel: 'r' | 'g' | 'b'; width: number } {
	const spread = (pick: 'r' | 'g' | 'b') => {
		let low = 255;
		let high = 0;
		for (const color of colors) {
			low = Math.min(low, color[pick]);
			high = Math.max(high, color[pick]);
		}
		return high - low;
	};
	const r = spread('r');
	const g = spread('g');
	const b = spread('b');
	const width = Math.max(r, g, b);
	return { channel: r >= g && r >= b ? 'r' : g >= b ? 'g' : 'b', width };
}

function colorKey(color: { r: number; g: number; b: number }): number {
	return (color.r << 16) | (color.g << 8) | color.b;
}

/** The palette index a pixel maps to; a small cache keeps flat art cheap. */
export function nearestPaletteIndex(image: Rgba, at: number, palette: readonly PaletteColor[], alphaThreshold = 128): number {
	if ((image.data[at + 3] ?? 0) < alphaThreshold) {
		const transparent = palette.findIndex((color) => color.transparent);
		if (transparent !== -1) {
			return transparent;
		}
	}
	const r = image.data[at] ?? 0;
	const g = image.data[at + 1] ?? 0;
	const b = image.data[at + 2] ?? 0;
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < palette.length; index += 1) {
		const color = palette[index];
		if (color === undefined) {
			continue;
		}
		if (color.transparent) {
			continue;
		}
		const dr = r - color.r;
		const dg = g - color.g;
		const db = b - color.b;
		const distance = dr * dr + dg * dg + db * db;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = index;
		}
	}
	return best;
}
