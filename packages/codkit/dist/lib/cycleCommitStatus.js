/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Worktree/index status snapshots keep cycle object construction focused.
import { realpathSync } from 'node:fs';
import { verifyReceipt } from './workspaceReceipt.js';
import { ckError } from './messages.js';
export function readDirt(patchesDir, git, workspace) {
    if (workspace !== undefined) {
        if (realpathSync(patchesDir) !== workspace.patchset.path)
            throw ckError('CONFIG', 'workspace cycle commit custody differs');
        verifyReceipt(workspace, 'patchset');
    }
    return {
        staged: gitPaths(patchesDir, ['diff', '--cached', '--name-only', '-z'], git, 'cannot inspect staged paths'),
        unstaged: gitPaths(patchesDir, ['diff', '--name-only', '-z'], git, 'cannot inspect unstaged paths'),
        untracked: gitPaths(patchesDir, ['ls-files', '--others', '--exclude-standard', '-z'], git, 'cannot inspect untracked paths').filter((path) => workspace === undefined || !path.startsWith('.codkit/'))
    };
}
export function gitPaths(patchesDir, args, git, failure) {
    const result = git({ args, cwd: patchesDir });
    if (result.status !== 0)
        throw ckError('INTERNAL', `${failure}: ${(result.stderr.trim() || result.stdout.trim()).split('\n')[0] || `git exited ${result.status}`}`);
    if (result.stdout !== '' && !result.stdout.endsWith('\0')) {
        throw ckError('INTERNAL', `${failure}: output is not NUL-terminated`);
    }
    return [...new Set(result.stdout === '' ? [] : result.stdout.slice(0, -1).split('\0'))].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}
