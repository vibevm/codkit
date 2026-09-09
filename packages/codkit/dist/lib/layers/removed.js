/** @scope spec://codkit/modules/codkit/PROP-005#root */
// removed-registry: delta/removed.json (PROP-005 sec. 10).
//
// Deleting an upstream line, file, dependency or registration is forbidden, so
// everything the product deliberately does without is switched off by one of the
// layers above and then recorded here, with the layer that did it named in
// `how`. The registry is what makes "we do not ship this" reviewable at all.
//
// A guard test is mandatory on every entry (##REMOVED-GUARD-MANDATORY): the
// failure mode of this layer is an upgrade quietly bringing the removed thing
// back, and nothing but a test that asserts its absence can see that happen.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ckError } from '../messages.js';
export const REMOVED_SCHEMA_VERSION = 1;
/** The registry file, relative to the patchset root. */
export const REMOVED_PATH = 'delta/removed.json';
/** What kind of thing an entry describes (##REMOVED-FORMAT). */
export const REMOVED_KINDS = ['file', 'dependency', 'registration', 'setting'];
const entrySchema = z.object({
    id: z.string().min(1),
    kind: z.enum(REMOVED_KINDS),
    target: z.string().min(1),
    how: z.string().min(1),
    owner: z.string().min(1),
    reason: z.string().min(1),
    link: z.string().min(1),
    pin: z.string().min(1),
    contractTests: z.array(z.string().min(1)).min(1)
});
const registrySchema = z.object({
    codkitRemoved: z.literal(REMOVED_SCHEMA_VERSION),
    entries: z.array(entrySchema)
});
const FIELD_EXPECTATION = {
    codkitRemoved: `must be exactly ${REMOVED_SCHEMA_VERSION}`,
    entries: 'must be a list of removal entries',
    id: 'must be a non-empty artifact id',
    kind: `must be one of ${REMOVED_KINDS.join(', ')}`,
    target: 'must name the removed path, package, registration or setting',
    how: 'must say which layer switched it off',
    owner: 'must be a non-empty owner name',
    reason: 'must be a non-empty reason',
    link: 'must be an issue reference or the literal "none"',
    pin: 'must be "<tag>@<sha>" of the pin the entry was written against',
    contractTests: 'must be a non-empty list of contract test names (a guard test is mandatory for every removal)'
};
const HINT = 'see PROP-005 sec. 10 for the removed-registry format';
/**
 * Read delta/removed.json. A repository without the file has an empty registry,
 * which is the honest state of a delta that removes nothing.
 */
export function loadRemoved(patchesDir) {
    const absolute = join(patchesDir, ...REMOVED_PATH.split('/'));
    if (!existsSync(absolute)) {
        return { entries: [], present: false };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(absolute, 'utf8'));
    }
    catch (error) {
        throw broken(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'the registry is plain JSON without comments');
    }
    return { entries: parseRemoved(raw).entries, present: true };
}
/** Validate a decoded registry document. Exposed so tests need no file. */
export function parseRemoved(raw) {
    const parsed = registrySchema.safeParse(raw);
    if (!parsed.success) {
        throw schemaError(parsed.error.issues, raw);
    }
    return { entries: parsed.data.entries };
}
/** Canonical registry bytes: schema key order, two spaces, exactly one final LF. */
export function serializeRemoved(registry) {
    const entries = registry.entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        target: entry.target,
        how: entry.how,
        owner: entry.owner,
        reason: entry.reason,
        link: entry.link,
        pin: entry.pin,
        contractTests: [...entry.contractTests]
    }));
    return `${JSON.stringify({ codkitRemoved: REMOVED_SCHEMA_VERSION, entries }, null, 2)}\n`;
}
function schemaError(issues, raw) {
    const issue = issues[0];
    if (issue === undefined) {
        return broken('failed validation', HINT);
    }
    const label = renderIssuePath(issue.path);
    const field = String(issue.path[issue.path.length - 1] ?? '');
    const expectation = FIELD_EXPECTATION[field] ?? issue.message;
    const actual = valueAtPath(raw, issue.path);
    const got = actual === undefined ? 'nothing' : renderValue(actual);
    return broken(label === '' ? `${expectation}, got ${got}` : `${label} ${expectation}, got ${got}`, HINT);
}
function renderIssuePath(path) {
    let out = '';
    for (const segment of path) {
        if (typeof segment === 'number') {
            out += `[${segment}]`;
            continue;
        }
        out = out === '' ? String(segment) : `${out}.${String(segment)}`;
    }
    return out;
}
function renderValue(value) {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
function valueAtPath(raw, path) {
    let current = raw;
    for (const segment of path) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = current[String(segment)];
    }
    return current;
}
function broken(message, hint) {
    return ckError('ARTIFACT-BROKEN', message, hint, REMOVED_PATH);
}
