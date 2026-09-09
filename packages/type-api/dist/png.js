/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// PNG decode and encode, hand-written on purpose (IMAGESET-CONTAINERS): the
// image pipeline needs RGBA buffers for its containers and resamplers, and a
// full image-processing dependency would be the only non-permissive-licence
// risk in the closure. Scope: the PNG subset masters actually use - 8-bit
// gray/RGB/RGBA, palette images at depths 1/2/4/8, tRNS transparency, no
// interlacing. Anything else is refused with a diagnosable message instead of
// decoded wrongly.
//
// It lives in the contract package because PNG is the language the contract
// speaks: a codec of a project type hands the engine `ImagePayload.png` and
// takes it back, so the engine and every type must encode and decode the
// interchange the same way, byte for byte. Duplicating it per package would
// make "the same picture" a matter of luck (##TYPE-API-STABILITY).
import { deflateSync, inflateSync } from 'node:zlib';
import { brokenArtifact } from './refusal.js';
export function rgba(width, height, fill) {
    const data = new Uint8Array(width * height * 4);
    if (fill !== undefined) {
        for (let at = 0; at < data.length; at += 4) {
            data[at] = fill[0];
            data[at + 1] = fill[1];
            data[at + 2] = fill[2];
            data[at + 3] = fill[3];
        }
    }
    return { width, height, data };
}
function broken(message, hint) {
    return brokenArtifact(`PNG: ${message}`, hint);
}
/** The PNG signature every payload is checked against. */
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function isPng(bytes) {
    return bytes.length >= 8 && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}
/** Header-only dimensions: discovery needs sizes, not pixels. */
export function pngSize(bytes) {
    if (!isPng(bytes) || bytes.length < 24) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (latin1(bytes, 12, 4) !== 'IHDR') {
        return null;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
}
/** Decode a PNG into RGBA. Interlaced and 16-bit images are refused, not guessed. */
export function decodePng(bytes) {
    if (!isPng(bytes)) {
        throw broken('payload does not carry the PNG signature', 'supply an ordinary 8-bit PNG as the master');
    }
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    let interlace = -1;
    let palette = null;
    let transparency = null;
    const compressed = [];
    let at = 8;
    while (at + 8 <= bytes.length) {
        const view = DataViewAny(bytes);
        const length = view.getUint32(at);
        const type = latin1(bytes, at + 4, 4);
        const bodyStart = at + 8;
        const bodyEnd = bodyStart + length;
        if (bodyEnd + 4 > bytes.length) {
            throw broken(`chunk ${type} runs past the end of the file`, 'supply an intact PNG as the master');
        }
        const body = bytes.subarray(bodyStart, bodyEnd);
        if (type === 'IHDR') {
            const header = DataViewAny(body);
            width = header.getUint32(0);
            height = header.getUint32(4);
            bitDepth = body[8] ?? 0;
            colorType = body[9] ?? -1;
            interlace = body[12] ?? -1;
        }
        else if (type === 'PLTE') {
            palette = Uint8Array.from(body);
        }
        else if (type === 'tRNS') {
            transparency = Uint8Array.from(body);
        }
        else if (type === 'IDAT') {
            compressed.push(Buffer.from(body));
        }
        else if (type === 'IEND') {
            break;
        }
        at = bodyEnd + 4;
    }
    if (width <= 0 || height <= 0 || colorType === -1) {
        throw broken('no intact IHDR chunk was found', 'supply an ordinary PNG as the master');
    }
    if (interlace !== 0) {
        throw broken('interlaced PNG masters are not supported', 'save the master without Adam7 interlacing');
    }
    if (colorType !== 3 && bitDepth !== 8) {
        throw broken(`bit depth ${bitDepth} outside palette mode is not supported`, 'save the master as 8-bit gray, RGB or RGBA');
    }
    const channels = channelsOf(colorType);
    let raw;
    try {
        raw = inflateSync(Buffer.concat(compressed));
    }
    catch (error) {
        throw broken(`image data does not inflate: ${error instanceof Error ? error.message : String(error)}`, 'supply an intact PNG as the master');
    }
    return unfilter(raw, width, height, channels, bitDepth, colorType, palette, transparency);
}
function channelsOf(colorType) {
    if (colorType === 0)
        return 1;
    if (colorType === 2)
        return 3;
    if (colorType === 3)
        return 1;
    if (colorType === 4)
        return 2;
    if (colorType === 6)
        return 4;
    throw broken(`color type ${colorType} is not a PNG color type`, 'supply an ordinary gray, RGB, palette or RGBA PNG');
}
/**
 * Undo the per-scanline filters and expand to RGBA. Palette entries resolve
 * through PLTE, with tRNS supplying the alpha of palette indices.
 */
function unfilter(raw, width, height, channels, bitDepth, colorType, palette, transparency) {
    if (colorType === 3 && palette === null) {
        throw broken('palette image carries no PLTE chunk', 'save the master without stripping its palette');
    }
    const bitsPerRow = width * channels * bitDepth;
    const bytesPerRow = Math.ceil(bitsPerRow / 8);
    const stride = bytesPerRow + 1;
    if (raw.length < stride * height) {
        throw broken(`image data is ${raw.length} bytes, expected at least ${stride * height}`, 'supply an intact PNG as the master');
    }
    const out = rgba(width, height).data;
    const previous = new Uint8Array(bytesPerRow);
    const line = new Uint8Array(bytesPerRow);
    for (let row = 0; row < height; row += 1) {
        const filter = raw[row * stride] ?? 0;
        const source = raw.subarray(row * stride + 1, row * stride + 1 + bytesPerRow);
        for (let index = 0; index < bytesPerRow; index += 1) {
            const left = index >= channelsInBytes(channels, bitDepth) ? (line[index - channelsInBytes(channels, bitDepth)] ?? 0) : 0;
            const up = previous[index] ?? 0;
            const upperLeft = index >= channelsInBytes(channels, bitDepth) ? (previous[index - channelsInBytes(channels, bitDepth)] ?? 0) : 0;
            const value = source[index] ?? 0;
            let reconstructed;
            if (filter === 0) {
                reconstructed = value;
            }
            else if (filter === 1) {
                reconstructed = value + left;
            }
            else if (filter === 2) {
                reconstructed = value + up;
            }
            else if (filter === 3) {
                reconstructed = value + Math.floor((left + up) / 2);
            }
            else if (filter === 4) {
                const p = left + up - upperLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - upperLeft);
                reconstructed = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft);
            }
            else {
                throw broken(`scanline ${row} carries filter type ${filter}`, 'supply an ordinary PNG as the master');
            }
            line[index] = reconstructed & 0xff;
        }
        expandRow(line, out, row, width, channels, bitDepth, colorType, palette, transparency);
        previous.set(line);
    }
    return { width, height, data: out };
}
function channelsInBytes(channels, bitDepth) {
    return Math.max(1, (channels * bitDepth) / 8);
}
/** One reconstructed scanline to RGBA pixels in the output buffer. */
function expandRow(line, out, row, width, channels, bitDepth, colorType, palette, transparency) {
    for (let x = 0; x < width; x += 1) {
        const target = (row * width + x) * 4;
        if (colorType === 3) {
            const index = readSubByte(line, x, bitDepth);
            const entry = (palette ?? new Uint8Array()).subarray(index * 3, index * 3 + 3);
            out[target] = entry[0] ?? 0;
            out[target + 1] = entry[1] ?? 0;
            out[target + 2] = entry[2] ?? 0;
            out[target + 3] = transparency !== null && index < transparency.length ? (transparency[index] ?? 0) : 255;
            continue;
        }
        if (colorType === 0) {
            const gray = line[x] ?? 0;
            const alpha = colorType === 0 && transparency !== null && transparency.length >= 2 ? (transparency[1] ?? 255) : 255;
            out[target] = gray;
            out[target + 1] = gray;
            out[target + 2] = gray;
            out[target + 3] = alpha;
            continue;
        }
        const base = x * channels;
        if (colorType === 4) {
            out[target] = line[base] ?? 0;
            out[target + 1] = line[base] ?? 0;
            out[target + 2] = line[base] ?? 0;
            out[target + 3] = line[base + 1] ?? 255;
            continue;
        }
        out[target] = line[base] ?? 0;
        out[target + 1] = line[base + 1] ?? 0;
        out[target + 2] = line[base + 2] ?? 0;
        out[target + 3] = colorType === 6 ? (line[base + 3] ?? 255) : 255;
    }
}
/** Palette indices at depths below eight share bytes; MSB-first within a byte. */
function readSubByte(line, index, bitDepth) {
    if (bitDepth === 8) {
        return line[index] ?? 0;
    }
    const perByte = 8 / bitDepth;
    const at = Math.floor(index / perByte);
    const shift = 8 - bitDepth * ((index % perByte) + 1);
    return ((line[at] ?? 0) >> shift) & (0xff >> (8 - bitDepth));
}
/**
 * Encode RGBA as a deterministic PNG: RGBA 8-bit, filter type 0 per scanline,
 * one IDAT, fixed deflate level. Determinism is what makes "regenerate twice,
 * diff is empty" a meaningful property of the generated artifacts.
 */
export function encodePng(image) {
    const { width, height, data } = image;
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let row = 0; row < height; row += 1) {
        raw[row * (stride + 1)] = 0;
        Buffer.from(data.buffer, data.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const chunks = [chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
    const total = 8 + chunks.reduce((sum, bytes) => sum + bytes.length, 0);
    const out = new Uint8Array(total);
    out.set(PNG_SIGNATURE, 0);
    let at = 8;
    for (const bytes of chunks) {
        out.set(bytes, at);
        at += bytes.length;
    }
    return out;
}
function chunk(type, body) {
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    view.setUint32(0, body.length);
    for (let index = 0; index < 4; index += 1) {
        out[4 + index] = type.charCodeAt(index);
    }
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
}
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
        let candidate = value;
        for (let bit = 0; bit < 8; bit += 1) {
            candidate = (candidate & 1) !== 0 ? 0xedb88320 ^ (candidate >>> 1) : candidate >>> 1;
        }
        table[value] = candidate >>> 0;
    }
    return table;
})();
/** Standard PNG CRC-32; small enough to carry, and it keeps encode self-contained. */
function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
        crc = (CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function latin1(bytes, start, length) {
    let out = '';
    for (let index = 0; index < length; index += 1) {
        out += String.fromCharCode(bytes[start + index] ?? 0);
    }
    return out;
}
function DataViewAny(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
