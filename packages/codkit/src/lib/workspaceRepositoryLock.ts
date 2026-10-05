/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-REPOSITORY-COORDINATION */
import { join } from 'node:path';
import type { LockHandle } from './lock.ts';
import { acquireCommonRepositoryLock, commonLockDirectory } from './worktrees.ts';
import { acquireWorkspaceCoordinationLock } from './workspaceCoordination.ts';
import { workspaceIdSchema } from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';

function operationWorkspace(command: string): WorkspaceRecord['id'] | null {
	const match = /^(?:generated ref refs\/heads\/codkit\/workspace\/([^/]+)\/|workspace ([^ ]+) worktree-local exclude$)/.exec(command);
	const parsed = workspaceIdSchema.safeParse(match?.[1] ?? match?.[2]);
	return parsed.success ? parsed.data : null;
}

/** Retain shared Git exclusion while different named tasks queue at its guarded write. */
export function acquireWorkspaceRepositoryLock(
	treeDir: string,
	command: string,
	workspaceId: WorkspaceRecord['id'] | undefined
): LockHandle {
	if (workspaceId === undefined || operationWorkspace(command) !== workspaceId) return acquireCommonRepositoryLock(treeDir, command);
	return acquireWorkspaceCoordinationLock(join(commonLockDirectory(treeDir), 'refs.lock'), command, (holder) => {
		const other = operationWorkspace(holder.command);
		return other !== null && other !== workspaceId;
	});
}
