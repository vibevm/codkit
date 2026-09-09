/** @scope spec://codkit/modules/theia/PROP-004#THEIA-INSTALL */
// Area 4: what installs, lints, compiles, tests and packages a tree of this
// family.
//
// The order of the steps, the transactions and the reporting are the engine's;
// which command each step runs is this type's answer, and every one of them is
// a command of upstream's own monorepo:
//
//   install        npm ci                                  (##THEIA-INSTALL)
//   hygiene        lerna run lint --scope <own>, npm run lint   (##THEIA-LINT)
//   own tests      lerna run test --scope <own>            (##THEIA-TEST-RUNNERS)
//   package build  theia build in the application directory (##THEIA-PACKAGE-BUILD)
//
// `lerna` and `theia` are dev dependencies of the tree, so every command that
// needs one runs it through `npm exec --no`, which refuses rather than fetching
// anything: the tool never reaches a registry on its own (PROP-011).

import type { BuildArea, BuildCommand } from '@codkit/type-api';
import type { TheiaTypeConfig } from './configSchema.ts';

/** ##THEIA-INSTALL: the whole install of this family is one command. */
export const INSTALL: readonly BuildCommand[] = [{ label: 'install', command: 'npm', args: ['ci'] }];

/** The npm scripts of the tree root the watch channels of this family start. */
export const DEFAULT_TYPECHECK_SCRIPT = 'watch:compile';
export const DEFAULT_BUNDLE_SCRIPT = 'watch:bundle';

/**
 * ##THEIA-BUILD-CHANNELS: the two watchers of this family. `tsc -b -w` walks the
 * project references of the whole tree, and `theia build --watch` is esbuild in
 * context watch mode inside the application directory. Both are started as npm
 * scripts of the tree root, which is what the wrapper starts; the names are the
 * fork's own and the pass boundaries are the compilers' and are stated here.
 *
 * The boundaries of the bundle channel are the lines of upstream's own esbuild
 * problem-matcher plugin (`dev-packages/bundle-plugin/src/esbuild-plugin.ts:247-263`),
 * which prints `[watch/<target>] Build started` when a pass opens and
 * `[watch/<target>] Finished with N errors in Mms.` when it closes. The
 * boundaries of the typecheck channel are the TypeScript compiler's own watch
 * lines, whose optional `[HH:MM:SS AM]` stamp every pattern accepts.
 */
export function watchProfileOf(config: TheiaTypeConfig): unknown {
	const scripts = config.watchScripts ?? {};
	return {
		codkitBuildWatch: 1,
		channels: {
			typecheck: {
				script: scripts.typecheck ?? DEFAULT_TYPECHECK_SCRIPT,
				passStart: [`${TIME_STAMP}(?:Starting compilation in watch mode|File change detected\\. Starting incremental compilation)`],
				passEnd: [`${TIME_STAMP}Found \\d+ errors?\\. Watching for file changes`],
				errorLine: [`^${TIME_STAMP}(.+?)\\((\\d+),(\\d+)\\): error (TS\\d+): (.+)$`],
				errorCountLine: [`${TIME_STAMP}Found (\\d+) errors?\\. Watching for file changes`],
				falseEndGuards: []
			},
			bundle: {
				script: scripts.bundle ?? DEFAULT_BUNDLE_SCRIPT,
				passStart: ['^\\[watch/[a-z-]+\\] Build started$'],
				passEnd: ['^\\[watch/[a-z-]+\\] Finished with \\d+ errors in \\d+ms\\.$'],
				errorLine: [],
				errorCountLine: ['^\\[watch/[a-z-]+\\] Finished with (\\d+) errors in \\d+ms\\.$'],
				falseEndGuards: []
			}
		}
	};
}

/** The `[10:11:12 AM] ` stamp the TypeScript watch prints before each of its lines. */
const TIME_STAMP = '(?:\\[\\d{1,2}:\\d{2}:\\d{2}(?: [AP]M)?\\] )?';

/**
 * ##THEIA-BUILD-CHANNELS: argv words that mean somebody else's watcher already
 * runs over this tree. Upstream's own watch scripts run exactly these two
 * commands, and two writers of `lib/` are one too many.
 */
export const FOREIGN_WATCHER_MARKERS: readonly string[] = ['tsc -b -w', 'theia build --watch'];

/** One `npm exec` of a binary the tree's own dev dependencies carry. */
function exec(label: string, args: readonly string[]): BuildCommand {
	// `--no` is what keeps an air-gapped run air-gapped: npm refuses a binary
	// the tree does not carry instead of fetching it (PROP-011 ##NET-FORBIDDEN).
	return { label, command: 'npm', args: ['exec', '--no', '--', ...args] };
}

/**
 * ##THEIA-LINT: the own package first, then the whole tree. The full run is the
 * gate of a phase that adds a package: the own package brings its own
 * `.eslintrc.js` and its own `tsconfig.json`, and a package without them is not
 * linted at all.
 */
export function hygieneOf(ownPackageName: string): readonly BuildCommand[] {
	return [
		exec('lint own package', ['lerna', 'run', 'lint', '--scope', ownPackageName]),
		{ label: 'lint', command: 'npm', args: ['run', 'lint'] }
	];
}

/**
 * ##THEIA-TEST-RUNNERS: the unit tests of the own package - `theiaext test`,
 * which is nyc plus mocha over the compiled `lib/**&#47;*.spec.js` of the package.
 * The selection of this family is the package scope, not a path glob, so the own
 * root arrives and is not used: what names the package is its npm name.
 */
export function ownTestsOf(ownPackageName: string): BuildCommand {
	return exec('own tests', ['lerna', 'run', 'test', '--scope', ownPackageName]);
}

/**
 * ##THEIA-PACKAGE-BUILD: upstream packages no desktop application - no
 * electron-builder configuration, no signing, no installer - and its contract
 * with a packager is the built `lib/` of the application. The package build of
 * this type is therefore `theia build` of the application, run inside the
 * application directory through the workspace it is; the installer is a product
 * artifact and the product declares it in its own delta.
 */
export function packageBuildOf(applicationRoot: string): readonly BuildCommand[] {
	return [{ label: 'package', command: 'npm', args: ['exec', '--no', '--workspace', applicationRoot, '--', 'theia', 'build'] }];
}

export function makeBuild(config: TheiaTypeConfig): BuildArea {
	const ownTests = ownTestsOf(config.ownPackageName);
	return {
		install: INSTALL,
		hygiene: hygieneOf(config.ownPackageName),
		ownTests: () => ownTests,
		packageBuild: packageBuildOf(config.applicationRoot),
		// ##THEIA-NO-STAMPS: nothing is stamped at build time in this family -
		// no sha, no date, no quality channel. What is baked into `src-gen/` is
		// the declared configuration and the extension inventory, and a product
		// that wants a commit in its About dialog writes it into its own package.
		packageStamps: [],
		// The channels are npm scripts of the fork's own root manifest, so the
		// profile is data rather than a file this package ships (##TYPE-CONFIGURED).
		watchProfilePath: null,
		watchProfile: watchProfileOf(config),
		foreignWatcherMarkers: FOREIGN_WATCHER_MARKERS
	};
}
