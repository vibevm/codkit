/** @scope spec://codkit/modules/theia/PROP-001#THEIA-TYPE-IS-AN-ANSWER-SET */
// The `theia` project type: the tool's knowledge of the Eclipse Theia monorepo
// as an upstream, as the ten answers of the contract.
//
// It is the second real type and the proof of the contract, because it answers
// the same questions with different shapes: the own root is a workspace
// package rather than a directory of one source tree, the product manifest is
// the application's `package.json` rather than a `product.json`, a service is
// overridden by an inversify `rebind` plus a dependency edge rather than by a
// late registration, and two of the layers are simply absent - own code needs
// no graft into an entry module, and a Theia extension is own code rather than
// a built-in extension of a distribution.
//
// Three of the answers are a function of the patch set's own configuration -
// where the own package sits, what it is called, which directory is the
// application - so this type answers `configure` and the engine asks the result
// everything afterwards (##TYPE-CONFIGURED). The capabilities are the same
// either way: every Theia patch set has an application manifest to overlay, a
// `rebind` to verify, two watch channels and an upgrade advisory.
//
// The engine imports this package only through `ProjectType`; everything else
// exported here exists for this package's own suite.
import { makeAdvisory } from './advisory.js';
import { makeBuild } from './build.js';
import { configSchema, PLACEHOLDER_CONFIG } from './configSchema.js';
import { conventions } from './conventions.js';
import { generators } from './generators.js';
import { identity } from './identity.js';
import { makeLayers } from './layers.js';
import { makeLayout } from './layout.js';
import { standards } from './standards.js';
/** The identifier a patch set declares in `codkit.json`. */
export const TYPE_ID = 'theia';
/**
 * ##THEIA-CAPABILITIES: four of the ten, and the six absences are answers too.
 * There is no `dev-channel` - the running application reads what was frozen
 * into `src-gen/` at build time, so there is no sidecar to read instead; no
 * `entry-module` and no `own-extensions` (##THEIA-NO-ENTRY-MODULE,
 * ##THEIA-EXTENSIONS-ARE-OWN-CODE); no `brand-images`, because upstream has no
 * icon target table at all; no `gen-brand`, because identity is a manifest key
 * and not a string funnel; and no `runtime-library` in the first version.
 */
export const CAPABILITIES = ['config-overlay', 'service-override', 'build-channels', 'upgrade-advisory'];
/** The type as one patch set's `typeConfig` makes it. */
export function projectTypeFor(config) {
    return {
        id: TYPE_ID,
        capabilities: new Set(CAPABILITIES),
        configSchema,
        identity,
        layout: makeLayout(config.applicationRoot),
        layers: makeLayers(config.applicationRoot),
        build: makeBuild(config),
        advisory: makeAdvisory(config.applicationRoot),
        standards,
        conventions,
        generators,
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
export { APPLICATION_PROPS_PATH, EXTENSION_PACKAGE_PATH, LOCK_PATH, makeAdvisory, readersFor } from './advisory.js';
export { DEFAULT_BUNDLE_SCRIPT, DEFAULT_TYPECHECK_SCRIPT, FOREIGN_WATCHER_MARKERS, hygieneOf, INSTALL, makeBuild, ownTestsOf, packageBuildOf, watchProfileOf } from './build.js';
export { configSchema, PLACEHOLDER_CONFIG } from './configSchema.js';
export { conventions, FORBIDDEN_SERVICE_IDS, SUBSYSTEMS } from './conventions.js';
export { bindFunctionName, featureClassName, featureConstant, featureSkeleton, generators, preferenceId } from './generators.js';
export { CORE_MANIFEST_PATH, CORE_PACKAGE_NAME, fingerprints, identity, LERNA_MANIFEST_PATH, MONOREPO_NAME, monorepoVersion, REQUIRED_WORKSPACE_GLOBS, ROOT_MANIFEST_PATH, TAG_PATTERN } from './identity.js';
export { importedPackageOf, makeLayers, overlayTargetsOf, overrideProblems, packageNameOf, serviceOverride } from './layers.js';
export { APPLICATION_BUILD_OUTPUTS, CLEANUP_WHITELIST, FORBIDDEN_PATCH_TARGETS, layout, makeLayout, OWN_BUILD_OUTPUTS, ownRootProblem, WORKSPACE_PARENTS } from './layout.js';
export { standards, STANDARDS_PACKAGES } from './standards.js';
