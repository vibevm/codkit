/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Strict on-disk transaction format and byte/mode CAS primitives for cycle regeneration.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
export const CYCLE_REGENERATE_RECOVERY_PATH = '.codkit/cycle-regenerate.json';
export const PORTABLE_MODES = ['100644', '100755'];
const canonicalBase64 = z.string().refine((value) => Buffer.from(value, 'base64').toString('base64') === value);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const modeSchema = z.enum(PORTABLE_MODES);
const pathSchema = z.string().min(1);
const basisSchema = z.object({ path: pathSchema, before: canonicalBase64, hash: hashSchema, mode: modeSchema }).strict();
const operationSchema = z
    .object({
    path: pathSchema,
    action: z.enum(['write', 'delete']),
    before: canonicalBase64,
    beforeMode: modeSchema,
    after: canonicalBase64.nullable(),
    afterMode: modeSchema.nullable()
})
    .strict();
const causeSchema = z.object({ sha: shaSchema, approx: z.boolean() }).strict();
const actionSchema = z
    .object({
    artifactPath: pathSchema,
    artifactId: z.string().min(1),
    kind: z.enum(['patch', 'rule', 'overlay', 'resource', 'own', 'service-override', 'removed']),
    action: z.enum(['write', 'delete', 'noop', 'untouched']),
    cause: causeSchema.nullable()
})
    .strict();
const planSchema = z
    .object({
    codkitCycleRegeneration: z.literal(1),
    digest: hashSchema,
    authorityDigest: hashSchema,
    sourcePin: z.string().regex(/^[^@\s]+@[0-9a-f]{40}$/),
    targetPin: z.string().regex(/^[^@\s]+@[0-9a-f]{40}$/),
    basis: z.array(basisSchema),
    operations: z.array(operationSchema),
    actions: z.array(actionSchema)
})
    .strict();
export function parseRegenerationPlan(input) {
    const parsed = planSchema.safeParse(input);
    if (!parsed.success)
        throw broken(`invalid regeneration plan: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
    const plan = parsed.data;
    assertSortedUnique(plan.basis.map((item) => item.path), 'basis');
    assertSortedUnique(plan.operations.map((item) => item.path), 'operations');
    assertSortedUnique(plan.actions.map((item) => `${item.artifactPath}\0${item.artifactId}`), 'actions');
    const basis = new Map(plan.basis.map((item) => [item.path, item]));
    for (const item of plan.basis) {
        if (hash(fromBase64(item.before)) !== item.hash)
            throw broken(`${item.path}: basis hash does not match before bytes`);
    }
    for (const operation of plan.operations) {
        const bound = basis.get(operation.path);
        if (bound === undefined || bound.before !== operation.before || bound.mode !== operation.beforeMode)
            throw broken(`${operation.path}: operation is not exactly bound to basis bytes and mode`);
        if (operation.action === 'delete') {
            if (operation.after !== null || operation.afterMode !== null)
                throw broken(`${operation.path}: delete operation carries output state`);
        }
        else if (operation.after === null || operation.afterMode !== operation.beforeMode) {
            throw broken(`${operation.path}: write operation does not preserve its portable mode`);
        }
    }
    const { digest: actual, ...body } = plan;
    if (actual !== digest(body))
        throw broken('regeneration plan digest does not match its contents');
    return plan;
}
export function readRecovery(root) {
    const current = readFileState(root, CYCLE_REGENERATE_RECOVERY_PATH);
    if (current === null)
        return null;
    if (current.mode !== '100644')
        throw broken('regeneration recovery has non-canonical mode');
    const text = decodeUtf8Strict(current.bytes);
    let raw;
    try {
        raw = JSON.parse(text ?? '');
    }
    catch (error) {
        throw broken(`invalid regeneration recovery JSON: ${messageOf(error)}`);
    }
    const plan = parseRegenerationPlan(raw);
    if (!bytesEqual(current.bytes, jsonBytes(plan)))
        throw broken('regeneration recovery bytes are not canonical');
    return plan;
}
export function writeRecovery(root, plan) {
    const current = readFileState(root, CYCLE_REGENERATE_RECOVERY_PATH);
    const bytes = jsonBytes(plan);
    if (current !== null) {
        if (current.mode !== '100644' || !bytesEqual(current.bytes, bytes))
            throw broken('another regeneration recovery record already exists');
        return;
    }
    atomicWrite(root, CYCLE_REGENERATE_RECOVERY_PATH, { bytes, mode: '100644' });
}
export function preflightBasis(root, plan) {
    const operations = new Map(plan.operations.map((item) => [item.path, item]));
    for (const item of plan.basis) {
        const current = readFileState(root, item.path);
        const operation = operations.get(item.path);
        const after = operation === undefined ? undefined : operationAfter(operation);
        if (!sameState(current, { bytes: fromBase64(item.before), mode: item.mode }) && (after === undefined || !sameState(current, after)))
            throw broken(`${item.path}: bytes or mode changed after regeneration planning`);
    }
}
export function readFileState(root, path) {
    const resolved = resolveContainedPath(root, path, { allowMissing: true });
    if (!resolved.ok)
        throw broken(`${path}: unsafe path: ${resolved.reason}`);
    try {
        const before = lstatSync(resolved.absolute);
        if (!before.isFile())
            throw broken(`${path}: is not a regular file`);
        const bytes = readFileSync(resolved.absolute);
        const after = lstatSync(resolved.absolute);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode)
            throw broken(`${path}: identity changed while being read`);
        return { bytes, mode: portableMode(after.mode) };
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return null;
        if (isRegenerationError(error))
            throw error;
        throw broken(`${path}: cannot read: ${messageOf(error)}`);
    }
}
export function atomicWrite(root, path, state) {
    const resolved = resolveContainedPath(root, path, { allowMissing: true });
    if (!resolved.ok)
        throw broken(`${path}: unsafe write path: ${resolved.reason}`);
    mkdirSync(dirname(resolved.absolute), { recursive: true });
    const verified = resolveContainedPath(root, path, { allowMissing: true });
    if (!verified.ok)
        throw broken(`${path}: unsafe write path after directory creation: ${verified.reason}`);
    const temporary = `${verified.absolute}.cycle-${randomUUID()}`;
    try {
        writeFileSync(temporary, state.bytes, { flag: 'wx', mode: state.mode === '100755' ? 0o755 : 0o644 });
        chmodSync(temporary, state.mode === '100755' ? 0o755 : 0o644);
        renameSync(temporary, verified.absolute);
    }
    finally {
        try {
            unlinkSync(temporary);
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
    }
}
export function removeContained(root, path) {
    const resolved = resolveContainedPath(root, path, { allowMissing: true });
    if (!resolved.ok)
        throw broken(`${path}: unsafe delete path: ${resolved.reason}`);
    try {
        unlinkSync(resolved.absolute);
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT')
            throw broken(`${path}: cannot delete: ${messageOf(error)}`);
    }
}
export function operationAfter(operation) {
    return operation.after === null || operation.afterMode === null
        ? null
        : { bytes: fromBase64(operation.after), mode: operation.afterMode };
}
export function sameState(left, right) {
    return left === null || right === null ? left === right : left.mode === right.mode && bytesEqual(left.bytes, right.bytes);
}
export function jsonBytes(value) {
    return encodeUtf8(`${JSON.stringify(value, null, 2)}\n`);
}
export function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
export function base64(bytes) {
    return Buffer.from(bytes).toString('base64');
}
export function fromBase64(text) {
    if (Buffer.from(text, 'base64').toString('base64') !== text)
        throw broken('invalid base64 bytes in regeneration plan');
    return Buffer.from(text, 'base64');
}
function portableMode(mode) {
    return mode & 0o111 ? '100755' : '100644';
}
function assertSortedUnique(values, label) {
    for (let index = 0; index < values.length; index += 1) {
        const previous = values[index - 1];
        const current = values[index];
        if (current === undefined || (previous !== undefined && Buffer.from(previous).compare(Buffer.from(current)) >= 0))
            throw broken(`${label} is not strictly byte-sorted and unique`);
    }
}
function errorCode(error) {
    return error.code;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function isRegenerationError(error) {
    return error instanceof Error && error.message.includes('cannot regenerate cycle:');
}
function broken(message) {
    return ckError('ARTIFACT-BROKEN', `cannot regenerate cycle: ${message}`, 'repair cycle inputs or resume the durable transaction');
}
