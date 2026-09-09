/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYOUT */
// Area 2 of the contract: tree layout.
//
// The own root is a full path from the tree root and comes from the patch set's
// `typeConfig.ownRoot` (##TYPE-OWN-ROOT); the type states the bounds it must sit
// inside and refuses a root outside them. To the engine the own root is an
// opaque directory: mirrored by content, excluded from the drift guard, named in
// the inventory.
//
// Amended 2026-09-09, after the second real type was measured on a real clone:
// the own root is the *first* of the directories a type may own, and a type
// names the build outputs inside each of them
// (##DECISION-OWNED-DIRECTORIES-AND-BUILD-OUTPUTS). A family that compiles its
// own package in place writes `lib/` next to `src/` inside the owned directory,
// and a family whose application is a directory of the product owns that
// directory too.

/** A refusal detail, or null when the value is acceptable. */
export type Refusal = string | null;

/**
 * What a directory the delta owns is *for*. The engine treats every role the
 * same way - mirrored by content, kept out of the drift guard, named in the
 * inventory - and uses the name only to address the directory: in the delta, in
 * the inventory and in what a command prints. `own` is the own root itself and
 * exists for every type; `application` is the directory of the product's
 * application, which a family whose application is a directory of the tree owns
 * beside its own code. A new role is added when a second type needs one
 * (##DECISION-TYPE-CONTRACT-FROM-MEASUREMENT), never in anticipation.
 */
export type OwnedRole = 'own' | 'application';

/**
 * One directory the delta owns (##TYPE-AREA-LAYOUT, amended 2026-09-09).
 *
 * `path` is a full path from the tree root; `buildOutputs` are the paths inside
 * it that a build of this family writes, as gitignore-style globs relative to
 * `path` (`lib/**`, `*.tsbuildinfo`). They are the answer to the one thing a
 * directory of sources cannot say about itself: a family that compiles a
 * package in place puts the output next to the sources, and without this the
 * engine would read a build as a change of own code.
 */
export type OwnedDirectory = {
	readonly path: string;
	readonly role: OwnedRole;
	readonly buildOutputs: readonly string[];
};

/**
 * The universal fields of `typeConfig` the layout answer is given. A type whose
 * other owned directories come from its own section of the configuration has
 * been handed that section by `configure` already (##TYPE-CONFIGURED) and reads
 * them from there; the own root is universal and is passed here, so a type that
 * needs nothing else answers without a configuration of its own.
 */
export type LayoutConfig = {
	readonly ownRoot: string;
};

export type LayoutArea = {
	/**
	 * Whether this own root is inside the bounds of the family. The detail names
	 * the constraint; the engine turns it into `CK-E-CONFIG`.
	 */
	ownRootProblem(ownRoot: string): Refusal;
	/**
	 * Every directory the delta owns in this patch set, the own root first
	 * (##TYPE-OWN-ROOT). One entry is the usual answer; a family whose
	 * application is a directory of the product answers with two, and the engine
	 * mirrors, guards, inventories and cleans each of them the same way.
	 *
	 * The first entry must be `config.ownRoot` with the role `own`; the roles
	 * and the paths must not repeat, and no owned directory may sit inside
	 * another - the engine refuses an answer that breaks any of it with
	 * `CK-E-CONFIG`, because it could not tell which directory a file belongs
	 * to.
	 */
	ownRoots(config: LayoutConfig): readonly OwnedDirectory[];
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

/**
 * The answer of a family that owns exactly one directory: the own root, with
 * the build outputs it writes inside itself (none, for a family that compiles
 * elsewhere). Every type answers `ownRoots`, and most of them answer this.
 */
export function oneOwnedDirectory(ownRoot: string, buildOutputs: readonly string[] = []): readonly OwnedDirectory[] {
	return [{ path: ownRoot, role: 'own', buildOutputs }];
}
