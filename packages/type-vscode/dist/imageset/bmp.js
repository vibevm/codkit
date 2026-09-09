/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// BMP for installer art, hand-written (IMAGESET-CONTAINERS): the installer
// banner format is 24-bit bottom-up rows padded to four bytes, with the
// background painted explicitly because the format has no alpha. Parsing reads
// only the header - the width and height the distribution ships at every scale
// step are the target, and they are discovered from the files.
import { brokenArtifact, rgba } from '@codkit/type-api';
function broken(message, hint) {
    return brokenArtifact(`BMP: ${message}`, hint);
}
/** Read width, height and depth from a 'BM' file with a BITMAPINFOHEADER. */
export function parseBmp(bytes) {
    if (bytes.length < 54 || latin1(bytes, 0, 2) !== 'BM') {
        throw broken('file does not start with the BM signature', 'the target must be an intact .bmp file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint32(14, true);
    if (headerSize < 40) {
        throw broken(`DIB header of ${headerSize} bytes is not a BITMAPINFOHEADER`, 'the target must carry an ordinary 40-byte header');
    }
    const width = view.getInt32(18, true);
    const rawHeight = view.getInt32(22, true);
    const bitsPerPixel = view.getUint16(28, true);
    const compression = view.getUint32(30, true);
    if (compression !== 0) {
        throw broken(`compression ${compression} is not the uncompressed BI_RGB`, 'the target must be an uncompressed .bmp');
    }
    if (width <= 0 || rawHeight === 0) {
        throw broken(`nonsensical dimensions ${width}x${rawHeight}`, 'the target must be an intact .bmp file');
    }
    return { width, height: Math.abs(rawHeight), bitsPerPixel };
}
/**
 * Write installer art: 24-bit BGR, bottom-up, rows padded to four bytes, alpha
 * composited over an explicit background. The background is part of the
 * artifact's design, not an accident of the encoder.
 */
export function encodeBmp24(image, background = { r: 255, g: 255, b: 255 }) {
    const { width, height, data } = image;
    const rowLength = width * 3;
    const padding = (4 - (rowLength % 4)) % 4;
    const pixelBytes = height * (rowLength + padding);
    const out = new Uint8Array(54 + pixelBytes);
    const view = new DataView(out.buffer);
    latin1Into(out, 0, 'BM');
    view.setUint32(2, 54 + pixelBytes, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    for (let row = 0; row < height; row += 1) {
        let at = 54 + row * (rowLength + padding);
        for (let x = 0; x < width; x += 1) {
            const pixel = ((height - 1 - row) * width + x) * 4;
            const alpha = data[pixel + 3] ?? 0;
            out[at] = blend(data[pixel + 2] ?? 0, background.b, alpha);
            out[at + 1] = blend(data[pixel + 1] ?? 0, background.g, alpha);
            out[at + 2] = blend(data[pixel] ?? 0, background.r, alpha);
            at += 3;
        }
        for (let pad = 0; pad < padding; pad += 1) {
            out[at + pad] = 0;
        }
    }
    return out;
}
/**
 * Decode an uncompressed 24- or 32-bit BI_RGB 'BM' file to RGBA. This exists
 * for seeding - the distribution's own installer art is the day-one master -
 * so it covers exactly what parseBmp accepts.
 */
export function decodeBmp(bytes) {
    const structure = parseBmp(bytes);
    if (structure.bitsPerPixel !== 24 && structure.bitsPerPixel !== 32) {
        throw broken(`bit depth ${structure.bitsPerPixel} is not 24 or 32`, 'seeding needs an ordinary uncompressed installer bitmap');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const topDown = view.getInt32(22, true) < 0;
    const { width, height, bitsPerPixel } = structure;
    const channels = bitsPerPixel / 8;
    const rowLength = width * channels;
    const padding = (4 - (rowLength % 4)) % 4;
    const pixelStart = 14 + view.getUint32(14, true);
    if (pixelStart + height * (rowLength + padding) > bytes.length) {
        throw broken('pixel data ends before the file does', 'the target must be an intact .bmp file');
    }
    const out = rgba(width, height);
    for (let row = 0; row < height; row += 1) {
        const source = topDown ? row : height - 1 - row;
        let at = pixelStart + source * (rowLength + padding);
        for (let x = 0; x < width; x += 1) {
            const target = (row * width + x) * 4;
            out.data[target] = bytes[at + 2] ?? 0;
            out.data[target + 1] = bytes[at + 1] ?? 0;
            out.data[target + 2] = bytes[at] ?? 0;
            out.data[target + 3] = bitsPerPixel === 32 ? (bytes[at + 3] ?? 255) : 255;
            at += channels;
        }
    }
    return out;
}
function blend(foreground, background, alpha) {
    if (alpha === 255) {
        return foreground;
    }
    if (alpha === 0) {
        return background;
    }
    return Math.round((foreground * alpha + background * (255 - alpha)) / 255);
}
function latin1(bytes, start, length) {
    let out = '';
    for (let index = 0; index < length; index += 1) {
        out += String.fromCharCode(bytes[start + index] ?? 0);
    }
    return out;
}
function latin1Into(bytes, start, text) {
    for (let index = 0; index < text.length; index += 1) {
        bytes[start + index] = text.charCodeAt(index);
    }
}
