/** @scope spec://codkit/modules/vscode/PROP-004#VSCODE-BUILD-STEPS */
// Area 4: which command each step of the universal build skeleton runs, where
// the pass boundaries of a watch channel are, and what a packaged build has to
// have stamped.
//
// The order of the steps, the profiles, the transactions and the exit codes are
// the engine's; the names of the scripts are this type's answer.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildArea, BuildCommand, BuildStamp } from '@codkit/type-api';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** ##VSCODE-BUILD-STEPS: the dependency install of the tree and of `build/`. */
export const INSTALL: readonly BuildCommand[] = [
	{ label: 'install', command: 'npm', args: ['ci'] },
	{ label: 'install build', command: 'npm', args: ['ci', '--prefix', 'build'] }
];

/**
 * ##VSCODE-DEPENDENCY-ROOTS: this distribution installs twice - the tree root
 * and the build toolchain under `build/` - so a tree with only the first one
 * restored is not ready for a build profile.
 */
export const DEPENDENCY_ROOTS: readonly string[] = ['node_modules', 'build/node_modules'];

/** ##VSCODE-BUILD-STEPS: the hygiene and lint gates, in the order they must run. */
export const HYGIENE: readonly BuildCommand[] = [
	{ label: 'hygiene', command: 'npm', args: ['run', 'hygiene'] },
	{ label: 'eslint', command: 'npm', args: ['run', 'eslint'] }
];

/**
 * ##VSCODE-BUILD-STEPS: the package build is the upstream `gulp vscode-*` task.
 * The task carries the platform and the architecture in its name, so a type can
 * only state a default; the release protocol names the one it wants. Nothing in
 * `ci` runs it - `ci --profile build` stops at the compile channels and the
 * tests - so this is the declared default and not an executed step.
 */
export const PACKAGE_BUILD: readonly BuildCommand[] = [
	{ label: 'package', command: 'npm', args: ['run', 'gulp', '--', 'vscode-linux-x64'] }
];

/**
 * ##VSCODE-PACKAGE-OUTPUTS: the task above writes its result **beside** the
 * managed tree, in a sibling directory whose name carries the platform and the
 * architecture. `packageOutputs` is tree-relative by contract - a pattern that
 * left the tree would point `codkit package` at a directory the tool neither
 * manages nor guards - so this type states honestly that it can name none, and
 * the operator reads the location from the packager's own output.
 */
export const PACKAGE_OUTPUTS: readonly string[] = [];

/**
 * ##VSCODE-PACKAGE-OUTPUTS: the task above is the whole packaging of this
 * family; there is no second, product-supplied step to run after it.
 */
export const PACKAGE_DISTRIBUTABLE: readonly BuildCommand[] = [];

/**
 * ##BUILD-COMMIT-COMES-FROM-THE-TREE-HEAD: a managed tree is a linked worktree,
 * so the packaging step cannot read `.git/HEAD` as a directory and has to be
 * told the commit; without it the packaged product carries no `commit` and the
 * NLS loader does not read language packs.
 */
export const PACKAGE_STAMPS: readonly BuildStamp[] = [
	{ name: 'BUILD_SOURCEVERSION', source: 'tree-head' },
	{ name: 'VSCODE_QUALITY', source: 'pin-tag' }
];

/**
 * ##DAEMON-TRAPS: argv fragments that mean somebody else's watcher already
 * runs over this tree. The upstream watch scripts and the channels of this type
 * are mutually exclusive writers of `out/`.
 */
export const FOREIGN_WATCHER_MARKERS: readonly string[] = ['build/next/index.ts transpile --watch', 'gulp watch-'];

/**
 * The pass-boundary profile of the watch channels, as an absolute path inside
 * this package. The engine reads and validates it exactly as it reads a profile
 * a patch set declares for itself (##FALSE-END-GUARDS).
 */
export const WATCH_PROFILE_PATH = join(packageRoot, 'config', 'build-watch.json');

/**
 * ##TESTS-LAYER-SPLIT: `--runGlob` bypasses the layer exclusion of the upstream
 * node runner, and a suite that brings up the workbench pulls in stylesheets
 * node cannot load; the node runner therefore takes the `common` and `node`
 * layers, and the browser suites are a protocol step outside `ci`.
 */
export function ownTests(ownRoot: string): BuildCommand | null {
	const leaf =
		ownRoot
			.split('/')
			.filter((segment) => segment !== '')
			.at(-1) ?? '';
	if (leaf === '') {
		return null;
	}
	return {
		label: 'product tests',
		command: 'npm',
		args: ['run', 'test-node', '--', '--runGlob', `vs/${leaf}/**/test/{common,node}/**/*.test.js`]
	};
}

export const build: BuildArea = {
	install: INSTALL,
	dependencyRoots: DEPENDENCY_ROOTS,
	hygiene: HYGIENE,
	ownTests,
	packageBuild: PACKAGE_BUILD,
	packageDistributable: PACKAGE_DISTRIBUTABLE,
	packageStamps: PACKAGE_STAMPS,
	packageOutputs: PACKAGE_OUTPUTS,
	watchProfilePath: WATCH_PROFILE_PATH,
	foreignWatcherMarkers: FOREIGN_WATCHER_MARKERS
};
