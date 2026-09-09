/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYOUT */
// Area 2 of the contract: tree layout.
//
// The own root is a full path from the tree root and comes from the patch set's
// `typeConfig.ownRoot` (##TYPE-OWN-ROOT); the type states the bounds it must sit
// inside and refuses a root outside them. To the engine the own root is an
// opaque directory: mirrored by content, excluded from the drift guard, named in
// the inventory.
export {};
