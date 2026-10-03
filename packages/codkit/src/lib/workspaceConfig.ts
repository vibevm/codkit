/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-NAMESPACE */
// Runtime namespaces retain the original serializable declaration separately.
import type { CodkitConfig } from './configFile.ts';
import { workspaceRefPrefixes, workspaceRegistryRoot } from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';

export function workspaceConfig(
	config: CodkitConfig,
	record: WorkspaceRecord,
	registryRoot: string = workspaceRegistryRoot()
): CodkitConfig {
	const declared = config.workspace?.declared ?? {
		generatedBranchPrefix: config.generatedBranchPrefix,
		cycleBranchPrefix: config.cycleBranchPrefix,
		releaseRefPrefix: config.releaseRefPrefix
	};
	return { ...config, ...workspaceRefPrefixes(record.id), workspace: { record, declared, registryRoot } };
}
export function inheritWorkspaceConfig(config: CodkitConfig, execution: CodkitConfig): CodkitConfig {
	return execution.workspace === undefined ? config : workspaceConfig(config, execution.workspace.record, execution.workspace.registryRoot);
}
export function declaredWorkspaceConfig(config: CodkitConfig) {
	const { workspace, ...declared } = config;
	return workspace === undefined ? declared : { ...declared, ...workspace.declared };
}
