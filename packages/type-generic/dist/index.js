/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-GENERIC */
// The `generic` project type: a plain git upstream with no product model.
//
// It exists so that `load|save|verify|cycle|publish|ci` run over any repository
// before that repository's own type is written - and so that the contract has a
// second, unrelated implementation keeping it honest. No extensions, no service
// overrides, no entry module, no development channel, no brand images, no
// runtime library: what is left is the universal half of Codkit and a
// configuration overlay over JSON files the patch set declares.
//
// Every answer of this type is a function of `typeConfig`, so the type the
// engine gets is the one `configure` builds from that section
// (##TYPE-CONFIGURED). The unconfigured export declares no capability at all:
// before a patch set is read, there is nothing this type is known to be able to
// do.
import { advisory } from './advisory.js';
import { makeBuild } from './build.js';
import { configSchema } from './configSchema.js';
import { conventions } from './conventions.js';
import { generators } from './generators.js';
import { makeIdentity } from './identity.js';
import { makeLayers } from './layers.js';
import { makeLayout } from './layout.js';
import { standards } from './standards.js';
/** The identifier a patch set declares in `codkit.json`. */
export const TYPE_ID = 'generic';
/**
 * ##TYPE-GENERIC: the two abilities a patch set can ask this type for -
 * `config-overlay` by declaring the JSON targets an overlay may touch, and
 * `build-channels` by declaring the npm scripts that are its watch channels.
 * Everything else in the capability list needs a product model this type does
 * not have, and the verbs that need one refuse with `CK-E-TYPE-CAPABILITY`.
 */
export const CONFIGURABLE_CAPABILITIES = ['config-overlay', 'build-channels'];
/** The type as one patch set's `typeConfig` makes it. */
export function projectTypeFor(config) {
    const overlayTargets = config.overlayTargets ?? [];
    const compile = config.commands?.compile ?? [];
    const capabilities = new Set();
    if (overlayTargets.length > 0) {
        capabilities.add('config-overlay');
    }
    if (compile.length > 0) {
        capabilities.add('build-channels');
    }
    return {
        id: TYPE_ID,
        capabilities,
        configurableCapabilities: new Set(CONFIGURABLE_CAPABILITIES),
        configSchema,
        identity: makeIdentity(config.identity),
        layout: makeLayout(config.cleanupWhitelist ?? [], config.ownBuildOutputs ?? []),
        layers: makeLayers(overlayTargets),
        build: makeBuild(config),
        advisory,
        standards,
        conventions,
        generators,
        configure
    };
}
/**
 * The specialization step of the contract. The engine has already validated the
 * section with `configSchema`; parsing it again here is what makes this
 * function total, and a section that somehow reaches it unvalidated produces
 * the type of a patch set with nothing declared rather than a crash.
 */
function configure(typeConfig) {
    const parsed = configSchema.safeParse(typeConfig);
    return projectTypeFor(parsed.success ? parsed.data : { ownRoot: 'own' });
}
/**
 * The unconfigured type: what the registry imports and what `codkit types`
 * prints. It answers no capability, and names the two it can be configured into.
 */
export const projectType = {
    id: TYPE_ID,
    capabilities: new Set(),
    configurableCapabilities: new Set(CONFIGURABLE_CAPABILITIES),
    configSchema,
    identity: makeIdentity(undefined),
    layout: makeLayout([]),
    layers: makeLayers([]),
    build: makeBuild({ ownRoot: 'own' }),
    advisory,
    standards,
    conventions,
    generators,
    configure
};
export default projectType;
export { advisory } from './advisory.js';
export { build, makeBuild, toCommand, watchProfileOf } from './build.js';
export { argvOf, configSchema } from './configSchema.js';
export { conventions, SUBSYSTEMS } from './conventions.js';
export { featureConstant, featureSkeleton, generators, settingId } from './generators.js';
export { identity, makeIdentity, TAG_PATTERN } from './identity.js';
export { layers, makeLayers, overlayTargetsOf } from './layers.js';
export { layout, makeLayout, ownRootProblem } from './layout.js';
export { standards } from './standards.js';
