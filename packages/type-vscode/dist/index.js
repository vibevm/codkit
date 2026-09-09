/** @scope spec://codkit/modules/vscode/PROP-001#VSCODE-TYPE-IS-AN-ANSWER-SET */
// The `vscode` project type: the tool's knowledge of the Visual Studio Code
// family of upstreams, as the ten answers of the contract.
//
// The engine imports this package only through `ProjectType`; everything else
// exported here exists for this package's own suite and for the type's tests.
import { advisory } from './advisory.js';
import { brandImages } from './brandImages.js';
import { makeBuild } from './build.js';
import { configSchema, PLACEHOLDER_CONFIG } from './configSchema.js';
import { conventions } from './conventions.js';
import { generators } from './generators.js';
import { identity } from './identity.js';
import { layers } from './layers.js';
import { layout } from './layout.js';
import { runtime } from './runtime.js';
import { standards } from './standards.js';
/** The identifier a patch set declares in `codkit.json`. */
export const TYPE_ID = 'vscode';
/**
 * ##VSCODE-CAPABILITIES: the type declares every optional capability of the
 * contract, which is what makes the extraction invisible to a patch set that
 * was written before types existed.
 */
export const CAPABILITIES = [
    'brand-images',
    'gen-brand',
    'build-channels',
    'runtime-library',
    'own-extensions',
    'service-override',
    'entry-module',
    'config-overlay',
    'dev-channel',
    'upgrade-advisory'
];
/** The type as one patch set's `typeConfig` makes it. */
export function projectTypeFor(config) {
    return {
        id: TYPE_ID,
        capabilities: new Set(CAPABILITIES),
        configSchema,
        identity,
        layout,
        layers,
        build: makeBuild(config),
        advisory,
        brandImages,
        runtime,
        standards,
        conventions,
        generators,
        configure
    };
}
/**
 * The specialization step of the contract (##TYPE-CONFIGURED). Only one answer
 * of this type depends on the section - the quality channel of the packaging -
 * but the engine asks the result everything afterwards, so the whole type is
 * rebuilt from the validated section. Parsing it again here is what makes this
 * function total: a section that somehow arrives unvalidated produces the type
 * of a patch set that answered nothing rather than a crash.
 */
function configure(typeConfig) {
    const parsed = configSchema.safeParse(typeConfig);
    return projectTypeFor(parsed.success ? parsed.data : PLACEHOLDER_CONFIG);
}
export const projectType = projectTypeFor(PLACEHOLDER_CONFIG);
export default projectType;
export { advisory, ADVISORY_PATHS, readers } from './advisory.js';
export { brandImages, codecs, familyNotes, targets } from './brandImages.js';
export { build, makeBuild, packageStampsOf } from './build.js';
export { configSchema, PLACEHOLDER_CONFIG, QUALITY_CHANNELS } from './configSchema.js';
export { conventions, FORBIDDEN_SERVICE_IDS, SUBSYSTEMS } from './conventions.js';
export { brandGraft, featureClassName, featureSkeleton, generators, settingId } from './generators.js';
export { identity } from './identity.js';
export { entryModule, layers, overlayTargets, ownExtensions, serviceOverride } from './layers.js';
export { layout, OWN_ROOT_PREFIX } from './layout.js';
export { runtime } from './runtime.js';
export { standards } from './standards.js';
