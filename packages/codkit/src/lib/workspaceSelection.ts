/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-SELECTION */
// Resolve named roots from user authority, proving both real checkout identities.
import { realpathSync } from 'node:fs';
import { findWorkspace, readWorkspaceRegistry, workspaceRegistryRoot } from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { verifyWorkspaceCheckout } from './workspaceCreate.ts';
import { verifyReceipt } from './workspaceFinish.ts';
import { ckError } from './messages.ts';
import { resolveLocations } from './paths.ts';
import type { LocationFlags, ResolvedLocations } from './paths.ts';

export function selectWorkspace(
	name: string,
	flags: LocationFlags,
	registryRoot: string = workspaceRegistryRoot()
): {
	readonly record: WorkspaceRecord;
	readonly locations: ResolvedLocations;
} {
	if (flags.patchesDir != null || flags.forkDir != null)
		throw ckError('CONFIG', '--workspace selects both roots; explicit external root flags are not accepted');
	const record = findWorkspace(readWorkspaceRegistry(registryRoot), name);
	if (record.state !== 'active') throw ckError('CONFIG', 'named command selection requires an active workspace');
	for (const role of ['patchset', 'fork'] as const) {
		verifyWorkspaceCheckout(record, role, true);
		verifyReceipt(record, role);
		if (realpathSync(record[role].path) !== record[role].path) throw ckError('CONFIG', 'workspace selected path moved through an alias');
	}
	return {
		record,
		locations: resolveLocations({ patchesDir: record.patchset.path, forkDir: record.fork.path }, {}, { codkitSettings: 1 })
	};
}
