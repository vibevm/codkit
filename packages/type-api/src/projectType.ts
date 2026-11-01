/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONTRACT-IS-CLOSED */
// The contract itself: the twelve questions a project type answers, and nothing
// else. The list is the set of variation points measured in the engine; a new
// question is added when a second type needs it, never in anticipation
// (##DECISION-TYPE-CONTRACT-FROM-MEASUREMENT). The tenth, generators, was added
// on 2026-09-09 exactly so: the second type needs a different skeleton and has
// no string funnel to graft a brand table into at all. The eleventh, preview,
// was added on 2026-11-01 for the family whose whole feedback loop is a host
// application showing the product (##TYPE-AREA-PREVIEW). The twelfth, licensing,
// was added the same day, after a product shipped under a licence its own
// surfaces contradicted: where a family states a licence is the family's
// knowledge (##TYPE-AREA-LICENSING).
//
// `@codkit/type-api` is the only import a type package takes from the tool, and
// the CLI imports a type only through this interface (##TYPE-API-STABILITY).

import { isAbsolute } from 'node:path';
import type { ZodType } from 'zod';
import type { AdvisoryArea } from './advisory.ts';
import type { BrandImagesArea } from './brandImages.ts';
import type { BuildArea, PackageTarget } from './build.ts';
import type { Capability } from './capabilities.ts';
import type { ConventionsArea } from './conventions.ts';
import type { GeneratorsArea } from './generators.ts';
import type { IdentityArea } from './identity.ts';
import type { LayersArea } from './layers.ts';
import type { LayoutArea, OwnedDirectory } from './layout.ts';
import { licensingShapeProblems } from './licensing.ts';
import type { LicensingArea } from './licensing.ts';
import type { PreviewArea } from './preview.ts';
import type { RuntimeArea } from './runtime.ts';
import type { StandardsArea } from './standards.ts';

export type ProjectType = {
	/** The identifier a patch set declares in `codkit.json`, e.g. `vscode`. */
	readonly id: string;
	/** The optional abilities this type declares (##TYPE-TERM-CAPABILITY). */
	readonly capabilities: ReadonlySet<Capability>;
	/**
	 * The abilities this type declares only for a patch set whose `typeConfig`
	 * asks for them (##TYPE-CONFIGURED). They are what `codkit types` prints
	 * next to the declared ones, so a person reads what the type could answer
	 * before writing a configuration; `configure` is what actually declares
	 * them, and it may declare no other.
	 */
	readonly configurableCapabilities?: ReadonlySet<Capability>;
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
	/** Present exactly when `preview` is declared (##TYPE-AREA-PREVIEW). */
	readonly preview?: PreviewArea;
	/** Present exactly when `licensing` is declared (##TYPE-AREA-LICENSING). */
	readonly licensing?: LicensingArea;
	readonly standards: StandardsArea;
	readonly conventions: ConventionsArea;
	readonly generators: GeneratorsArea;
	/**
	 * ##TYPE-CONFIGURED: a type whose answers depend on its own section of the
	 * configuration returns the specialized type here, once, after the section
	 * has passed `configSchema`; the engine asks the result everything
	 * afterwards. A type whose answers are the same for every patch set - the
	 * usual case - does not answer this at all. The result is a project type in
	 * its own right: it is checked by `projectTypeProblems` like any other, and
	 * it may declare only capabilities the unconfigured type named in
	 * `capabilities` or `configurableCapabilities`.
	 */
	configure?(typeConfig: unknown): ProjectType;
};

/**
 * ##TYPE-AREA-LAYOUT: the shape of the owned directories, asked of the type
 * with a probe own root. The engine asks the same questions again over the real
 * configuration, where a bad answer is `CK-E-CONFIG`; here they are part of the
 * type's own shape, so a type package's suite catches the answer before any
 * patch set exists. The rules are the ones the engine could not work around:
 * the own root comes first, no role and no path repeats, and no owned directory
 * sits inside another.
 */
function ownedDirectoryProblems(type: ProjectType): readonly string[] {
	const probe = 'codkit-probe/own-root';
	let answer: readonly OwnedDirectory[];
	try {
		answer = type.layout.ownRoots({ ownRoot: probe });
	} catch (error) {
		return [`${type.id}: layout.ownRoots refused a well-formed own root: ${error instanceof Error ? error.message : String(error)}`];
	}
	const problems: string[] = [];
	const first = answer[0];
	if (first === undefined || first.path !== probe || first.role !== 'own') {
		problems.push(`${type.id}: the first owned directory must be the own root itself, with the role own`);
	}
	const paths = new Set<string>();
	const roles = new Set<string>();
	for (const owned of answer) {
		if (owned.path === '' || owned.path.startsWith('/') || owned.path.endsWith('/') || owned.path.includes('\\')) {
			problems.push(`${type.id}: the owned directory ${JSON.stringify(owned.path)} is not a path from the tree root`);
		}
		if (paths.has(owned.path)) problems.push(`${type.id}: the owned directory ${owned.path} is named twice`);
		if (roles.has(owned.role)) problems.push(`${type.id}: the role ${owned.role} is used by two owned directories`);
		paths.add(owned.path);
		roles.add(owned.role);
	}
	for (const owned of answer) {
		for (const other of answer) {
			if (other !== owned && `${other.path}/`.startsWith(`${owned.path}/`) && other.path !== owned.path) {
				problems.push(`${type.id}: the owned directory ${other.path} sits inside the owned directory ${owned.path}`);
			}
		}
	}
	return problems;
}

/**
 * ##TYPE-PACKAGE-TARGETS: the shape of the optional answers of one package
 * target. A container route is for hosts the target cannot build on natively,
 * so it names at least one and none of the native ones; its recipe is a
 * directory of the type package and must be given as an absolute path; an
 * output pattern stays inside the tree, like `packageOutputs`.
 */
function packageTargetShapeProblems(typeId: string, target: PackageTarget): readonly string[] {
	const problems: string[] = [];
	const container = target.container;
	if (container !== undefined) {
		if (container.hosts.length === 0) problems.push(`${typeId}: package target ${target.id} has a container that names no host`);
		for (const host of container.hosts) {
			if (target.supportedHosts.includes(host)) {
				problems.push(`${typeId}: package target ${target.id} names ${host} both as a native host and as a container host`);
			}
		}
		if (!isAbsolute(container.recipe)) {
			problems.push(`${typeId}: package target ${target.id} names a container recipe that is not an absolute path: ${container.recipe}`);
		}
	}
	for (const pattern of target.outputs ?? []) {
		const segments = (pattern.endsWith('/') ? pattern.slice(0, -1) : pattern).split('/');
		if (segments.some((segment) => segment === '' || segment === '.' || segment === '..') || pattern.includes('\\')) {
			problems.push(`${typeId}: package target ${target.id} names an output that is not a path inside the tree: ${pattern}`);
		}
	}
	return problems;
}

/**
 * The areas that are optional in the interface, paired with the capability that
 * must be declared exactly when the area is present. Both the engine and a
 * type's own suite check the pairing, so a type cannot declare an ability it
 * does not answer for, or answer for one it never declared.
 */
export const OPTIONAL_AREAS: readonly {
	readonly area: 'brandImages' | 'runtime' | 'preview' | 'licensing';
	readonly capability: Capability;
}[] = [
	{ area: 'brandImages', capability: 'brand-images' },
	{ area: 'runtime', capability: 'runtime-library' },
	{ area: 'preview', capability: 'preview' },
	{ area: 'licensing', capability: 'licensing' }
];

/**
 * ##TYPE-AREA-PREVIEW: the shape of the preview answer. The modes are the names
 * a person selects, so there is at least one and the default is among them; the
 * default host is an executable name, never empty, because the engine looks it
 * up on PATH when nothing else names a host.
 */
function previewShapeProblems(type: ProjectType): readonly string[] {
	const preview = type.preview;
	if (preview === undefined) {
		return [];
	}
	const problems: string[] = [];
	if (preview.modes.length === 0) problems.push(`${type.id}: the preview area names no mode`);
	if (new Set(preview.modes).size !== preview.modes.length) problems.push(`${type.id}: a preview mode is named twice`);
	if (!preview.modes.includes(preview.defaultMode)) {
		problems.push(`${type.id}: the default preview mode ${preview.defaultMode} is absent from the modes`);
	}
	if (preview.defaultHost === '') problems.push(`${type.id}: the preview area names no default host`);
	return problems;
}

/**
 * Everything wrong with a type's own shape, as one list: an optional area that
 * disagrees with its capability, an image target whose container has no codec,
 * a layer answered without its capability. An empty list is a well-formed type.
 */
export function projectTypeProblems(type: ProjectType): readonly string[] {
	const problems: string[] = [];
	const packageTargets = type.build.packageTargets ?? [];
	const packageTargetIds = new Set<string>();
	for (const target of packageTargets) {
		if (packageTargetIds.has(target.id)) problems.push(`${type.id}: package target ${target.id} is named twice`);
		packageTargetIds.add(target.id);
		if (target.build.length === 0) problems.push(`${type.id}: package target ${target.id} has no build command`);
		if (target.supportedHosts.length === 0) problems.push(`${type.id}: package target ${target.id} names no supported host`);
		problems.push(...packageTargetShapeProblems(type.id, target));
	}
	for (const target of type.build.defaultPackageTargets ?? []) {
		if (!packageTargetIds.has(target)) problems.push(`${type.id}: default package target ${target} is absent from the catalog`);
	}
	for (const { area, capability } of OPTIONAL_AREAS) {
		const present = type[area] !== undefined;
		const declared = type.capabilities.has(capability);
		if (present && !declared) problems.push(`${type.id}: ${area} is answered but the capability ${capability} is not declared`);
		if (!present && declared) problems.push(`${type.id}: the capability ${capability} is declared but ${area} is not answered`);
	}
	if ((type.generators.brandGraft !== undefined) !== type.capabilities.has('gen-brand')) {
		problems.push(`${type.id}: the brand graft and the capability gen-brand must agree`);
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
	// A capability named as configurable is a promise that `configure` can
	// declare it; the configured type keeps the list, so a name appearing in
	// both is the normal state of a type after configuration and is not a
	// problem. What is a problem is promising it with nothing to keep the
	// promise (##TYPE-CONFIGURED).
	const configurable = type.configurableCapabilities;
	if (configurable !== undefined && configurable.size > 0 && type.configure === undefined) {
		problems.push(`${type.id}: capabilities are named as configurable, and the type answers no configure`);
	}
	problems.push(...ownedDirectoryProblems(type));
	problems.push(...previewShapeProblems(type));
	problems.push(...licensingShapeProblems(type));
	const images = type.brandImages;
	if (images !== undefined) {
		const kinds = new Set(images.codecs.map((codec) => codec.kind));
		for (const target of images.targets) {
			if (!kinds.has(target.kind)) problems.push(`${type.id}: the image target ${target.path} needs a codec for ${target.kind}`);
		}
	}
	return problems;
}
