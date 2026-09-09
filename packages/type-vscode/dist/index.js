/** @scope spec://codkit/modules/vscode/PROP-001#VSCODE-TYPE-IS-AN-ANSWER-SET */
// The `vscode` project type: the tool's knowledge of the Visual Studio Code
// family of upstreams, as the nine answers of the contract.
//
// The engine imports this package only through `ProjectType`; everything else
// exported here exists for this package's own suite and for the type's tests.
import { advisory } from './advisory.js';
import { brandImages } from './brandImages.js';
import { build } from './build.js';
import { configSchema } from './configSchema.js';
import { conventions } from './conventions.js';
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
export const projectType = {
    id: TYPE_ID,
    capabilities: new Set(CAPABILITIES),
    configSchema,
    identity,
    layout,
    layers,
    build,
    advisory,
    brandImages,
    runtime,
    standards,
    conventions
};
export default projectType;
export { advisory } from './advisory.js';
export { brandImages, codecs, familyNotes, targets } from './brandImages.js';
export { build } from './build.js';
export { configSchema } from './configSchema.js';
export { conventions, FORBIDDEN_SERVICE_IDS, SUBSYSTEMS } from './conventions.js';
export { DEFERRED_PHASE } from './deferred.js';
export { identity } from './identity.js';
export { entryModule, layers, overlayTargets, ownExtensions, serviceOverride } from './layers.js';
export { layout, OWN_ROOT_PREFIX } from './layout.js';
export { runtime } from './runtime.js';
export { standards } from './standards.js';
