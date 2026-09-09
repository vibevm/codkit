/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-RUNTIME */
// Area 7 of the contract: the runtime library (capability `runtime-library`).
//
// `codkit runtime load` delivers a managed copy of a shipped library into the
// patch set's own layer. The delivery, the managed-copy discipline, the version
// literal and the drift check are the engine's; which library a type delivers,
// and what a person must do in the tree afterwards, is the type's answer.

export type RuntimeArea = {
	/**
	 * The identifier of the shipped runtime package this type delivers. It is
	 * the directory the library sits in under the installation's `runtime/`.
	 */
	readonly packageId: string;
	/** The directory the copy is called inside the own layer, POSIX. */
	readonly targetDirName: string;
	/**
	 * The next steps a person takes in the tree after a delivery: importing the
	 * library from the composition root, teaching the fork's lint about the new
	 * directory, and whatever else this family needs. The own root arrives as a
	 * tree-relative path.
	 */
	nextSteps(ownRoot: string): readonly string[];
};
