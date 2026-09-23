/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// PNG decode and encode, hand-written on purpose (IMAGESET-CONTAINERS): the
// image pipeline needs RGBA buffers for its containers and resamplers, and a
// full image-processing dependency would be the only non-permissive-licence
// risk in the closure. Decoding reads every variant the PNG format defines
// (IMAGESET-PNG-MASTERS) - grey at 1, 2, 4, 8 and 16 bits, RGB, grey with
// alpha and RGBA at 8 and 16 bits, a palette at 1, 2, 4 and 8 bits, tRNS in
// each, Adam7 interlacing - into 8 bits per channel, which is what the pipeline
// works in. A file that is not a well-formed PNG is refused with what is wrong
// with it and what to export instead, rather than decoded wrongly.
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
/** Every refusal says what to export instead: the one form every consumer reads. */
const EXPORT_HINT = 'export the master as an 8-bit RGBA PNG';
function broken(message) {
    return brokenArtifact(`PNG: ${message}`, EXPORT_HINT);
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
    const view = DataViewAny(bytes);
    if (latin1(bytes, 12, 4) !== 'IHDR') {
        return null;
    }
    return { width: view.getUint32(16), height: view.getUint32(20) };
}
/** The header a report needs - the bit depth above all - without decoding a pixel. */
export function pngHeader(bytes) {
    if (!isPng(bytes) || bytes.length < 29 || latin1(bytes, 12, 4) !== 'IHDR') {
        return null;
    }
    const view = DataViewAny(bytes);
    return {
        width: view.getUint32(16),
        height: view.getUint32(20),
        bitDepth: bytes[24] ?? 0,
        colorType: bytes[25] ?? -1,
        interlaced: (bytes[28] ?? 0) !== 0
    };
}
/** The colour types of the format: what each is called, its samples, the depths it may have. */
const COLOUR_TYPES = new Map([
    [0, { name: 'grey', channels: 1, depths: [1, 2, 4, 8, 16] }],
    [2, { name: 'RGB', channels: 3, depths: [8, 16] }],
    [3, { name: 'palette', channels: 1, depths: [1, 2, 4, 8] }],
    [4, { name: 'grey with alpha', channels: 2, depths: [8, 16] }],
    [6, { name: 'RGBA', channels: 4, depths: [8, 16] }]
]);
/** Adam7: the origin and the step of each of the seven passes, x then y. */
const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2]
];
/** A whole image read as one pass. */
const SINGLE_PASS = [[0, 0, 1, 1]];
/**
 * Decode a PNG into RGBA with 8 bits per channel. Every variant the format
 * defines is read: a 16-bit sample becomes round(value * 255 / 65535), a grey
 * sample of 1, 2 or 4 bits is scaled to the full 8-bit range, tRNS makes a
 * palette entry or one exact grey or RGB colour transparent, and an Adam7 image
 * is put back together from its seven passes.
 */
export function decodePng(bytes) {
    const { layout, data } = readPng(bytes);
    const out = rgba(layout.width, layout.height).data;
    let offset = 0;
    for (const [x0, y0, dx, dy] of layout.interlaced ? ADAM7 : SINGLE_PASS) {
        const passWidth = Math.ceil((layout.width - x0) / dx);
        const passHeight = Math.ceil((layout.height - y0) / dy);
        if (passWidth <= 0 || passHeight <= 0) {
            continue;
        }
        offset = decodePass(data, offset, passWidth, passHeight, layout, out, (x, y) => ((y0 + y * dy) * layout.width + x0 + x * dx) * 4);
    }
    return { width: layout.width, height: layout.height, data: out };
}
/** The chunks of a PNG, checked against the format, and its image data inflated. */
function readPng(bytes) {
    if (!isPng(bytes)) {
        throw broken('the file does not carry the PNG signature');
    }
    let ihdr = null;
    let palette = null;
    let transparency = null;
    const compressed = [];
    let at = 8;
    while (at + 8 <= bytes.length) {
        const length = DataViewAny(bytes).getUint32(at);
        const type = latin1(bytes, at + 4, 4);
        const bodyStart = at + 8;
        const bodyEnd = bodyStart + length;
        if (bodyEnd + 4 > bytes.length) {
            throw broken(`chunk ${type} runs past the end of the file`);
        }
        const body = bytes.subarray(bodyStart, bodyEnd);
        if (type === 'IHDR') {
            ihdr = Uint8Array.from(body);
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
    if (ihdr === null || ihdr.length < 13) {
        throw broken('no intact IHDR chunk was found');
    }
    const fields = DataViewAny(ihdr);
    const width = fields.getUint32(0);
    const height = fields.getUint32(4);
    const bitDepth = ihdr[8] ?? 0;
    const colorType = ihdr[9] ?? -1;
    const interlace = ihdr[12] ?? -1;
    if (width <= 0 || height <= 0) {
        throw broken(`the header gives the image a size of ${width}x${height}`);
    }
    const variant = COLOUR_TYPES.get(colorType);
    if (variant === undefined) {
        throw broken(`colour type ${colorType} is not one of the PNG colour types`);
    }
    if (!variant.depths.includes(bitDepth)) {
        throw broken(`${variant.name} at ${bitDepth} bits is not a PNG variant: ${variant.name} comes at ${variant.depths.join(', ')} bits`);
    }
    if ((ihdr[10] ?? -1) !== 0 || (ihdr[11] ?? -1) !== 0) {
        throw broken(`compression method ${ihdr[10] ?? -1} and filter method ${ihdr[11] ?? -1} are not the ones PNG defines (0 and 0)`);
    }
    if (interlace !== 0 && interlace !== 1) {
        throw broken(`interlace method ${interlace} is neither none (0) nor Adam7 (1)`);
    }
    if (colorType === 3 && palette === null) {
        throw broken('the palette image carries no PLTE chunk');
    }
    let data;
    try {
        data = inflateSync(Buffer.concat(compressed));
    }
    catch (error) {
        throw broken(`the image data does not inflate: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
        layout: {
            width,
            height,
            bitDepth,
            colorType,
            channels: variant.channels,
            interlaced: interlace === 1,
            palette,
            key: colourKey(colorType, transparency),
            paletteAlpha: colorType === 3 ? transparency : null
        },
        data
    };
}
/** tRNS of a grey or RGB image names one colour, sample by sample, that is transparent. */
function colourKey(colorType, transparency) {
    const samples = colorType === 0 ? 1 : colorType === 2 ? 3 : 0;
    if (transparency === null || samples === 0 || transparency.length < samples * 2) {
        return null;
    }
    const view = DataViewAny(transparency);
    return Array.from({ length: samples }, (_, index) => view.getUint16(index * 2));
}
/**
 * Undo the scanline filters of one pass and write its pixels through `place`,
 * which maps a pixel of the pass to its byte offset in the image. Returns where
 * the next pass starts in the inflated data.
 */
function decodePass(data, start, width, height, layout, out, place) {
    const bytesPerRow = Math.ceil((width * layout.channels * layout.bitDepth) / 8);
    const stride = bytesPerRow + 1;
    if (data.length < start + stride * height) {
        throw broken(`the image data holds ${data.length} bytes, fewer than the ${start + stride * height} its dimensions need`);
    }
    const unit = Math.max(1, (layout.channels * layout.bitDepth) / 8);
    const previous = new Uint8Array(bytesPerRow);
    const line = new Uint8Array(bytesPerRow);
    for (let row = 0; row < height; row += 1) {
        const filter = data[start + row * stride] ?? 0;
        const source = data.subarray(start + row * stride + 1, start + row * stride + 1 + bytesPerRow);
        for (let index = 0; index < bytesPerRow; index += 1) {
            const left = index >= unit ? (line[index - unit] ?? 0) : 0;
            const up = previous[index] ?? 0;
            const upperLeft = index >= unit ? (previous[index - unit] ?? 0) : 0;
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
                throw broken(`scanline ${row} carries filter type ${filter}, which PNG does not define`);
            }
            line[index] = reconstructed & 0xff;
        }
        for (let x = 0; x < width; x += 1) {
            writePixel(line, x, layout, out, place(x, row));
        }
        previous.set(line);
    }
    return start + stride * height;
}
/** One pixel of a reconstructed scanline, as straight RGBA with 8 bits per channel. */
function writePixel(line, x, layout, out, target) {
    const { bitDepth, channels, colorType } = layout;
    const first = x * channels;
    if (colorType === 3) {
        const index = sampleAt(line, first, bitDepth);
        const entry = (layout.palette ?? new Uint8Array()).subarray(index * 3, index * 3 + 3);
        out[target] = entry[0] ?? 0;
        out[target + 1] = entry[1] ?? 0;
        out[target + 2] = entry[2] ?? 0;
        out[target + 3] = layout.paletteAlpha !== null && index < layout.paletteAlpha.length ? (layout.paletteAlpha[index] ?? 0) : 255;
        return;
    }
    const grey = colorType === 0 || colorType === 4;
    const red = sampleAt(line, first, bitDepth);
    const green = grey ? red : sampleAt(line, first + 1, bitDepth);
    const blue = grey ? red : sampleAt(line, first + 2, bitDepth);
    out[target] = to8(red, bitDepth);
    out[target + 1] = to8(green, bitDepth);
    out[target + 2] = to8(blue, bitDepth);
    if (colorType === 4 || colorType === 6) {
        out[target + 3] = to8(sampleAt(line, first + channels - 1, bitDepth), bitDepth);
        return;
    }
    const key = layout.key;
    const keyed = key !== null && red === key[0] && (grey || (green === key[1] && blue === key[2]));
    out[target + 3] = keyed ? 0 : 255;
}
/** The n-th sample of a scanline at the image's own depth; below 8 bits, MSB first within a byte. */
function sampleAt(line, index, bitDepth) {
    if (bitDepth === 16) {
        return ((line[index * 2] ?? 0) << 8) | (line[index * 2 + 1] ?? 0);
    }
    if (bitDepth === 8) {
        return line[index] ?? 0;
    }
    const perByte = 8 / bitDepth;
    const at = Math.floor(index / perByte);
    const shift = 8 - bitDepth * ((index % perByte) + 1);
    return ((line[at] ?? 0) >> shift) & (0xff >> (8 - bitDepth));
}
/** A sample at its own depth brought to 8 bits: rounded down from 16, scaled up from 1, 2 or 4. */
function to8(value, bitDepth) {
    if (bitDepth === 16) {
        return Math.round((value * 255) / 65535);
    }
    if (bitDepth === 8) {
        return value;
    }
    return (value * 255) / ((1 << bitDepth) - 1);
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
