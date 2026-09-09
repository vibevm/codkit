/** @scope spec://codkit/modules/theia/PROP-004#THEIA-INSTALL */
// Area 4: what installs, lints, compiles, tests and packages a tree of this
// family.
//
// The order of the steps, the transactions and the reporting are the engine's;
// which command each step runs is this type's answer, and every one of them is
// a command of upstream's own monorepo:
//
//   install        npm ci                                       (##THEIA-INSTALL)
//   hygiene        npm run lint -w <own root>, then npm run lint (##THEIA-LINT)
//   own tests      npm run test -w <own root>                    (##THEIA-TEST-RUNNERS)
//   package build  theia build in the application directory      (##THEIA-PACKAGE-BUILD)
//
// The scripts of the own package are run **by workspace and not through
// `lerna --scope`**, and that is a measurement rather than a preference: the
// tool excludes the own root from git (`.git/info/exclude`), lerna discovers
// its packages with the git ignores applied, and `lerna run <script> --scope
// <own package>` therefore ends in `EFILTER No packages remain after
// filtering` on a real fork. npm reads the workspace globs of the manifest and
// finds the package whatever git thinks of it. The full-tree `npm run lint`
// stays as upstream wrote it, and it is the run that covers every upstream
// package - it just cannot cover the own one, which is why the own package is
// linted first and separately.
//
// `theia` is a dev dependency of the application, so the package build runs it
// through `npm exec --no`, which refuses rather than fetching anything: the
// tool never reaches a registry on its own (PROP-011).
/** ##THEIA-INSTALL: the whole install of this family is one command. */
export const INSTALL = [{ label: 'install', command: 'npm', args: ['ci'] }];
/**
 * ##THEIA-DEPENDENCY-ROOTS: one install, one dependency root. This monorepo is a
 * single npm workspace - every package of it, the build tooling included, is
 * hoisted into the `node_modules/` of the tree root - and there is no second
 * install root anywhere: a `build/` directory does not exist at the root of this
 * upstream at all.
 */
export const DEPENDENCY_ROOTS = ['node_modules'];
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
export function watchProfileOf(config) {
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
export const FOREIGN_WATCHER_MARKERS = ['tsc -b -w', 'theia build --watch'];
/** One npm script of the own package, run by its workspace directory. */
function ownScript(label, script, ownRoot) {
    return { label, command: 'npm', args: ['run', script, '--workspace', ownRoot] };
}
/**
 * ##THEIA-LINT: the own package first, then the whole tree. The full run is the
 * gate of a phase that adds a package: the own package brings its own
 * `.eslintrc.js` and its own `tsconfig.json`, and a package without them is not
 * linted at all.
 */
export function hygieneOf(ownRoot) {
    return [ownScript('lint own package', 'lint', ownRoot), { label: 'lint', command: 'npm', args: ['run', 'lint'] }];
}
/**
 * ##THEIA-TEST-RUNNERS: the unit tests of the own package - `theiaext test`,
 * which is nyc plus mocha over the compiled `lib/**&#47;*.spec.js` of the package.
 * The selection of this family is a whole package and not a path glob, so the
 * own root arrives and is used as the workspace the script runs in.
 */
export function ownTestsOf(ownRoot) {
    return ownScript('own tests', 'test', ownRoot);
}
/**
 * ##THEIA-PACKAGE-BUILD: upstream packages no desktop application - no
 * electron-builder configuration, no signing, no installer - and its contract
 * with a packager is the built `lib/` of the application. The package build of
 * this type is therefore `theia build` of the application, run inside the
 * application directory through the workspace it is; the installer is a product
 * artifact and the product declares it in its own delta.
 */
export function packageBuildOf(applicationRoot) {
    return [{ label: 'package', command: 'npm', args: ['exec', '--no', '--workspace', applicationRoot, '--', 'theia', 'build'] }];
}
export function makeBuild(config) {
    const ownTests = ownTestsOf(config.ownRoot);
    return {
        install: INSTALL,
        dependencyRoots: DEPENDENCY_ROOTS,
        hygiene: hygieneOf(config.ownRoot),
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
