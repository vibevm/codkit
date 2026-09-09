/** @scope spec://codkit/modules/vscode/PROP-002#VSCODE-OWN-ROOT-CONSTRAINT */
// Area 2: where own code lives, where an own extension materializes, what a
// fresh pass may delete and what a patch may never target.
//
// To the engine the own root is an opaque directory. Only this type knows why
// it has to sit under `src/vs/`: the tsconfig, layering, test and nls globs of
// the distribution are anchored there (##OWN-UNDER-SRC-VS).
import { oneOwnedDirectory } from '@codkit/type-api';
/** The bounds of `typeConfig.ownRoot` for this family, with a trailing slash. */
export const OWN_ROOT_PREFIX = 'src/vs/';
/** Where the upstream build looks for built-in extensions, from the tree root. */
export const EXTENSIONS_TREE_DIR = 'extensions';
/** ##VSCODE-CLEANUP-WHITELIST: the build outputs a fresh pass may remove. */
export const CLEANUP_WHITELIST = [
    'node_modules/',
    '.build/',
    '/out*/',
    'extensions/*/out/',
    'extensions/*/dist/',
    '.eslintcache',
    '*.tsbuildinfo'
];
/**
 * ##VSCODE-FORBIDDEN-PATCH-TARGETS: a file with mixed line endings that no
 * deterministic patch can carry. The overlay targets of PROP-003 are forbidden
 * to patches too, and the engine adds them from the layers area rather than
 * having them restated here.
 */
export const FORBIDDEN_PATCH_TARGETS = ['.config/1espt/**'];
/** ##VSCODE-OWN-ROOT-CONSTRAINT: the own root must sit under `src/vs/`. */
export function ownRootProblem(ownRoot) {
    if (ownRoot === '') {
        return `must be a path from the tree root under ${OWN_ROOT_PREFIX}`;
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
    if (!ownRoot.startsWith(OWN_ROOT_PREFIX) || ownRoot.length === OWN_ROOT_PREFIX.length) {
        return `must be a directory under ${OWN_ROOT_PREFIX}: the tsconfig, layering, test and nls globs of this distribution are anchored there`;
    }
    return null;
}
/** ##OWN-EXTENSION-UNIT: `extensions/<name>`, relative to the tree root. */
export function ownExtensionPath(name) {
    return `${EXTENSIONS_TREE_DIR}/${name}`;
}
/**
 * ##VSCODE-OWN-ROOT-CONSTRAINT: one owned directory and no build output inside
 * it. This distribution transpiles the whole of `src/` into `out/` at the tree
 * root, so nothing of a build is ever written next to the sources of own code.
 */
export function ownRoots(config) {
    return oneOwnedDirectory(config.ownRoot);
}
export const layout = {
    ownRootProblem,
    ownRoots,
    ownExtensionPath,
    cleanupWhitelist: CLEANUP_WHITELIST,
    forbiddenPatchTargets: FORBIDDEN_PATCH_TARGETS
};
