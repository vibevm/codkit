/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { cycleLiveSnapshotSchema } from './cycleStabilizeEvidence.js';
import { cycleStateSchema } from './cycleState.js';
import { z } from 'zod';
const optionalDiagnosticFields = {
    hint: z.string().optional(),
    file: z.string().optional(),
    line: z.number().int().positive().optional()
};
const errorSchema = z.object({ code: z.string().min(1), message: z.string(), ...optionalDiagnosticFields }).strict();
const inventoryEntrySchema = z
    .object({
    id: z.string(),
    layer: z.enum(['own', 'service-override', 'entry-module', 'config-overlay', 'resource-file', 'rewrite-rule', 'patch']),
    type: z.string(),
    category: z.string(),
    subsystem: z.string(),
    files: z.array(z.string()),
    owner: z.string(),
    reason: z.string(),
    link: z.string(),
    cause: z.string().nullable(),
    pin: z.string(),
    contractTests: z.array(z.string()),
    artifact: z.string()
})
    .strict();
const inventorySchema = z
    .object({
    codkitInventory: z.number().int(),
    patchSetCommit: z.string(),
    pin: z.string(),
    entries: z.array(inventoryEntrySchema),
    metrics: z
        .object({
        byLayer: z.record(z.string(), z.number()),
        bySubsystem: z.record(z.string(), z.number()),
        patchAndRuleCount: z.number(),
        hunks: z.number(),
        patchLineTotal: z.number(),
        contractCoverage: z.object({ covered: z.number(), requiredCovered: z.number(), requiredTotal: z.number() }).strict()
    })
        .strict()
})
    .strict();
const verifySchema = z
    .object({
    findings: z.array(z
        .object({ code: z.string(), message: z.string(), hint: z.string(), file: z.string().optional(), line: z.number().optional() })
        .strict()),
    warnings: z.array(z.string()),
    counts: z.record(z.string(), z.number()),
    inventory: inventorySchema.nullable(),
    checked: z.number().int().nonnegative()
})
    .strict();
const ciStepSchema = z.object({ name: z.string(), state: z.enum(['ok', 'warned', 'skipped', 'failed']), detail: z.string() }).strict();
const effectiveDiffSchema = z
    .object({
    base: z.string(),
    baseSha: z.string(),
    baseTip: z.string(),
    tip: z.string(),
    patchPath: z.string(),
    inventoryDiffPath: z.string(),
    stat: z.string()
})
    .strict();
const ciSchema = z
    .object({
    exitCode: z.number().int(),
    profile: z.enum(['verify', 'build']),
    steps: z.array(ciStepSchema),
    branchTip: z.string().nullable(),
    effectiveDiff: effectiveDiffSchema.nullable()
})
    .strict();
const executionSchema = z
    .object({
    verify: verifySchema.nullable(),
    verifyExitCode: z.number().int().nullable(),
    build: ciSchema.nullable(),
    log: z.array(z.string()),
    errors: z.array(errorSchema),
    cleanupErrors: z.array(errorSchema),
    runnerFailure: z.string().nullable()
})
    .strict();
const contractFailureSchema = z.object({ test: z.string().min(1), artifacts: z.array(z.string().min(1)).min(1) }).strict();
const redSchema = z
    .object({
    kind: z.enum(['runner', 'verify', 'build', 'error', 'cleanup', 'contract']),
    id: z.string(),
    detail: z.string(),
    artifact: z.string().nullable()
})
    .strict();
export const stabilizeDocumentSchema = z
    .object({
    codkitCycleStabilize: z.literal(1),
    basis: z
        .object({
        state: cycleStateSchema,
        updatedAt: z.iso.datetime({ offset: true }),
        live: cycleLiveSnapshotSchema,
        execution: executionSchema,
        contractFailures: z.array(contractFailureSchema),
        red: z.array(redSchema)
    })
        .strict(),
    nextState: cycleStateSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/)
})
    .strict();
