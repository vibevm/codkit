/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
export function applyReportWrites(root, writes) {
    for (const write of writes) {
        const current = readText(root, write.path);
        if (current !== write.previous && current !== write.contents)
            throw ckError('ARTIFACT-BROKEN', `${write.path}: report changed after planning`);
        if (current === write.contents)
            continue;
        const path = contained(root, write.path);
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, write.contents, { flag: 'wx' });
            renameSync(temporary, path);
        }
        finally {
            removeOptional(temporary);
        }
    }
}
export function pendingAcknowledgement(document) {
    if (document === null)
        return null;
    let value;
    try {
        value = JSON.parse(document);
    }
    catch {
        return null;
    }
    if (!isRecord(value) || value['acceptance'] !== 'pending')
        return null;
    return typeof value['acknowledgement'] === 'string' ? value['acknowledgement'] : null;
}
export function rebindAdvisoryState(document, state) {
    if (document === null)
        return null;
    let value;
    try {
        value = JSON.parse(document);
    }
    catch {
        return document;
    }
    if (!isRecord(value) || !isRecord(value['state']))
        return document;
    const previous = value['state'];
    if (!isRecord(previous['sourcePin']) || !isRecord(previous['targetPin']))
        return document;
    if (previous['sourcePin']['sha'] !== state.sourcePin.sha || previous['targetPin']['sha'] !== state.targetPin.sha)
        return null;
    return `${JSON.stringify({ ...value, state }, null, 2)}\n`;
}
export function stabilizeReportIsRed(document) {
    if (document === null)
        return false;
    let value;
    try {
        value = JSON.parse(document);
    }
    catch {
        return false;
    }
    return isRecord(value) && isRecord(value['nextState']) && value['nextState']['phase'] === 'resolve';
}
export function stabilizeReportMatchesCycle(document, state) {
    if (document === null)
        return false;
    let value;
    try {
        value = JSON.parse(document);
    }
    catch {
        return true;
    }
    if (!isRecord(value) || !isRecord(value['basis']) || !isRecord(value['basis']['state']))
        return true;
    const previous = value['basis']['state'];
    return (isRecord(previous['sourcePin']) &&
        isRecord(previous['targetPin']) &&
        previous['sourcePin']['sha'] === state.sourcePin.sha &&
        previous['targetPin']['sha'] === state.targetPin.sha);
}
export function removeExactText(root, relative, expected) {
    if (readText(root, relative) !== expected)
        throw ckError('ARTIFACT-BROKEN', `${relative}: report changed before cleanup`);
    unlinkSync(contained(root, relative));
}
export function fileDigest(root, relative) {
    try {
        return createHash('sha256')
            .update(readFileSync(contained(root, relative)))
            .digest('hex');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
export function readText(root, relative) {
    try {
        return readFileSync(contained(root, relative), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
export function byteSorted(values) {
    return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}
export function toJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (Array.isArray(value))
        return value.map(toJson);
    if (typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
    return String(value);
}
function contained(root, relative) {
    const resolved = resolveContainedPath(root, relative, { allowMissing: true });
    if (!resolved.ok)
        throw ckError('ARTIFACT-BROKEN', `${relative}: ${resolved.reason}`);
    return resolved.absolute;
}
function removeOptional(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
