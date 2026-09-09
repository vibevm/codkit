/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// ICNS container, hand-written (IMAGESET-CONTAINERS): the 'icns' magic, a
// big-endian total length, then elements of <4-byte type><4-byte length
// including the 8-byte element header><payload>. The eight modern element
// types take a PNG verbatim as their payload, which is the whole reason no
// image-processing dependency is needed.
//
// The types the distribution actually carries are read from its file. Legacy
// element types (the compressed miniatures ic04/ic05, the 'info' property
// list, the pre-OS-X families) cannot hold a PNG and are reported as legacy
// rather than silently dropped: the honest structure of a regenerated file is
// the ordered list of PNG-capable elements the distribution shipped.
import { brokenArtifact, decodePng, isPng } from '@codkit/type-api';
/** The eight element types whose payload is a PNG, at their fixed dimensions. */
export const ICNS_PNG_TYPES = new Map([
    ['ic07', { width: 128, height: 128 }],
    ['ic08', { width: 256, height: 256 }],
    ['ic09', { width: 512, height: 512 }],
    ['ic10', { width: 1024, height: 1024 }],
    ['ic11', { width: 32, height: 32 }],
    ['ic12', { width: 64, height: 64 }],
    ['ic13', { width: 256, height: 256 }],
    ['ic14', { width: 512, height: 512 }]
]);
/** Legacy types with known dimensions, so discovery can still report sizes. */
const ICNS_LEGACY_DIMENSIONS = new Map([
    ['ic04', { width: 16, height: 16 }],
    ['ic05', { width: 32, height: 32 }]
]);
const ICNS_HEADER = 8;
function broken(message, hint) {
    return brokenArtifact(`ICNS: ${message}`, hint);
}
/** Read the element list of an .icns in file order, with sizes when known. */
export function parseIcns(bytes) {
    const elements = payloads(bytes).map(({ type, payload }) => {
        const known = ICNS_PNG_TYPES.get(type) ?? (isPng(payload) ? pngDimensions(payload) : (ICNS_LEGACY_DIMENSIONS.get(type) ?? null));
        return {
            type,
            width: known?.width ?? 0,
            height: known?.height ?? 0,
            pngCapable: ICNS_PNG_TYPES.has(type)
        };
    });
    return {
        elements,
        legacyTypes: elements.filter((element) => !element.pngCapable).map((element) => element.type)
    };
}
/**
 * The payload of every PNG-capable element, in file order. The legacy elements
 * are skipped for the same reason the encoder does not write them: they are
 * not PNG payloads and this codec does not reproduce them
 * (##IMAGESET-CONTAINERS). Nothing is re-encoded: the bytes are the ones the
 * distribution shipped.
 */
export function icnsElementPayloads(bytes) {
    const found = [];
    for (const { type, payload } of payloads(bytes)) {
        if (!ICNS_PNG_TYPES.has(type)) {
            continue;
        }
        if (!isPng(payload)) {
            throw broken(`element ${type} is a PNG-capable type carrying something that is not a PNG`, 'the target must be an intact .icns file');
        }
        found.push({ type, png: Uint8Array.from(payload) });
    }
    return found;
}
/** Walk the elements once, validating the file: both readers go through here. */
function payloads(bytes) {
    if (bytes.length < ICNS_HEADER) {
        throw broken('file is shorter than the 8-byte header', 'the target must be an intact .icns file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (latin1(bytes, 0, 4) !== 'icns') {
        throw broken('the magic is not icns', 'the target must be an .icns file');
    }
    const total = view.getUint32(4);
    if (total > bytes.length) {
        throw broken(`header announces ${total} bytes but the file holds ${bytes.length}`, 'the target must be an intact .icns file');
    }
    const out = [];
    let at = ICNS_HEADER;
    while (at < total) {
        if (at + ICNS_HEADER > total) {
            throw broken(`element at byte ${at} has no room for its header`, 'the target must be an intact .icns file');
        }
        const type = latin1(bytes, at, 4);
        const length = view.getUint32(at + 4);
        if (length < ICNS_HEADER || at + length > total) {
            throw broken(`element ${type} announces ${length} bytes, which does not fit the file`, 'the target must be an intact .icns file');
        }
        out.push({ type, payload: bytes.subarray(at + ICNS_HEADER, at + length) });
        at += length;
    }
    return out;
}
/** Build an .icns from PNG payloads, preserving the caller's element order. */
export function encodeIcns(elements) {
    if (elements.length === 0) {
        throw broken('cannot encode an empty element list', 'an .icns carries at least one element');
    }
    for (const element of elements) {
        if (!ICNS_PNG_TYPES.has(element.type)) {
            throw broken(`element type ${element.type} cannot carry a PNG payload`, 'regenerate only the PNG-capable types: ic07 to ic14');
        }
    }
    const total = ICNS_HEADER + elements.reduce((sum, element) => sum + element.png.length + ICNS_HEADER, 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    latin1Into(out, 0, 'icns');
    view.setUint32(4, total);
    let at = ICNS_HEADER;
    for (const element of elements) {
        latin1Into(out, at, element.type);
        view.setUint32(at + 4, element.png.length + ICNS_HEADER);
        out.set(element.png, at + ICNS_HEADER);
        at += element.png.length + ICNS_HEADER;
    }
    return out;
}
/** PNG IHDR dimensions, for payloads the fixed table does not describe. */
export function pngDimensions(bytes) {
    const decoded = decodePng(bytes);
    return { width: decoded.width, height: decoded.height };
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
