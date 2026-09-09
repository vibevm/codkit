/** @scope spec://codkit/modules/vscode/PROP-009#VSCODE-CONVENTIONS-DEFAULTS */
// Area 9: the defaults this family contributes to the conventions of a patch
// set.
//
// The field names, the shape of the id pattern, the intervention types, the
// categories, the layer order and the marker forms are the engine's; the
// subsystems an id may name and the decorator ids own code may never
// re-register are the family's, and a product extends them additively through
// `conventionsExtensionFile`.
/** ##VSCODE-CONVENTIONS-DEFAULTS: the top-level areas of the source tree. */
export const SUBSYSTEMS = [
    'workbench',
    'editor',
    'platform',
    'extensions',
    'build',
    'product',
    'base',
    'server',
    'test'
];
/**
 * ##FORBIDDEN-SERVICES-SEED: the bootstrap services of this family. They are
 * installed by an explicit set before the workbench is created, so a late
 * re-registration is ignored - silently - and the product breaks at load.
 */
export const FORBIDDEN_SERVICE_IDS = [
    'IAccountPolicyGateService',
    'IBrowserWorkbenchEnvironmentService',
    'IDefaultAccountService',
    'IEncryptionService',
    'IFileManagedSettingsService',
    'IFileService',
    'ILogService',
    'ILoggerService',
    'IMainProcessService',
    'IManagedSettingsService',
    'INativeKeyboardLayoutService',
    'INativeManagedSettingsService',
    'INativeWorkbenchEnvironmentService',
    'IPolicyService',
    'IProductService',
    'IRemoteAgentService',
    'IRemoteAuthorityResolverService',
    'IRemoteSocketFactoryService',
    'IRequestService',
    'ISecretStorageService',
    'ISharedProcessService',
    'ISignService',
    'IStorageService',
    'IUriIdentityService',
    'IUserDataInitializationService',
    'IUserDataProfileService',
    'IUserDataProfilesService',
    'IUserDataSyncStoreManagementService',
    'IUtilityProcessWorkerWorkbenchService',
    'IWorkbenchConfigurationService',
    'IWorkbenchLayoutService',
    'IWorkspaceContextService',
    'IWorkspaceTrustEnablementService',
    'IWorkspaceTrustManagementService'
];
export const conventions = { subsystems: SUBSYSTEMS, forbiddenServiceIds: FORBIDDEN_SERVICE_IDS };
