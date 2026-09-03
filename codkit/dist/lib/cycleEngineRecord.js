/** @scope spec://codkit/modules/codkit/PROP-009#state */
// Durable authority for the apply half of a cycle. It retains the byte-bearing
// classification so a process restart never has to infer it from a partly
// regenerated patchset checkout.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { cycleArtifactsSchema, cyclePinSchema, cycleRenameSchema } from './cycleState.js';
import { decodeUtf8Strict } from './bytes.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
export const CYCLE_APPLY_RECORD_PATH = '.codkit/cycle-apply.json';
const storedJsonSchema = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(storedJsonSchema), z.record(z.string(), storedJsonSchema)]));
const causeSchema = z
    .object({
    artifactPath: z.string().min(1),
    artifactId: z.string().min(1),
    targetPath: z.string().min(1),
    outcome: z.enum(['clean', 'shifted', 'merged', 'conflict', 'target-deleted', 'target-renamed', 'rule-broken', 'contract-failed']),
    cause: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), approx: z.boolean() }).strict()
})
    .strict();
const envelopeSchema = z
    .object({
    codkitCycleApply: z.literal(1),
    sourcePin: cyclePinSchema,
    targetPin: cyclePinSchema,
    branch: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    classifications: storedJsonSchema,
    causes: z.array(causeSchema),
    buckets: cycleArtifactsSchema,
    renames: z.array(cycleRenameSchema),
    renamePaths: z.array(z.string().min(1)),
    regenerationPaths: z.array(z.string().min(1)),
    reviewToken: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
    reviewStop: z.enum(['rename-review', 'resource-rename-review']).nullable(),
    checkpoint: z.enum(['preview', 'classified', 'materialized', 'regenerated', 'committed']),
    renameParent: z.string().regex(/^[0-9a-f]{40}$/),
    renameCommit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable(),
    regenerationParent: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable(),
    regenerationCommit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable(),
    digest: z.string().regex(/^[0-9a-f]{64}$/)
})
    .strict();
export function makeCycleApplyRecord(input) {
    const body = { codkitCycleApply: 1, ...input };
    return { ...body, digest: digest(storedBody(body)) };
}
export function updateCycleApplyRecord(record, change) {
    const { codkitCycleApply: _version, digest: _digest, ...body } = record;
    return makeCycleApplyRecord({ ...body, ...change });
}
export function writeCycleApplyRecord(patchesDir, record) {
    assertRecord(record);
    let path = absolute(patchesDir);
    const bytes = serialize(record);
    mkdirSync(dirname(path), { recursive: true });
    path = absolute(patchesDir);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, bytes, { flag: 'wx' });
        renameSync(temporary, path);
    }
    finally {
        removeOptional(temporary);
    }
}
export function readCycleApplyRecord(patchesDir) {
    const bytes = readOptional(absolute(patchesDir));
    if (bytes === null)
        return null;
    const text = decodeUtf8Strict(bytes);
    if (text === null || text.includes('\r') || !text.endsWith('\n'))
        throw broken('record is not canonical UTF-8/LF JSON');
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        throw broken(`record is not valid JSON: ${messageOf(error)}`);
    }
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success)
        throw broken(`record failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    const classifications = decodeStored(parsed.data.classifications);
    if (!isClassifications(classifications))
        throw broken('record classifications are not a complete cycle classification list');
    const record = { ...parsed.data, classifications };
    assertRecord(record);
    if (serialize(record) !== text)
        throw broken('record bytes are not canonical');
    return record;
}
export function clearCycleApplyRecord(patchesDir) {
    removeOptional(absolute(patchesDir));
}
function storedBody(record) {
    return {
        codkitCycleApply: record.codkitCycleApply,
        sourcePin: encodeStored(record.sourcePin),
        targetPin: encodeStored(record.targetPin),
        branch: record.branch,
        createdAt: record.createdAt,
        classifications: encodeStored(record.classifications),
        causes: encodeStored(record.causes),
        buckets: encodeStored(record.buckets),
        renames: encodeStored(record.renames),
        renamePaths: encodeStored(record.renamePaths),
        regenerationPaths: encodeStored(record.regenerationPaths),
        reviewToken: record.reviewToken,
        reviewStop: record.reviewStop,
        checkpoint: record.checkpoint,
        renameParent: record.renameParent,
        renameCommit: record.renameCommit,
        regenerationParent: record.regenerationParent,
        regenerationCommit: record.regenerationCommit
    };
}
function serialize(record) {
    const { digest: claimed, ...body } = record;
    return `${JSON.stringify({ ...storedBody(body), digest: claimed }, null, 2)}\n`;
}
function assertRecord(record) {
    const { digest: claimed, ...body } = record;
    if (claimed !== digest(storedBody(body)))
        throw broken('record digest does not match its canonical authority');
    if (!orderedUnique(record.renamePaths))
        throw broken('rename paths are not byte-sorted and unique');
    if (!orderedUnique(record.regenerationPaths))
        throw broken('regeneration paths are not byte-sorted and unique');
    assertClassificationRelations(record);
    if ((record.reviewToken === null) !== (record.reviewStop === null))
        throw broken('review token and stop kind disagree');
    if (record.reviewToken !== null && record.checkpoint !== 'preview')
        throw broken('review token exists outside preview');
    if (record.renameCommit !== null && record.renamePaths.length === 0)
        throw broken('rename commit has no rename paths');
    if (record.checkpoint === 'preview' &&
        (record.renameCommit !== null || record.regenerationParent !== null || record.regenerationCommit !== null))
        throw broken('preview carries later checkpoint evidence');
    if (record.checkpoint === 'classified' && (record.regenerationParent !== null || record.regenerationCommit !== null))
        throw broken('classified record carries regeneration evidence');
    if (['materialized', 'regenerated', 'committed'].includes(record.checkpoint) && record.regenerationParent === null)
        throw broken('later checkpoint has no regeneration parent');
    if (record.checkpoint !== 'committed' && record.regenerationCommit !== null)
        throw broken('uncommitted checkpoint carries regeneration commit');
}
function assertClassificationRelations(record) {
    const buckets = Object.fromEntries(Object.keys(record.buckets).map((outcome) => [outcome, []]));
    const byPath = new Map();
    for (const item of record.classifications) {
        if (byPath.has(item.artifactPath))
            throw broken(`duplicate classification ${item.artifactPath}`);
        byPath.set(item.artifactPath, item);
        const renamed = item.kind === 'patch' && item.outcome === 'clean' && record.renames.some((rename) => rename.to === item.targetPath);
        const outcome = renamed ? 'target-renamed' : item.outcome;
        const bucket = buckets[outcome];
        if (bucket === undefined)
            throw broken(`unknown classification outcome ${outcome}`);
        bucket.push(item.artifactPath);
    }
    for (const paths of Object.values(buckets))
        paths.sort(compare);
    if (JSON.stringify(buckets) !== JSON.stringify(record.buckets))
        throw broken('buckets are not derived from classifications and renames');
    const expected = Object.entries(record.buckets).flatMap(([outcome, paths]) => outcome === 'clean' ? [] : paths.map((path) => ({ path, outcome })));
    if (record.causes.length !== expected.length)
        throw broken('causes do not cover every non-clean classification');
    const seen = new Set();
    for (const cause of record.causes) {
        const item = byPath.get(cause.artifactPath);
        if (item === undefined ||
            seen.has(cause.artifactPath) ||
            cause.artifactId !== item.artifactId ||
            cause.targetPath !== item.targetPath ||
            expected.some((entry) => entry.path === cause.artifactPath && entry.outcome === cause.outcome) === false)
            throw broken(`cause is not derived from classification ${cause.artifactPath}`);
        seen.add(cause.artifactPath);
    }
}
function encodeStored(value) {
    if (value instanceof Uint8Array)
        return { codkitBytesBase64: Buffer.from(value).toString('base64') };
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (Array.isArray(value))
        return value.map(encodeStored);
    if (typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeStored(item)]));
    throw broken(`unsupported record value ${typeof value}`);
}
function decodeStored(value) {
    if (Array.isArray(value))
        return value.map(decodeStored);
    if (isRecord(value)) {
        const entries = Object.entries(value);
        if (entries.length === 1 && entries[0]?.[0] === 'codkitBytesBase64' && typeof entries[0][1] === 'string') {
            const bytes = Buffer.from(entries[0][1], 'base64');
            if (bytes.toString('base64') !== entries[0][1])
                throw broken('record contains non-canonical base64');
            return new Uint8Array(bytes);
        }
        return Object.fromEntries(entries.map(([key, item]) => [key, decodeStored(item)]));
    }
    return value;
}
function isClassifications(value) {
    return Array.isArray(value) && value.every(isClassification);
}
function isClassification(value) {
    if (!isRecord(value))
        return false;
    if (!stringField(value, 'artifactPath') || !stringField(value, 'artifactId') || !stringField(value, 'targetPath'))
        return false;
    const kind = value['kind'];
    const outcome = value['outcome'];
    if (!['patch', 'rule', 'overlay', 'resource'].includes(typeof kind === 'string' ? kind : ''))
        return false;
    if (!['clean', 'shifted', 'merged', 'conflict', 'target-deleted', 'target-renamed', 'rule-broken'].includes(typeof outcome === 'string' ? outcome : ''))
        return false;
    if (kind === 'patch') {
        const bytes = value['bytes'];
        const materials = value['materials'];
        return ((bytes === null || bytes instanceof Uint8Array) &&
            (materials === null ||
                (isRecord(materials) &&
                    materials['base'] instanceof Uint8Array &&
                    materials['ours'] instanceof Uint8Array &&
                    materials['theirs'] instanceof Uint8Array &&
                    typeof materials['baseExists'] === 'boolean' &&
                    typeof materials['oursExists'] === 'boolean')));
    }
    if (kind === 'rule')
        return value['targetBytes'] === null || value['targetBytes'] instanceof Uint8Array;
    if (kind === 'overlay')
        return value['targetBytes'] === null || value['targetBytes'] instanceof Uint8Array;
    return true;
}
function stringField(value, key) {
    return typeof value[key] === 'string' && value[key] !== '';
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function orderedUnique(values) {
    return values.every((value, index) => index === 0 || compare(values[index - 1] ?? '', value) < 0);
}
function compare(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function absolute(root) {
    const resolved = resolveContainedPath(root, CYCLE_APPLY_RECORD_PATH, { allowMissing: true });
    if (!resolved.ok)
        throw broken(`unsafe record path: ${resolved.reason}`);
    return resolved.absolute;
}
function readOptional(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (codeOf(error) === 'ENOENT')
            return null;
        throw broken(`cannot open record: ${messageOf(error)}`);
    }
    try {
        if (!fstatSync(fd).isFile())
            throw broken('record path is not a regular file');
        return readFileSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
function removeOptional(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (codeOf(error) !== 'ENOENT')
            throw error;
    }
}
function broken(reason) {
    return ckError('ARTIFACT-BROKEN', `cycle apply record: ${reason}`, `inspect ${CYCLE_APPLY_RECORD_PATH}; never edit it`);
}
function codeOf(error) {
    return error.code;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
