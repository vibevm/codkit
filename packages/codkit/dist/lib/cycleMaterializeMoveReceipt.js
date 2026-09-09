/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Canonical durable intent for provisional cycle worktree movement.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { decodeUtf8Strict } from './bytes.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
export const CYCLE_MATERIALIZE_RECORD_PATH = '.codkit/cycle-materialize.json';
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const path = z.string().min(1);
const mode = z.enum(['100644', '100755', '120000']);
const digest = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), mode }).strict();
const object = z.object({ oid: sha, mode }).strict();
export const cycleMoveCheckpointSchema = z.enum([
    'prepared',
    'ref-updated',
    'head-selected',
    'index-reset',
    'checkout-complete',
    'conflicts-written',
    'verified'
]);
const legacyCheckpoint = cycleMoveCheckpointSchema.exclude(['verified']);
const conflict = z.object({ path, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const common = {
    branch: z.string().min(1),
    targetPin: sha,
    tip: sha,
    sourceHead: sha,
    sourceBranch: z.string().min(1).nullable(),
    originalRef: sha.nullable(),
    changedPaths: z.array(path),
    conflicts: z.array(conflict)
};
export const cycleMoveRecordSchema = z
    .object({
    codkitCycleMaterialize: z.literal(2),
    ...common,
    entries: z.array(z
        .object({
        path,
        before: digest.nullable(),
        after: digest.nullable(),
        beforeObject: object.nullable(),
        afterObject: object.nullable()
    })
        .strict()),
    checkpoint: cycleMoveCheckpointSchema
})
    .strict();
const legacyRecordSchema = z.object({ codkitCycleMaterialize: z.literal(1), ...common, checkpoint: legacyCheckpoint }).strict();
const storedRecordSchema = z.union([cycleMoveRecordSchema, legacyRecordSchema]);
export function readCycleMoveRecord(patchesDir) {
    const target = cycleRecordPath(patchesDir);
    let bytes;
    try {
        bytes = readFileSync(target);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw cycleRecordError(`cannot read: ${messageOf(error)}`);
    }
    const text = decodeUtf8Strict(bytes);
    if (text === null || !text.endsWith('\n') || text.includes('\r'))
        throw cycleRecordError('has noncanonical UTF-8/LF bytes');
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw cycleRecordError(`is invalid JSON: ${messageOf(error)}`);
    }
    const parsed = storedRecordSchema.safeParse(value);
    if (!parsed.success || text !== `${JSON.stringify(parsed.data, null, 2)}\n`)
        throw cycleRecordError('fails schema or canonical JSON validation');
    return parsed.data;
}
export function writeCycleMoveRecord(patchesDir, record) {
    const target = cycleRecordPath(patchesDir);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify(cycleMoveRecordSchema.parse(record), null, 2)}\n`, { flag: 'wx' });
        renameSync(temporary, target);
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
export function removeCycleMoveRecord(patchesDir) {
    try {
        unlinkSync(cycleRecordPath(patchesDir));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw cycleRecordError(`cannot remove: ${messageOf(error)}`);
    }
}
export function cycleRecordError(detail) {
    return ckError('CONFIG', `cycle materialize record ${detail}`, 'inspect the provisional branch and restore the exact transaction state', CYCLE_MATERIALIZE_RECORD_PATH);
}
function cycleRecordPath(patchesDir) {
    const resolved = resolveContainedPath(patchesDir, CYCLE_MATERIALIZE_RECORD_PATH, { allowMissing: true });
    if (!resolved.ok)
        throw cycleRecordError(`has unsafe path: ${resolved.reason}`);
    return resolved.absolute;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
