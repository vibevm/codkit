/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// The containers this family of distributions stores its brand images in, as
// the contract's `ImageCodec` (##IMAGESET-CONTAINERS).
//
// The engine never names one of them. It looks a codec up by the `kind` of the
// target it is working on and asks it for everything: the frames a file
// carries, the picture of each frame as PNG bytes, the bytes of a regenerated
// file, and the sentences a report says about the container. Everything the
// codecs need beyond that - the PNG interchange, the refusal shape - comes from
// `@codkit/type-api`, which is the only import a type package takes.
//
// PNG is both a container of this family and the language every codec speaks,
// so its codec is the identity one: a payload the engine rendered is written
// out unchanged and read back unchanged.
import { brokenArtifact, decodePng, encodePng, pngSize } from '@codkit/type-api';
import { decodeBmp, encodeBmp24, parseBmp } from './bmp.js';
import { encodeIcns, icnsElementPayloads, ICNS_PNG_TYPES, parseIcns } from './icns.js';
import { encodeIco, icoFramePayloads, parseIco } from './ico.js';
import { parseSvg } from './svg.js';
import { encodeXpm, parseXpm } from './xpm.js';
/** Installer art has no alpha channel; the backdrop is part of the design. */
const BMP_BACKGROUND = { r: 255, g: 255, b: 255 };
/** The element an .icns falls back to when a frame arrives without its type. */
const ICNS_DEFAULT_TYPE = 'ic07';
const TRANSPARENCY_KEPT = 'transparency is expected and preserved end to end';
function frame(width, height, type, pngCapable) {
    return { width, height, type, pngCapable };
}
function only(payloads, kind) {
    const single = payloads[0];
    if (payloads.length !== 1 || single === undefined) {
        throw brokenArtifact(`${kind.toUpperCase()}: a single-frame container was handed ${payloads.length} payloads`, 'the engine renders exactly one frame for a container that carries one');
    }
    return single.png;
}
/**
 * The application and file-type icons of Windows: several frames of one drawing
 * in one directory. The frames the distribution ships are what is regenerated,
 * and every one of them is written as a PNG payload.
 */
export const icoCodec = {
    kind: 'ico',
    extension: '.ico',
    layered: true,
    vector: false,
    // The icon families that carry an .ico carry an .icns or a .png as well, and
    // those hold the drawing at a larger size than any .ico frame does.
    seedsMasters: false,
    constraints: [TRANSPARENCY_KEPT],
    parse: (bytes) => parseIco(bytes).frames.map((entry) => frame(entry.width, entry.height, null, true)),
    legacyTypes: () => [],
    extract: (bytes) => icoFramePayloads(bytes).map((entry) => entry.png),
    encode: (payloads) => encodeIco(payloads.map((item) => ({ width: item.frame.width, height: item.frame.height, png: item.png })))
};
/**
 * The application and file-type icons of macOS: named elements, of which only
 * the eight PNG-capable ones are reproduced. The rest are reported as legacy
 * rather than silently dropped.
 */
export const icnsCodec = {
    kind: 'icns',
    extension: '.icns',
    layered: true,
    vector: false,
    seedsMasters: true,
    constraints: [TRANSPARENCY_KEPT],
    parse: (bytes) => parseIcns(bytes)
        .elements.filter((element) => element.pngCapable)
        .map((element) => frame(element.width, element.height, element.type, true)),
    legacyTypes: (bytes) => parseIcns(bytes).legacyTypes,
    extract: (bytes) => icnsElementPayloads(bytes).map((element) => element.png),
    encode: (payloads) => encodeIcns(payloads.map((item) => ({ type: item.frame.type ?? ICNS_DEFAULT_TYPE, png: item.png })))
};
/** The one container that is also the interchange: written and read verbatim. */
export const pngCodec = {
    kind: 'png',
    extension: '.png',
    layered: false,
    vector: false,
    seedsMasters: true,
    constraints: [TRANSPARENCY_KEPT],
    parse: (bytes) => {
        const size = pngSize(bytes);
        if (size === null) {
            throw brokenArtifact('not a PNG', 'the target must be an intact .png file');
        }
        return [frame(size.width, size.height, null, true)];
    },
    legacyTypes: () => [],
    extract: (bytes) => [Uint8Array.from(bytes)],
    encode: (payloads) => only(payloads, 'png')
};
/** The installer bitmaps: no alpha, so the backdrop is part of the design. */
export const bmpCodec = {
    kind: 'bmp',
    extension: '.bmp',
    layered: false,
    vector: false,
    seedsMasters: true,
    constraints: ['no alpha channel: transparent pixels of the master are composited onto an explicit white background'],
    parse: (bytes) => {
        const structure = parseBmp(bytes);
        return [frame(structure.width, structure.height, null, false)];
    },
    legacyTypes: () => [],
    extract: (bytes) => [encodePng(decodeBmp(bytes))],
    encode: (payloads) => encodeBmp24(decodePng(only(payloads, 'bmp')), BMP_BACKGROUND)
};
/** The RPM package icon: a palette container, so it cannot seed a master. */
export const xpmCodec = {
    kind: 'xpm',
    extension: '.xpm',
    layered: false,
    vector: false,
    // Quantisation is lossy in exactly the direction a master must not be.
    seedsMasters: false,
    constraints: ['palette-quantised on write; transparent pixels become the XPM `None` colour'],
    parse: (bytes) => {
        const structure = parseXpm(new TextDecoder().decode(bytes));
        return [frame(structure.width, structure.height, null, false)];
    },
    legacyTypes: () => [],
    extract: () => [null],
    encode: (payloads, stem) => new TextEncoder().encode(encodeXpm(decodePng(only(payloads, 'xpm')), stem))
};
/**
 * The watermarks: a vector document the application loads as a vector, so the
 * master IS the artifact and nothing is rasterised (##IMAGESET-SVG-PASSTHROUGH).
 */
export const svgCodec = {
    kind: 'svg',
    extension: '.svg',
    layered: false,
    vector: true,
    seedsMasters: true,
    constraints: ['a vector target: the master is emitted unchanged, nothing is rasterised'],
    parse: (bytes) => {
        const size = parseSvg(new TextDecoder().decode(bytes));
        if (size === null) {
            throw brokenArtifact('not an SVG document with usable dimensions', 'the target must be an intact .svg file');
        }
        return [frame(size.width, size.height, null, false)];
    },
    legacyTypes: () => [],
    // A vector master is copied, never extracted frame by frame.
    extract: () => [null],
    encode: () => {
        throw brokenArtifact('SVG: a vector target is emitted from its master unchanged and is never encoded', 'the engine copies the master of a vector target instead of rendering it');
    }
};
export const codecs = [icoCodec, icnsCodec, pngCodec, bmpCodec, xpmCodec, svgCodec];
/** The element types an .icns reproduces, for this package's own suite. */
export { ICNS_PNG_TYPES };
