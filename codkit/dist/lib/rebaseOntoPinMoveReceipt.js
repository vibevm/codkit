/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
// Canonical durable receipt shape and explicit disposition of legacy receipts.
import { z } from 'zod';
import { ckError } from './messages.js';
import { readCanonical } from './renameFileState.js';
export const REBASE_MOVE_PATH = '.codkit/rebase-onto-pin-move.json';
export const REBASE_MOVE_VERSION = 2;
const modeSchema = z.enum(['100644', '100755', '120000']);
const digestSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), mode: modeSchema }).strict();
const objectSchema = z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/), mode: modeSchema }).strict();
const recordSchema = z
    .object({
    codkitRebaseOntoPinMove: z.literal(REBASE_MOVE_VERSION),
    state: z.enum(['active', 'complete']),
    patchsetHead: z.string().regex(/^[0-9a-f]{40}$/),
    head: z.string().regex(/^[0-9a-f]{40}$/),
    desiredTree: z.string().regex(/^[0-9a-f]{40}$/),
    entries: z.array(z
        .object({
        path: z.string().min(1),
        before: digestSchema.nullable(),
        after: digestSchema.nullable(),
        beforeObject: objectSchema.nullable(),
        afterObject: objectSchema.nullable()
    })
        .strict())
})
    .strict();
const legacyDigestSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), mode: z.enum(['100644', '100755']) }).strict();
const legacyRecordSchema = z
    .object({
    codkitRebaseOntoPinMove: z.literal(1),
    state: z.enum(['active', 'complete']),
    patchsetHead: z.string().regex(/^[0-9a-f]{40}$/),
    head: z.string().regex(/^[0-9a-f]{40}$/),
    desiredTree: z.string().regex(/^[0-9a-f]{40}$/),
    entries: z.array(z.object({ path: z.string().min(1), before: legacyDigestSchema.nullable(), after: legacyDigestSchema.nullable() }).strict())
})
    .strict();
const storedRecordSchema = z.union([recordSchema, legacyRecordSchema]);
export function hasRebaseMoveRecord(patchesDir) {
    return readCanonical(patchesDir, REBASE_MOVE_PATH, storedRecordSchema) !== null;
}
export function readRebaseMoveRecord(patchesDir) {
    const record = readCanonical(patchesDir, REBASE_MOVE_PATH, storedRecordSchema);
    if (record?.codkitRebaseOntoPinMove === 1) {
        throw ckError('DIRTY-TREE', 'cannot materialize rebase target: legacy v1 receipt lacks canonical object identity and cannot be resumed safely', 'restore the fork to its recorded HEAD, remove the legacy receipt, and retry the rebase transaction');
    }
    return record;
}
