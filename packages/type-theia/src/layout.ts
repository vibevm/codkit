/** @scope spec://codkit/modules/theia/PROP-002#THEIA-OWN-ROOT */
// Area 2: where own code lives, what a fresh pass may delete and what a patch
// may never target.
//
// The own root of this family is a **workspace package directory**: upstream is
// one npm workspace and every unit of code in it is a package, so own code is a
// package too and it has to sit under one of the workspace globs of the root
// manifest, or `lerna run`, the generated tsconfig references and the
// localization extraction never see it (##THEIA-OWN-ROOT).

import type { LayoutArea, OwnedDirectory, Refusal } from '@codkit/type-api';

/**
 * ##THEIA-OWN-ROOT: the workspace globs an own package may live under. The
 * fourth glob of the root manifest, `sample-plugins/*&#47;*`, is deliberately not
 * here: it holds VS Code-style plugins, which are the other extension
 * mechanism of this family and not own code of a patch set (##THEIA-EXTENSIONS-ARE-OWN-CODE).
 */
export const WORKSPACE_PARENTS: readonly string[] = ['packages', 'dev-packages', 'examples'];

/** The parent a `gen`-shaped default own root sits in. */
export const DEFAULT_OWN_PARENT = 'packages';

/**
 * ##THEIA-NATIVE-ADDON-BUILD: where `node-gyp` puts the compiled native addon of
 * this upstream. The monorepo has exactly one package with a `binding.gyp` -
 * `dev-packages/ffmpeg`, the codec check of the Electron distribution - and its
 * `build/` directory is written by the install, is ignored by git, and is the
 * only thing standing between the tree and `Cannot find module
 * '../build/Debug/ffmpeg.node'` on the next bundle. Rebuilding it costs a full
 * `npm ci`, which is why a fresh pass keeps it exactly as it keeps
 * `node_modules/`: both are the install's output and neither is litter.
 */
export const NATIVE_ADDON_BUILD_DIR = 'dev-packages/ffmpeg/build/';

/**
 * ##THEIA-CLEANUP-WHITELIST: the untracked content of this family a fresh pass
 * keeps; everything outside this list it removes. Each entry is written by an
 * install, a build or a download and is expensive enough to be worth keeping -
 * the user-editable `esbuild.mjs` of an application is deliberately absent,
 * because a build only regenerates it when it is gone, so it is a file the
 * product owns rather than an output.
 */
export const CLEANUP_WHITELIST: readonly string[] = [
	'node_modules/',
	'**/lib/',
	'**/src-gen/',
	'**/gen-esbuild.*.mjs',
	'**/gen-webpack*.js',
	'.browser_modules/',
	'plugins/',
	'**/dist/',
	'.eslintcache',
	'**/.nyc_output/',
	'**/coverage/',
	'*.tsbuildinfo',
	'**/*.tsbuildinfo',
	NATIVE_ADDON_BUILD_DIR
];

/**
 * ##THEIA-FORBIDDEN-TARGETS: upstream's own patches of `node_modules`, applied
 * on every install; the lockfile, which the install regenerates; and the
 * generated application sources. A patch of any of them is either overwritten
 * by the next install or is a patch of a generated file.
 */
export const FORBIDDEN_PATCH_TARGETS: readonly string[] = ['dev-packages/cli/patches/**', 'package-lock.json', '**/src-gen/**'];

/** ##THEIA-OWN-ROOT: a directory one level under a workspace glob of the root manifest. */
export function ownRootProblem(ownRoot: string): Refusal {
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
		return (
			`must match a workspace glob of the root package.json (${WORKSPACE_PARENTS.map((glob) => `${glob}/*`).join(', ')}): ` +
			'a package outside them misses the lerna fan-out, the generated tsconfig references and the localization extraction'
		);
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
export const OWN_BUILD_OUTPUTS: readonly string[] = [
	'lib/**',
	'node_modules/**',
	'.nyc_output/**',
	'coverage/**',
	'.eslintcache',
	'*.tsbuildinfo'
];

/**
 * ##THEIA-APPLICATION-ROOT: the application generates more than it compiles.
 * `theia build` writes the frozen composition into `src-gen/`, the bundler
 * entries beside it and the bundle into `lib/`; the plugins the application
 * downloads land in `plugins/`; and the packager the product runs after the
 * build - the second half of the package build, ##THEIA-PACKAGE-BUILD - writes
 * its unpacked application and its installers into `dist/`, which is where
 * every packager of this ecosystem puts them by default. It is the largest of
 * them by far, and none of it is own code. The user-editable `esbuild.mjs` is
 * deliberately absent: a build only writes it when it is gone, so it is a file
 * the product owns (##THEIA-CLEANUP-WHITELIST).
 */
export const APPLICATION_BUILD_OUTPUTS: readonly string[] = [
	'lib/**',
	'src-gen/**',
	'dist/**',
	'node_modules/**',
	'plugins/**',
	'.nyc_output/**',
	'coverage/**',
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
export function makeLayout(applicationRoot: string): LayoutArea {
	return {
		ownRootProblem,
		ownRoots: (config): readonly OwnedDirectory[] => [
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
export const layout: LayoutArea = makeLayout('applications/own');
