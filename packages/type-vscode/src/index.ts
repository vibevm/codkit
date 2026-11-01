/** @scope spec://codkit/modules/vscode/PROP-001#VSCODE-TYPE-IS-AN-ANSWER-SET */
// The `vscode` project type: the tool's knowledge of the Visual Studio Code
// family of upstreams, as its answers of the contract.
//
// The engine imports this package only through `ProjectType`; everything else
// exported here exists for this package's own suite and for the type's tests.

import type { Capability, ProjectType } from '@codkit/type-api';
import { advisory } from './advisory.ts';
import { brandImages } from './brandImages.ts';
import { makeBuild } from './build.ts';
import { configSchema, PLACEHOLDER_CONFIG } from './configSchema.ts';
import type { VscodeTypeConfig } from './configSchema.ts';
import { conventions } from './conventions.ts';
import { generators } from './generators.ts';
import { identity } from './identity.ts';
import { layers } from './layers.ts';
import { layout } from './layout.ts';
import { licensing } from './licensing.ts';
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
	'upgrade-advisory',
	'licensing'
];

/** The type as one patch set's `typeConfig` makes it. */
export function projectTypeFor(config: VscodeTypeConfig): ProjectType {
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
		licensing,
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
function configure(typeConfig: unknown): ProjectType {
	const parsed = configSchema.safeParse(typeConfig);
	return projectTypeFor(parsed.success ? parsed.data : PLACEHOLDER_CONFIG);
}

export const projectType: ProjectType = projectTypeFor(PLACEHOLDER_CONFIG);

export default projectType;

export { advisory, ADVISORY_PATHS, readers } from './advisory.ts';
export { brandImages, codecs, familyNotes, targets } from './brandImages.ts';
export { build, makeBuild, packageStampsOf } from './build.ts';
export { configSchema, PLACEHOLDER_CONFIG, QUALITY_CHANNELS } from './configSchema.ts';
export type { VscodeQuality, VscodeTypeConfig } from './configSchema.ts';
export { conventions, FORBIDDEN_SERVICE_IDS, SUBSYSTEMS } from './conventions.ts';
export { brandGraft, featureClassName, featureSkeleton, generators, settingId } from './generators.ts';
export { identity } from './identity.ts';
export { entryModule, layers, overlayTargets, ownExtensions, serviceOverride } from './layers.ts';
export { layout, OWN_ROOT_PREFIX } from './layout.ts';
export {
	COMPONENT_LICENCE_DIRECTORY,
	LICENCE_FIELDS,
	LICENCE_GUARD_PATH,
	LICENCE_RENDERINGS,
	licenceGuard,
	licensing,
	UPSTREAM_LICENCE_FILES
} from './licensing.ts';
export { runtime } from './runtime.ts';
export { standards } from './standards.ts';
