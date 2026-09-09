/** @scope spec://codkit/modules/codkit/PROP-008#renames */
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { bytesEqual, decodeUtf8Strict } from './bytes.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
export function captureFileState(root, path) {
    const bytes = readOptionalBytes(root, path);
    return { path, bytes: optionalBase64(bytes), mode: bytes === null ? null : portableMode(containedRenamePath(root, path, false)) };
}
export function readOptionalBytes(root, path) {
    const absolute = containedRenamePath(root, path, true);
    try {
        return readFileSync(absolute);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw stateError(`cannot read ${path}: ${messageOf(error)}`);
    }
}
export function sameFileState(root, path, expectedBytes, expectedMode) {
    return sameOptional(readOptionalBytes(root, path), expectedBytes) && portableModeOptional(root, path) === expectedMode;
}
export function matchesUnmodedTempState(root, expected, modes, temps, targetTemp, expectedBytes, finalMode) {
    for (const [path, bytes] of expected)
        if (!sameFileState(root, path, bytes, modes.get(path) ?? null))
            return false;
    for (const temp of temps) {
        if (temp !== targetTemp) {
            if (!sameFileState(root, temp, null, null))
                return false;
            continue;
        }
        const bytes = readOptionalBytes(root, temp);
        const mode = portableModeOptional(root, temp);
        if (bytes === null || toBase64(bytes) !== expectedBytes || mode === null || mode === finalMode)
            return false;
    }
    return true;
}
export function containedRenamePath(root, path, allowMissing) {
    const result = resolveContainedPath(root, path, allowMissing ? { allowMissing: true } : {});
    if (!result.ok)
        throw stateError(`unsafe path ${path}: ${result.reason}`);
    return result.absolute;
}
export function portableMode(path) {
    return statSync(path).mode & 0o777;
}
export function portableModeOptional(root, path) {
    return readOptionalBytes(root, path) === null ? null : portableMode(containedRenamePath(root, path, false));
}
export function modeBindings(initial) {
    return initial.map(({ path, mode }) => ({ path, mode }));
}
export function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
export function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
export function countOccurrences(text, search) {
    let count = 0;
    for (let offset = 0;;) {
        const found = text.indexOf(search, offset);
        if (found < 0)
            return count;
        count += 1;
        offset = found + search.length;
    }
}
export function canonicalBase64(value) {
    return Buffer.from(value, 'base64').toString('base64') === value;
}
export function toBase64(bytes) {
    return Buffer.from(bytes).toString('base64');
}
export function fromBase64(value) {
    return Buffer.from(value, 'base64');
}
export function optionalBase64(bytes) {
    return bytes === null ? null : toBase64(bytes);
}
export function writeControlExclusive(root, path, text) {
    const absolute = containedRenamePath(root, path, true);
    mkdirSync(posix.dirname(absolute), { recursive: true });
    containedRenamePath(root, path, true);
    const temp = containedRenamePath(root, `${path}.${randomUUID()}.tmp`, true);
    try {
        writeFileSync(temp, text, { flag: 'wx' });
        linkSync(temp, absolute);
        unlinkSync(temp);
    }
    catch (error) {
        tryRemove(temp);
        throw stateError(`cannot create ${path} exclusively: ${messageOf(error)}`);
    }
}
export function removeRequired(root, path) {
    try {
        unlinkSync(containedRenamePath(root, path, false));
    }
    catch (error) {
        throw stateError(`cannot remove completed ${path}: ${messageOf(error)}`);
    }
}
export function readCanonical(root, path, schema) {
    const bytes = readOptionalBytes(root, path);
    if (bytes === null)
        return null;
    const text = decodeUtf8Strict(bytes);
    if (text === null || !text.endsWith('\n') || text.endsWith('\n\n') || text.includes('\r')) {
        throw stateError(`${path} is not canonical UTF-8 JSON`);
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw stateError(`${path} is invalid JSON: ${messageOf(error)}`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
        throw stateError(`${path} failed validation: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
    if (text !== `${JSON.stringify(parsed.data, null, 2)}\n`)
        throw stateError(`${path} bytes are not canonical JSON`);
    return parsed.data;
}
function sameOptional(actual, expected) {
    return actual === null ? expected === null : expected !== null && bytesEqual(actual, fromBase64(expected));
}
function tryRemove(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
function stateError(reason) {
    return ckError('ARTIFACT-BROKEN', `rename transaction ${reason}`, 'repair or resume only the exact checked rename state');
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
