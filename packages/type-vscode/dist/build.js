/** @scope spec://codkit/modules/vscode/PROP-004#VSCODE-BUILD-STEPS */
// Area 4: which command each step of the universal build skeleton runs, where
// the pass boundaries of a watch channel are, and what a packaged build has to
// have stamped.
//
// The order of the steps, the profiles, the transactions and the exit codes are
// the engine's; the names of the scripts are this type's answer.
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_CONFIG } from './configSchema.js';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
/** ##VSCODE-BUILD-STEPS: the dependency install of the tree and of `build/`. */
export const INSTALL = [
    { label: 'install', command: 'npm', args: ['ci'] },
    { label: 'install build', command: 'npm', args: ['ci', '--prefix', 'build'] }
];
/**
 * ##VSCODE-DEPENDENCY-ROOTS: this distribution installs twice - the tree root
 * and the build toolchain under `build/` - so a tree with only the first one
 * restored is not ready for a build profile.
 */
export const DEPENDENCY_ROOTS = ['node_modules', 'build/node_modules'];
/** ##VSCODE-BUILD-STEPS: the hygiene and lint gates, in the order they must run. */
export const HYGIENE = [
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
export const PACKAGE_BUILD = [
    { label: 'package', command: 'npm', args: ['run', 'gulp', '--', 'vscode-linux-x64'] }
];
const target = (id, platform, arch, gulpTask, supportedHosts, environment) => ({
    id,
    platform,
    arch,
    supportedHosts,
    build: [
        { label: `package ${id}`, command: 'npm', args: ['run', 'gulp', '--', gulpTask], ...(environment === undefined ? {} : { environment }) }
    ]
});
export function windowsSdkEnvironment(environment) {
    const path = environment['PATH'] ?? environment['Path'] ?? '';
    if (path.split(delimiter).some((entry) => entry !== '' && existsSync(join(entry, 'signtool.exe'))))
        return {};
    const programFiles = environment['ProgramFiles(x86)'];
    if (programFiles === undefined || programFiles === '')
        throw new Error('Windows SDK signtool.exe is not on PATH and ProgramFiles(x86) is unavailable');
    const bin = join(programFiles, 'Windows Kits', '10', 'bin');
    const toolArch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const candidate = existsSync(bin)
        ? readdirSync(bin, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(bin, entry.name, toolArch))
            .filter((entry) => existsSync(join(entry, 'signtool.exe')))
            .sort()
            .at(-1)
        : undefined;
    if (candidate === undefined)
        throw new Error('Windows SDK signtool.exe was not found; install Windows SDK Signing Tools');
    return { PATH: `${candidate}${delimiter}${path}` };
}
/** Raw application bundles. Installer/signing recipes remain separate future targets. */
export const PACKAGE_TARGETS = [
    target('windows-x64', 'windows', 'x64', 'vscode-win32-x64', ['win32'], windowsSdkEnvironment),
    target('windows-arm64', 'windows', 'arm64', 'vscode-win32-arm64', ['win32'], windowsSdkEnvironment),
    // linux-x64 is measured on both Linux and Windows in the Nimbus package lane.
    target('linux-x64', 'linux', 'x64', 'vscode-linux-x64', ['linux', 'win32']),
    target('linux-arm64', 'linux', 'arm64', 'vscode-linux-arm64', ['linux']),
    target('linux-armhf', 'linux', 'armhf', 'vscode-linux-armhf', ['linux']),
    target('macos-x64', 'macos', 'x64', 'vscode-darwin-x64', ['darwin']),
    target('macos-arm64', 'macos', 'arm64', 'vscode-darwin-arm64', ['darwin'])
];
/**
 * ##VSCODE-PACKAGE-OUTPUTS: the task above writes its result **beside** the
 * managed tree, in a sibling directory whose name carries the platform and the
 * architecture. `packageOutputs` is tree-relative by contract - a pattern that
 * left the tree would point `codkit package` at a directory the tool neither
 * manages nor guards - so this type states honestly that it can name none, and
 * the operator reads the location from the packager's own output.
 */
export const PACKAGE_OUTPUTS = [];
/**
 * ##VSCODE-PACKAGE-OUTPUTS: the task above is the whole packaging of this
 * family; there is no second, product-supplied step to run after it.
 */
export const PACKAGE_DISTRIBUTABLE = [];
/**
 * ##VSCODE-PACKAGE-SCRATCH: the bundling of a built-in add-on of this family
 * rewrites the add-on's own manifest in place - the build kind, the version,
 * the pre-release flag - so a successful package run leaves a tracked file of
 * the upstream changed and an otherwise clean tree dirty. The manifests are
 * the residue this family is known to leave; the pattern is the shape of them
 * rather than the name of one add-on, because which add-ons a distribution
 * bundles is the distribution's business and not the type's.
 */
export const PACKAGE_SCRATCH = ['extensions/*/package.json'];
/**
 * ##BUILD-COMMIT-COMES-FROM-THE-TREE-HEAD: a managed tree is a linked worktree,
 * so the packaging step cannot read `.git/HEAD` as a directory and has to be
 * told the commit; without it the packaged product carries no `commit` and the
 * NLS loader does not read language packs.
 *
 * ##VSCODE-QUALITY-IS-A-PRODUCT-ANSWER: the second stamp is the quality channel,
 * and which channel a product ships is a property of the product and not of the
 * pin it sits on. A patch set that says so in `typeConfig.quality` gets that
 * word; one that says nothing keeps the older answer - the tag of the pin -
 * which is a version string and therefore reads as "not the released channel"
 * to a packager that compares it with one.
 */
export function packageStampsOf(quality) {
    return [
        { name: 'BUILD_SOURCEVERSION', source: 'tree-head' },
        quality === undefined ? { name: 'VSCODE_QUALITY', source: 'pin-tag' } : { name: 'VSCODE_QUALITY', source: 'literal', value: quality }
    ];
}
export const PACKAGE_STAMPS = packageStampsOf();
/**
 * ##DAEMON-TRAPS: argv fragments that mean somebody else's watcher already
 * runs over this tree. The upstream watch scripts and the channels of this type
 * are mutually exclusive writers of `out/`.
 */
export const FOREIGN_WATCHER_MARKERS = ['build/next/index.ts transpile --watch', 'gulp watch-'];
/**
 * The pass-boundary profile of the watch channels, as an absolute path inside
 * this package. The engine reads and validates it exactly as it reads a profile
 * a patch set declares for itself (##FALSE-END-GUARDS).
 */
export const WATCH_PROFILE_PATH = join(packageRoot, 'config', 'build-watch.json');
/**
 * ##VSCODE-BUILD-CHANNELS-DEFAULT: the two channels a bare `build up` and the
 * single pass of the build profile start. The profile of this family declares
 * four; the other two compile the add-ons and are started by name when a change
 * asks for them.
 */
export const DEFAULT_CHANNELS = ['transpile', 'typecheck'];
/**
 * ##TESTS-LAYER-SPLIT: `--runGlob` bypasses the layer exclusion of the upstream
 * node runner, and a suite that brings up the workbench pulls in stylesheets
 * node cannot load; the node runner therefore takes the `common` and `node`
 * layers, and the browser suites are a protocol step outside `ci`.
 */
export function ownTests(ownRoot) {
    const leaf = ownRoot
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
/**
 * The area as one patch set's `typeConfig` makes it. Only the stamps depend on
 * the section: every command of this family is the same script whoever declares
 * it, and the quality channel is the one thing the product answers for itself.
 */
export function makeBuild(config) {
    const defaults = config.packageTargets ?? ['linux-x64'];
    const defaultIds = new Set(defaults);
    const defaultBuild = PACKAGE_TARGETS.filter((candidate) => defaultIds.has(candidate.id)).flatMap((candidate) => candidate.build);
    return {
        install: INSTALL,
        dependencyRoots: DEPENDENCY_ROOTS,
        hygiene: HYGIENE,
        ownTests,
        packageBuild: defaultBuild,
        packageTargets: PACKAGE_TARGETS,
        defaultPackageTargets: defaults,
        packageDistributable: PACKAGE_DISTRIBUTABLE,
        packageStamps: packageStampsOf(config.quality),
        packageOutputs: PACKAGE_OUTPUTS,
        packageScratch: PACKAGE_SCRATCH,
        defaultChannels: DEFAULT_CHANNELS,
        watchProfilePath: WATCH_PROFILE_PATH,
        foreignWatcherMarkers: FOREIGN_WATCHER_MARKERS
    };
}
/** The area of a patch set that answered nothing beyond the own root. */
export const build = makeBuild(PLACEHOLDER_CONFIG);
