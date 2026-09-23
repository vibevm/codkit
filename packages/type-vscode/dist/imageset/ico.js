/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// ICO container, hand-written (IMAGESET-CONTAINERS): a 6-byte header, 16 bytes
// of directory per frame and one payload each. Payloads here are PNG - legal
// in .ico since Vista and what the rasteriser produces anyway - so no
// DIB-with-mask encoding is needed. The directory byte for 256 is zero, the
// one value that cannot be stored in a byte.
//
// Parsing exists for target discovery: the structure of the file the
// distribution ships - how many frames, at which sizes, in which order - is
// read from that file, never assumed.
//
// Reading the PIXELS of a shipped frame is a second job, and it needs more
// than the directory: the distribution writes its large frame as a PNG but its
// small ones as headerless 32-bit DIBs with a doubled height - an XOR image
// followed by an AND mask - which is the .ico form that predates the PNG
// payload. decodeIcoFrames covers both, so the round trip of ##IMAGESET-VERIFY
// can compare a regenerated layer against the layer the distribution ships.
import { decodeBmp } from './bmp.js';
import { brokenArtifact, decodePng, encodePng, isPng } from '@codkit/type-api';
/** The DIB header a raw frame carries in place of a PNG signature. */
const BITMAPINFOHEADER = 40;
/** The 'BM' file header decodeBmp expects in front of that DIB. */
const BMP_FILE_HEADER = 14;
const ICO_DIRECTORY_ENTRY = 16;
const ICO_HEADER = 6;
function broken(message, hint) {
    return brokenArtifact(`ICO: ${message}`, hint);
}
/** Read the frame list of an .ico: sizes in directory order, 0 meaning 256. */
export function parseIco(bytes) {
    return { frames: directory(bytes).map((entry) => ({ width: entry.width, height: entry.height })) };
}
/**
 * Every frame as PNG bytes, in directory order. Both payload forms are covered
 * because the distribution ships both in one file, and a reader that could only
 * take the PNG one would silently skip the small frames - exactly the sizes
 * where a regenerated layer differs most.
 */
export function icoFramePayloads(bytes) {
    return directory(bytes).map((entry) => {
        const payload = bytes.subarray(entry.offset, entry.offset + entry.length);
        const stored = isPng(payload);
        const image = stored ? decodePng(payload) : decodeIcoDib(payload, entry.width, entry.height);
        if (image.width !== entry.width || image.height !== entry.height) {
            throw broken(`the directory announces a ${entry.width}x${entry.height} frame whose payload is ${image.width}x${image.height}`, 'the target must be an intact .ico file');
        }
        return { width: entry.width, height: entry.height, png: stored ? Uint8Array.from(payload) : encodePng(image) };
    });
}
/** The directory, validated once: both readers walk the file through this. */
function directory(bytes) {
    if (bytes.length < ICO_HEADER) {
        throw broken('file is shorter than the 6-byte header', 'the target must be an intact .ico file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = view.getUint16(2, true);
    const count = view.getUint16(4, true);
    if (type !== 1) {
        throw broken(`resource type ${type} is not an icon directory`, 'the target must be an .ico file, not a cursor directory');
    }
    if (count === 0) {
        throw broken('directory lists no frames', 'the target must carry at least one frame');
    }
    if (bytes.length < ICO_HEADER + count * ICO_DIRECTORY_ENTRY) {
        throw broken(`directory announces ${count} frames but the file ends inside it`, 'the target must be an intact .ico file');
    }
    const entries = [];
    for (let index = 0; index < count; index += 1) {
        const at = ICO_HEADER + index * ICO_DIRECTORY_ENTRY;
        const length = view.getUint32(at + 8, true);
        const offset = view.getUint32(at + 12, true);
        if (offset + length > bytes.length) {
            throw broken(`frame ${index} announces ${length} bytes at ${offset}, past the end of the file`, 'the target must be an intact .ico file');
        }
        entries.push({ width: byteOr256(bytes[at] ?? 0), height: byteOr256(bytes[at + 1] ?? 0), offset, length });
    }
    return entries;
}
/**
 * A raw frame: a BITMAPINFOHEADER whose declared height covers the XOR image
 * and the 1-bit AND mask stacked on top of each other, then the pixels. Halve
 * that height, put a 'BM' file header in front of the XOR half, and the frame
 * is an ordinary bottom-up bitmap the BMP decoder already reads. The AND mask
 * is deliberately dropped: these frames are 32-bit, so their own alpha channel
 * is the transparency, and folding the mask in would change pixels the shipped
 * file does not change.
 */
function decodeIcoDib(payload, width, height) {
    if (payload.length < BITMAPINFOHEADER) {
        throw broken(`a ${width}x${height} frame is neither a PNG nor long enough to hold a DIB header`, 'the target must be an intact .ico file');
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const headerSize = view.getUint32(0, true);
    const declaredHeight = view.getInt32(8, true);
    const paletteEntries = view.getUint32(32, true);
    if (headerSize < BITMAPINFOHEADER) {
        throw broken(`a ${width}x${height} frame carries a ${headerSize}-byte DIB header`, 'the frame must carry an ordinary 40-byte BITMAPINFOHEADER');
    }
    if (paletteEntries !== 0) {
        throw broken(`a ${width}x${height} frame carries a ${paletteEntries}-colour table, which codkit does not read`, 'the frame must be a palette-free 24- or 32-bit DIB, or a PNG payload');
    }
    // The doubled height is what says "icon DIB"; a frame that already declares
    // the image height is taken at its word rather than halved into nonsense.
    const xorHeight = declaredHeight === height ? height : Math.trunc(declaredHeight / 2);
    if (xorHeight !== height) {
        throw broken(`a ${width}x${height} frame declares a DIB height of ${declaredHeight}`, 'an .ico frame declares either its own height or twice it, the second half being the AND mask');
    }
    const file = new Uint8Array(BMP_FILE_HEADER + payload.length);
    file.set(payload, BMP_FILE_HEADER);
    const out = new DataView(file.buffer);
    file[0] = 0x42;
    file[1] = 0x4d;
    out.setUint32(2, file.length, true);
    out.setUint32(10, BMP_FILE_HEADER + headerSize, true);
    out.setInt32(BMP_FILE_HEADER + 8, xorHeight, true);
    return decodeBmp(file);
}
/** The largest frame a directory byte can state; 256 itself is stored as 0. */
const ICO_LARGEST_FRAME = 256;
/**
 * Why a declared list of square sizes cannot be the frames of an .ico, or null
 * when it can (spec://codkit/modules/vscode/PROP-006#IMAGESET-ICO-FRAME-SET):
 * at least one frame, every size a whole number of pixels from 1 to 256 - the
 * most a directory byte states - and no size twice, because the writer puts
 * exactly one frame of a size into the file.
 */
export function icoFrameSetProblem(sizes) {
    if (sizes.length === 0) {
        return 'an ICO carries at least one frame, and the list is empty';
    }
    const seen = new Set();
    for (const size of sizes) {
        if (!Number.isInteger(size) || size < 1 || size > ICO_LARGEST_FRAME) {
            return `an ICO frame is square, 1 to ${ICO_LARGEST_FRAME} pixels a side, and ${String(size)} is not`;
        }
        if (seen.has(size)) {
            return `the size ${size} is listed twice, and an ICO carries one frame of a size`;
        }
        seen.add(size);
    }
    return null;
}
/**
 * Build an .ico from rendered PNG payloads. Frames keep the caller's order:
 * that order is part of what the distribution's own file declared, or of what
 * the product declared in its place.
 */
export function encodeIco(frames) {
    if (frames.length === 0 || frames.length > 0xffff) {
        throw broken(`cannot encode ${frames.length} frames`, 'an .ico carries between 1 and 65535 frames');
    }
    const out = new Uint8Array(ICO_HEADER + frames.length * ICO_DIRECTORY_ENTRY + frames.reduce((sum, frame) => sum + frame.png.length, 0));
    const view = new DataView(out.buffer);
    view.setUint16(0, 0, true);
    view.setUint16(2, 1, true);
    view.setUint16(4, frames.length, true);
    let offset = ICO_HEADER + frames.length * ICO_DIRECTORY_ENTRY;
    frames.forEach((frame, index) => {
        const at = ICO_HEADER + index * ICO_DIRECTORY_ENTRY;
        out[at] = widthByte(frame.width);
        out[at + 1] = widthByte(frame.height);
        out[at + 2] = 0;
        out[at + 3] = 0;
        view.setUint16(at + 4, 1, true);
        view.setUint16(at + 6, 32, true);
        view.setUint32(at + 8, frame.png.length, true);
        view.setUint32(at + 12, offset, true);
        out.set(frame.png, offset);
        offset += frame.png.length;
    });
    return out;
}
function byteOr256(value) {
    return value === 0 ? 256 : value;
}
function widthByte(value) {
    return value >= 256 ? 0 : value;
}
