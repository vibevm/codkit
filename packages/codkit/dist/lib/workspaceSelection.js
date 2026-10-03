/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-SELECTION */
// Resolve named roots from user authority, proving both real checkout identities.
import { realpathSync } from 'node:fs';
import { findWorkspace, readWorkspaceRegistry, workspaceRegistryRoot } from './workspaceRegistry.js';
import { verifyWorkspaceCheckout } from './workspaceCreate.js';
import { verifyReceipt } from './workspaceFinish.js';
import { ckError } from './messages.js';
import { resolveLocations } from './paths.js';
export function selectWorkspace(name, flags, registryRoot = workspaceRegistryRoot()) {
    if (flags.patchesDir != null || flags.forkDir != null)
        throw ckError('CONFIG', '--workspace selects both roots; explicit external root flags are not accepted');
    const record = findWorkspace(readWorkspaceRegistry(registryRoot), name);
    if (record.state !== 'active')
        throw ckError('CONFIG', 'named command selection requires an active workspace');
    for (const role of ['patchset', 'fork']) {
        verifyWorkspaceCheckout(record, role, true);
        verifyReceipt(record, role);
        if (realpathSync(record[role].path) !== record[role].path)
            throw ckError('CONFIG', 'workspace selected path moved through an alias');
    }
    return {
        record,
        locations: resolveLocations({ patchesDir: record.patchset.path, forkDir: record.fork.path }, {}, { codkitSettings: 1 })
    };
}
