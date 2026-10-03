/** @scope spec://codkit/modules/codkit/PROP-003#CFG-REVISION-PIN */
// Operational ref/header identity is distinct from an optional upstream label.
import { z } from 'zod';
import { safeBasenameProblem } from './pathSafety.js';
export const legacyPinSchema = z.strictObject({
    tag: z
        .string()
        .min(1)
        .refine((value) => safeBasenameProblem(value) === null),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});
export const revisionPinSchema = legacyPinSchema.extend({
    tag: legacyPinSchema.shape.tag.nullable().optional().default(null),
    resolvedAt: z.iso.datetime({ offset: true }).optional(),
    provenance: z.strictObject({ source: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional()
});
export function pinKey(pin) {
    return pin.tag ?? `sha-${pin.sha}`;
}
export function pinData(pin) {
    return {
        tag: pin.tag,
        sha: pin.sha,
        date: pin.date,
        ...(pin.resolvedAt === undefined ? {} : { resolvedAt: pin.resolvedAt }),
        ...(pin.provenance === undefined ? {} : { provenance: pin.provenance })
    };
}
export function requiresRevisionPin(pin) {
    return pin.tag === null || pin.resolvedAt !== undefined || pin.provenance !== undefined;
}
