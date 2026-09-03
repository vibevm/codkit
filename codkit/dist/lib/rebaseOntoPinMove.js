/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
// Durable full-worktree reconciliation for rebase-onto-pin. The real HEAD and
// index never move; a canonical intent record makes every partial state either
// exactly resumable or a fail-closed mismatch.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { porcelainZEntries } from './driftGuard.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
import { removeRequired, writeControlExclusive } from './renameFileState.js';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.js';
import { listOwnFiles } from './ownCopy.js';
import { createRebaseCheckoutContext, readRebaseWorktreeSemantics, releaseRebaseCheckoutContext, rebaseTreeEntry, rebaseTreeObject } from './rebaseOntoPinCheckout.js';
import { REBASE_MOVE_PATH, REBASE_MOVE_VERSION, hasRebaseMoveRecord, readRebaseMoveRecord } from './rebaseOntoPinMoveReceipt.js';
export { REBASE_MOVE_PATH } from './rebaseOntoPinMoveReceipt.js';
/** Canonical presence check used before granting retry-only dirty-patchset authority. */
export function rebaseMovePending(patchesDir) {
    return hasRebaseMoveRecord(patchesDir);
}
export function assertRebasePendingMoveBinding(patchesDir, treeDir, pending, allowAdvancedTarget) {
    const record = readRebaseMoveRecord(patchesDir);
    const target = record?.entries.find((entry) => entry.path === pending.targetPath);
    const advanced = allowAdvancedTarget &&
        target !== undefined &&
        sameState(worktreeState(treeDir, pending.targetPath, readRebaseWorktreeSemantics(treeDir)), target.after);
    if (record === null || record.state !== 'complete' || target === undefined || (record.desiredTree !== pending.desiredTree && !advanced)) {
        throw moveError(`${pending.targetPath}: conflict pending record is not bound to the completed desired tree`);
    }
}
export function retireCompletedRebaseMove(patchesDir) {
    const record = readRebaseMoveRecord(patchesDir);
    if (record?.state === 'complete')
        removeRequired(patchesDir, REBASE_MOVE_PATH);
}
/** Advance a completed conflict tree to the exact manually resolved worktree bytes. */
export function advanceCompletedRebaseMove(patchesDir, treeDir, targetPath) {
    const record = readRebaseMoveRecord(patchesDir);
    if (record === null || record.state !== 'complete' || !record.entries.some((entry) => entry.path === targetPath)) {
        throw moveError(`${targetPath}: cannot advance absent completed conflict receipt`);
    }
    const index = contained(patchesDir, '.codkit/rebase-onto-pin-resolved.index', true);
    const blobFile = contained(patchesDir, '.codkit/rebase-onto-pin-resolved.blob', true);
    const semantics = readRebaseWorktreeSemantics(treeDir);
    rmSync(index, { force: true });
    rmSync(blobFile, { force: true });
    const env = { GIT_INDEX_FILE: index };
    try {
        mustGit(treeDir, ['read-tree', record.head], env, 'seed resolved rebase tree');
        const entries = record.entries.map((entry) => {
            const actual = worktreeState(treeDir, entry.path, semantics);
            if (entry.path !== targetPath && !sameState(actual, entry.after)) {
                throw moveError(`${entry.path}: non-conflict path changed before resolved receipt update`);
            }
            let object = null;
            if (actual === null)
                mustGit(treeDir, ['update-index', '--force-remove', '--', entry.path], env, `remove ${entry.path}`);
            else {
                const mode = canonicalMode(actual, entry.afterObject, semantics);
                const blob = storeWorktreeEntry(treeDir, entry.path, mode, blobFile, env);
                object = { oid: blob, mode };
                mustGit(treeDir, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${entry.path}`], env, `stage ${entry.path}`);
            }
            return entry.path === targetPath ? { ...entry, after: actual, afterObject: object } : entry;
        });
        const desiredTree = mustGit(treeDir, ['write-tree'], env, 'write resolved rebase tree');
        replaceRecord(patchesDir, { ...record, desiredTree, entries });
        return desiredTree;
    }
    finally {
        rmSync(index, { force: true });
        rmSync(blobFile, { force: true });
    }
}
export function retireHistoricalCompletedRebaseMove(patchesDir, treeDir, currentPatchSetHead) {
    const record = readRebaseMoveRecord(patchesDir);
    if (record === null || record.state !== 'complete' || record.patchsetHead === currentPatchSetHead)
        return false;
    if (runGit({ args: ['merge-base', '--is-ancestor', record.patchsetHead, currentPatchSetHead], cwd: patchesDir }).status !== 0) {
        throw moveError('completed receipt does not belong to an ancestor of the current patchset merge');
    }
    const status = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: treeDir });
    if (status.status !== 0 || status.stdout !== '')
        throw moveError('fork must be clean before retiring a historical completed receipt');
    removeRequired(patchesDir, REBASE_MOVE_PATH);
    return true;
}
export function completedRebaseMoveForSync(patchesDir, treeDir) {
    const record = readRebaseMoveRecord(patchesDir);
    if (record === null || record.state !== 'complete')
        return null;
    const patchsetStatus = runGit({
        args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).codkit'],
        cwd: patchesDir
    });
    if (patchsetStatus.status !== 0 || patchsetStatus.stdout !== '')
        throw moveError('completed receipt requires committed clean patchset delta');
    const currentHead = runGit({ args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: patchesDir });
    const head = currentHead.stdout.trim();
    if (currentHead.status !== 0 ||
        !/^([0-9a-f]{40})$/.test(head) ||
        runGit({ args: ['merge-base', '--is-ancestor', record.patchsetHead, head], cwd: patchesDir }).status !== 0) {
        throw moveError('completed receipt patchset merge is not an ancestor of current committed delta');
    }
    const semantics = readRebaseWorktreeSemantics(treeDir);
    for (const entry of record.entries) {
        if (!sameState(worktreeState(treeDir, entry.path, semantics), entry.after))
            throw moveError(`${entry.path}: completed receipt fork bytes changed`);
    }
    const allowed = new Set(record.entries.map((entry) => entry.path));
    const forkStatus = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: treeDir });
    if (forkStatus.status !== 0)
        throw moveError('completed receipt fork status is unreadable');
    const extra = porcelainZEntries(forkStatus.stdout)
        .map((entry) => entry.path)
        .filter((path) => !allowed.has(path));
    if (extra.length > 0)
        throw moveError(`completed receipt has unrelated fork dirt: ${extra.join(', ')}`);
    return { desiredTree: record.desiredTree };
}
export function assertCompletedRebaseMoveSyncTree(patchesDir, treeDir, expectedTree, actualTree) {
    const record = readRebaseMoveRecord(patchesDir);
    if (record === null || record.state !== 'complete' || record.desiredTree !== expectedTree) {
        throw moveError('sync completion lost its exact completed receipt');
    }
    for (const entry of record.entries) {
        const actual = rebaseTreeObject(treeDir, actualTree, entry.path);
        if (!sameObject(actual, entry.afterObject))
            throw moveError(`${entry.path}: sync tree differs from completed receipt object (${JSON.stringify(actual)} != ${JSON.stringify(entry.afterObject)})`);
    }
    const diff = runGit({ args: ['diff', '--name-only', '-z', record.head, actualTree], cwd: treeDir });
    if (diff.status !== 0 || (diff.stdout !== '' && !diff.stdout.endsWith('\0')))
        throw moveError('cannot compare sync tree with receipt base');
    const actualChanged = diff.stdout.split('\0').filter(Boolean).sort(compareText);
    const expectedChanged = record.entries
        .filter((entry) => !sameObject(rebaseTreeObject(treeDir, record.head, entry.path), entry.afterObject))
        .map((entry) => entry.path)
        .sort(compareText);
    if (JSON.stringify(actualChanged) !== JSON.stringify(expectedChanged))
        throw moveError(`sync tree changed paths differ from completed receipt (${JSON.stringify(actualChanged)} != ${JSON.stringify(expectedChanged)})`);
}
export function finishCompletedRebaseMoveSync(patchesDir, treeDir, expectedTree, actualTree) {
    assertCompletedRebaseMoveSyncTree(patchesDir, treeDir, expectedTree, actualTree);
    const status = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: treeDir });
    if (status.status !== 0 || status.stdout !== '')
        throw moveError('sync did not leave the fork clean while consuming completed receipt');
    removeRequired(patchesDir, REBASE_MOVE_PATH);
}
/** Reconcile every path changed by the complete desired tree, resuming exact partial work. */
export function materializeRebaseDesiredTree(options) {
    const head = exactHead(options.treeDir);
    const existing = readRebaseMoveRecord(options.patchesDir);
    const rollover = existing?.state === 'complete' && existing.patchsetHead !== options.patchsetHead;
    const checkout = createRebaseCheckoutContext(options.scratchTree, options.treeDir);
    const semantics = checkout.semantics;
    const desired = (() => {
        try {
            if (rollover)
                assertCompletedRollover(options, existing, semantics);
            return desiredEntries(options, checkout, head, existing, rollover);
        }
        finally {
            releaseRebaseCheckoutContext(checkout);
        }
    })();
    const record = {
        codkitRebaseOntoPinMove: REBASE_MOVE_VERSION,
        state: 'active',
        patchsetHead: options.patchsetHead,
        head,
        desiredTree: options.desiredTree,
        entries: desired.map(({ path, before, after, beforeObject, afterObject }) => ({ path, before, after, beforeObject, afterObject }))
    };
    reconcileMoveTemps(options.treeDir, desired, semantics);
    assertIgnoredClean(options.treeDir, options.allowedIgnoredPrefix, options.allowedIgnoredPaths);
    if (existing === null) {
        const alreadyDesired = desired.every((entry) => sameState(worktreeState(options.treeDir, entry.path, semantics), entry.after));
        if (alreadyDesired)
            assertRecognizedPartial(options.treeDir, desired, semantics);
        else {
            assertForkClean(options.treeDir);
            assertAllBefore(options.treeDir, desired, semantics);
        }
        if (desired.length === 0)
            return { paths: [], complete() { } };
        writeControlExclusive(options.patchesDir, REBASE_MOVE_PATH, `${JSON.stringify(record, null, 2)}\n`);
    }
    else {
        if (rollover) {
            assertAllBefore(options.treeDir, desired, semantics);
            replaceRecord(options.patchesDir, record);
        }
        else {
            if (JSON.stringify({ ...existing, state: 'active' }) !== JSON.stringify(record))
                throw moveError('pending move does not match the recomputed graph and desired tree');
            assertRecognizedPartial(options.treeDir, desired, semantics);
        }
    }
    let completed = 0;
    for (const entry of desired) {
        const actual = worktreeState(options.treeDir, entry.path, semantics);
        if (!sameState(actual, entry.after)) {
            if (!sameState(actual, entry.before))
                throw moveError(`${entry.path}: worktree bytes are neither recorded before nor desired after`);
            applyEntry(options, entry);
        }
        completed += 1;
        options.checkpoint?.(entry.path, completed);
    }
    const paths = desired.map((entry) => entry.path);
    return {
        paths,
        complete() {
            for (const entry of desired) {
                if (!sameState(worktreeState(options.treeDir, entry.path, semantics), entry.after))
                    throw moveError(`${entry.path}: desired state did not persist`);
            }
            replaceRecord(options.patchesDir, { ...record, state: 'complete' });
            options.completedCheckpoint?.();
        }
    };
}
function replaceRecord(patchesDir, record) {
    const target = contained(patchesDir, REBASE_MOVE_PATH, false);
    const temporary = contained(patchesDir, `${REBASE_MOVE_PATH}.${randomUUID()}.tmp`, true);
    try {
        writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
        renameSync(temporary, target);
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
function assertCompletedRollover(options, record, semantics) {
    if (!options.allowCompletedRollover)
        throw moveError('completed receipt still has unresolved conflict pending records');
    if (runGit({ args: ['merge-base', '--is-ancestor', record.patchsetHead, options.patchsetHead], cwd: options.patchesDir }).status !== 0) {
        throw moveError('completed receipt is not an ancestor of the new patchset merge');
    }
    for (const entry of record.entries) {
        if (!sameState(worktreeState(options.treeDir, entry.path, semantics), entry.after)) {
            throw moveError(`${entry.path}: completed receipt no longer matches the fork worktree`);
        }
    }
    const allowed = new Set(record.entries.map((entry) => entry.path));
    const status = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: options.treeDir });
    if (status.status !== 0)
        throw moveError('cannot inspect completed receipt before rollover');
    const extra = porcelainZEntries(status.stdout)
        .map((entry) => entry.path)
        .filter((path) => !allowed.has(path));
    if (extra.length > 0)
        throw moveError(`completed receipt has unrelated fork dirt: ${extra.join(', ')}`);
}
function assertIgnoredClean(treeDir, allowedPrefix, allowedPaths) {
    const status = runGit({ args: ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal'], cwd: treeDir });
    if (status.status !== 0)
        throw moveError('fork ignored-file status is unreadable');
    const forbidden = porcelainZEntries(status.stdout)
        .filter((entry) => entry.status === '!!')
        .map((entry) => entry.path)
        .filter((path) => path !== allowedPrefix.slice(0, -1) && !path.startsWith(allowedPrefix) && !allowedPaths.includes(path));
    if (forbidden.length > 0)
        throw moveError(`fork has unrelated ignored paths: ${forbidden.join(', ')}`);
}
function desiredEntries(options, checkout, head, existing, rollover) {
    const { scratchTree, desiredTree, treeDir, allowedIgnoredPrefix, allowedOwnBeforeTree } = options;
    const diff = runGit({ args: ['diff', '--name-status', '--no-renames', '-z', head, desiredTree], cwd: scratchTree });
    if (diff.status !== 0 || (diff.stdout !== '' && !diff.stdout.endsWith('\0')))
        throw moveError('cannot compare real HEAD with the scratch desired tree');
    const fields = diff.stdout.split('\0');
    fields.pop();
    const paths = new Set();
    for (let index = 0; index < fields.length; index += 2) {
        const status = fields[index] ?? '';
        const path = fields[index + 1] ?? '';
        if (!/^[ADMT]$/.test(status) || path === '')
            throw moveError(`malformed desired-tree diff record ${JSON.stringify(status)}`);
        paths.add(path);
    }
    const ownRoot = contained(treeDir, allowedIgnoredPrefix.slice(0, -1), true);
    for (const relative of listOwnFiles(ownRoot, { refuseSymlinks: true }))
        paths.add(`${allowedIgnoredPrefix}${relative}`);
    const desiredOwn = runGit({ args: ['ls-tree', '-r', '--name-only', '-z', desiredTree, '--', allowedIgnoredPrefix], cwd: scratchTree });
    if (desiredOwn.status !== 0 || (desiredOwn.stdout !== '' && !desiredOwn.stdout.endsWith('\0')))
        throw moveError('cannot list desired own files');
    for (const path of desiredOwn.stdout.split('\0').filter(Boolean))
        paths.add(path);
    const sourceOwn = runGit({
        args: ['ls-tree', '-r', '--name-only', '-z', allowedOwnBeforeTree, '--', allowedIgnoredPrefix],
        cwd: scratchTree
    });
    if (sourceOwn.status !== 0 || (sourceOwn.stdout !== '' && !sourceOwn.stdout.endsWith('\0')))
        throw moveError('cannot list source own files');
    for (const path of sourceOwn.stdout.split('\0').filter(Boolean))
        paths.add(path);
    for (const path of options.allowedIgnoredPaths)
        paths.add(path);
    for (const entry of existing?.entries ?? [])
        paths.add(entry.path);
    const existingByPath = new Map(existing?.entries.map((entry) => [entry.path, entry]) ?? []);
    return [...paths].sort(compareText).map((path) => {
        const before = rebaseTreeEntry(checkout, head, path);
        const after = rebaseTreeEntry(checkout, desiredTree, path);
        const existingEntry = existingByPath.get(path);
        let recordedBefore = rollover && existingEntry !== undefined ? existingEntry.after : (before?.digest ?? null);
        let recordedBeforeObject = rollover && existingEntry !== undefined ? existingEntry.afterObject : (before?.object ?? null);
        if (path.startsWith(allowedIgnoredPrefix)) {
            if (rollover && existingEntry !== undefined) {
                recordedBefore = existingEntry.after;
                recordedBeforeObject = existingEntry.afterObject;
            }
            else if (existingEntry !== undefined) {
                recordedBefore = existingEntry.before;
                recordedBeforeObject = existingEntry.beforeObject;
            }
            else {
                recordedBefore = worktreeState(treeDir, path, checkout.semantics);
                const sourceEntry = rebaseTreeEntry(checkout, allowedOwnBeforeTree, path);
                const source = sourceEntry?.digest ?? null;
                const desired = after?.digest ?? null;
                if (!sameState(recordedBefore, source) && !sameState(recordedBefore, desired)) {
                    throw moveError(`${path}: ignored own bytes are not the source or target managed state`);
                }
                recordedBeforeObject = sameState(recordedBefore, desired) ? (after?.object ?? null) : (sourceEntry?.object ?? null);
            }
        }
        else if (options.allowedIgnoredPaths.includes(path)) {
            recordedBefore =
                existingEntry === undefined
                    ? worktreeState(treeDir, path, checkout.semantics)
                    : rollover
                        ? existingEntry.after
                        : existingEntry.before;
            recordedBeforeObject = existingEntry === undefined ? null : rollover ? existingEntry.afterObject : existingEntry.beforeObject;
        }
        return {
            path,
            before: recordedBefore,
            after: after?.digest ?? null,
            beforeObject: recordedBeforeObject,
            afterObject: after?.object ?? null,
            bytes: after?.bytes ?? null
        };
    });
}
function assertForkClean(treeDir) {
    const status = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: treeDir });
    if (status.status !== 0)
        throw moveError('fork worktree status is unreadable');
    const dirty = porcelainZEntries(status.stdout).map((entry) => entry.path);
    if (dirty.length > 0)
        throw moveError(`fork has unrelated or unextracted dirty paths: ${dirty.join(', ')}`);
}
function assertAllBefore(treeDir, entries, semantics) {
    for (const entry of entries) {
        if (!sameState(worktreeState(treeDir, entry.path, semantics), entry.before))
            throw moveError(`${entry.path}: clean worktree does not match real HEAD`);
    }
}
function assertRecognizedPartial(treeDir, entries, semantics) {
    const allowed = new Set(entries.map((entry) => entry.path));
    const status = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: treeDir });
    if (status.status !== 0)
        throw moveError('cannot inspect pending partial move');
    const extra = porcelainZEntries(status.stdout)
        .map((entry) => entry.path)
        .filter((path) => !allowed.has(path));
    if (extra.length > 0)
        throw moveError(`pending move has unrelated dirty paths: ${extra.join(', ')}`);
    for (const entry of entries) {
        const actual = worktreeState(treeDir, entry.path, semantics);
        if (!sameState(actual, entry.before) && !sameState(actual, entry.after))
            throw moveError(`${entry.path}: pending move state is unrecognized`);
    }
}
function worktreeState(root, path, semantics) {
    const absolute = containedEntry(root, path);
    try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink())
            return { sha256: hash(readlinkSync(absolute, { encoding: 'buffer' })), mode: '120000' };
        if (!stat.isFile())
            throw moveError(`${path}: worktree entry is not a file or symbolic link`);
        return { sha256: hash(readFileSync(absolute)), mode: semantics.fileMode && (stat.mode & 0o111) !== 0 ? '100755' : '100644' };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function applyEntry(options, entry) {
    const target = containedEntry(options.treeDir, entry.path);
    if (entry.after === null || entry.bytes === null) {
        unlinkSync(target);
        return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const temporary = containedEntry(options.treeDir, moveTempPath(entry.path));
    rmSync(temporary, { force: true });
    let completed = false;
    try {
        if (entry.after.mode === '120000')
            symlinkSync(Buffer.from(entry.bytes), temporary);
        else {
            writeFileSync(temporary, entry.bytes, { flag: 'wx' });
            chmodSync(temporary, entry.after.mode === '100755' ? 0o755 : 0o644);
        }
        options.tempCheckpoint?.(entry.path);
        renameSync(temporary, target);
        completed = true;
    }
    finally {
        if (completed)
            rmSync(temporary, { force: true });
    }
}
function reconcileMoveTemps(root, entries, semantics) {
    for (const entry of entries) {
        if (entry.after === null)
            continue;
        const tempPath = moveTempPath(entry.path);
        const temp = worktreeState(root, tempPath, semantics);
        if (temp === null)
            continue;
        const target = worktreeState(root, entry.path, semantics);
        if (!sameState(temp, entry.after)) {
            throw moveError(`${tempPath}: temp bytes or mode differ from durable desired state`);
        }
        if (sameState(target, entry.before))
            renameSync(containedEntry(root, tempPath), containedEntry(root, entry.path));
        else if (sameState(target, entry.after))
            rmSync(containedEntry(root, tempPath), { force: true });
        else
            throw moveError(`${tempPath}: exact temp accompanies unrecognized target`);
    }
}
function moveTempPath(path) {
    return `${path}.codkit-rebase-move.tmp`;
}
function sameState(left, right) {
    return left === null ? right === null : right !== null && left.sha256 === right.sha256 && left.mode === right.mode;
}
function sameObject(left, right) {
    return left === null ? right === null : right !== null && left.oid === right.oid && left.mode === right.mode;
}
function canonicalMode(state, previous, semantics) {
    if (!semantics.symlinks && state.mode === '100644' && previous?.mode === '120000')
        return '120000';
    if (!semantics.fileMode && state.mode === '100644' && previous?.mode === '100755')
        return '100755';
    return state.mode;
}
function exactHead(treeDir) {
    const head = runGit({ args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: treeDir });
    const sha = head.stdout.trim();
    if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(sha))
        throw moveError('real fork HEAD is not one commit');
    return sha;
}
function storeWorktreeEntry(treeDir, path, mode, blobFile, env) {
    if (mode !== '120000') {
        return mustGit(treeDir, ['hash-object', '-w', `--path=${path}`, '--', containedEntry(treeDir, path)], env, `store ${path}`);
    }
    const absolute = containedEntry(treeDir, path);
    const bytes = lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute, { encoding: 'buffer' }) : readFileSync(absolute);
    writeFileSync(blobFile, bytes, { flag: 'wx' });
    try {
        return mustGit(treeDir, ['hash-object', '-w', '--no-filters', '--', blobFile], env, `store ${path}`);
    }
    finally {
        rmSync(blobFile, { force: true });
    }
}
function mustGit(cwd, args, env, action) {
    const result = runGit({ args, cwd, env });
    const value = result.stdout.trim();
    if (result.status !== 0)
        throw moveError(`cannot ${action}: ${result.stderr.trim() || `git exited ${result.status}`}`);
    return value;
}
function contained(root, path, allowMissing) {
    const resolved = resolveContainedPath(root, path, allowMissing ? { allowMissing: true } : {});
    if (!resolved.ok)
        throw moveError(`${path}: unsafe worktree path: ${resolved.reason}`);
    return resolved.absolute;
}
/** Resolve safe parents while permitting the leaf itself to be a managed symlink. */
function containedEntry(root, path) {
    const problem = repoRelativePathProblem(path);
    if (problem !== null)
        throw moveError(`${path}: unsafe worktree path: ${problem}`);
    const parent = dirname(path);
    if (parent !== '.')
        contained(root, parent, true);
    return resolve(root, ...path.split('/'));
}
function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function compareText(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function moveError(reason) {
    return ckError('DIRTY-TREE', `cannot materialize rebase target: ${reason}`, 'remove unrelated work or retry the exact pending rebase transaction');
}
