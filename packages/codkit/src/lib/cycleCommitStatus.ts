/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Worktree/index status snapshots keep cycle object construction focused.
import { realpathSync } from 'node:fs';
import type { CycleCommitGitRunner } from './cycleCommit.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { verifyReceipt } from './workspaceReceipt.ts';
import { ckError } from './messages.ts';
export type Dirt = { readonly staged: readonly string[]; readonly unstaged: readonly string[]; readonly untracked: readonly string[] };

export function readDirt(patchesDir: string, git: CycleCommitGitRunner, workspace?: WorkspaceRecord): Dirt {
	if (workspace !== undefined) {
		if (realpathSync(patchesDir) !== workspace.patchset.path) throw ckError('CONFIG', 'workspace cycle commit custody differs');
		verifyReceipt(workspace, 'patchset');
	}
	return {
		staged: gitPaths(patchesDir, ['diff', '--cached', '--name-only', '-z'], git, 'cannot inspect staged paths'),
		unstaged: gitPaths(patchesDir, ['diff', '--name-only', '-z'], git, 'cannot inspect unstaged paths'),
		untracked: gitPaths(patchesDir, ['ls-files', '--others', '--exclude-standard', '-z'], git, 'cannot inspect untracked paths').filter(
			(path) => workspace === undefined || !path.startsWith('.codkit/')
		)
	};
}

export function gitPaths(patchesDir: string, args: readonly string[], git: CycleCommitGitRunner, failure: string): readonly string[] {
	const result = git({ args, cwd: patchesDir });
	if (result.status !== 0)
		throw ckError(
			'INTERNAL',
			`${failure}: ${(result.stderr.trim() || result.stdout.trim()).split('\n')[0] || `git exited ${result.status}`}`
		);
	if (result.stdout !== '' && !result.stdout.endsWith('\0')) {
		throw ckError('INTERNAL', `${failure}: output is not NUL-terminated`);
	}
	return [...new Set(result.stdout === '' ? [] : result.stdout.slice(0, -1).split('\0'))].sort((left, right) =>
		Buffer.from(left).compare(Buffer.from(right))
	);
}
