/** @scope spec://codkit/modules/codkit/PROP-012#root */
// Single definition of the codkit message registry (PROP-012 sec. 2).
//
// Every diagnostic codkit prints carries a code from one of the two lists
// below. Internal errors keep the compact registry value; the public JSON and
// human forms are rendered as `CK-E-<CODE>`. Nothing outside this file may
// invent or render an error code.
import { z } from 'zod';
export const ERROR_CODES = [
    'CONFIG',
    'NOT-A-REPO',
    'NOT-UPSTREAM',
    'PIN-UNREACHABLE',
    'LFS',
    'LOCKED',
    'DIRTY-TREE',
    'TREE-READONLY',
    'CRLF',
    'EOF-NEWLINE',
    'ENCODING',
    'MARKER-MALFORMED',
    'MARKER-NESTED',
    'MARKER-UNBALANCED',
    'MARKER-UNCLOSED',
    'MARKER-DUP-ID',
    'MARKER-BAD-ID',
    'HUNK-OUTSIDE-MARKER',
    'DELETES-UPSTREAM-LINE',
    'DELETES-UPSTREAM-FILE',
    'NEW-FILE-IN-UPSTREAM-ZONE',
    'HEADER-MISSING',
    'FORBIDDEN-TARGET',
    'MARKER-ARTIFACT-MISMATCH',
    'UNTRACKED-INTERVENTION',
    'STALE-ARTIFACT',
    'OWN-UNCOVERED',
    'OWNER-UNKNOWN',
    // A record that must carry a guard test does not, or names a test id that no
    // own test declares (PROP-005 ##CROSS-CUTTING-MECHANISMS,
    // ##RESOURCE-GUARD-MANDATORY, ##REMOVED-GUARD-MANDATORY). Distinct from
    // OWN-UNCOVERED, which is about own *files* nobody declared.
    'GUARD-MISSING',
    // Own code re-registers a decorator that must not be overridden
    // (PROP-005 ##SO-FORBIDDEN-IDS).
    'FORBIDDEN-SERVICE',
    'OVERLAY-SCHEMA',
    'OVERLAY-DRIFT',
    'RULE-DRIFT',
    'ARTIFACT-BROKEN',
    'NET-FORBIDDEN',
    'LOG-INCOMPLETE',
    'BOTH-SIDES-EDITED',
    // A generated branch is shared by every worktree of its repository; codkit
    // refuses to move it while a sibling worktree has it checked out
    // (PROP-008 ##GENERATED-REF-WORKTREE-PREFLIGHT).
    'WORKTREE-REF-SHARED',
    // HEAD of the fork tree is not on the generated branch while commits above
    // the pin exist, or history below the generated tip was rewritten: the
    // destructive commands refuse rather than extract from the wrong place
    // (PROP-008 ##TREE-COMMITS-ARE-WORK, campaign decision D8).
    'TREE-HEAD',
    // Not carried by a domain spec section, but required by the runtime:
    'INTERNAL',
    // Dependencies that are not there: the launcher (codkit/bin/codkit.mjs) says
    // it about patchset's own, before src/ is loadable, and `ci --profile build`
    // about the fork tree's, which an air-gapped run may check but never install
    // (PROP-011 sec. 7).
    'DEPS-MISSING'
];
export const publicErrorCodeSchema = z.templateLiteral(['CK-E-', z.enum(ERROR_CODES)]);
export const WARNING_CODES = ['MARK-RO', 'PATCHSET-SIDE-EDIT', 'EMPTY-BLOCK'];
/** The single public error shape carried by the JSON envelope and findings. */
export const publicErrorPayloadSchema = z.object({
    code: publicErrorCodeSchema,
    message: z.string(),
    hint: z.string().optional(),
    file: z.string().optional(),
    line: z.int().optional()
});
/** Serialize the internal registry value into the frozen public representation. */
export function serializeErrorPayload(payload) {
    const publicPayload = { code: `CK-E-${payload.code}`, message: payload.message };
    if (payload.hint !== undefined) {
        publicPayload.hint = payload.hint;
    }
    if (payload.file !== undefined) {
        publicPayload.file = payload.file;
    }
    if (payload.line !== undefined) {
        publicPayload.line = payload.line;
    }
    return publicErrorPayloadSchema.parse(publicPayload);
}
/**
 * The only exception type codkit modules throw across their public seam.
 * Anything else reaching the top level is reported as `CK-E-INTERNAL`.
 */
export class CkError extends Error {
    code;
    hint;
    file;
    line;
    constructor(payload) {
        super(payload.message);
        this.name = 'CkError';
        this.code = payload.code;
        this.hint = payload.hint;
        this.file = payload.file;
        this.line = payload.line;
    }
    toPayload() {
        return buildPayload(this.code, this.message, this.hint, this.file, this.line);
    }
}
export function isCkError(value) {
    return value instanceof CkError;
}
function buildPayload(code, message, hint, file, line) {
    // exactOptionalPropertyTypes: absent keys, never explicit `undefined`.
    const payload = { code, message };
    if (hint !== undefined) {
        payload.hint = hint;
    }
    if (file !== undefined) {
        payload.file = file;
    }
    if (line !== undefined) {
        payload.line = line;
    }
    return payload;
}
/**
 * Build a domain error. The result is both the structure carried in the
 * `--json` envelope and a throwable value: `throw ckError(...)`.
 */
export function ckError(code, message, hint, file, line) {
    return new CkError(buildPayload(code, message, hint, file, line));
}
/**
 * Render an error the way PROP-012 sec. 2 prescribes:
 *   error CK-E-<CODE>: <file>:<line>: <message>
 *   hint: <what to do>
 * The location prefix is omitted when the error carries no file.
 */
export function formatError(payload) {
    const lines = [`error ${serializeErrorPayload(payload).code}: ${locationPrefix(payload)}${payload.message}`];
    if (payload.hint !== undefined) {
        lines.push(`hint: ${payload.hint}`);
    }
    return lines.join('\n');
}
/** Render a warning: `warning CK-W-<CODE>: <text>`, or plain text when uncoded. */
export function formatWarning(text, code) {
    return code === undefined ? `warning: ${text}` : `warning CK-W-${code}: ${text}`;
}
function locationPrefix(payload) {
    if (payload.file === undefined) {
        return '';
    }
    return payload.line === undefined ? `${payload.file}: ` : `${payload.file}:${payload.line}: `;
}
