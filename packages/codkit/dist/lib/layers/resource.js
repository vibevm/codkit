/** @scope spec://codkit/modules/codkit/PROP-005#root */
// resource-file layer: the map and its two existence rules (PROP-005 sec. 6).
//
// The layer replaces the *content* of an upstream file under its own name -
// brand resource names are hard-coded in the upstream build, so renaming is not
// an option (##RESOURCE-MAP-FORMAT). Two invariants make the layer honest:
//
//   * `source` must exist in patchset and live under delta/resources/files/, so a
//     map entry can never point at something outside the delta;
//   * `target` must exist at the pin, so the layer cannot quietly add files -
//     that is what a patch is for.
//
// A guard test is mandatory on every entry (##RESOURCE-GUARD-MANDATORY): this is
// the layer where upstream silently losing a branded binary is invisible to the
// compiler.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { runGit } from '../gitx.js';
import { ckError } from '../messages.js';
import { repoRelativePathProblem, resolveContainedPath } from '../pathSafety.js';
export const RESOURCE_MAP_SCHEMA_VERSION = 2;
/** The map file, relative to the patchset root. */
export const RESOURCE_MAP_PATH = 'delta/resources/map.json';
/** Every source file must live under this prefix, relative to the patchset root. */
export const RESOURCE_FILES_PREFIX = 'delta/resources/files/';
const entrySchema = z.object({
    id: z.string().min(1),
    target: z.string().min(1),
    source: z.string().min(1),
    type: z.string().min(1),
    category: z.string().min(1),
    owner: z.string().min(1),
    reason: z.string().min(1),
    link: z.string().min(1),
    cause: z.string().min(1),
    pin: z.string().min(1),
    contractTests: z.array(z.string().min(1)).min(1)
});
const mapSchema = z.object({
    codkitResourceMap: z.literal(RESOURCE_MAP_SCHEMA_VERSION),
    entries: z.array(entrySchema)
});
/**
 * Read delta/resources/map.json. Returns null when there is no map at all,
 * which is a legal state for a delta that replaces no resources.
 */
export function loadResourceMap(patchesDir) {
    const absolute = join(patchesDir, ...RESOURCE_MAP_PATH.split('/'));
    if (!existsSync(absolute)) {
        return null;
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(absolute, 'utf8'));
    }
    catch (error) {
        throw broken(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'the resource map is plain JSON without comments');
    }
    const map = parseResourceMap(raw);
    for (const entry of map.entries) {
        assertSourceUsable(patchesDir, entry);
    }
    return map;
}
/**
 * Validate a decoded map document and put its entries in target order. Exposed
 * without the file system so a staged blob can be checked before it is
 * committed, and so tests need no directory.
 */
export function parseResourceMap(raw) {
    const parsed = mapSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? '' : renderPath(issue.path);
        throw broken(`${where === '' ? 'document' : where} ${issue?.message ?? 'failed validation'}`, 'see PROP-005 sec. 6 for the resource map format; every entry needs a non-empty contractTests list');
    }
    const entries = [...parsed.data.entries];
    for (const entry of entries) {
        const targetProblem = repoRelativePathProblem(entry.target);
        if (targetProblem !== null) {
            throw broken(`${entry.id}: target ${entry.target} ${targetProblem}`, 'use a canonical path relative to the fork-tree root');
        }
        const sourceProblem = repoRelativePathProblem(entry.source);
        if (sourceProblem !== null) {
            throw broken(`${entry.id}: source ${entry.source} ${sourceProblem}`, `use a canonical path below ${RESOURCE_FILES_PREFIX}`);
        }
    }
    const wasSorted = isSortedByTarget(entries);
    entries.sort((left, right) => compareBytes(left.target, right.target));
    return { entries, wasSorted };
}
/** Canonical map bytes, including the schema-defined target ordering. */
export function serializeResourceMap(map) {
    const entries = [...map.entries]
        .sort((left, right) => compareBytes(left.target, right.target))
        .map((entry) => ({
        id: entry.id,
        target: entry.target,
        source: entry.source,
        type: entry.type,
        category: entry.category,
        owner: entry.owner,
        reason: entry.reason,
        link: entry.link,
        cause: entry.cause,
        pin: entry.pin,
        contractTests: [...entry.contractTests]
    }));
    return `${JSON.stringify({ codkitResourceMap: RESOURCE_MAP_SCHEMA_VERSION, entries }, null, 2)}\n`;
}
/** Absolute path of an entry's source file in patchset. */
export function resourceSourcePath(patchesDir, entry) {
    const resolved = resolveContainedPath(patchesDir, entry.source, { allowMissing: true });
    if (!resolved.ok) {
        throw broken(`${entry.id}: source ${entry.source} is unsafe: ${resolved.reason}`, `use a regular file below ${RESOURCE_FILES_PREFIX}, not a symlink`);
    }
    return resolved.absolute;
}
/**
 * The target must exist at the pin: the layer replaces content, it does not add
 * files. Checked against git objects, so it works on a dirty tree too.
 */
export function assertTargetAtPin(treeDir, pinSha, entry) {
    const result = runGit({ args: ['cat-file', '-e', `${pinSha}:${entry.target}`], cwd: treeDir });
    if (result.status !== 0) {
        throw ckError('ARTIFACT-BROKEN', `${entry.id}: the target ${entry.target} does not exist at the pin, and the resource-file layer replaces content, it does not add files`, 'move the file into own code, or add it with an add-file patch if it must live in the upstream zone', RESOURCE_MAP_PATH);
    }
}
function assertSourceUsable(patchesDir, entry) {
    if (!entry.source.startsWith(RESOURCE_FILES_PREFIX)) {
        throw broken(`${entry.id}: source ${entry.source} is outside ${RESOURCE_FILES_PREFIX}`, `move the file under ${RESOURCE_FILES_PREFIX} and point the entry at it`);
    }
    const absolute = resourceSourcePath(patchesDir, entry);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        throw broken(`${entry.id}: source ${entry.source} does not exist in patchset`, `add the file at ${entry.source}, or remove the entry from the map`);
    }
}
function isSortedByTarget(entries) {
    for (let index = 1; index < entries.length; index += 1) {
        const previous = entries[index - 1];
        const current = entries[index];
        if (previous !== undefined && current !== undefined && compareBytes(previous.target, current.target) > 0) {
            return false;
        }
    }
    return true;
}
function compareBytes(left, right) {
    return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}
function renderPath(path) {
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
function broken(message, hint) {
    return ckError('ARTIFACT-BROKEN', message, hint, RESOURCE_MAP_PATH);
}
