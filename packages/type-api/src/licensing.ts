/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LICENSING */
// Area 12 of the contract: where this family states a licence (capability
// `licensing`).
//
// The rights holders, the licence expression and the canonical text are the
// organization's, kept in the trusted policy store of PROP-019 and selected by
// the patch set. What this area answers is the family's part: the shape own
// files carry a header in, where the product's licence file lives, which
// manifest fields name the licence, which files carry the upstream's own terms,
// what the family's installers read instead of the text, where component
// licences gather, the subsystem licensing interventions are numbered in, and
// where the leftover guard goes with the words of the runner that finds it.
//
// The engine lays headers out, writes every artifact, scans and refuses; a type
// writes nothing. Added on 2026-11-01 after a product of the first family
// shipped under a licence its own surfaces contradicted (DESIGN-003 §1): the
// engine had no question to ask about where a family states a licence.

import type { LayersArea } from './layers.ts';
import type { ConventionsArea } from './conventions.ts';

/**
 * The shape of an own-file header: `line` is four comment lines in the comment
 * of the file's extension; `block` is the ruled comment the sources of an
 * editor family carry, so own code sits flush with the code beside it.
 */
export type LicenceHeaderStyle = 'line' | 'block';

/** A field of a product manifest that declares the licence, inside an overlay target of the type. */
export type LicenceField = {
	/** The overlay target, a path from the tree root. */
	readonly target: string;
	/** The key path inside the document. */
	readonly path: readonly string[];
	/**
	 * `expression`: set to the own SPDX expression; `file-name`: set to the name
	 * of the product's licence file; `url`: set to the product's licence URL, or
	 * removed when the product declares none.
	 */
	readonly role: 'expression' | 'file-name' | 'url';
};

/** A file of the upstream that carries the upstream's own licence terms: never edited, shipped as a component licence. */
export type UpstreamLicenceFile = {
	/** Path from the tree root. */
	readonly path: string;
	/** The component the terms belong to: a lower-case name, written into `LICENSE-<component>.txt`. */
	readonly component: string;
};

/** A rendering of the canonical text that an installer of this family reads instead of the text itself. */
export type LicenceRendering = {
	/** Path from the tree root. */
	readonly path: string;
	readonly format: 'rtf' | 'text';
};

/**
 * Where the leftover guard of the licence lives in the patch set, how its runner
 * spells a suite and a test, and what the family needs in front of the suite.
 */
export type LicenceGuard = {
	/** Path from the patch-set root, POSIX, inside the own layer. */
	readonly path: string;
	readonly suite: string;
	readonly test: string;
	/**
	 * Lines written right before the suite - a directive of the family's own lint
	 * rules, say - each a complete, non-empty line of the file. None by default.
	 */
	readonly preamble?: readonly string[];
};

export type LicensingArea = {
	readonly headerStyle: LicenceHeaderStyle;
	/** The directory of the product's licence file, from the tree root; the empty string is the root itself. */
	readonly licenceFileDirectory: string;
	/** The directory component licences gather in, from the tree root; the family's build copies it into the distributable. */
	readonly componentLicenceDirectory: string;
	/** The subsystem licensing interventions are numbered in; one of the type's conventions. */
	readonly subsystem: string;
	readonly fields: readonly LicenceField[];
	readonly upstreamLicenceFiles: readonly UpstreamLicenceFile[];
	readonly renderings: readonly LicenceRendering[];
	/** The guard for one own root of the patch set. */
	guard(ownRoot: string): LicenceGuard;
};

/** The shape of a component name: lower-case, digits and hyphens, starting with a letter or a digit. */
const COMPONENT_NAME = /^[a-z0-9][a-z0-9-]*$/u;

/**
 * A path from the tree root: forward slashes only, no slash at either end, no
 * empty, dot or dot-dot segment. The empty string is the root itself and is
 * acceptable only where the caller says so.
 */
export function treePathProblem(path: string, options: { readonly rootAllowed: boolean } = { rootAllowed: false }): string | null {
	if (path === '') return options.rootAllowed ? null : 'is empty';
	if (path.includes('\\')) return 'uses backslashes';
	if (path.startsWith('/') || path.endsWith('/')) return 'starts or ends with a slash';
	if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
		return 'has an empty, dot or dot-dot segment';
	return null;
}

/** What the shape check needs of a type: its id, the area, and the two areas the fields and the subsystem are checked against. */
export type LicensingShapeSubject = {
	readonly id: string;
	readonly licensing?: LicensingArea;
	readonly layers: LayersArea;
	readonly conventions: ConventionsArea;
};

/**
 * ##TYPE-AREA-LICENSING: the shape of the licensing answer. The directories are
 * tree paths; every field names a declared overlay target (the engine writes the
 * field through an overlay and nothing else), and the roles `expression` and
 * `file-name` appear at most once per target; components are lower-case names
 * and unique; the renderings and the upstream files are tree paths and unique;
 * the subsystem is one of the type's conventions, because the ids of the
 * interventions are numbered in it; the guard lies inside the own layer of the
 * patch set, where `verify` finds suite ids, and its preamble lines are complete
 * non-empty lines. An empty list is a well-formed answer.
 */
export function licensingShapeProblems(type: LicensingShapeSubject): readonly string[] {
	const area = type.licensing;
	if (area === undefined) return [];
	const problems: string[] = [];
	const fileDirectory = treePathProblem(area.licenceFileDirectory, { rootAllowed: true });
	if (fileDirectory !== null) problems.push(`${type.id}: the licence file directory ${fileDirectory}`);
	const componentDirectory = treePathProblem(area.componentLicenceDirectory);
	if (componentDirectory !== null) problems.push(`${type.id}: the component licence directory ${componentDirectory}`);
	if (!type.conventions.subsystems.includes(area.subsystem)) {
		problems.push(`${type.id}: the licensing subsystem ${area.subsystem} is not one of the type's subsystems`);
	}
	const targets = new Set(type.layers.overlayTargets.map((target) => target.path));
	const seenRoles = new Set<string>();
	for (const field of area.fields) {
		if (!targets.has(field.target))
			problems.push(`${type.id}: the licence field ${field.path.join('.')} names ${field.target}, which is not an overlay target`);
		if (field.path.length === 0 || field.path.some((key) => key === '')) {
			problems.push(`${type.id}: a licence field of ${field.target} has an empty key path`);
		}
		if (field.role !== 'url') {
			const key = `${field.target} ${field.role}`;
			if (seenRoles.has(key)) problems.push(`${type.id}: the role ${field.role} appears twice for ${field.target}`);
			seenRoles.add(key);
		}
	}
	const components = new Set<string>();
	const paths = new Set<string>();
	for (const file of area.upstreamLicenceFiles) {
		const problem = treePathProblem(file.path);
		if (problem !== null) problems.push(`${type.id}: the upstream licence file ${JSON.stringify(file.path)} ${problem}`);
		if (!COMPONENT_NAME.test(file.component))
			problems.push(`${type.id}: the component ${JSON.stringify(file.component)} is not a lower-case name`);
		if (components.has(file.component)) problems.push(`${type.id}: the component ${file.component} is named twice`);
		components.add(file.component);
		if (paths.has(file.path)) problems.push(`${type.id}: the upstream licence file ${file.path} is named twice`);
		paths.add(file.path);
	}
	for (const rendering of area.renderings) {
		const problem = treePathProblem(rendering.path);
		if (problem !== null) problems.push(`${type.id}: the rendering ${JSON.stringify(rendering.path)} ${problem}`);
		if (paths.has(rendering.path)) problems.push(`${type.id}: the rendering ${rendering.path} is named twice`);
		paths.add(rendering.path);
	}
	let guard: LicenceGuard;
	try {
		guard = area.guard('codkit-probe/own-root');
	} catch (error) {
		return [
			...problems,
			`${type.id}: licensing.guard refused a well-formed own root: ${error instanceof Error ? error.message : String(error)}`
		];
	}
	if (!guard.path.startsWith('delta/own/') || treePathProblem(guard.path) !== null) {
		problems.push(`${type.id}: the licence guard ${JSON.stringify(guard.path)} is not a path inside delta/own/`);
	}
	if ((guard.preamble ?? []).some((line) => line.trim() === '' || line.includes('\n'))) {
		problems.push(`${type.id}: the licence guard preamble has an empty or multi-line entry`);
	}
	if (guard.suite === '' || guard.test === '') problems.push(`${type.id}: the licence guard names no runner words`);
	return problems;
}
