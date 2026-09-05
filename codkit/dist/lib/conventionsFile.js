/** @scope spec://codkit/modules/codkit/PROP-003#root */
// Reading codkit/config/conventions.json (PROP-003 sec. 3).
//
// ##CONVENTIONS-SINGLE-DEFINITION: the enumerations exist once, in that file,
// and every consumer reads them from it - the marker forms, the id pattern, the
// cleanup whitelist. Nothing in the code restates them.
//
// The file ships with the tool and is looked up only next to the Codkit
// sources. A patch set is untrusted input and cannot weaken safety policy.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadBaseConfig } from './configFile.js';
import { readContainedFile } from './containedFile.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
export const CONVENTIONS_RELATIVE_PATH = 'codkit/config/conventions.json';
const conventionsSchema = z.object({
    codkitConventions: z.literal(1),
    subsystems: z.array(z.string().min(1)).default([]),
    idPattern: z.string().min(1),
    interventionTypes: z.array(z.string().min(1)).min(1),
    categories: z.array(z.string().min(1)).min(1),
    layers: z.array(z.string().min(1)).min(1),
    forbiddenPatchTargets: z.array(z.string()).default([]),
    forbiddenServiceIds: z.array(z.string().min(1)).default([]),
    cleanupWhitelist: z.array(z.string().min(1)).default([]),
    markerComment: z.record(z.string(), z.unknown()).default({})
});
const extensionMarkerSchema = z.object({ open: z.string().min(1), close: z.string() }).strict();
const conventionsExtensionSchema = z
    .object({
    codkitConventionsExtension: z.literal(1),
    subsystems: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
    forbiddenPatchTargets: z.array(z.string().min(1)).default([]),
    forbiddenServiceIds: z.array(z.string().min(1)).default([]),
    markerComment: z.record(z.string().regex(/^\.[A-Za-z0-9]+$/), extensionMarkerSchema).default({})
})
    .strict();
/** Where this module sits, so the shipped conventions can be found from it. */
const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let cachedShippedConventions = null;
const extensionCache = new Map();
export function loadConventions(patchesDir) {
    const shipped = loadShippedConventions();
    if (patchesDir === undefined)
        return shipped;
    const configured = loadBaseConfig(patchesDir)?.conventionsExtensionFile ?? null;
    if (configured === null)
        return shipped;
    const resolved = resolveContainedPath(patchesDir, configured);
    if (!resolved.ok) {
        throw ckError('CONFIG', `conventionsExtensionFile is unsafe or unreadable: ${resolved.reason}`, 'point conventionsExtensionFile at a real non-symlink JSON file inside the patch-set repository', 'codkit.json');
    }
    const cached = extensionCache.get(resolved.absolute);
    if (cached !== undefined)
        return cached;
    let raw;
    try {
        // The contained reader: parents proven real directories, leaf opened
        // without following a symlink, descriptor proven inside the patch set
        // (PROP-002 ##CONTAINED-FILE-IO).
        const read = readContainedFile(patchesDir, configured, { what: configured });
        if (read.state === 'absent') {
            throw new Error('the file does not exist');
        }
        raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
    }
    catch (error) {
        throw ckError('CONFIG', `cannot be read: ${error instanceof Error ? error.message : String(error)}`, 'write valid JSON in the configured conventions extension', configured);
    }
    const parsed = conventionsExtensionSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw ckError('CONFIG', `${issue?.path.map(String).join('.') || 'document'}: ${issue?.message ?? 'failed validation'}`, 'use the codkitConventionsExtension:1 additive schema', configured);
    }
    for (const extension of Object.keys(parsed.data.markerComment)) {
        if (Object.prototype.hasOwnProperty.call(shipped.markerComment, extension)) {
            throw ckError('CONFIG', `markerComment.${extension} cannot replace a shipped marker form`, 'remove the duplicate; extensions may add new file extensions only', configured);
        }
    }
    const subsystems = unique([...shipped.subsystems, ...parsed.data.subsystems]);
    const merged = {
        ...shipped,
        subsystems,
        idPattern: `^CK-(?:${subsystems.map(escapeRegex).join('|')})-[0-9]{3}$`,
        forbiddenPatchTargets: unique([...shipped.forbiddenPatchTargets, ...parsed.data.forbiddenPatchTargets]),
        forbiddenServiceIds: unique([...shipped.forbiddenServiceIds, ...parsed.data.forbiddenServiceIds]),
        markerComment: { ...shipped.markerComment, ...parsed.data.markerComment }
    };
    extensionCache.set(resolved.absolute, merged);
    return merged;
}
function loadShippedConventions() {
    if (cachedShippedConventions !== null)
        return cachedShippedConventions;
    let raw;
    try {
        const read = readContainedFile(codkitRoot, 'config/conventions.json', { what: CONVENTIONS_RELATIVE_PATH });
        if (read.state === 'absent') {
            throw new Error('the file does not exist');
        }
        raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
    }
    catch (error) {
        throw ckError('CONFIG', `cannot be read: ${error instanceof Error ? error.message : String(error)}`, 'conventions.json ships with codkit; restore it from the repository', CONVENTIONS_RELATIVE_PATH);
    }
    const parsed = conventionsSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
        throw ckError('CONFIG', `${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`, 'see PROP-003 sec. 3 for the conventions file', CONVENTIONS_RELATIVE_PATH);
    }
    cachedShippedConventions = parsed.data;
    return parsed.data;
}
function unique(values) {
    return [...new Set(values)];
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * gitignore semantics for the two pattern lists of conventions.json
 * (`cleanupWhitelist`, `forbiddenPatchTargets`), restricted to the shapes they
 * use:
 *   * a trailing slash matches directories only;
 *   * a leading slash anchors the pattern at the tree root and is not part of it
 *     (PROP-011 ##CLEANUP-WHITELIST-CONTENT: the rooted out-directory pattern
 *     protects the top-level build output and never `outer/` somewhere deep);
 *   * a pattern with an inner slash is anchored too, as gitignore has it;
 *   * a pattern without any slash matches at any level;
 *   * `*` does not cross a slash, `**` does.
 *
 * `path` is POSIX and relative to the tree root; a trailing slash marks a
 * directory entry.
 */
export function matchesPatternList(path, patterns) {
    const isDirectoryEntry = path.endsWith('/');
    const clean = isDirectoryEntry ? path.slice(0, -1) : path;
    const segments = clean.split('/');
    const directories = [];
    const upTo = isDirectoryEntry ? segments.length : segments.length - 1;
    for (let count = 1; count <= upTo; count += 1) {
        directories.push(segments.slice(0, count).join('/'));
    }
    for (const pattern of patterns) {
        if (pattern === '') {
            continue;
        }
        const directoryOnly = pattern.endsWith('/');
        let core = directoryOnly ? pattern.slice(0, -1) : pattern;
        const rooted = core.startsWith('/');
        if (rooted) {
            core = core.slice(1);
        }
        if (core === '') {
            continue;
        }
        const expression = globToRegExp(core, rooted || core.includes('/'));
        // A directory pattern matches the entry itself and everything under it.
        if (directories.some((directory) => expression.test(directory))) {
            return true;
        }
        if (!directoryOnly && expression.test(clean)) {
            return true;
        }
    }
    return false;
}
function globToRegExp(core, anchored) {
    let body = '';
    for (let index = 0; index < core.length; index += 1) {
        const character = core[index];
        if (character === undefined) {
            continue;
        }
        if (character === '*') {
            if (core[index + 1] === '*') {
                body += '.*';
                index += 1;
                continue;
            }
            body += '[^/]*';
            continue;
        }
        if (character === '?') {
            body += '[^/]';
            continue;
        }
        body += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
}
