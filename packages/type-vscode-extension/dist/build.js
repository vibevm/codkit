/** @scope spec://codkit/modules/vscode-extension/PROP-004#VSX-PACKAGE-MANAGER */
// Area 4: what installs, lints, compiles, tests and packages a tree of this
// family.
//
// The order of the steps, the transactions and the reporting are the engine's;
// which command each step runs is this type's answer, and every one of them is
// a script of the extension manifest run by the package manager the patch set
// declares - the type never guesses the manager (##VSX-PACKAGE-MANAGER):
//
//   install        the manager's frozen install at the tree root   (##VSX-INSTALL)
//   hygiene        the declared lint scripts, `lint` by default    (##VSX-LINT)
//   own tests      the declared runner over the own root, or none  (##VSX-OWN-TESTS)
//   package build  the declared build script, `compile` by default (##VSX-PACKAGE-BUILD)
//   distributable  the declared package script, or nothing         (##VSX-PACKAGE-DISTRIBUTABLE)
//
// A script is run from the tree root and pointed at the extension root with the
// spelling of the declared manager (##VSX-RUN-SCRIPT).
import { argvOf } from './configSchema.js';
import { packageManagerOf } from './identity.js';
import { treePath } from './layout.js';
/** ##VSX-PACKAGE-BUILD: the script of the family's own build. */
export const DEFAULT_BUILD_SCRIPT = 'compile';
/** ##VSX-LINT: the one script the extension generator of the family writes into every manifest. */
export const DEFAULT_LINT_SCRIPTS = ['lint'];
/** ##VSX-BUILD-CHANNELS: the scripts of the two default channels. */
export const DEFAULT_BUNDLE_SCRIPT = 'watch:esbuild';
export const DEFAULT_TYPECHECK_SCRIPT = 'watch:tsc';
/** ##VSX-BUILD-CHANNELS: both channels are the default of a run that names none. */
export const DEFAULT_CHANNELS = ['bundle', 'typecheck'];
/** ##VSX-FOREIGN-WATCHER-MARKERS: the two commands the default channels start. */
export const FOREIGN_WATCHER_MARKERS = ['esbuild --watch', 'tsc --watch'];
/** ##VSX-INSTALL: the declared manager's frozen install at the tree root. */
export const INSTALL_ARGS = {
    npm: ['ci'],
    pnpm: ['install', '--frozen-lockfile'],
    yarn: ['install', '--immutable'],
    bun: ['install', '--frozen-lockfile']
};
export function installOf(manager) {
    return [{ label: 'install', command: manager, args: INSTALL_ARGS[manager] }];
}
/**
 * ##VSX-DEPENDENCY-ROOTS: `node_modules` of the tree root, and of the extension
 * root too for a monorepo, because a workspace install leaves the packages a
 * root cannot hoist beside the package that needs them.
 */
export function dependencyRootsOf(config) {
    const root = 'node_modules';
    if (config.monorepo !== true) {
        return [root];
    }
    const extension = treePath(config.extensionRoot, 'node_modules');
    return extension === root ? [root] : [root, extension];
}
/**
 * ##VSX-RUN-SCRIPT: a script of the extension manifest, run with the declared
 * manager from the tree root and pointed at the extension root. A repository
 * that is one extension - its extension root is `.` - runs `npm run <script>`
 * plainly; the three other managers take the directory as the specification
 * spells it.
 */
// REVIEW: "a repository that is one extension" is read as an extension root of
// `.`, because `--workspace .` names no workspace; the specification spells the
// plain form for npm alone, so pnpm, yarn and bun keep their directory flag
// with `.` as its value.
export function runScript(manager, extensionRoot, script, label) {
    switch (manager) {
        case 'npm':
            return { label, command: 'npm', args: extensionRoot === '.' ? ['run', script] : ['run', script, '--workspace', extensionRoot] };
        case 'pnpm':
            return { label, command: 'pnpm', args: ['-C', extensionRoot, 'run', script] };
        case 'yarn':
            return { label, command: 'yarn', args: ['--cwd', extensionRoot, 'run', script] };
        case 'bun':
            return { label, command: 'bun', args: ['run', '--cwd', extensionRoot, script] };
    }
}
/** ##VSX-LINT: the declared lint scripts, in order, each labelled by its name. */
export function hygieneOf(config) {
    const manager = packageManagerOf(config);
    return (config.scripts?.lint ?? DEFAULT_LINT_SCRIPTS).map((script) => runScript(manager, config.extensionRoot, script, script));
}
/**
 * ##VSX-OWN-TESTS: the declared runner over `<ownRoot>/**&#47;*.test.*`, exactly
 * as the `generic` type runs it, or null when the patch set declared none - a
 * runner the type guessed would run the wrong suite silently.
 */
export function ownTestsOf(config, ownRoot) {
    const test = config.scripts?.test;
    if (test === undefined || ownRoot === '') {
        return null;
    }
    const [command, ...args] = argvOf(test.command);
    if (command === undefined) {
        return null;
    }
    const glob = `${ownRoot}/**/*.test.*`;
    const tail = test.ownGlobArg === undefined ? [glob] : [test.ownGlobArg, glob];
    return { label: 'own tests', command, args: [...args, ...tail] };
}
/** The `[10:11:12 AM] ` stamp the TypeScript watch prints before each of its lines. */
const TIME_STAMP = '(?:\\[\\d{1,2}:\\d{2}:\\d{2}(?: [AP]M)?\\] )?';
/**
 * ##VSX-BUILD-CHANNELS: the two channels of the family, as the build-watch
 * document the engine validates. `bundle` is esbuild in watch mode, whose
 * passes open with `[watch] build started` and close with `[watch] build
 * finished`; its errors are the `[ERROR]` lines after the cross mark, counted
 * by the `N errors` summary. `typecheck` is the TypeScript compiler in watch
 * mode, with the lines the second family states for it
 * (`spec://codkit/modules/theia/PROP-004#THEIA-BUILD-CHANNELS`).
 */
export function defaultWatchProfile() {
    return {
        codkitBuildWatch: 1,
        channels: {
            bundle: {
                script: DEFAULT_BUNDLE_SCRIPT,
                passStart: ['^\\[watch\\] build started$'],
                passEnd: ['^\\[watch\\] build finished$'],
                errorLine: ['^\\u2718 \\[ERROR\\] (.+)$'],
                errorCountLine: ['^(\\d+) errors?$'],
                falseEndGuards: []
            },
            typecheck: {
                script: DEFAULT_TYPECHECK_SCRIPT,
                passStart: [`${TIME_STAMP}(?:Starting compilation in watch mode|File change detected\\. Starting incremental compilation)`],
                passEnd: [`${TIME_STAMP}Found \\d+ errors?\\. Watching for file changes`],
                errorLine: [`^${TIME_STAMP}(.+?)\\((\\d+),(\\d+)\\): error (TS\\d+): (.+)$`],
                errorCountLine: [`${TIME_STAMP}Found (\\d+) errors?\\. Watching for file changes`],
                falseEndGuards: []
            }
        }
    };
}
/**
 * ##VSX-BUILD-CHANNELS: the declared channels replace the defaults whole; each
 * is named by its `channel` field, or by its script when it has none.
 */
export function watchProfileOf(config) {
    const declared = config.watch?.channels;
    if (declared === undefined) {
        return defaultWatchProfile();
    }
    return {
        codkitBuildWatch: 1,
        channels: Object.fromEntries(declared.map((channel) => [
            channelNameOf(channel),
            {
                script: channel.script,
                passStart: channel.passStart,
                passEnd: channel.passEnd,
                errorLine: channel.errorLine ?? [],
                errorCountLine: channel.errorCountLine ?? [],
                falseEndGuards: channel.falseEndGuards ?? []
            }
        ]))
    };
}
/**
 * ##VSX-BUILD-CHANNELS: both family channels, or every declared channel in the
 * order it was declared when the patch set replaced them.
 */
// REVIEW: the default of a run that names none over declared channels is every
// declared channel, as the `generic` type answers; the specification fixes the
// default for the family's two channels only.
export function defaultChannelsOf(config) {
    const declared = config.watch?.channels;
    return declared === undefined ? DEFAULT_CHANNELS : declared.map(channelNameOf);
}
function channelNameOf(channel) {
    return channel.channel ?? channel.script;
}
/** ##VSX-PACKAGE-BUILD: one command, the family's own build of the extension into `dist/`. */
export function packageBuildOf(config) {
    return [runScript(packageManagerOf(config), config.extensionRoot, config.scripts?.build ?? DEFAULT_BUILD_SCRIPT, 'build')];
}
/**
 * ##VSX-PACKAGE-DISTRIBUTABLE: the product's script that runs its packager,
 * or nothing when the patch set declared none. The type spells no `vsce`
 * invocation of its own (##DECISION-VSX-PACKAGE-SCRIPT-IS-THE-PRODUCTS).
 */
export function packageDistributableOf(config) {
    const script = config.scripts?.package;
    if (script === undefined) {
        return [];
    }
    return [runScript(packageManagerOf(config), config.extensionRoot, script, 'package distributable')];
}
/** ##VSX-PACKAGE-OUTPUTS: `<extensionRoot>/dist/*.vsix`, or the declared patterns. */
export function packageOutputsOf(config) {
    return config.outputs ?? [treePath(config.extensionRoot, 'dist/*.vsix')];
}
/** ##VSX-STAMPS: the declared `{name, value}` literals, and nothing by default. */
export function stampsOf(config) {
    return (config.stamps ?? []).map((stamp) => ({ name: stamp.name, source: 'literal', value: stamp.value }));
}
export function makeBuild(config) {
    return {
        install: installOf(packageManagerOf(config)),
        dependencyRoots: dependencyRootsOf(config),
        hygiene: hygieneOf(config),
        ownTests: (ownRoot) => ownTestsOf(config, ownRoot),
        packageBuild: packageBuildOf(config),
        packageDistributable: packageDistributableOf(config),
        packageStamps: stampsOf(config),
        packageOutputs: packageOutputsOf(config),
        // ##VSX-PACKAGE-SCRATCH: neither the bundler nor the packager edits a
        // tracked file in place; a product whose build rewrites one declares it.
        packageScratch: config.packageScratch ?? [],
        defaultChannels: defaultChannelsOf(config),
        // The channels are scripts of the extension manifest and may be replaced
        // by the patch set, so the profile is data rather than a file this package
        // ships (`spec://codkit/modules/codkit/PROP-016#TYPE-CONFIGURED`).
        watchProfilePath: null,
        watchProfile: watchProfileOf(config),
        foreignWatcherMarkers: FOREIGN_WATCHER_MARKERS
    };
}
