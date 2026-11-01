/** @scope spec://codkit/modules/vscode-extension/PROP-001#VSX-TYPE-IS-AN-ANSWER-SET */
// The `vscode-extension` project type: the tool's knowledge of a Visual Studio
// Code extension repository as an upstream, as the eleven answers of the
// contract.
//
// It is the fourth official type, the third real one, and the first to answer
// the preview question: an extension is looked at by launching a VS Code-based
// host with it. Its product manifest is the extension's `package.json`, open to
// an overlay with no dev channel; own code enters through the activation
// module; the tree is built by the package manager the repository names, and
// the distributable is the `.vsix` the product's own script writes.
//
// Every answer is a function of the patch set's own configuration - where the
// extension sits, which manager runs its scripts, which scripts, which entry
// and which locale manifests - so this type answers `configure` and the engine
// asks the result everything afterwards (##VSX-CONFIGURED-TYPE). The
// capabilities are the same for every configuration, so `codkit types` prints
// a true matrix with no patch set in reach.
//
// The engine imports this package only through `ProjectType`; everything else
// exported here exists for this package's own suite.
import { makeAdvisory } from './advisory.js';
import { makeBuild } from './build.js';
import { configSchema, PLACEHOLDER_CONFIG } from './configSchema.js';
import { conventions } from './conventions.js';
import { makeGenerators } from './generators.js';
import { makeIdentity } from './identity.js';
import { makeLayers } from './layers.js';
import { makeLayout } from './layout.js';
import { makeLicensing } from './licensing.js';
import { makePreview } from './preview.js';
import { standards } from './standards.js';
/** The identifier a patch set declares in `codkit.json`. */
export const TYPE_ID = 'vscode-extension';
/**
 * ##VSX-CAPABILITIES: seven of the twelve, for every patch set of the family,
 * and the five absences are answers too (##VSX-ABSENCES): no `own-extensions`
 * and no `service-override` (PROP-003), no `dev-channel` (the host reads the
 * manifest from the extension root), no `brand-images` in the first version,
 * and no `runtime-library` - the brand transform is generated self-contained.
 * `licensing` joined on 2026-11-01 (PROP-006).
 */
export const CAPABILITIES = [
    'config-overlay',
    'entry-module',
    'build-channels',
    'upgrade-advisory',
    'gen-brand',
    'preview',
    'licensing'
];
/** The type as one patch set's `typeConfig` makes it. */
export function projectTypeFor(config) {
    return {
        id: TYPE_ID,
        capabilities: new Set(CAPABILITIES),
        configSchema,
        identity: makeIdentity(config),
        layout: makeLayout(config),
        layers: makeLayers(config),
        build: makeBuild(config),
        advisory: makeAdvisory(config),
        preview: makePreview(config),
        licensing: makeLicensing(config),
        standards,
        conventions,
        generators: makeGenerators(config),
        configure
    };
}
/**
 * The specialization step of the contract. The engine has already validated the
 * section with `configSchema`; parsing it again here is what makes this
 * function total, and a section that somehow arrives unvalidated produces the
 * type of a patch set that declared nothing rather than a crash.
 */
function configure(typeConfig) {
    const parsed = configSchema.safeParse(typeConfig);
    return projectTypeFor(parsed.success ? parsed.data : PLACEHOLDER_CONFIG);
}
/**
 * The unconfigured type: what the registry imports and what `codkit types`
 * prints. Its capabilities are the ones every patch set of this family has, so
 * the matrix a person reads before writing a configuration is the true one; the
 * paths inside it are placeholders and no command uses them, because a command
 * with a patch set has been handed the configured type.
 */
export const projectType = projectTypeFor(PLACEHOLDER_CONFIG);
export default projectType;
export { configurationKeys, filesOf, makeAdvisory, readersFor, removedEntries } from './advisory.js';
export { DEFAULT_BUILD_SCRIPT, DEFAULT_BUNDLE_SCRIPT, DEFAULT_CHANNELS, DEFAULT_LINT_SCRIPTS, DEFAULT_TYPECHECK_SCRIPT, defaultChannelsOf, defaultWatchProfile, dependencyRootsOf, FOREIGN_WATCHER_MARKERS, hygieneOf, INSTALL_ARGS, installOf, makeBuild, ownTestsOf, packageBuildOf, packageDistributableOf, packageOutputsOf, runScript, stampsOf, watchProfileOf } from './build.js';
export { BRAND_GUARD_PATH, BRAND_MODULE_PATH, brandGuardText, brandHookText, brandModuleText, brandReminders, GUARD_ALLOWED_DIRECTORIES, GUARD_ALLOWED_NAME_PREFIXES, GUARD_CONTENT_EXTENSIONS, GUARD_CONTENT_FILES, GUARD_CONTENT_ROOTS, GUARD_NAME_ROOTS } from './brandTemplates.js';
export { argvOf, configSchema, PACKAGE_MANAGERS, PLACEHOLDER_CONFIG } from './configSchema.js';
export { conventions, FORBIDDEN_SERVICE_IDS, SUBSYSTEMS } from './conventions.js';
export { brandGraftOf, featureConstant, featureFunctionName, featureSkeletonOf, makeGenerators, ownUnderSource, settingConstant, settingId, testWordsOf } from './generators.js';
export { DEFAULT_TAG_PATTERN, EXTENSION_KEYS, extensionManifestProblem, fingerprintsOf, makeIdentity, manifestPathOf, packageManagerName, packageManagerOf, packageManagerProblem, ROOT_MANIFEST_PATH, rootManifestOf, rootManifestProblem, tagPatternOf, tagShapeOf } from './identity.js';
export { DEFAULT_ENTRY_MODULE, entryModuleOf, entryModulesOf, makeLayers, overlayTargetsOf } from './layers.js';
export { anchoredPattern, cleanupWhitelistOf, FORBIDDEN_PATCH_TARGETS, isTreePath, LOCKFILES, makeLayout, ownRootProblem, SOURCE_DIR, sourceRootOf, treePath } from './layout.js';
export { COMPONENT_LICENCE_DIRECTORY, DEFAULT_UPSTREAM_COMPONENT, DEFAULT_UPSTREAM_LICENCE_FILE, distributableExclusionsOf, IGNORE_FILE, LICENCE_GUARD_PATH, licenceFieldsOf, licenceGuardOf, LICENSING_SUBSYSTEM, makeLicensing, upstreamComponentOf, upstreamLicenceFileOf, upstreamLicenceFilesOf } from './licensing.js';
export { isJsonObject, nonEmptyString, objectField, readJsonObject } from './manifest.js';
export { artifactRecipe, DEFAULT_PREVIEW_HOST, DEFAULT_PREVIEW_MODE, developmentRecipe, EXTENSIONS_DIR, isolationOf, makePreview, PREVIEW_MODES, USER_DATA_DIR, workspaceOf } from './preview.js';
export { standards, STANDARDS_PACKAGES } from './standards.js';
