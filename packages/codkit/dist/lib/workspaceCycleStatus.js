import { realpathSync } from 'node:fs';
import { workspaceForkReceipt, verifyReceipt } from './workspaceReceipt.js';
import { runGit } from './gitx.js';
import { porcelainZEntries } from './driftGuard.js';
import { ckError } from './messages.js';
export function cycleRepositoryStatus(root) {
    const result = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: root });
    if (result.status !== 0)
        throw ckError('NOT-A-REPO', `cannot inspect resolve dirt in ${root}`);
    return porcelainZEntries(result.stdout);
}
export function workspaceCycleStatus(root, entries, workspace) {
    if (workspace === undefined)
        return entries;
    if (realpathSync(root) === workspace.patchset.path) {
        verifyReceipt(workspace, 'patchset');
        return entries.filter((entry) => entry.status !== '??' || !entry.path.startsWith('.codkit/'));
    }
    const receipts = workspaceForkReceipt(root, workspace);
    return entries.filter((entry) => entry.status !== '??' || !receipts.includes(entry.path));
}
export function readCycleResolveHead(options) {
    if (options.runtime?.head !== undefined)
        return options.runtime.head(options.patchesDir);
    const result = runGit({ args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: options.patchesDir });
    if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim()))
        throw ckError('ARTIFACT-BROKEN', 'cannot resolve patchset HEAD');
    return result.stdout.trim();
}
export function readCycleResolveBranch(options) {
    if (options.runtime?.branch !== undefined)
        return options.runtime.branch(options.patchesDir);
    return runGit({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: options.patchesDir }).stdout.trim();
}
