/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-CYCLE-PUBLISH */
// Ordinary dirt and verified workspace runtime state remain separate facts.
import type { CycleResolveOptions } from './cycleResolve.ts';
import { realpathSync } from 'node:fs';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { workspaceForkReceipt, verifyReceipt } from './workspaceReceipt.ts';
import { runGit } from './gitx.ts';
import { porcelainZEntries } from './driftGuard.ts';
import { ckError } from './messages.ts';

export function cycleRepositoryStatus(root: string): readonly { readonly status: string; readonly path: string }[] {
	const result = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: root });
	if (result.status !== 0) throw ckError('NOT-A-REPO', `cannot inspect resolve dirt in ${root}`);
	return porcelainZEntries(result.stdout);
}

export function workspaceCycleStatus(
	root: string,
	entries: readonly { readonly status: string; readonly path: string }[],
	workspace: WorkspaceRecord | undefined
): readonly { readonly status: string; readonly path: string }[] {
	if (workspace === undefined) return entries;
	if (realpathSync(root) === workspace.patchset.path) {
		verifyReceipt(workspace, 'patchset');
		return entries.filter((entry) => entry.status !== '??' || !entry.path.startsWith('.codkit/'));
	}
	const receipts = workspaceForkReceipt(root, workspace);
	return entries.filter((entry) => entry.status !== '??' || !receipts.includes(entry.path));
}

export function readCycleResolveHead(options: CycleResolveOptions): string {
	if (options.runtime?.head !== undefined) return options.runtime.head(options.patchesDir);
	const result = runGit({ args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: options.patchesDir });
	if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim())) throw ckError('ARTIFACT-BROKEN', 'cannot resolve patchset HEAD');
	return result.stdout.trim();
}

export function readCycleResolveBranch(options: CycleResolveOptions): string {
	if (options.runtime?.branch !== undefined) return options.runtime.branch(options.patchesDir);
	return runGit({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: options.patchesDir }).stdout.trim();
}
