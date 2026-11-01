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

import type { Capability, ProjectType } from '@codkit/type-api';
import { makeAdvisory } from './advisory.ts';
import { makeBuild } from './build.ts';
import { configSchema, PLACEHOLDER_CONFIG } from './configSchema.ts';
import type { VsxTypeConfig } from './configSchema.ts';
import { conventions } from './conventions.ts';
import { makeGenerators } from './generators.ts';
import { makeIdentity } from './identity.ts';
import { makeLayers } from './layers.ts';
import { makeLayout } from './layout.ts';
import { makePreview } from './preview.ts';
import { standards } from './standards.ts';

/** The identifier a patch set declares in `codkit.json`. */
export const TYPE_ID = 'vscode-extension';

/**
 * ##VSX-CAPABILITIES: six of the eleven, for every patch set of the family, and
 * the five absences are answers too (##VSX-ABSENCES): no `own-extensions` and
 * no `service-override` (PROP-003), no `dev-channel` (the host reads the
 * manifest from the extension root), no `brand-images` in the first version,
 * and no `runtime-library` - the brand transform is generated self-contained.
 */
export const CAPABILITIES: readonly Capability[] = [
	'config-overlay',
	'entry-module',
	'build-channels',
	'upgrade-advisory',
	'gen-brand',
	'preview'
];

/** The type as one patch set's `typeConfig` makes it. */
export function projectTypeFor(config: VsxTypeConfig): ProjectType {
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
function configure(typeConfig: unknown): ProjectType {
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
export const projectType: ProjectType = projectTypeFor(PLACEHOLDER_CONFIG);

export default projectType;

export { configurationKeys, filesOf, makeAdvisory, readersFor, removedEntries } from './advisory.ts';
export {
	DEFAULT_BUILD_SCRIPT,
	DEFAULT_BUNDLE_SCRIPT,
	DEFAULT_CHANNELS,
	DEFAULT_LINT_SCRIPTS,
	DEFAULT_TYPECHECK_SCRIPT,
	defaultChannelsOf,
	defaultWatchProfile,
	dependencyRootsOf,
	FOREIGN_WATCHER_MARKERS,
	hygieneOf,
	INSTALL_ARGS,
	installOf,
	makeBuild,
	ownTestsOf,
	packageBuildOf,
	packageDistributableOf,
	packageOutputsOf,
	runScript,
	stampsOf,
	watchProfileOf
} from './build.ts';
export {
	BRAND_GUARD_PATH,
	BRAND_MODULE_PATH,
	brandGuardText,
	brandHookText,
	brandModuleText,
	brandReminders,
	GUARD_ALLOWED_DIRECTORIES,
	GUARD_ALLOWED_NAME_PREFIXES,
	GUARD_CONTENT_EXTENSIONS,
	GUARD_CONTENT_FILES,
	GUARD_CONTENT_ROOTS,
	GUARD_NAME_ROOTS
} from './brandTemplates.ts';
export { argvOf, configSchema, PACKAGE_MANAGERS, PLACEHOLDER_CONFIG } from './configSchema.ts';
export type { PackageManager, VsxTypeConfig } from './configSchema.ts';
export { conventions, FORBIDDEN_SERVICE_IDS, SUBSYSTEMS } from './conventions.ts';
export {
	brandGraftOf,
	featureConstant,
	featureFunctionName,
	featureSkeletonOf,
	makeGenerators,
	ownUnderSource,
	settingConstant,
	settingId,
	testWordsOf
} from './generators.ts';
export type { TestWords } from './brandTemplates.ts';
export {
	DEFAULT_TAG_PATTERN,
	EXTENSION_KEYS,
	extensionManifestProblem,
	fingerprintsOf,
	makeIdentity,
	manifestPathOf,
	packageManagerName,
	packageManagerOf,
	packageManagerProblem,
	ROOT_MANIFEST_PATH,
	rootManifestOf,
	rootManifestProblem,
	tagPatternOf,
	tagShapeOf
} from './identity.ts';
export { DEFAULT_ENTRY_MODULE, entryModuleOf, entryModulesOf, makeLayers, overlayTargetsOf } from './layers.ts';
export {
	anchoredPattern,
	cleanupWhitelistOf,
	FORBIDDEN_PATCH_TARGETS,
	isTreePath,
	LOCKFILES,
	makeLayout,
	ownRootProblem,
	SOURCE_DIR,
	sourceRootOf,
	treePath
} from './layout.ts';
export { isJsonObject, nonEmptyString, objectField, readJsonObject } from './manifest.ts';
export type { JsonObject, TextFiles } from './manifest.ts';
export {
	artifactRecipe,
	DEFAULT_PREVIEW_HOST,
	DEFAULT_PREVIEW_MODE,
	developmentRecipe,
	EXTENSIONS_DIR,
	isolationOf,
	makePreview,
	PREVIEW_MODES,
	USER_DATA_DIR,
	workspaceOf
} from './preview.ts';
export { standards, STANDARDS_PACKAGES } from './standards.ts';
