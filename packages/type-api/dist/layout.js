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
/**
 * The answer of a family that owns exactly one directory: the own root, with
 * the build outputs it writes inside itself (none, for a family that compiles
 * elsewhere). Every type answers `ownRoots`, and most of them answer this.
 */
export function oneOwnedDirectory(ownRoot, buildOutputs = []) {
    return [{ path: ownRoot, role: 'own', buildOutputs }];
}
