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
import { ckError } from './messages.js';
import { decodePng, encodePng, isBrokenArtifact } from '@codkit/type-api';
import { resizeRgba } from './imagesetRaster.js';
let resvgConstructor;
function loadResvg() {
    if (resvgConstructor !== undefined) {
        return resvgConstructor;
    }
    try {
        const module = createRequire(import.meta.url)('@resvg/resvg-js');
        resvgConstructor = module.Resvg;
    }
    catch {
        resvgConstructor = null;
    }
    return resvgConstructor;
}
function requireResvg() {
    const Resvg = loadResvg();
    if (Resvg === null) {
        throw ckError('DEPS-MISSING', 'the SVG rasteriser @resvg/resvg-js is not installed', 'restore the Codkit installation from approved supply (source checkouts may run npm ci); rendering an SVG master needs the native module');
    }
    return Resvg;
}
/** The measure of ##IMAGESET-STRETCH-REPORTED, one for every report. */
export function stretchOf(master, width, height) {
    const percent = Math.round(Math.abs((height * master.width) / (width * master.height) - 1) * 1000) / 10;
    return { master, percent, stretched: percent > 0 };
}
/** The one wording of a stretch, for every report that carries it. */
export function stretchPhrase(stretch) {
    return `stretched ${stretch.percent.toFixed(1)}% from the master's aspect`;
}
/** A size as the rasteriser gave it: whole where it is whole, its decimals where it is not. */
export function formatVectorSize(size) {
    return `${String(size.width)}x${String(size.height)}`;
}
/**
 * The intrinsic size of a vector master without rendering it: the rasteriser
 * parses the document with the options the render uses, so this is the very
 * size the render fits to the frame.
 */
export function vectorMasterSize(svg) {
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
export function renderSvgToRgba(svg, width, height) {
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
export function renderSvgToPng(svg, width, height) {
    const { image, stretch } = renderSvgToRgba(svg, width, height);
    return { png: encodePng(image), stretch };
}
/**
 * Run one call into the rasteriser, turning its own failure into a broken
 * master. A diagnosed error - a refusal of the PNG codec, or one of ours -
 * passes through untouched.
 */
function rasterising(run) {
    try {
        return run();
    }
    catch (error) {
        if (!(error instanceof Error) || (error.name !== 'CkError' && !isBrokenArtifact(error))) {
            throw ckError('ARTIFACT-BROKEN', `the SVG master does not rasterise: ${error instanceof Error ? error.message : String(error)}`, 'fix the master, or replace it with a raster master');
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
function treeSizeOf(resvg) {
    const root = /<svg\b[^>]*>/u.exec(resvg.toString())?.[0] ?? '';
    const width = rootLength(root, 'width');
    const height = rootLength(root, 'height');
    if (width === null || height === null) {
        throw ckError('ARTIFACT-BROKEN', 'the SVG rasteriser gave back no size for the master', 'fix the master, or replace it with a raster master');
    }
    return { width, height };
}
function rootLength(tag, name) {
    const raw = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag)?.[1];
    const value = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
}
