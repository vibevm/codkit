/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-IDENTITY */
// Area 1 of the contract: upstream identity.
//
// The type says what a pin of this family looks like and what proves that a
// directory really is a tree of this family. Resolving a pin into the universal
// `tag@sha@date` form, and the anchor-commit rule that proves the origin of a
// fork, stay the engine's.

import type { Refusal } from './layout.ts';

/**
 * The text of the file fingerprints of this family, in the tree being checked;
 * a file that is absent or unreadable arrives as null. The shape is the one the
 * advisory area uses for the same reason: an answer of a type never opens a
 * file itself, it is handed the bytes the engine read.
 */
export type FingerprintFiles = ReadonlyMap<string, string | null>;

/** One thing `check-tree` requires of a healthy tree of this family. */
export type TreeFingerprint = {
	/** Path from the tree root, POSIX, no leading slash. */
	readonly path: string;
	readonly kind: 'file' | 'directory';
	/** Why this path proves the family; printed when the check fails. */
	readonly why: string;
	/**
	 * What the content of this file has to say, beyond existing at all - the
	 * name in a manifest, a declared package manager, a version two files must
	 * agree on (##TYPE-AREA-IDENTITY names the manifest name as part of the
	 * answer). The engine hands over the text of every file fingerprint of this
	 * family, so a fingerprint may be a statement about two of them; the detail
	 * that comes back completes the sentence "`<path>`: ...". Only a `file`
	 * fingerprint is asked, and only when the file is present.
	 */
	contentProblem?(files: FingerprintFiles): Refusal;
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
