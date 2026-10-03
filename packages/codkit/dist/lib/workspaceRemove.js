/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-REMOVE */
// Removal keeps checkout guards through Git deletion and journals partial progress.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { acquireLock } from './lock.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
import { treeId } from './fingerprint.js';
import { readTreeCache, treeCachePath } from './treeCache.js';
import { verifyWorkspaceCheckout } from './workspaceCreate.js';
import { assertWorkspaceClean, refuseWorkspaceDaemons, verifyReceipt, workspaceOwnedPaths } from './workspaceFinish.js';
import { findWorkspace, updateWorkspaceRegistry, workspaceRecordSchema } from './workspaceRegistry.js';
const roles = ['patchset', 'fork'];
export function removeWorkspace(options) {
    return updateWorkspaceRegistry(options.registryRoot, (registry, save) => {
        let record = findWorkspace(registry, options.name);
        if (record.state === 'removed')
            return record;
        if (record.state !== 'finished' && record.state !== 'removing')
            throw ckError('CONFIG', 'workspace must finish before removal');
        const locks = new Map();
        const extra = new Map();
        const publish = (state) => {
            record = workspaceRecordSchema.parse({ ...record, state, updatedAt: new Date().toISOString() });
            save(registry.workspaces.map((entry) => (entry.id === record.id ? record : entry)));
        };
        try {
            for (const role of roles) {
                if (!present(record[role].path)) {
                    if (record.state !== 'removing')
                        throw ckError('CONFIG', 'finished workspace checkout is missing');
                    verifyAbsent(record, role);
                    continue;
                }
                verifyWorkspaceCheckout(record, role, true);
                if (realpathSync(record[role].path) !== record[role].path)
                    throw ckError('CONFIG', 'workspace removal path moved through an alias');
                locks.set(role, acquireLock(record[role].path, `workspace-${record.id}`, 'workspace remove'));
                const cache = role === 'patchset' ? readTreeCache(record.patchset.path, treeId(record.fork.path)) : null;
                extra.set(role, cache === null
                    ? []
                    : [relative(record.patchset.path, treeCachePath(record.patchset.path, treeId(record.fork.path))).replaceAll('\\', '/')]);
                check(record, role, locks.get(role), extra.get(role) ?? []);
            }
            for (const role of roles)
                preserveHead(record, role);
            publish('removing');
            options.checkpoint?.('journaled');
            for (const role of roles) {
                const lock = locks.get(role);
                if (lock === undefined)
                    continue;
                check(record, role, lock, extra.get(role) ?? []);
                // Force is necessary only for our verified receipt/cache and held lock files.
                // The physical inventory below refuses all other data, including ignored/empty paths.
                git(record[role].repository, ['worktree', 'remove', '--force', '--', record[role].path]);
                verifyAbsent(record, role);
                options.checkpoint?.(role === 'patchset' ? 'patchset-removed' : 'fork-removed');
            }
            publish('removed');
            return record;
        }
        finally {
            for (const lock of [...locks.values()].reverse())
                lock.release();
        }
    });
}
function check(record, role, lock, extra) {
    verifyWorkspaceCheckout(record, role, true);
    verifyReceipt(record, role);
    refuseWorkspaceDaemons(record[role].path);
    assertWorkspaceClean(record[role].path, lock, extra);
    if (git(record[role].path, ['rev-parse', 'HEAD']).trim() !== finishedHead(record, role))
        throw ckError('DIRTY-TREE', 'workspace HEAD changed after finish; finish again before removal');
    const paths = new Set([...workspaceOwnedPaths(record[role].path, lock, extra), '.git']);
    const index = git(record[role].path, ['ls-files', '--stage', '-z']);
    for (const entry of index.split('\0').filter(Boolean)) {
        if (entry.startsWith('160000 '))
            throw ckError('CONFIG', 'workspace removal refuses submodule checkouts');
        const tab = entry.indexOf('\t');
        if (tab < 0)
            throw ckError('CONFIG', 'workspace index inventory is invalid');
        paths.add(entry.slice(tab + 1));
    }
    const directories = new Set();
    for (const path of paths) {
        const parts = path.split('/');
        for (let count = 1; count < parts.length; count++)
            directories.add(parts.slice(0, count).join('/'));
    }
    const walk = (prefix) => {
        for (const entry of readdirSync(join(record[role].path, prefix), { withFileTypes: true })) {
            const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory() && directories.has(path))
                walk(path);
            else if (!entry.isDirectory() && (entry.isFile() || entry.isSymbolicLink()) && paths.has(path))
                continue;
            else
                throw ckError('DIRTY-TREE', `workspace contains unowned data, including ignored paths: ${path}`);
        }
    };
    walk('');
}
function finishedHead(record, role) {
    if (record.finished === undefined)
        throw ckError('CONFIG', 'workspace finish proof is missing');
    return role === 'patchset' ? record.finished.patchsetCommit : record.finished.forkCommit;
}
function preservedRef(record, role) {
    return `refs/codkit/workspace/${record.id}/finished/${role}`;
}
function preserveHead(record, role) {
    const ref = preservedRef(record, role);
    const result = runGit({ cwd: record[role].repository, args: ['rev-parse', '--verify', ref] });
    const head = finishedHead(record, role);
    if (result.status === 0) {
        if (result.stdout.trim() !== head)
            throw ckError('CONFIG', 'workspace preserved finish ref is foreign');
    }
    else
        git(record[role].repository, ['update-ref', ref, head, '0'.repeat(40)]);
}
function verifyAbsent(record, role) {
    if (present(record[role].path))
        throw ckError('CONFIG', 'workspace deletion did not remove its recorded path');
    const entries = git(record[role].repository, ['worktree', 'list', '--porcelain', '-z']).split('\0');
    if (entries.some((entry) => entry === `worktree ${record[role].path}` || entry === `worktree ${record[role].path.replaceAll('\\', '/')}`))
        throw ckError('CONFIG', 'missing workspace is still registered; refusing ambiguous removal recovery');
    if (git(record[role].repository, ['rev-parse', '--verify', preservedRef(record, role)]).trim() !== finishedHead(record, role))
        throw ckError('CONFIG', 'removed workspace finish ref is missing or foreign');
}
function present(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function git(root, args) {
    const result = runGit({ cwd: root, args });
    if (result.status !== 0)
        throw ckError('CONFIG', `workspace removal refused: ${result.stderr.trim()}`);
    return result.stdout;
}
