/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-RENDER */
// Vector rasterisation (IMAGESET-RENDER): the one dependency of the icon
// pipeline, loaded lazily so that no other codkit command pays for it - or
// fails on a platform binary it never asked for. Every size is rendered from
// the SVG at that exact size; the vector path never resamples raster pixels.
//
// A master whose aspect is not the frame's is still delivered at the exact
// size, and how far that stretches the drawing is measured here, once, from
// the rasteriser's own reading of the document: the run takes it from the
// render it just made, and a prediction that renders nothing takes it from the
// same parse, so the two cannot disagree (##IMAGESET-STRETCH-REPORTED).

import { createRequire } from 'node:module';
import { ckError } from './messages.ts';
import { decodePng, encodePng, isBrokenArtifact } from '@codkit/type-api';
import type { Rgba } from '@codkit/type-api';
import { resizeRgba } from './imagesetRaster.ts';

/** The one instance surface the pipeline uses: a render, and the parsed document back. */
type ResvgInstance = {
	render(): { asPng(): Buffer; width: number; height: number };
	toString(): string;
};

/** The module is a native optional dependency; one resolution is enough. */
type ResvgConstructor = new (svg: string, options?: { fitTo: { mode: 'width' | 'height'; value: number } }) => ResvgInstance;

let resvgConstructor: ResvgConstructor | null | undefined;

function loadResvg(): ResvgConstructor | null {
	if (resvgConstructor !== undefined) {
		return resvgConstructor;
	}
	try {
		const module = createRequire(import.meta.url)('@resvg/resvg-js') as { Resvg: ResvgConstructor };
		resvgConstructor = module.Resvg;
	} catch {
		resvgConstructor = null;
	}
	return resvgConstructor;
}

function requireResvg(): ResvgConstructor {
	const Resvg = loadResvg();
	if (Resvg === null) {
		throw ckError(
			'DEPS-MISSING',
			'the SVG rasteriser @resvg/resvg-js is not installed',
			'restore the Codkit installation from approved supply (source checkouts may run npm ci); rendering an SVG master needs the native module'
		);
	}
	return Resvg;
}

/** The intrinsic size of a vector master, in the units the rasteriser resolved it to. */
export type VectorSize = { readonly width: number; readonly height: number };

/**
 * How far one frame stretches the drawing of a vector master: for the master's
 * intrinsic size w x h and the frame W x H, |H*w / (W*h) - 1| as a percentage
 * rounded to one decimal - how far the frame's height departs from the height
 * the master's own aspect gives it at the frame's width.
 */
export type VectorStretch = {
	readonly master: VectorSize;
	readonly percent: number;
	/** True when the rounded figure is at least 0.1. */
	readonly stretched: boolean;
};

/** The measure of ##IMAGESET-STRETCH-REPORTED, one for every report. */
export function stretchOf(master: VectorSize, width: number, height: number): VectorStretch {
	const percent = Math.round(Math.abs((height * master.width) / (width * master.height) - 1) * 1000) / 10;
	return { master, percent, stretched: percent > 0 };
}

/** The one wording of a stretch, for every report that carries it. */
export function stretchPhrase(stretch: VectorStretch): string {
	return `stretched ${stretch.percent.toFixed(1)}% from the master's aspect`;
}

/** A size as the rasteriser gave it: whole where it is whole, its decimals where it is not. */
export function formatVectorSize(size: VectorSize): string {
	return `${String(size.width)}x${String(size.height)}`;
}

/**
 * The intrinsic size of a vector master without rendering it: the rasteriser
 * parses the document with the options the render uses, so this is the very
 * size the render fits to the frame.
 */
export function vectorMasterSize(svg: string): VectorSize {
	const Resvg = requireResvg();
	return rasterising(() => treeSizeOf(new Resvg(svg)));
}

/**
 * Render an SVG master to RGBA at an exact size. The rasteriser fits the
 * drawing to the width; when the master's aspect does not match the target's,
 * the result is resampled to the exact height, and the caller is told how far
 * the drawing is stretched, because a stretched banner is a design fact the
 * operator should know about.
 */
export function renderSvgToRgba(svg: string, width: number, height: number): { image: Rgba; stretch: VectorStretch } {
	const Resvg = requireResvg();
	const { rendered, master } = rasterising(() => {
		const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
		return { rendered: decodePng(resvg.render().asPng()), master: treeSizeOf(resvg) };
	});
	const stretch = stretchOf(master, width, height);
	if (rendered.width === width && rendered.height === height) {
		return { image: rendered, stretch };
	}
	return { image: resizeRgba(rendered, width, height), stretch };
}

/** Render an SVG master straight to PNG bytes at an exact size. */
export function renderSvgToPng(svg: string, width: number, height: number): { png: Uint8Array; stretch: VectorStretch } {
	const { image, stretch } = renderSvgToRgba(svg, width, height);
	return { png: encodePng(image), stretch };
}

/**
 * Run one call into the rasteriser, turning its own failure into a broken
 * master. A diagnosed error - a refusal of the PNG codec, or one of ours -
 * passes through untouched.
 */
function rasterising<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (!(error instanceof Error) || (error.name !== 'CkError' && !isBrokenArtifact(error))) {
			throw ckError(
				'ARTIFACT-BROKEN',
				`the SVG master does not rasterise: ${error instanceof Error ? error.message : String(error)}`,
				'fix the master, or replace it with a raster master'
			);
		}
		throw error;
	}
}

/**
 * The size of the parsed tree, which the rasteriser writes on the root element
 * of the document it gives back. Its width and height getters are not read:
 * they round that size to whole pixels, and a master drawn at a fractional size
 * would then be reported stretched at a frame the render fills exactly.
 */
function treeSizeOf(resvg: ResvgInstance): VectorSize {
	const root = /<svg\b[^>]*>/u.exec(resvg.toString())?.[0] ?? '';
	const width = rootLength(root, 'width');
	const height = rootLength(root, 'height');
	if (width === null || height === null) {
		throw ckError(
			'ARTIFACT-BROKEN',
			'the SVG rasteriser gave back no size for the master',
			'fix the master, or replace it with a raster master'
		);
	}
	return { width, height };
}

function rootLength(tag: string, name: string): number | null {
	const raw = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag)?.[1];
	const value = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(value) && value > 0 ? value : null;
}
