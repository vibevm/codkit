/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-FINISH */
// Finish seals clean/save evidence while checkout writer capabilities are held.
import { verifyReceipt } from './workspaceReceipt.js';
import { captureWorkspaceMaterials, writeWorkspaceMaterials } from './workspaceMaterials.js';
import { workspaceLogPaths } from './workspaceLogs.js';
import { captureWorkspaceRuntime } from './workspaceRuntime.js';
export { verifyReceipt } from './workspaceReceipt.js';
import { readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { acquireLock, isAlive, lockPath, readLock } from './lock.js';
import { PATCHSET_WRITER_LOCK_ID } from './patchsetWriter.js';
import { loadConfig } from './configFile.js';
import { pinKey } from './pinIdentity.js';
import { deltaFingerprint, treeId } from './fingerprint.js';
import { readTreeCache, readTreeMark, treeCachePath } from './treeCache.js';
import { declaredDiscipline } from './discipline.js';
import { driftDirty } from './driftGuard.js';
import { ownedRootsOf } from './ownedRoots.js';
import { materializerOf } from './layers/ownExtensions.js';
import { foreignCommits } from './treeCommits.js';
import { readRecordState } from './buildRuntime.js';
import { resolveContainedPath } from './pathSafety.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
import { verifyWorkspaceCheckout } from './workspaceCreate.js';
import { findWorkspace, updateWorkspaceRegistry, workspaceRecordSchema, workspaceRefPrefixes } from './workspaceRegistry.js';
export function finishWorkspace(options) {
    return updateWorkspaceRegistry(options.registryRoot, (registry, save) => {
        const record = findWorkspace(registry, options.name);
        if (record.state !== 'active' && record.state !== 'finished')
            throw ckError('CONFIG', 'only an active or finished workspace can be finished');
        const locks = [];
        try {
            for (const role of ['patchset', 'fork']) {
                verifyWorkspaceCheckout(record, role, true);
                locks.push(acquireLock(record[role].path, `workspace-${record.id}`, 'workspace finish'));
                verifyReceipt(record, role);
                refuseWorkspaceDaemons(record[role].path, record.id);
            }
            const config = loadConfig(record.patchset.path);
            if (config === null || config.type !== record.type.id || options.type.id !== record.type.id)
                throw ckError('CONFIG', 'workspace configuration/type custody differs from registry');
            const patchsetHead = git(record.patchset.path, ['rev-parse', 'HEAD']);
            const runtime = captureWorkspaceRuntime(options.registryRoot, record, config);
            const materials = captureWorkspaceMaterials(record, config, options.type, patchsetHead, options.registryRoot);
            const logs = [...workspaceLogPaths(options.registryRoot, record), ...runtime];
            for (const [index, role] of ['patchset', 'fork'].entries()) {
                const cache = role === 'patchset' ? readTreeCache(record.patchset.path, treeId(record.fork.path)) : null;
                assertWorkspaceClean(record[role].path, locks[index], cache === null
                    ? role === 'fork'
                        ? materials.map((file) => file.path)
                        : logs
                    : [...logs, relative(record.patchset.path, treeCachePath(record.patchset.path, treeId(record.fork.path))).replaceAll('\\', '/')]);
            }
            const forkHead = git(record.fork.path, ['rev-parse', 'HEAD']);
            const mark = readTreeMark(record.fork.path);
            let fingerprint = null;
            if (mark === null) {
                if (forkHead !== record.fork.baseCommit)
                    throw ckError('CONFIG', 'workspace contains unextracted fork commits without a generated mark');
            }
            else {
                const cache = readTreeCache(record.patchset.path, treeId(record.fork.path));
                fingerprint = deltaFingerprint(record.patchset.path, config.pin.sha, declaredDiscipline(config));
                if (cache === null ||
                    cache.pinSha !== config.pin.sha ||
                    cache.deltaFingerprint !== fingerprint ||
                    mark.deltaFingerprint !== fingerprint ||
                    mark.branchTip !== forkHead ||
                    cache.branchTip !== forkHead)
                    throw ckError('CONFIG', 'workspace save/apply evidence is stale; save and reload before finish');
                const commits = foreignCommits(record.fork.path, config.pin.sha, `${workspaceRefPrefixes(record.id).generatedBranchPrefix}${pinKey(config.pin)}`);
                if (commits.commits.length > 0 || commits.anomaly !== null)
                    throw ckError('CONFIG', 'workspace contains unextracted fork history');
                const drift = driftDirty(materializerOf(options.type), record.fork.path, ownedRootsOf(options.type, config.typeConfig, { treeDir: record.fork.path, pinSha: config.pin.sha }), record.patchset.path, {
                    workspace: record,
                    ownedUntrackedFiles: [
                        ...workspaceOwnedPaths(record.fork.path, locks[1], materials.map((file) => file.path))
                    ],
                    generated: { pinSha: config.pin.sha, branch: `${workspaceRefPrefixes(record.id).generatedBranchPrefix}${pinKey(config.pin)}` }
                });
                if (drift.dirty)
                    throw ckError('DIRTY-TREE', 'workspace own/upstream work is not saved to its patchset');
            }
            const now = new Date().toISOString();
            const finished = workspaceRecordSchema.parse({
                ...record,
                state: 'finished',
                updatedAt: now,
                finished: {
                    patchsetCommit: patchsetHead,
                    forkCommit: forkHead,
                    deltaFingerprint: fingerprint,
                    at: now
                }
            });
            writeWorkspaceMaterials(options.registryRoot, finished, materials);
            save(registry.workspaces.map((entry) => (entry.id === record.id ? finished : entry)));
            return finished;
        }
        finally {
            for (const lock of locks.reverse())
                lock.release();
        }
    });
}
export function workspaceOwnedPaths(root, owned, extra) {
    if (owned === undefined)
        throw ckError('LOCKED', 'workspace clean proof requires checkout writer custody');
    const allowed = new Set(['.codkit/workspace.json', ...extra]);
    for (const path of [owned.path, lockPath(root, PATCHSET_WRITER_LOCK_ID)]) {
        const info = readLock(path);
        if (info === null || info.pid !== process.pid || info.nonce === undefined)
            throw ckError('LOCKED', 'workspace writer ownership moved');
        allowed.add(relative(root, path).replaceAll('\\', '/'));
        allowed.add(`${relative(root, path).replaceAll('\\', '/')}.${info.nonce}.owner`);
    }
    return allowed;
}
export function assertWorkspaceClean(root, owned, extra) {
    const allowed = workspaceOwnedPaths(root, owned, extra);
    const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
    const entries = status.split('\0').filter((entry) => entry !== '');
    if (entries.some((entry) => !(entry.startsWith('?? ') && allowed.has(entry.slice(3)))))
        throw ckError('DIRTY-TREE', 'workspace contains uncommitted or untracked work; save it before finish');
}
export function refuseWorkspaceDaemons(root, workspaceId) {
    const dir = resolveContainedPath(root, '.codkit/build', { allowMissing: true });
    if (!dir.ok)
        throw ckError('CONFIG', 'workspace daemon directory is not contained');
    let files;
    try {
        files = readdirSync(dir.absolute);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    for (const file of files.filter((file) => file.endsWith('.json'))) {
        if (file === 'deps-hash.json')
            continue; // Validated/archived separately as dependency runtime, never as a daemon.
        const state = readRecordState(root, file.slice(0, -5));
        if (workspaceId !== undefined || state.state !== 'valid' || state.record.pid === 0 || isAlive(state.record.pid))
            throw ckError('LOCKED', 'workspace has an active or unresolved build daemon');
    }
}
function git(root, args) {
    const result = runGit({ cwd: root, args });
    if (result.status !== 0)
        throw ckError('CONFIG', result.stderr.trim());
    return result.stdout.trim();
}
