/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-RASTER */
// Resampling a raster master (IMAGESET-RASTER). Hand-written on purpose - the
// one resampling-grade dependency in this space is sharp/libvips, which is LGPL
// and therefore outside the licence rule. The vector path never resamples at
// all: every size is rendered by the rasteriser at that size.
//
// This is the engine's half of the raster work: every container wants its
// frames at the sizes the distribution ships, whatever the container is. The
// quantisation a palette container needs is that container's business and
// travels with its codec.
/** Lanczos a-parameter; 3 is the usual quality/cost balance. */
const LANCZOS_A = 3;
/**
 * Resize an RGBA image with a separable Lanczos filter. Work happens on
 * premultiplied alpha so a transparent halo cannot bleed colour into opaque
 * pixels, and the result is clamped back to straight alpha at the end.
 */
export function resizeRgba(image, width, height) {
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
function premultiply(image) {
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
function unpremultiply(image) {
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
function resampleAxis(source, lineLength, sourceSamples, axis, targetSamples) {
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
function lanczosWeights(sourceLength, targetLength) {
    const scale = Math.max(1, sourceLength / targetLength);
    const radius = LANCZOS_A * scale;
    const result = [];
    for (let target = 0; target < targetLength; target += 1) {
        const center = ((target + 0.5) * sourceLength) / targetLength;
        const first = Math.max(0, Math.ceil(center - radius));
        const last = Math.min(sourceLength - 1, Math.floor(center + radius));
        const taps = [];
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
        result.push(taps.map(([offset, weight]) => [offset, weight / total]));
    }
    return result;
}
function lanczosKernel(distance) {
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
function clampByte(value) {
    return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
