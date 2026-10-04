import { loadConfig } from './configFile.js';
import { ckError } from './messages.js';
import { readTypeManifest } from '../types/manifest.js';
import { effectiveRegistry, resolveProjectType } from '../types/registry.js';
import { assertTypeConfig } from '../types/typeConfig.js';
import { configureProjectType } from '../types/configure.js';
import { verifyWorkspaceCheckout } from './workspaceCreate.js';
import { verifyReceipt } from './workspaceFinish.js';
export async function resolveWorkspaceType(record) {
    verifyWorkspaceCheckout(record, 'patchset', true);
    verifyReceipt(record, 'patchset');
    const config = loadConfig(record.patchset.path);
    if (config === null || config.type !== record.type.id)
        throw ckError('CONFIG', 'workspace configuration/type custody differs from registry');
    const packageName = effectiveRegistry().get(record.type.id);
    if (packageName === undefined)
        throw ckError('TYPE-UNKNOWN', 'workspace type is not installed in the trusted registry');
    const registration = readTypeManifest(record.type.id, packageName);
    if (registration.sha256 !== record.type.manifestSha256 || registration.manifest.contractVersion !== record.type.contractVersion)
        throw ckError('TYPE-UNKNOWN', 'workspace saved type declaration differs from the installed contract; no adapter has been imported');
    const type = await resolveProjectType(config.type);
    assertTypeConfig(type, config);
    return configureProjectType(type, config.typeConfig);
}
