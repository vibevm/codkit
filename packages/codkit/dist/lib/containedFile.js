/** @scope spec://codkit/modules/codkit/PROP-002#CONTAINED-FILE-IO */
// One implementation for every file codkit reads or writes inside an area it
// administers - git directories (marks, hooks, excludes) and repository roots
// (config and data files of the patch set). The rules (PROP-002
// ##CONTAINED-FILE-IO):
//
//   * a read opens the real file behind one descriptor and never follows a
//     leaf symlink, so a link planted at the leaf can neither redirect the
//     read outside the area nor swap content under it;
//   * a write replaces the file atomically (exclusive temporary file plus
//     rename) inside a canonically verified parent only, and refuses a leaf
//     that is a symlink instead of writing through it;
//   * every directory the path descends through is proven a real directory,
//     never a symlink, before anything is created or replaced inside it;
//   * where the platform offers no O_NOFOLLOW (Windows), the leaf is checked
//     with lstat before the open and the descriptor is re-verified after it;
//     the check-then-open window that remains is documented, not hidden.
//
// There is one reader, not two: a weaker sibling that skipped the parent walk
// and the post-open containment proof was exported here with no production
// caller, and exported surface eventually gets called. It was removed rather
// than left as a trap, on the same precedent as the collapsing record reader.
//
// Nothing here decides policy (whose file it is, what bytes are legal); it only
// proves shape and location, so callers keep their own diagnostics vocabulary.
//
// The hard-link election a lock generation is published and retired through is
// a separate responsibility and lives in `containedGeneration.ts`: it needs an
// injected liveness oracle, which nothing else here does.
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isCkError } from './messages.js';
import { safeBasenameProblem } from './pathSafety.js';
import { NOFOLLOW, NONBLOCK, ensureAdminDirectory, errnoOf, isWithin, lstatIfPresent, messageOf, realpathIfPresent, refuse, refuseNonRegularLeaf, sameFile, statIfPresent, unlinkIfPresent, writeAll } from './containedPath.js';
function readAllFrom(handle) {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
        const read = readSync(handle, buffer, 0, buffer.length, null);
        if (read === 0) {
            break;
        }
        chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return new Uint8Array(Buffer.concat(chunks));
}
// Windows refuses a rename over a target that any other handle holds open -
// with EPERM, whatever sharing that handle allows, because Node's rename there
// has no POSIX semantics - and the holder measured on a file written moments
// before was a kernel-mode handle codkit cannot close (PROP-002
// ##CONTAINED-WINDOWS-REPLACE-RETRY). The rename is tried again after waits
// that double from 10 ms up to 250 ms, for as long as their sum stays inside
// the budget of the write; then the refusal is the one a failed rename has
// always been. The target is never removed first.
const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
const WINDOWS_RENAME_FIRST_WAIT_MS = 10;
const WINDOWS_RENAME_WAIT_CAP_MS = 250;
/** The waits of 10, 20, 40, 80 and 160 ms every administrative write gets. */
const WINDOWS_REPLACE_DEFAULT_BUDGET_MS = 310;
const renameWaitCell = new Int32Array(new SharedArrayBuffer(4));
function waitForRenameRetry(milliseconds) {
    Atomics.wait(renameWaitCell, 0, 0, milliseconds);
}
function replaceTemporaryFile(temporary, absolutePath, options) {
    const applyRename = options.applyRename ?? renameSync;
    const platform = options.renamePlatform ?? process.platform;
    const budget = options.windowsReplaceBudgetMs ?? WINDOWS_REPLACE_DEFAULT_BUDGET_MS;
    let waited = 0;
    for (let wait = WINDOWS_RENAME_FIRST_WAIT_MS;; wait = Math.min(wait * 2, WINDOWS_RENAME_WAIT_CAP_MS)) {
        try {
            applyRename(temporary, absolutePath);
            return;
        }
        catch (error) {
            if (platform !== 'win32' || waited + wait > budget || !WINDOWS_TRANSIENT_RENAME_ERRORS.has(errnoOf(error) ?? '')) {
                throw error;
            }
            (options.waitForRenameRetry ?? waitForRenameRetry)(wait);
            waited += wait;
        }
    }
}
/**
 * The contained read for repository files: the parent directories are proven
 * real directories first, the leaf is opened without following a symlink, and
 * after the open the descriptor is proven to name a file inside `root` - so a
 * parent swapped to a symlink between the walk and the open is still caught
 * and the bytes that were read are never used.
 */
export function readContainedFile(root, repositoryPath, options) {
    const segments = repositoryPath.split('/');
    const leaf = segments[segments.length - 1] ?? '';
    if (leaf === '' || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        refuse(options, `${JSON.stringify(repositoryPath)} is not a canonical relative file path`, 'point at a file inside the root by its relative path');
    }
    let current = resolve(root);
    for (const segment of segments.slice(0, -1)) {
        current = join(current, segment);
        let stat;
        try {
            stat = lstatSync(current);
        }
        catch (error) {
            if (errnoOf(error) === 'ENOENT') {
                return { state: 'absent' };
            }
            refuse(options, `cannot inspect ${current}: ${messageOf(error)}`, 'make the path readable');
        }
        if (stat.isSymbolicLink()) {
            refuse(options, `contains a symlink component at ${relative(resolve(root), current)}`, 'replace symlinks with real directories inside the root');
        }
        if (!stat.isDirectory()) {
            refuse(options, `contains a non-directory component at ${relative(resolve(root), current)}`, 'the path must descend through directories only');
        }
    }
    const absolute = join(current, leaf);
    // Open first, prove afterwards: the descriptor pins the file that was read,
    // and the proof compares it against the canonical location.
    refuseNonRegularLeaf(absolute, options);
    options.beforeOpen?.();
    let handle;
    try {
        handle = openSync(absolute, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
    }
    catch (error) {
        const code = errnoOf(error);
        if (code === 'ENOENT') {
            return { state: 'absent' };
        }
        if (code === 'ELOOP' || (NOFOLLOW === 0 && code === 'EPERM')) {
            refuse(options, 'must be a regular non-symlink file', 'replace it with a real file inside the root');
        }
        refuse(options, `cannot be read: ${messageOf(error)}`, 'check file permissions');
    }
    try {
        const shape = fstatSync(handle);
        if (!shape.isFile()) {
            refuse(options, 'must be a regular non-symlink file', 'replace it with a real regular file inside the root');
        }
        options.afterOpen?.();
        // Post-open containment: prove the descriptor names a file inside the
        // real root. A parent component swapped to a symlink after the walk
        // redirected the open outside; that answer is refused, never parsed.
        let rootReal;
        let canonical;
        try {
            rootReal = realpathSync(resolve(root));
            canonical = realpathSync(absolute);
        }
        catch (error) {
            refuse(options, `cannot prove the file is inside ${resolve(root)}: ${messageOf(error)}`, 'replace symlinks with real files inside the root');
        }
        if (!isWithin(rootReal, canonical)) {
            refuse(options, 'resolves outside the root', 'replace symlinks with real files inside the root');
        }
        const named = statIfPresent(canonical);
        if (named === null || !sameFile(shape, named)) {
            // The path moved between the open and the proof; conservative refusal.
            refuse(options, 'changed while it was being read', 're-run the command');
        }
        return { state: 'ok', bytes: readAllFrom(handle) };
    }
    catch (error) {
        if (isCkError(error)) {
            throw error;
        }
        refuse(options, `cannot be read: ${messageOf(error)}`, 'check file permissions');
    }
    finally {
        closeSync(handle);
    }
}
/** Atomically replace one exact relative file inside `root`. */
export function writeContainedFileAtomic(root, repositoryPath, options) {
    const segments = repositoryPath.split('/');
    const name = segments.pop() ?? '';
    if (name === '' || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        refuse(options, `${JSON.stringify(repositoryPath)} is not a canonical relative file path`, 'write only inside the declared root');
    }
    const parent = ensureAdminDirectory(root, segments, options);
    writeRegularFileAtomic(join(parent, name), options);
}
/** Remove one exact contained regular file; absent is already complete. */
export function removeContainedFile(root, repositoryPath, options) {
    const segments = repositoryPath.split('/');
    const name = segments.pop() ?? '';
    const parent = ensureAdminDirectory(root, segments, { ...options, create: false });
    // `ensureAdminDirectory` with `create: false` may return a path whose
    // components do not exist, and the contract above covers that state: no
    // parent means nothing contained is left to remove, the same answer the
    // absent leaf below gets - never a raw errno out of a stat.
    const parentShape = statIfPresent(parent);
    if (parentShape === null)
        return;
    const path = join(parent, name);
    const leaf = lstatIfPresent(path);
    if (leaf === null)
        return;
    if (leaf.isSymbolicLink()) {
        refuse(options, 'must be a regular non-symlink file', 'remove the unexpected entry manually');
    }
    if (!leaf.isFile()) {
        // The refusal names the state it refuses: a pipe, socket, device or
        // directory is not a symlink, and hinting at one sends the operator
        // looking for a link that is not there.
        refuse(options, 'must be a regular file', 'remove the pipe, socket, device or directory entry manually');
    }
    options.afterOpen?.();
    const currentParent = statIfPresent(ensureAdminDirectory(root, segments, { ...options, create: false }));
    if (currentParent === null)
        return;
    const currentLeaf = lstatIfPresent(path);
    if (!sameFile(parentShape, currentParent) || currentLeaf === null || !sameFile(leaf, currentLeaf)) {
        refuse(options, 'changed before contained removal', 'retry after inspecting the contained path');
    }
    unlinkSync(path);
}
/** Publish complete bytes at an absent contained path in one atomic link step. */
export function writeContainedFileExclusive(root, repositoryPath, options) {
    const segments = repositoryPath.split('/');
    const name = segments.pop() ?? '';
    const parent = ensureAdminDirectory(root, segments, options);
    const parentShape = statSync(parent);
    const path = join(parent, name);
    const candidate = join(parent, `.${name}.${randomUUID()}.candidate`);
    const handle = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, options.mode ?? 0o666);
    try {
        try {
            writeAll(handle, options);
        }
        finally {
            closeSync(handle);
        }
    }
    catch (error) {
        unlinkIfPresent(candidate);
        throw error;
    }
    // From here every exit unlinks the candidate, the seam's own throw included:
    // the neighbouring failure paths all clean up, and an asymmetry here is one
    // refactor away from littering a directory humans are told to inspect.
    try {
        options.afterOpen?.();
        const verifiedParent = ensureAdminDirectory(root, segments, options);
        if (!sameFile(parentShape, statSync(verifiedParent))) {
            refuse(options, 'runtime parent identity changed before exclusive publication', 'retry after repairing the contained root');
        }
        try {
            linkSync(candidate, path);
            return true;
        }
        catch (error) {
            if (errnoOf(error) === 'EEXIST')
                return false;
            throw error;
        }
    }
    finally {
        unlinkIfPresent(candidate);
    }
}
/** Open one contained regular file for append/create without following a leaf link. */
export function openContainedFileAppend(root, repositoryPath, options) {
    const segments = repositoryPath.split('/');
    const name = segments.pop() ?? '';
    const parent = ensureAdminDirectory(root, segments, options);
    const parentShape = statSync(parent);
    const path = join(parent, name);
    const leaf = lstatIfPresent(path);
    refuseNonRegularLeaf(path, options);
    if (leaf !== null && leaf.nlink > 1)
        refuse(options, 'has more than one hard link; refusing append', 'replace it with a singly linked regular file');
    options.beforeOpen?.();
    let handle;
    try {
        handle = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | NOFOLLOW | NONBLOCK, 0o666);
    }
    catch (error) {
        refuse(options, `cannot be opened for append: ${messageOf(error)}`, 'check the contained runtime directory');
    }
    const shape = fstatSync(handle);
    if (!shape.isFile()) {
        closeSync(handle);
        refuse(options, 'must be a regular file', 'replace the entry with a regular file');
    }
    try {
        options.afterOpen?.();
        const verifiedParent = ensureAdminDirectory(root, segments, options);
        const named = lstatIfPresent(join(verifiedParent, name));
        if (!sameFile(parentShape, statSync(verifiedParent)) || named === null || named.isSymbolicLink() || !sameFile(shape, named)) {
            refuse(options, 'changed while the append descriptor was being opened', 'retry after repairing the contained runtime path');
        }
    }
    catch (error) {
        closeSync(handle);
        throw error;
    }
    return handle;
}
/** Rename one contained regular file to another direct contained name. */
export function renameContainedFile(root, from, to, options) {
    const fromSegments = from.split('/');
    const toSegments = to.split('/');
    const fromName = fromSegments.pop() ?? '';
    const toName = toSegments.pop() ?? '';
    if (fromSegments.join('/') !== toSegments.join('/')) {
        refuse(options, 'contained rename must stay in one directory', 'use sibling runtime files');
    }
    const parent = ensureAdminDirectory(root, fromSegments, options);
    const parentShape = statSync(parent);
    const source = join(parent, fromName);
    const target = join(parent, toName);
    const sourceShape = lstatIfPresent(source);
    if (sourceShape === null)
        return false;
    if (sourceShape.isSymbolicLink() || !sourceShape.isFile())
        refuse(options, 'rename source must be a regular file', 'remove the unexpected entry');
    const targetShape = lstatIfPresent(target);
    if (targetShape?.isSymbolicLink() || (targetShape !== null && !targetShape.isFile())) {
        refuse(options, 'rename target must be absent or a regular file', 'remove the unexpected entry');
    }
    options.afterOpen?.();
    const verifiedParent = ensureAdminDirectory(root, fromSegments, options);
    if (!sameFile(parentShape, statSync(verifiedParent))) {
        refuse(options, 'runtime parent identity changed before rename', 'retry after repairing the contained root');
    }
    // No unlink of the target first: `rename` replaces an existing regular
    // target atomically, and unlinking buys only a window in which the
    // rotation target does not exist and any rename failure loses the previous
    // rotation outright. The shape refusal above keeps the rename off a symlink
    // or a non-regular target.
    renameSync(source, target);
    return true;
}
/**
 * Replace one administrative regular file atomically: an exclusive temporary
 * file inside the verified parent, then rename over the leaf. A leaf symlink is
 * refused, never written through; so is any non-regular leaf - the writer
 * replaces files, it does not silently delete a pipe, socket, device or
 * directory a human placed at the path it is told to administer. A symlink
 * raced in after the check is replaced by the rename itself, so the link
 * target is never modified.
 */
export function writeRegularFileAtomic(absolutePath, options) {
    const parent = dirname(absolutePath);
    const name = absolutePath.split(sep).pop() ?? '';
    if (name === '' || safeBasenameProblem(name) !== null) {
        refuse(options, `unsafe administrative file name ${JSON.stringify(name)}`, 'this is a bug in codkit unless the git directory is damaged');
    }
    let canonicalParent;
    let parentShape;
    try {
        parentShape = lstatSync(parent);
        if (parentShape.isSymbolicLink() || !parentShape.isDirectory()) {
            refuse(options, `the parent ${parent} must be a real directory`, 'replace the symlink or non-directory parent and retry');
        }
        canonicalParent = realpathSync(parent);
        if (canonicalParent !== resolve(parent)) {
            refuse(options, `the parent ${parent} resolves through a symlink`, 'write only inside a canonical real administrative directory');
        }
    }
    catch (error) {
        if (isCkError(error)) {
            throw error;
        }
        refuse(options, `cannot resolve the parent directory ${parent}: ${messageOf(error)}`, 'check the git directory');
    }
    const leaf = lstatIfPresent(absolutePath);
    if (leaf !== null && leaf.isSymbolicLink()) {
        refuse(options, 'is a symlink; codkit never writes through one', 'remove the link and re-run; the target it points at was not touched');
    }
    if (leaf !== null && !leaf.isFile()) {
        refuse(options, 'must be a regular file', 'codkit replaces regular files only; remove the pipe, socket, device or directory entry and re-run');
    }
    if (leaf !== null && leaf.nlink > 1) {
        refuse(options, 'has more than one hard link; refusing replacement', 'replace it with a singly linked regular file');
    }
    const temporary = join(parent, `.${name}.${randomUUID()}.tmp`);
    let handle;
    try {
        handle = openSync(temporary, 'wx');
    }
    catch (error) {
        refuse(options, `cannot create a temporary file beside ${absolutePath}: ${messageOf(error)}`, 'check the permissions of the parent directory');
    }
    let renamed = false;
    try {
        try {
            writeAll(handle, options);
        }
        catch (error) {
            refuse(options, `cannot write ${absolutePath}: ${messageOf(error)}`, 'check the permissions of the parent directory');
        }
        finally {
            closeSync(handle);
        }
        if (options.mode !== undefined) {
            try {
                (options.applyMode ?? chmodSync)(temporary, options.mode);
            }
            catch (error) {
                refuse(options, `cannot set the mode of ${absolutePath}: ${messageOf(error)}`, 'check the permissions of the parent directory');
            }
        }
        options.afterOpen?.();
        const beforeRenameParent = lstatIfPresent(parent);
        const beforeRenameLeaf = lstatIfPresent(absolutePath);
        if (beforeRenameParent === null ||
            beforeRenameParent.isSymbolicLink() ||
            !sameFile(parentShape, beforeRenameParent) ||
            (leaf === null ? beforeRenameLeaf !== null : beforeRenameLeaf === null || !sameFile(leaf, beforeRenameLeaf))) {
            refuse(options, 'the parent or target changed before atomic replacement', 'retry after inspecting the contained path');
        }
        try {
            replaceTemporaryFile(temporary, absolutePath, options);
        }
        catch (error) {
            refuse(options, `cannot atomically replace ${absolutePath}: ${messageOf(error)}`, 'check the permissions of the parent directory');
        }
        renamed = true;
    }
    finally {
        // Every exit between the open and the rename removes the temporary: a
        // mode failure, a throwing seam, a refused re-verification - not only
        // the exits that used to clean up after themselves.
        if (!renamed) {
            unlinkIfPresent(temporary);
        }
    }
    // The write above happened inside the parent verified before it; prove the
    // parent still is that directory, so a mid-write redirect is reported
    // instead of passing silently.
    options.afterReplace?.();
    const afterParent = lstatIfPresent(parent);
    if (afterParent === null ||
        afterParent.isSymbolicLink() ||
        !afterParent.isDirectory() ||
        !sameFile(parentShape, afterParent) ||
        realpathIfPresent(parent) !== canonicalParent) {
        refuse(options, 'the parent directory changed during the write', `check ${parent}; the write may have landed in a replaced directory`);
    }
}
