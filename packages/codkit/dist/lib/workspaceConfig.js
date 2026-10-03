import { workspaceRefPrefixes } from './workspaceRegistry.js';
export function workspaceConfig(config, record) {
    const declared = config.workspace?.declared ?? {
        generatedBranchPrefix: config.generatedBranchPrefix,
        cycleBranchPrefix: config.cycleBranchPrefix,
        releaseRefPrefix: config.releaseRefPrefix
    };
    return { ...config, ...workspaceRefPrefixes(record.id), workspace: { record, declared } };
}
export function inheritWorkspaceConfig(config, execution) {
    return execution.workspace === undefined ? config : workspaceConfig(config, execution.workspace.record);
}
export function declaredWorkspaceConfig(config) {
    const { workspace, ...declared } = config;
    return workspace === undefined ? declared : { ...declared, ...workspace.declared };
}
