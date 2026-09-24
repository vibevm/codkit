/** @scope spec://codkit/modules/vscode/PROP-004#VSCODE-BUILD-STEPS */
// Area 4: which command each step of the universal build skeleton runs, where
// the pass boundaries of a watch channel are, and what a packaged build has to
// have stamped.
//
// The order of the steps, the profiles, the transactions and the exit codes are
// the engine's; the names of the scripts are this type's answer.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildArea, BuildCommand, BuildStamp, PackageContainer, PackageInput, PackageTarget } from '@codkit/type-api';
import { PLACEHOLDER_CONFIG } from './configSchema.ts';
import type { VscodeQuality, VscodeTypeConfig } from './configSchema.ts';

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

const target = (
	id: PackageTarget['id'],
	platform: PackageTarget['platform'],
	arch: PackageTarget['arch'],
	gulpTask: string,
	supportedHosts: PackageTarget['supportedHosts'],
	environment?: BuildCommand['environment']
): PackageTarget => ({
	id,
	platform,
	arch,
	supportedHosts,
	build: [
		{ label: `package ${id}`, command: 'npm', args: ['run', 'gulp', '--', gulpTask], ...(environment === undefined ? {} : { environment }) }
	]
});

export function windowsSdkEnvironment(environment: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
	const path = environment['PATH'] ?? environment['Path'] ?? '';
	if (path.split(delimiter).some((entry) => entry !== '' && existsSync(join(entry, 'signtool.exe')))) return {};
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
	if (candidate === undefined) throw new Error('Windows SDK signtool.exe was not found; install Windows SDK Signing Tools');
	return { PATH: `${candidate}${delimiter}${path}` };
}

/**
 * ##VSCODE-LINUX-CONTAINER-RECIPE: the Linux container the installer targets are
 * built in on a host that is not Linux - a public Ubuntu 22.04 with exactly the
 * prerequisites of upstream's Linux build, Node of the tree's `.nvmrc`, and the
 * entry that installs the Linux dependencies and runs the commands.
 */
export const LINUX_CONTAINER_RECIPE = join(packageRoot, 'container', 'linux');

const PROXY_VARIABLES: readonly string[] = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

export const LINUX_CONTAINER: PackageContainer = {
	hosts: ['win32', 'darwin'],
	recipe: LINUX_CONTAINER_RECIPE,
	treeArguments: { NODE_VERSION: '.nvmrc' },
	buildEnvironment: ['NODEJS_ORG_MIRROR', ...PROXY_VARIABLES],
	runEnvironment: [...PROXY_VARIABLES, 'NODE_USE_ENV_PROXY', 'npm_config_registry', 'NODEJS_ORG_MIRROR', 'ELECTRON_MIRROR', 'GITHUB_TOKEN']
};

/**
 * ##VSCODE-LINUX-INSTALLER-TARGETS: the client sysroot `setup-env.sh` installs
 * for the native modules; the deb and rpm steps and the glibc check take it
 * unless the operator, or a provisioned input, sets `VSCODE_SYSROOT_DIR`.
 */
const CLIENT_SYSROOT = '.build/sysroots/glibc-2.28-gcc-10.5.0';
const SYSROOT = `export VSCODE_SYSROOT_DIR="\${VSCODE_SYSROOT_DIR:-$PWD/${CLIENT_SYSROOT}}"`;

/** Lines of upstream's Linux pipeline, run by bash in the tree. */
const pipelineLines = (label: string, lines: readonly string[]): BuildCommand => ({
	label,
	command: 'bash',
	args: ['-c', ['set -e', ...lines].join('\n')]
});

const gulp = (label: string, task: string): BuildCommand => ({ label, command: 'npm', args: ['run', 'gulp', '--', task] });

/**
 * ##VSCODE-LINUX-INPUTS: a static server of the loopback for a pre-provisioned
 * Electron. The bundle task downloads Electron with `@electron/get`, which reads
 * the archive from its cache but fetches `SHASUMS256.txt` on every run past it,
 * so a cache alone never makes the task offline; `ELECTRON_MIRROR`, the variable
 * `@electron/get` reads for its base address, can point at a copy served here.
 * Arguments: the directory to serve and the file the port is written to.
 */
const ELECTRON_MIRROR_SERVER = [
	'const http = require("node:http"), fs = require("node:fs"), path = require("node:path");',
	'const [root, portFile] = process.argv.slice(1);',
	'const server = http.createServer((request, response) => {',
	'  const file = path.join(root, decodeURIComponent(new URL(request.url, "http://mirror").pathname));',
	'  if (!file.startsWith(path.join(root, path.sep)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {',
	'    response.writeHead(404);',
	'    response.end();',
	'    return;',
	'  }',
	'  response.writeHead(200, { "content-length": fs.statSync(file).size });',
	'  if (request.method === "HEAD") return response.end();',
	'  fs.createReadStream(file).pipe(response);',
	'});',
	'server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));'
].join('\n');

/**
 * The raw bundle every installer target starts from: `../VSCode-linux-x64`.
 * When `CODKIT_ELECTRON_MIRROR_DIR` names a pre-provisioned Electron, laid out
 * like the release downloads (`v<version>/<file>`), it is served on the loopback
 * for the run of the task, `ELECTRON_MIRROR` points at it, and the loopback is
 * taken out of any proxy - the offline fence points the proxies at a closed port.
 */
const BUNDLE_LINUX_X64 = pipelineLines('bundle linux-x64', [
	'if [ -n "${CODKIT_ELECTRON_MIRROR_DIR:-}" ]; then',
	'  mirror_run="$(mktemp -d)"',
	`  node -e '${ELECTRON_MIRROR_SERVER}' "$CODKIT_ELECTRON_MIRROR_DIR" "$mirror_run/port" >"$mirror_run/log" 2>&1 &`,
	'  trap "kill $! 2>/dev/null || true" EXIT',
	'  for _ in $(seq 1 100); do [ -s "$mirror_run/port" ] && break; sleep 0.1; done',
	'  if [ ! -s "$mirror_run/port" ]; then echo "the Electron mirror of $CODKIT_ELECTRON_MIRROR_DIR did not start:" >&2; cat "$mirror_run/log" >&2; exit 1; fi',
	'  export ELECTRON_MIRROR="http://127.0.0.1:$(cat "$mirror_run/port")/"',
	'  export NO_PROXY="127.0.0.1${NO_PROXY:+,$NO_PROXY}" no_proxy="127.0.0.1${no_proxy:+,$no_proxy}"',
	'  echo "Electron mirror: $ELECTRON_MIRROR serves $CODKIT_ELECTRON_MIRROR_DIR"',
	'fi',
	'npm run gulp -- vscode-linux-x64'
]);

/**
 * Upstream's glibc check (product-build-linux-compile.yml, lines 339-342) over
 * the client bundle, after the sysroot download of the same pipeline (lines
 * 127-138): the script reads the output of a missing objdump as no requirement
 * at all and passes, so the objdump is required first.
 */
const GLIBC_CHECK = pipelineLines('glibc check', [
	SYSROOT,
	`SYSROOT_ARCH=amd64 node -e 'import { getVSCodeSysroot } from "./build/linux/debian/install-sysroot.ts"; (async () => { await getVSCodeSysroot(process.env["SYSROOT_ARCH"]); })()'`,
	'objdump="$VSCODE_SYSROOT_DIR/x86_64-linux-gnu/x86_64-linux-gnu/bin/objdump"',
	'if [ ! -x "$objdump" ]; then echo "the glibc check needs the objdump of the sysroot, and $objdump is not there" >&2; exit 1; fi',
	'EXPECTED_GLIBC_VERSION="2.28" EXPECTED_GLIBCXX_VERSION="3.4.25" SEARCH_PATH=../VSCode-linux-x64 VSCODE_ARCH=x64 bash ./build/azure-pipelines/linux/verify-glibc-requirements.sh'
]);

/**
 * ##DECISION-VSCODE-RAW-LINUX-BUNDLE-IS-LINUX-HOSTED: why the raw Linux bundle
 * is refused off Linux, and the container route to take instead.
 */
const RAW_LINUX_BUNDLE_REFUSAL = {
	reason:
		'a raw Linux bundle built here carries the native modules of this host - on win32 19 of its 20 .node files were Windows binaries on 2026-09-24 - and a directory of Linux files copied onto this host loses the modes it needs',
	hint: `build linux-x64-tar instead: it builds the same bundle in the Linux container of ${LINUX_CONTAINER_RECIPE} and keeps its modes in the archive; or run linux-x64 on a Linux host`
};

/**
 * ##VSCODE-LINUX-INPUTS: what the Linux x64 targets download, read from the
 * tree - the Electron version from `.npmrc`, the Chromium version from
 * `cgmanifest.json` - because a new pin names new inputs.
 */
export function linuxInputs(treeDir: string, withDeb: boolean): readonly PackageInput[] {
	const electron = electronVersionOf(treeDir);
	const inputs: PackageInput[] = [
		{
			name: `Electron ${electron} for linux-x64`,
			from: `https://github.com/electron/electron/releases/download/ (v${electron}/electron-v${electron}-linux-x64.zip and v${electron}/SHASUMS256.txt)`,
			path: 'electron-mirror',
			use: { kind: 'environment', variable: 'CODKIT_ELECTRON_MIRROR_DIR' }
		},
		{
			name: 'the built-in extensions of product.json',
			from: 'the release of each entry of builtInExtensions in product.json',
			path: 'builtInExtensions',
			use: { kind: 'tree', target: '.build/builtInExtensions' }
		},
		{
			name: 'the VS Code sysroot x86_64-linux-gnu-glibc-2.28-gcc-10.5.0',
			from: 'https://github.com/microsoft/vscode-linux-build-agent/releases',
			path: 'vscode-sysroot',
			use: { kind: 'environment', variable: 'VSCODE_SYSROOT_DIR' }
		}
	];
	if (!withDeb) {
		return inputs;
	}
	const sysrootsJson = `https://raw.githubusercontent.com/electron/electron/v${electron}/script/sysroots.json`;
	const shlibdeps = `https://raw.githubusercontent.com/chromium/chromium/${chromiumVersionOf(treeDir)}/third_party/dpkg-shlibdeps/dpkg-shlibdeps.pl`;
	return [
		...inputs,
		{
			name: "the Chromium sysroot of Electron's sysroots.json",
			from: 'https://msftelectronbuild.z5.web.core.windows.net/sysroots/toolchain',
			path: 'tmp',
			use: { kind: 'directory', variable: 'TMPDIR' }
		},
		{ name: "Electron's sysroots.json", from: sysrootsJson, path: 'sysroots.json', use: { kind: 'fetch', url: sysrootsJson } },
		{ name: "Chromium's dpkg-shlibdeps.pl", from: shlibdeps, path: 'dpkg-shlibdeps.pl', use: { kind: 'fetch', url: shlibdeps } }
	];
}

/** The Electron version of the tree: `target` of its `.npmrc`. */
function electronVersionOf(treeDir: string): string {
	return /^target="(.*)"$/mu.exec(readTreeFile(treeDir, '.npmrc'))?.[1] ?? 'unknown';
}

type CgManifest = {
	readonly registrations?: readonly {
		readonly component?: { readonly type?: string; readonly git?: { readonly name?: string } };
		readonly version?: string;
	}[];
};

/** The Chromium version of the tree: the git registration named chromium in `cgmanifest.json`. */
function chromiumVersionOf(treeDir: string): string {
	try {
		const manifest = JSON.parse(readTreeFile(treeDir, 'cgmanifest.json')) as CgManifest;
		const chromium = manifest.registrations?.find(
			(registration) => registration.component?.type === 'git' && registration.component.git?.name === 'chromium'
		);
		return chromium?.version ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

function readTreeFile(treeDir: string, name: string): string {
	const path = join(treeDir, name);
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** One of the three Linux x64 installer targets: the bundle, the glibc check, then its own steps. */
const linuxInstaller = (id: string, steps: readonly BuildCommand[], outputs: readonly string[], withDeb: boolean): PackageTarget => ({
	id,
	platform: 'linux',
	arch: 'x64',
	supportedHosts: ['linux'],
	container: LINUX_CONTAINER,
	outputs,
	build: [BUNDLE_LINUX_X64, GLIBC_CHECK, ...steps],
	inputs: (treeDir) => linuxInputs(treeDir, withDeb)
});

/**
 * ##VSCODE-LINUX-INSTALLER-TARGETS: what upstream's Linux pipeline runs after the
 * bundle (build/azure-pipelines/linux/steps/product-build-linux-compile.yml at
 * the pin 1.135.0), line for line.
 */
export const LINUX_INSTALLER_TARGETS: readonly PackageTarget[] = [
	linuxInstaller(
		'linux-x64-tar',
		[
			// "Archive client", lines 265 and 297, after the archives of an earlier run.
			pipelineLines('archive', [
				'rm -f .build/linux/client/code-*-x64-*.tar.gz',
				'ARCHIVE_PATH=".build/linux/client/code-${VSCODE_QUALITY}-x64-$(date +%s).tar.gz"',
				'mkdir -p $(dirname $ARCHIVE_PATH)',
				'tar -czf $ARCHIVE_PATH -C .. VSCode-linux-x64'
			])
		],
		['.build/linux/client/code-*-x64-*.tar.gz'],
		false
	),
	linuxInstaller(
		'linux-x64-deb',
		[
			// "Prepare deb package", line 352, over the client sysroot of the tree.
			pipelineLines('prepare deb', [SYSROOT, 'npm run gulp -- vscode-linux-x64-prepare-deb']),
			// "Build deb package", lines 359-366: the task, then the check of the compression.
			gulp('build deb', 'vscode-linux-x64-build-deb'),
			pipelineLines('check deb', [
				'file_output=$(file $(ls .build/linux/deb/amd64/deb/*.deb))',
				'if [[ "$file_output" != *"data compression xz"* ]]; then',
				'  echo "Error: unknown compression. $file_output"',
				'  exit 1',
				'fi'
			])
		],
		['.build/linux/deb/amd64/deb/*.deb'],
		true
	),
	linuxInstaller(
		'linux-x64-rpm',
		[
			// "Prepare rpm package", lines 373-383.
			pipelineLines('prepare rpm', [
				'TRIPLE="x86_64-linux-gnu"',
				SYSROOT,
				'export STRIP="$VSCODE_SYSROOT_DIR/$TRIPLE/$TRIPLE/bin/strip"',
				'npm run gulp -- vscode-linux-x64-prepare-rpm'
			]),
			// "Build rpm package", line 390.
			gulp('build rpm', 'vscode-linux-x64-build-rpm')
		],
		['.build/linux/rpm/x86_64/*.rpm'],
		false
	)
];

/**
 * The catalog (##VSCODE-PACKAGE-TARGET-CATALOG): the raw application bundles,
 * one upstream task each, and the Linux x64 installer targets.
 */
export const PACKAGE_TARGETS: readonly PackageTarget[] = [
	target('windows-x64', 'windows', 'x64', 'vscode-win32-x64', ['win32'], windowsSdkEnvironment),
	target('windows-arm64', 'windows', 'arm64', 'vscode-win32-arm64', ['win32'], windowsSdkEnvironment),
	// A raw Linux bundle built off Linux carries the host's native modules
	// (##DECISION-VSCODE-RAW-LINUX-BUNDLE-IS-LINUX-HOSTED).
	{ ...target('linux-x64', 'linux', 'x64', 'vscode-linux-x64', ['linux']), hostRefusal: RAW_LINUX_BUNDLE_REFUSAL },
	target('linux-arm64', 'linux', 'arm64', 'vscode-linux-arm64', ['linux']),
	target('linux-armhf', 'linux', 'armhf', 'vscode-linux-armhf', ['linux']),
	target('macos-x64', 'macos', 'x64', 'vscode-darwin-x64', ['darwin']),
	target('macos-arm64', 'macos', 'arm64', 'vscode-darwin-arm64', ['darwin']),
	...LINUX_INSTALLER_TARGETS
];

/**
 * ##VSCODE-PACKAGE-OUTPUTS: a raw bundle is written **beside** the managed tree,
 * in a sibling directory whose name carries the platform and the architecture.
 * `packageOutputs` is tree-relative by contract - a pattern that left the tree
 * would point `codkit package` at a directory the tool neither manages nor
 * guards - so this type states honestly that it can name none, and the operator
 * reads the location from the packager's own output. The installer targets
 * write inside the tree and name their outputs themselves.
 */
export const PACKAGE_OUTPUTS: readonly string[] = [];

/**
 * ##VSCODE-PACKAGE-OUTPUTS: the task above is the whole packaging of this
 * family; there is no second, product-supplied step to run after it.
 */
export const PACKAGE_DISTRIBUTABLE: readonly BuildCommand[] = [];

/**
 * ##VSCODE-PACKAGE-SCRATCH: the bundling of a built-in add-on of this family
 * rewrites the add-on's own manifest in place - the build kind, the version,
 * the pre-release flag - so a successful package run leaves a tracked file of
 * the upstream changed and an otherwise clean tree dirty. The manifests are
 * the residue this family is known to leave; the pattern is the shape of them
 * rather than the name of one add-on, because which add-ons a distribution
 * bundles is the distribution's business and not the type's.
 */
export const PACKAGE_SCRATCH: readonly string[] = ['extensions/*/package.json'];

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
export function packageStampsOf(quality?: VscodeQuality): readonly BuildStamp[] {
	return [
		{ name: 'BUILD_SOURCEVERSION', source: 'tree-head' },
		quality === undefined ? { name: 'VSCODE_QUALITY', source: 'pin-tag' } : { name: 'VSCODE_QUALITY', source: 'literal', value: quality }
	];
}

export const PACKAGE_STAMPS: readonly BuildStamp[] = packageStampsOf();

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
 * ##VSCODE-BUILD-CHANNELS-DEFAULT: the two channels a bare `build up` and the
 * single pass of the build profile start. The profile of this family declares
 * four; the other two compile the add-ons and are started by name when a change
 * asks for them.
 */
export const DEFAULT_CHANNELS: readonly string[] = ['transpile', 'typecheck'];

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

/**
 * The area as one patch set's `typeConfig` makes it. Only the stamps depend on
 * the section: every command of this family is the same script whoever declares
 * it, and the quality channel is the one thing the product answers for itself.
 */
export function makeBuild(config: VscodeTypeConfig): BuildArea {
	const defaults = config.packageTargets ?? ['linux-x64'];
	const defaultIds = new Set<string>(defaults);
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
export const build: BuildArea = makeBuild(PLACEHOLDER_CONFIG);
