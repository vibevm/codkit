/** @scope spec://codkit/modules/theia/PROP-002#THEIA-OWN-ROOT */
// Area 2: where own code lives, what a fresh pass may delete and what a patch
// may never target.
//
// The own root of this family is a **workspace package directory**: upstream is
// one npm workspace and every unit of code in it is a package, so own code is a
// package too and it has to sit under one of the workspace globs of the root
// manifest, or `lerna run`, the generated tsconfig references and the
// localization extraction never see it (##THEIA-OWN-ROOT).
/**
 * ##THEIA-OWN-ROOT: the workspace globs an own package may live under. The
 * fourth glob of the root manifest, `sample-plugins/*&#47;*`, is deliberately not
 * here: it holds VS Code-style plugins, which are the other extension
 * mechanism of this family and not own code of a patch set (##THEIA-EXTENSIONS-ARE-OWN-CODE).
 */
export const WORKSPACE_PARENTS = ['packages', 'dev-packages', 'examples'];
/** The parent a `gen`-shaped default own root sits in. */
export const DEFAULT_OWN_PARENT = 'packages';
/**
 * ##THEIA-CLEANUP-WHITELIST: the build outputs of this family a fresh pass may
 * remove without asking. Everything here is written by a build, an install or a
 * download and is reproduced by running them again; the user-editable
 * `esbuild.mjs` of an application is deliberately absent, because it is a file
 * a product owns and a build only regenerates when it is gone.
 */
export const CLEANUP_WHITELIST = [
    'node_modules/',
    '**/lib/',
    '**/src-gen/',
    '**/gen-esbuild.*.mjs',
    '**/gen-webpack*.js',
    '.browser_modules/',
    'plugins/',
    '.eslintcache',
    '**/.nyc_output/',
    '**/coverage/',
    '*.tsbuildinfo',
    '**/*.tsbuildinfo'
];
/**
 * ##THEIA-FORBIDDEN-TARGETS: upstream's own patches of `node_modules`, applied
 * on every install; the lockfile, which the install regenerates; and the
 * generated application sources. A patch of any of them is either overwritten
 * by the next install or is a patch of a generated file.
 */
export const FORBIDDEN_PATCH_TARGETS = ['dev-packages/cli/patches/**', 'package-lock.json', '**/src-gen/**'];
/** ##THEIA-OWN-ROOT: a directory one level under a workspace glob of the root manifest. */
export function ownRootProblem(ownRoot) {
    if (ownRoot === '') {
        return `must be a workspace package directory, one of ${WORKSPACE_PARENTS.map((parent) => `${parent}/<name>`).join(', ')}`;
    }
    if (ownRoot.startsWith('/') || ownRoot.endsWith('/')) {
        return 'must be written without a leading or trailing slash';
    }
    if (ownRoot.includes('\\')) {
        return 'must use forward slashes';
    }
    const segments = ownRoot.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return 'must not contain an empty, dot or dot-dot segment';
    }
    const [parent, name] = segments;
    if (segments.length !== 2 || parent === undefined || name === undefined || !WORKSPACE_PARENTS.includes(parent)) {
        return (`must match a workspace glob of the root package.json (${WORKSPACE_PARENTS.map((glob) => `${glob}/*`).join(', ')}): ` +
            'a package outside them misses the lerna fan-out, the generated tsconfig references and the localization extraction');
    }
    return null;
}
/**
 * ##THEIA-OWN-ROOT-CARRIES-ITS-BUILD-OUTPUT: the own root of this family is a
 * *compiled npm package*, so `tsc -b` writes its output next to the sources -
 * `lib/` and the incremental state beside it - and an install of a package with
 * a dependency the root cannot hoist writes `node_modules/` there too. None of
 * it is own code, and none of it belongs in the delta.
 */
export const OWN_BUILD_OUTPUTS = ['lib/**', 'node_modules/**', '.eslintcache', '*.tsbuildinfo'];
/**
 * ##THEIA-APPLICATION-ROOT: the application generates more than it compiles.
 * `theia build` writes the frozen composition into `src-gen/`, the bundler
 * entries beside it and the bundle into `lib/`; the plugins the application
 * downloads land in `plugins/`. The user-editable `esbuild.mjs` is deliberately
 * absent: a build only writes it when it is gone, so it is a file the product
 * owns (##THEIA-CLEANUP-WHITELIST).
 */
export const APPLICATION_BUILD_OUTPUTS = [
    'lib/**',
    'src-gen/**',
    'node_modules/**',
    'plugins/**',
    'gen-esbuild.*.mjs',
    'gen-webpack*.js',
    '.eslintcache',
    '*.tsbuildinfo'
];
/**
 * ##THEIA-APPLICATION-ROOT: two owned directories. The own package is the first
 * of them; the application is a directory of the product too - its manifest,
 * its bundler entry and its resources are the product's, not upstream's - so
 * the delta owns it and materializes it exactly as it materializes own code.
 */
export function makeLayout(applicationRoot) {
    return {
        ownRootProblem,
        ownRoots: (config) => [
            { path: config.ownRoot, role: 'own', buildOutputs: OWN_BUILD_OUTPUTS },
            { path: applicationRoot, role: 'application', buildOutputs: APPLICATION_BUILD_OUTPUTS }
        ],
        // A Theia extension is own code - a workspace package - and not a built-in
        // extension of a distribution, so this family materializes none
        // (##THEIA-EXTENSIONS-ARE-OWN-CODE).
        ownExtensionPath: () => null,
        cleanupWhitelist: CLEANUP_WHITELIST,
        forbiddenPatchTargets: FORBIDDEN_PATCH_TARGETS
    };
}
/** The layout of a patch set that declared nothing yet; see `projectType`. */
export const layout = makeLayout('applications/own');
