/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-TYPE-CUSTODY */
// Check the saved declarative contract before importing or configuring an adapter.
import type { ProjectType } from '@codkit/type-api';
import { loadConfig } from './configFile.ts';
import { ckError } from './messages.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { readTypeManifest } from '../types/manifest.ts';
import { effectiveRegistry, resolveProjectType } from '../types/registry.ts';
import { assertTypeConfig } from '../types/typeConfig.ts';
import { configureProjectType } from '../types/configure.ts';
import { verifyWorkspaceCheckout } from './workspaceCreate.ts';
import { verifyReceipt } from './workspaceFinish.ts';

export async function resolveWorkspaceType(record: WorkspaceRecord): Promise<ProjectType> {
	verifyWorkspaceCheckout(record, 'patchset', true);
	verifyReceipt(record, 'patchset');
	const config = loadConfig(record.patchset.path);
	if (config === null || config.type !== record.type.id)
		throw ckError('CONFIG', 'workspace configuration/type custody differs from registry');
	const packageName = effectiveRegistry().get(record.type.id);
	if (packageName === undefined) throw ckError('TYPE-UNKNOWN', 'workspace type is not installed in the trusted registry');
	const registration = readTypeManifest(record.type.id, packageName);
	if (registration.sha256 !== record.type.manifestSha256 || registration.manifest.contractVersion !== record.type.contractVersion)
		throw ckError('TYPE-UNKNOWN', 'workspace saved type declaration differs from the installed contract; no adapter has been imported');
	const type = await resolveProjectType(config.type);
	assertTypeConfig(type, config);
	return configureProjectType(type, config.typeConfig);
}
