/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYOUT */
// Area 2: where own code lives and what a fresh pass may delete.
//
// A plain git upstream has no anchored source root, so the own root is any
// directory of the tree the patch set names; the only refusals are of a path
// that is not a repository-relative POSIX directory at all. There are no own
// extensions - a family with no extension host has nowhere to materialize one -
// and no forbidden patch targets beyond the overlay targets the engine adds
// from the layers area.
/** ##TYPE-GENERIC: any directory of the tree, named from its root. */
export function ownRootProblem(ownRoot) {
    if (ownRoot === '') {
        return 'must be a path from the tree root';
    }
    if (ownRoot.startsWith('/') || ownRoot.endsWith('/')) {
        return 'must be written without a leading or trailing slash';
    }
    if (ownRoot.includes('\\')) {
        return 'must use forward slashes';
    }
    if (ownRoot.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return 'must not contain an empty, dot or dot-dot segment';
    }
    return null;
}
/** The layout of a patch set whose cleanup whitelist it declared itself. */
export function makeLayout(cleanupWhitelist) {
    return {
        ownRootProblem,
        // No extension host, so an own extension has nowhere to go; the engine
        // refuses the layer through the capability rather than through a path.
        ownExtensionPath: () => null,
        cleanupWhitelist,
        forbiddenPatchTargets: []
    };
}
export const layout = makeLayout([]);
