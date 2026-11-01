/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-PREVIEW */
// Area 11 of the contract: the preview (capability `preview`).
//
// `codkit preview` shows a person the product: it launches a host application
// with the loaded tree - an extension development host with the extension, a
// built editor, an application's backend - in a profile that is isolated from
// the person's own. The engine owns the isolation directories, the record of
// the launched process, the lock, the overlay materialization and the restore;
// the type owns the recipe: what prepares the tree, which executable is the
// family's default host, and the exact argv the host takes
// (##DECISION-PREVIEW-IS-A-CONTRACT-AREA). A type never spawns anything.
export {};
