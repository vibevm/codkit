/** @scope spec://codkit/modules/codkit/PROP-021#ARTIFACT-CODEC */
// A representation seam over the existing v2 bytes; no new patch wire format.
import { createHash } from 'node:crypto';
import { parseCkpatch, serializeCkpatch } from './patchFormat.js';
import { applyUnified } from './applyUnified.js';
import { regeneratePatch } from './patchGenerate.js';
import { MINIMAL_DISCIPLINE } from './discipline.js';
import { ckError, isCkError } from './messages.js';
export const TEXT_PATCH_CODEC_ID = 'text-patch-v2';
/** @example const codec = artifactCodec('text-patch-v2'); if (codec.ok) codec.value.compatible('minimal-intervention@1'); */
export function artifactCodec(id) {
    return id === TEXT_PATCH_CODEC_ID
        ? { ok: true, value: textPatchCodec }
        : failure('unsupported', `artifact codec is not registered: ${id}`);
}
const textPatchCodec = Object.freeze({
    id: TEXT_PATCH_CODEC_ID,
    operations: ['add', 'modify'],
    compatible: (profile) => profile === MINIMAL_DISCIPLINE,
    decode: (bytes, conventions, file) => checked(() => parseCkpatch(bytes, conventions, file)),
    identifyTargets: (artifact) => [artifact.targetPath],
    plan: (artifact, base) => {
        if (base.targetPath !== artifact.targetPath)
            return failure('invalid', 'artifact target differs from plan target');
        if (artifact.isAddFile === base.exists)
            return failure('invalid', 'artifact add/modify operation differs from file existence');
        if (!base.exists && base.bytes.length !== 0)
            return failure('invalid', 'absent artifact base must have empty bytes');
        return checked(() => {
            const result = applyUnified(base.bytes, artifact);
            return {
                codecId: TEXT_PATCH_CODEC_ID,
                targetPath: artifact.targetPath,
                operation: artifact.isAddFile ? 'add' : 'modify',
                baseExists: base.exists,
                baseSha256: hash(base.bytes),
                resultSha256: hash(result),
                result: result.slice()
            };
        });
    },
    apply: (plan, current) => {
        if (plan.codecId !== TEXT_PATCH_CODEC_ID ||
            plan.targetPath !== current.targetPath ||
            plan.baseExists !== current.exists ||
            plan.baseSha256 !== hash(current.bytes))
            return failure('stale', 'artifact plan base/target custody changed');
        if (hash(plan.result) !== plan.resultSha256)
            return failure('stale', 'artifact plan output bytes changed');
        return { ok: true, value: plan.result.slice() };
    },
    extract: (options) => checked(() => regeneratePatch(options)),
    fingerprint: (artifact) => hash(serializeCkpatch(artifact)),
    inventory: (artifact) => ({
        codecId: TEXT_PATCH_CODEC_ID,
        id: artifact.header.id,
        layer: artifact.header.layer,
        targets: [artifact.targetPath],
        operations: [artifact.isAddFile ? 'add' : 'modify'],
        hunks: artifact.hunks.length,
        contractTests: [...artifact.header.contractTests]
    })
});
function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function failure(kind, message, code) {
    return { ok: false, problem: { kind, message, ...(code === undefined ? {} : { code }) } };
}
function checked(body) {
    try {
        return { ok: true, value: body() };
    }
    catch (error) {
        if (isCkError(error))
            return { ok: false, problem: { kind: 'invalid', message: error.message, code: error.code, cause: error } };
        throw error;
    }
}
/** Legacy engine boundary retains original diagnostics while using typed codec results. */
export function decodeTextArtifact(bytes, conventions, file) {
    const decoded = textPatchCodec.decode(bytes, conventions, file);
    if (decoded.ok)
        return decoded.value;
    if (decoded.problem.cause !== undefined)
        throw decoded.problem.cause;
    throw ckError('ARTIFACT-BROKEN', decoded.problem.message);
}
