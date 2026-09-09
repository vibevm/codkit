/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYOUT */
// Area 2 of the contract: tree layout.
//
// The own root is a full path from the tree root and comes from the patch set's
// `typeConfig.ownRoot` (##TYPE-OWN-ROOT); the type states the bounds it must sit
// inside and refuses a root outside them. To the engine the own root is an
// opaque directory: mirrored by content, excluded from the drift guard, named in
// the inventory.

/** A refusal detail, or null when the value is acceptable. */
export type Refusal = string | null;

export type LayoutArea = {
	/**
	 * Whether this own root is inside the bounds of the family. The detail names
	 * the constraint; the engine turns it into `CK-E-CONFIG`.
	 */
	ownRootProblem(ownRoot: string): Refusal;
	/**
	 * Where an own extension materializes in the tree, given its name, or null
	 * when the family has no such thing (capability `own-extensions`).
	 */
	ownExtensionPath(name: string): string | null;
	/**
	 * Untracked build outputs a fresh pass may remove without asking. The pattern
	 * semantics and the discipline "what is not in the list is deleted" are the
	 * engine's; which paths a build of this family leaves behind is the answer.
	 */
	readonly cleanupWhitelist: readonly string[];
	/** Paths a patch may never target, over and above the overlay targets. */
	readonly forbiddenPatchTargets: readonly string[];
};
