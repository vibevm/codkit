/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-GENERATORS */
// Area 10 of the contract: the skeletons `codkit gen` writes.
//
// What a feature of one family looks like - a class with dependency injection
// here, a container module there - and whether the family has a string funnel
// to graft a brand table into at all, is the type's knowledge. The engine keeps
// the command, the licence header of a generated file
// (##GEN-HEADER-IS-THE-PRODUCTS), the refusal over an existing file
// (##GEN-REFUSES-EXISTING) and the rule that the test of a feature lives inside
// the feature's own directory (##GEN-TEST-LIVES-WITH-THE-FEATURE) - which it
// checks against the skeleton rather than assuming.
//
// Nothing here writes anything: a generator returns text, and the engine
// classifies every target before the first byte reaches the disk.

/** What one module of a skeleton is, so the engine can check the shape. */
export type GeneratedRole = 'identifiers' | 'feature' | 'test' | 'table';

/** One file a generator would write, as text. */
export type GeneratedModule = {
	/** Path from the patch-set root, POSIX. */
	readonly path: string;
	readonly text: string;
	readonly role: GeneratedRole;
};

/** Everything a feature skeleton is generated from. */
export type FeatureRequest = {
	/** The full feature id, e.g. `acme.sample`. */
	readonly id: string;
	/** Its last segment, which the engine also uses as the directory name. */
	readonly name: string;
	/** The title the operator wrote; the template localizes it. */
	readonly title: string;
	/** Declare a setting for the feature's flag. */
	readonly setting: boolean;
	/** The feature is frozen at startup rather than hot-toggled. */
	readonly cold: boolean;
	/** The own root of the patch set, a path from the tree root. */
	readonly ownRoot: string;
};

export type FeatureSkeleton = {
	/**
	 * The directory of the feature inside the patch set, POSIX. One unit of the
	 * own manifest covers it, and the test must sit inside it.
	 */
	readonly directory: string;
	/** The modules, in the order the run reports them. */
	readonly modules: readonly GeneratedModule[];
	/** The line the composition root of the product gains by hand. */
	readonly importLine: string;
	/** What this family still asks of a person, one line each. */
	readonly reminders: readonly string[];
};

export type BrandGraft = {
	/** The rules table, written into the own layer. */
	readonly module: GeneratedModule;
	/**
	 * The graft into the family's string funnel. It is printed and never
	 * written: the funnel is upstream text, so the seam is a patch of the
	 * product and the tool does not author one here.
	 */
	readonly hookText: string;
	readonly reminders: readonly string[];
};

export type GeneratorsArea = {
	/** The files a feature of this family starts as. */
	featureSkeleton(request: FeatureRequest): FeatureSkeleton;
	/**
	 * The brand table and the graft that reaches the family's string funnel.
	 * Present exactly when the capability `gen-brand` is declared: a family with
	 * no single funnel has no honest graft to print.
	 */
	brandGraft?(ownRoot: string): BrandGraft;
};
