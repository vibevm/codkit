/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-RENDER */
// Vector rasterisation (IMAGESET-RENDER): the one dependency of the icon
// pipeline, loaded lazily so that no other codkit command pays for it - or
// fails on a platform binary it never asked for. Every size is rendered from
// the SVG at that exact size; the vector path never resamples raster pixels.

import { createRequire } from 'node:module';
import { ckError } from './messages.ts';
import { decodePng, encodePng, isBrokenArtifact } from '@codkit/type-api';
import type { Rgba } from '@codkit/type-api';
import { resizeRgba } from './imagesetRaster.ts';

/** The module is a native optional dependency; one resolution is enough. */
type ResvgConstructor = new (
	svg: string,
	options: { fitTo: { mode: 'width' | 'height'; value: number } }
) => {
	render(): { asPng(): Buffer; width: number; height: number };
};

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

/**
 * Render an SVG master to RGBA at an exact size. The rasteriser fits the
 * drawing to the width; when the master's aspect does not match the target's,
 * the result is resampled to the exact height and the caller is told, because
 * a stretched banner is a design fact the operator should know about.
 */
export function renderSvgToRgba(svg: string, width: number, height: number): { image: Rgba; stretched: boolean } {
	const Resvg = loadResvg();
	if (Resvg === null) {
		throw ckError(
			'DEPS-MISSING',
			'the SVG rasteriser @resvg/resvg-js is not installed',
			'restore the Codkit installation from approved supply (source checkouts may run npm ci); rendering an SVG master needs the native module'
		);
	}
	let rendered: Rgba;
	try {
		const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
		rendered = decodePng(resvg.render().asPng());
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
	if (rendered.width === width && rendered.height === height) {
		return { image: rendered, stretched: false };
	}
	return { image: resizeRgba(rendered, width, height), stretched: true };
}

/** Render an SVG master straight to PNG bytes at an exact size. */
export function renderSvgToPng(svg: string, width: number, height: number): { png: Uint8Array; stretched: boolean } {
	const { image, stretched } = renderSvgToRgba(svg, width, height);
	return { png: encodePng(image), stretched };
}
