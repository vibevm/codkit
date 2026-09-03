/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Pending patch headers (PROP-007 sec. 8, ##PENDING-HEADER-MECHANISM).
//
// `marker new` knows the metadata of an intervention - id, type, category,
// owner, reason - at the moment it scaffolds the block, and there is no patch
// file to put them in yet: the patch is born later, when `save` regenerates it.
// So the fields are parked in `.codkit/pending/<enc(target)>.json` and picked up
// by the first `save` that creates the patch, which then deletes them.
//
// The directory is local scratch state: `.codkit/` is not committed, so the
// metadata reaches git only inside the .ckpatch itself.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ckError } from './messages.js';
import { encodePatchName, PATCH_FILE_SUFFIX } from './patchFormat.js';
import { resolveContainedPath } from './pathSafety.js';
/** Where the drafts live, relative to the patchset root. */
export const PENDING_DIR = '.codkit/pending';
export const PENDING_FILE_SUFFIX = '.json';
const pendingSchema = z.object({
    id: z.string().min(1),
    layer: z.enum(['patch', 'entry-module']),
    type: z.string().min(1),
    category: z.string().min(1),
    owner: z.string().min(1),
    reason: z.string().min(1),
    link: z.string().min(1)
});
/**
 * `.codkit/pending/<enc(target)>.json`, with the same `/` -> `__` encoding the
 * patch file name uses (PROP-004, the patch name encoding rule), so a draft and the
 * patch it becomes are named after the same target.
 */
export function pendingPath(patchesDir, targetPath) {
    return contained(patchesDir, `${PENDING_DIR}/${pendingFileName(targetPath)}`);
}
export function pendingFileName(targetPath) {
    const encoded = encodePatchName(targetPath);
    return `${encoded.slice(0, -PATCH_FILE_SUFFIX.length)}${PENDING_FILE_SUFFIX}`;
}
export function writePendingHeader(patchesDir, targetPath, header) {
    let path = pendingPath(patchesDir, targetPath);
    mkdirSync(dirname(path), { recursive: true });
    path = pendingPath(patchesDir, targetPath);
    // The key order is the order of the header fields of PROP-004 sec. 4, so a
    // draft reads like the header it becomes.
    const document = {
        id: header.id,
        layer: header.layer,
        type: header.type,
        category: header.category,
        owner: header.owner,
        reason: header.reason,
        link: header.link
    };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    try {
        writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
        if (readFileSync(path, 'utf8') !== text) {
            throw ckError('MARKER-ARTIFACT-MISMATCH', `${PENDING_DIR}/${pendingFileName(targetPath)} already carries another pending header`, 'finish the existing draft with codkit save, or remove only that draft before retrying');
        }
    }
    return path;
}
/** The draft for a target, or null when there is none. A broken one is fatal. */
export function readPendingHeader(patchesDir, targetPath) {
    const path = pendingPath(patchesDir, targetPath);
    if (!existsSync(path)) {
        return null;
    }
    return parsePendingFile(path, `${PENDING_DIR}/${pendingFileName(targetPath)}`);
}
export function removePendingHeader(patchesDir, targetPath) {
    rmSync(pendingPath(patchesDir, targetPath), { force: true });
}
/** Every draft in the repository, in file-name order. Used for id uniqueness. */
export function listPendingHeaders(patchesDir) {
    const dir = contained(patchesDir, PENDING_DIR);
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => name.endsWith(PENDING_FILE_SUFFIX))
        .sort()
        .map((name) => ({
        fileName: name,
        header: parsePendingFile(contained(patchesDir, `${PENDING_DIR}/${name}`), `${PENDING_DIR}/${name}`)
    }));
}
function contained(patchesDir, relative) {
    const resolved = resolveContainedPath(patchesDir, relative, { allowMissing: true });
    if (!resolved.ok)
        throw ckError('HEADER-MISSING', `${relative}: unsafe pending path: ${resolved.reason}`);
    return resolved.absolute;
}
function parsePendingFile(absolutePath, label) {
    let raw;
    try {
        raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
    }
    catch (error) {
        throw ckError('HEADER-MISSING', `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, `delete it and run codkit marker new again: rm ${absolutePath}`, label);
    }
    const parsed = pendingSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
        throw ckError('HEADER-MISSING', `${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`, `delete it and run codkit marker new again: rm ${absolutePath}`, label);
    }
    return parsed.data;
}
