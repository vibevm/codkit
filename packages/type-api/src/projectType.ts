/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONTRACT-IS-CLOSED */
// The contract itself: the nine questions a project type answers, and nothing
// else. The list is the set of variation points measured in the engine; a tenth
// question is added when a second type needs it, never in anticipation
// (##DECISION-TYPE-CONTRACT-FROM-MEASUREMENT).
//
// `@codkit/type-api` is the only import a type package takes from the tool, and
// the CLI imports a type only through this interface (##TYPE-API-STABILITY).

import type { ZodType } from 'zod';
import type { AdvisoryArea } from './advisory.ts';
import type { BrandImagesArea } from './brandImages.ts';
import type { BuildArea } from './build.ts';
import type { Capability } from './capabilities.ts';
import type { ConventionsArea } from './conventions.ts';
import type { IdentityArea } from './identity.ts';
import type { LayersArea } from './layers.ts';
import type { LayoutArea } from './layout.ts';
import type { RuntimeArea } from './runtime.ts';
import type { StandardsArea } from './standards.ts';

export type ProjectType = {
	/** The identifier a patch set declares in `codkit.json`, e.g. `vscode`. */
	readonly id: string;
	/** The optional abilities this type declares (##TYPE-TERM-CAPABILITY). */
	readonly capabilities: ReadonlySet<Capability>;
	/**
	 * The schema of `typeConfig`. The engine validates the universal fields of
	 * the configuration and hands this the rest; a refusal becomes `CK-E-CONFIG`
	 * naming the field (##TYPE-CONFIG-FIELD).
	 */
	readonly configSchema: ZodType;
	readonly identity: IdentityArea;
	readonly layout: LayoutArea;
	readonly layers: LayersArea;
	readonly build: BuildArea;
	readonly advisory: AdvisoryArea;
	/** Present exactly when `brand-images` is declared. */
	readonly brandImages?: BrandImagesArea;
	/** Present exactly when `runtime-library` is declared. */
	readonly runtime?: RuntimeArea;
	readonly standards: StandardsArea;
	readonly conventions: ConventionsArea;
};

/**
 * The areas that are optional in the interface, paired with the capability that
 * must be declared exactly when the area is present. Both the engine and a
 * type's own suite check the pairing, so a type cannot declare an ability it
 * does not answer for, or answer for one it never declared.
 */
export const OPTIONAL_AREAS: readonly { readonly area: 'brandImages' | 'runtime'; readonly capability: Capability }[] = [
	{ area: 'brandImages', capability: 'brand-images' },
	{ area: 'runtime', capability: 'runtime-library' }
];

/**
 * Everything wrong with a type's own shape, as one list: an optional area that
 * disagrees with its capability, an image target whose container has no codec,
 * a layer answered without its capability. An empty list is a well-formed type.
 */
export function projectTypeProblems(type: ProjectType): readonly string[] {
	const problems: string[] = [];
	for (const { area, capability } of OPTIONAL_AREAS) {
		const present = type[area] !== undefined;
		const declared = type.capabilities.has(capability);
		if (present && !declared) problems.push(`${type.id}: ${area} is answered but the capability ${capability} is not declared`);
		if (!present && declared) problems.push(`${type.id}: the capability ${capability} is declared but ${area} is not answered`);
	}
	for (const [area, capability] of [
		['ownExtensions', 'own-extensions'],
		['serviceOverride', 'service-override'],
		['entryModule', 'entry-module']
	] as const) {
		const present = type.layers[area] !== null;
		const declared = type.capabilities.has(capability);
		if (present && !declared) problems.push(`${type.id}: layers.${area} is answered but the capability ${capability} is not declared`);
		if (!present && declared) problems.push(`${type.id}: the capability ${capability} is declared but layers.${area} is not answered`);
	}
	const overlays = type.layers.overlayTargets;
	if (overlays.length > 0 !== type.capabilities.has('config-overlay')) {
		problems.push(`${type.id}: overlay targets and the capability config-overlay must agree`);
	}
	if (overlays.some((target) => target.devChannel !== null) !== type.capabilities.has('dev-channel')) {
		problems.push(`${type.id}: a dev channel on an overlay target and the capability dev-channel must agree`);
	}
	if (type.advisory.readers.length > 0 !== type.capabilities.has('upgrade-advisory')) {
		problems.push(`${type.id}: advisory readers and the capability upgrade-advisory must agree`);
	}
	const images = type.brandImages;
	if (images !== undefined) {
		const kinds = new Set(images.codecs.map((codec) => codec.kind));
		for (const target of images.targets) {
			if (!kinds.has(target.kind)) problems.push(`${type.id}: the image target ${target.path} needs a codec for ${target.kind}`);
		}
	}
	return problems;
}
