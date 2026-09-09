/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-IDENTITY */
// Area 1 of the contract: upstream identity.
//
// The type says what a pin of this family looks like and what proves that a
// directory really is a tree of this family. Resolving a pin into the universal
// `tag@sha@date` form, and the anchor-commit rule that proves the origin of a
// fork, stay the engine's.

/** One thing `check-tree` requires of a healthy tree of this family. */
export type TreeFingerprint = {
	/** Path from the tree root, POSIX, no leading slash. */
	readonly path: string;
	readonly kind: 'file' | 'directory';
	/** Why this path proves the family; printed when the check fails. */
	readonly why: string;
};

export type IdentityArea = {
	/**
	 * The shape a pin tag of this family may take. The engine never invents a
	 * tag: it refuses one that does not match and says what the family expects.
	 */
	readonly tagPattern: RegExp;
	/** How the expected shape reads to a person, e.g. `<major>.<minor>.<patch>`. */
	readonly tagShape: string;
	/** The fingerprints of a healthy tree, in the order they are reported. */
	readonly fingerprints: readonly TreeFingerprint[];
};
