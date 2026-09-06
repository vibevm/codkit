/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-RASTER */
// Raster work the icon pipeline needs: Lanczos resampling for raster masters
// and palette quantisation for XPM (IMAGESET-RASTER). Hand-written on purpose
// - the one resampling-grade dependency in this space is sharp/libvips, which
// is LGPL and therefore outside the licence rule. The vector path never
// resamples at all: every size is rendered by the rasteriser at that size.

import type { Rgba } from './imagesetPng.ts';

/** Lanczos a-parameter; 3 is the usual quality/cost balance. */
const LANCZOS_A = 3;

/**
 * Resize an RGBA image with a separable Lanczos filter. Work happens on
 * premultiplied alpha so a transparent halo cannot bleed colour into opaque
 * pixels, and the result is clamped back to straight alpha at the end.
 */
export function resizeRgba(image: Rgba, width: number, height: number): Rgba {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(`resize target must be positive integers, got ${width}x${height}`);
	}
	if (image.width === width && image.height === height) {
		return { width, height, data: Uint8Array.from(image.data) };
	}
	const premultiplied = premultiply(image);
	const horizontal = resampleAxis(premultiplied, image.height, image.width, 'x', width);
	const both = resampleAxis(horizontal, width, image.height, 'y', height);
	return unpremultiply({ width, height, data: both });
}

/** Premultiply in place into a copy; the caller never wants the original mutated. */
function premultiply(image: Rgba): Float64Array {
	const out = new Float64Array(image.width * image.height * 4);
	for (let at = 0; at < out.length; at += 4) {
		const alpha = (image.data[at + 3] ?? 0) / 255;
		out[at] = (image.data[at] ?? 0) * alpha;
		out[at + 1] = (image.data[at + 1] ?? 0) * alpha;
		out[at + 2] = (image.data[at + 2] ?? 0) * alpha;
		out[at + 3] = image.data[at + 3] ?? 0;
	}
	return out;
}

function unpremultiply(image: { width: number; height: number; data: Float64Array }): Rgba {
	const out = new Uint8Array(image.width * image.height * 4);
	for (let at = 0; at < out.length; at += 4) {
		// Ringing can push the premultiplied alpha past 255; clamp, because a
		// Uint8Array assignment would silently wrap modulo 256 instead.
		const alpha = Math.min(255, Math.max(0, Math.round(image.data[at + 3] ?? 0)));
		out[at + 3] = alpha;
		if (alpha === 0) {
			continue;
		}
		const scale = 255 / alpha;
		out[at] = clampByte((image.data[at] ?? 0) * scale);
		out[at + 1] = clampByte((image.data[at + 1] ?? 0) * scale);
		out[at + 2] = clampByte((image.data[at + 2] ?? 0) * scale);
	}
	return { width: image.width, height: image.height, data: out };
}

/**
 * Resample one axis of a premultiplied RGBA buffer. `source` is row-major
 * RGBA in four doubles per sample; `lineLength` is the extent of the
 * untouched axis, `sourceSamples` the extent of the resampled one.
 */
function resampleAxis(
	source: Float64Array,
	lineLength: number,
	sourceSamples: number,
	axis: 'x' | 'y',
	targetSamples: number
): Float64Array {
	const total = (source.length / 4 / sourceSamples) * targetSamples;
	const result = new Float64Array(total * 4);
	const weights = lanczosWeights(sourceSamples, targetSamples);
	for (let line = 0; line < lineLength; line += 1) {
		for (let target = 0; target < targetSamples; target += 1) {
			const taps = weights[target] ?? [];
			let a = 0;
			let r = 0;
			let g = 0;
			let b = 0;
			for (const [offset, weight] of taps) {
				const base = axis === 'x' ? (line * sourceSamples + offset) * 4 : (offset * lineLength + line) * 4;
				a += (source[base + 3] ?? 0) * weight;
				r += (source[base] ?? 0) * weight;
				g += (source[base + 1] ?? 0) * weight;
				b += (source[base + 2] ?? 0) * weight;
			}
			const write = axis === 'x' ? (line * targetSamples + target) * 4 : (target * lineLength + line) * 4;
			result[write] = r;
			result[write + 1] = g;
			result[write + 2] = b;
			result[write + 3] = a;
		}
	}
	return result;
}

/** Per-output-pixel tap lists: [source index, weight], weights summing to 1. */
function lanczosWeights(sourceLength: number, targetLength: number): readonly (readonly (readonly [number, number])[])[] {
	const scale = Math.max(1, sourceLength / targetLength);
	const radius = LANCZOS_A * scale;
	const result: (readonly [number, number])[][] = [];
	for (let target = 0; target < targetLength; target += 1) {
		const center = ((target + 0.5) * sourceLength) / targetLength;
		const first = Math.max(0, Math.ceil(center - radius));
		const last = Math.min(sourceLength - 1, Math.floor(center + radius));
		const taps: [number, number][] = [];
		let total = 0;
		for (let source = first; source <= last; source += 1) {
			const distance = (source + 0.5 - center) / scale;
			const weight = lanczosKernel(distance);
			if (weight === 0) {
				continue;
			}
			taps.push([source, weight]);
			total += weight;
		}
		if (taps.length === 0) {
			taps.push([Math.min(sourceLength - 1, Math.max(0, Math.round(center - 0.5))), 1]);
			total = 1;
		}
		result.push(taps.map(([offset, weight]) => [offset, weight / total] as const));
	}
	return result;
}

function lanczosKernel(distance: number): number {
	if (distance === 0) {
		return 1;
	}
	const abs = Math.abs(distance);
	if (abs >= LANCZOS_A) {
		return 0;
	}
	const piDistance = Math.PI * distance;
	return (LANCZOS_A * Math.sin(piDistance) * Math.sin(piDistance / LANCZOS_A)) / (piDistance * piDistance);
}

function clampByte(value: number): number {
	return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

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
