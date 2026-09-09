/** @scope spec://codkit/modules/vscode/PROP-001#VSCODE-TYPE-IS-AN-ANSWER-SET */
// The `vscode` project type: the tool's knowledge of the Visual Studio Code
// family of upstreams, as the ten answers of the contract.
//
// The engine imports this package only through `ProjectType`; everything else
// exported here exists for this package's own suite and for the type's tests.

import type { Capability, ProjectType } from '@codkit/type-api';
import { advisory } from './advisory.ts';
import { brandImages } from './brandImages.ts';
import { build } from './build.ts';
import { configSchema } from './configSchema.ts';
import { conventions } from './conventions.ts';
import { identity } from './identity.ts';
import { layers } from './layers.ts';
import { layout } from './layout.ts';
import { runtime } from './runtime.ts';
import { standards } from './standards.ts';

/** The identifier a patch set declares in `codkit.json`. */
export const TYPE_ID = 'vscode';

/**
 * ##VSCODE-CAPABILITIES: the type declares every optional capability of the
 * contract, which is what makes the extraction invisible to a patch set that
 * was written before types existed.
 */
export const CAPABILITIES: readonly Capability[] = [
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

export const projectType: ProjectType = {
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

export { advisory, ADVISORY_PATHS, readers } from './advisory.ts';
export { brandImages, codecs, familyNotes, targets } from './brandImages.ts';
export { build } from './build.ts';
export { configSchema } from './configSchema.ts';
export type { VscodeTypeConfig } from './configSchema.ts';
export { conventions, FORBIDDEN_SERVICE_IDS, SUBSYSTEMS } from './conventions.ts';
export { identity } from './identity.ts';
export { entryModule, layers, overlayTargets, ownExtensions, serviceOverride } from './layers.ts';
export { layout, OWN_ROOT_PREFIX } from './layout.ts';
export { runtime } from './runtime.ts';
export { standards } from './standards.ts';
