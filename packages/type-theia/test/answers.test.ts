// The answers of the `theia` type, area by area, against the facts of upstream
// master 1.75.0 (spec://codkit/modules/theia/PROP-002, PROP-003, PROP-004,
// PROP-005).

import { describe, expect, it } from 'vitest';
import {
	CLEANUP_WHITELIST,
	configSchema,
	CORE_MANIFEST_PATH,
	FORBIDDEN_PATCH_TARGETS,
	fingerprints,
	hygieneOf,
	identity,
	importedPackageOf,
	LERNA_MANIFEST_PATH,
	makeAdvisory,
	makeBuild,
	makeLayout,
	NATIVE_ADDON_BUILD_DIR,
	ownTestsOf,
	overrideProblems,
	packageBuildOf,
	packageDistributableOf,
	packageNameOf,
	packageOutputsOf,
	ROOT_MANIFEST_PATH,
	serviceOverride,
	standards,
	SUBSYSTEMS,
	watchProfileOf
} from '../src/index.ts';
import type { ServiceOverrideContext } from '@codkit/type-api';
import type { TheiaTypeConfig } from '../src/index.ts';

const CONFIG: TheiaTypeConfig = {
	ownRoot: 'packages/acme',
	ownPackageName: '@acme/theia-product',
	applicationRoot: 'examples/electron'
};

/** The three manifests of a healthy tree, as upstream writes them. */
function healthyFiles(overrides: Readonly<Record<string, string>> = {}): ReadonlyMap<string, string | null> {
	return new Map<string, string | null>([
		[
			ROOT_MANIFEST_PATH,
			JSON.stringify({
				name: '@theia/monorepo',
				private: true,
				version: '0.0.0',
				workspaces: ['dev-packages/*', 'packages/*', 'examples/*']
			})
		],
		[LERNA_MANIFEST_PATH, JSON.stringify({ npmClient: 'npm', version: '1.75.0' })],
		[CORE_MANIFEST_PATH, JSON.stringify({ name: '@theia/core', version: '1.75.0' })],
		...Object.entries(overrides)
	]);
}

function problemOf(path: string, files: ReadonlyMap<string, string | null>): string | null {
	const fingerprint = fingerprints.find((candidate) => candidate.path === path);
	return fingerprint?.contentProblem?.(files) ?? null;
}

describe('identity', () => {
	it('takes a release tag and refuses the rolling one', () => {
		// ##THEIA-PIN-TAGS: `next` is moved onto the canary commit.
		expect(identity.tagPattern.test('v1.75.0')).toBe(true);
		expect(identity.tagPattern.test('next')).toBe(false);
		expect(identity.tagPattern.test('1.75.0')).toBe(false);
	});

	it('accepts the three manifests of a healthy tree', () => {
		const files = healthyFiles();
		for (const fingerprint of fingerprints) {
			expect(fingerprint.contentProblem?.(files) ?? null, fingerprint.path).toBeNull();
		}
	});

	it('refuses a root manifest that is not the monorepo of this family', () => {
		expect(problemOf(ROOT_MANIFEST_PATH, healthyFiles({ [ROOT_MANIFEST_PATH]: '{"name":"something-else"}' }))).toContain('@theia/monorepo');
		const withoutGlobs = JSON.stringify({ name: '@theia/monorepo', workspaces: ['examples/*'] });
		expect(problemOf(ROOT_MANIFEST_PATH, healthyFiles({ [ROOT_MANIFEST_PATH]: withoutGlobs }))).toContain('packages/*');
	});

	it('refuses a tree whose package manager is not npm', () => {
		// ##THEIA-TREE-FINGERPRINT: `npmClient: "npm"`; yarn is older knowledge.
		const yarn = JSON.stringify({ npmClient: 'yarn', version: '1.75.0' });
		expect(problemOf(LERNA_MANIFEST_PATH, healthyFiles({ [LERNA_MANIFEST_PATH]: yarn }))).toContain('npm');
	});

	it('refuses a core package that disagrees with lerna.json about the version', () => {
		// ##THEIA-VERSION-SOURCE: every package carries the same literal.
		const stale = JSON.stringify({ name: '@theia/core', version: '1.74.0' });
		expect(problemOf(CORE_MANIFEST_PATH, healthyFiles({ [CORE_MANIFEST_PATH]: stale }))).toContain('1.75.0');
	});
});

describe('layout', () => {
	it('keeps the outputs of a build and nothing else in the cleanup whitelist', () => {
		expect(CLEANUP_WHITELIST).toContain('**/src-gen/');
		expect(CLEANUP_WHITELIST).toContain('**/lib/');
		expect(CLEANUP_WHITELIST).toContain('plugins/');
		// The user-editable bundler entry of an application is not a build output.
		expect(CLEANUP_WHITELIST.some((glob) => glob.includes('esbuild.mjs') && !glob.includes('gen-esbuild'))).toBe(false);
	});

	it('counts the packager output of an application as a build output', () => {
		// ##THEIA-APPLICATION-ROOT: `dist/` is where the packager the product runs
		// after `theia build` puts the unpacked application and its installers -
		// hundreds of megabytes that used to be read as edited own code.
		expect(makeLayout('examples/electron').ownRoots({ ownRoot: 'packages/product' })[1]?.buildOutputs).toContain('dist/**');
		expect(CLEANUP_WHITELIST).toContain('**/dist/');
	});

	it('keeps the build directory of the one native addon this upstream has', () => {
		// ##THEIA-NATIVE-ADDON-BUILD: the install compiles it from the `binding.gyp`
		// of `dev-packages/ffmpeg`, a fresh pass that removed it cost a full
		// reinstall, and no other package of the monorepo has one.
		expect(NATIVE_ADDON_BUILD_DIR).toBe('dev-packages/ffmpeg/build/');
		expect(CLEANUP_WHITELIST).toContain(NATIVE_ADDON_BUILD_DIR);
		// It is one named package and not every directory called build.
		expect(CLEANUP_WHITELIST).not.toContain('**/build/');
	});

	it('owns the own package and the application, and names what a build writes inside each', () => {
		// ##THEIA-APPLICATION-ROOT, ##THEIA-OWN-ROOT-CARRIES-ITS-BUILD-OUTPUT.
		const owned = makeLayout('examples/electron').ownRoots({ ownRoot: 'packages/product' });
		expect(owned.map((entry) => [entry.path, entry.role])).toEqual([
			['packages/product', 'own'],
			['examples/electron', 'application']
		]);
		expect(owned[0]?.buildOutputs).toContain('lib/**');
		expect(owned[0]?.buildOutputs).toContain('*.tsbuildinfo');
		// The application generates its composition as well as compiling it.
		expect(owned[1]?.buildOutputs).toContain('src-gen/**');
		expect(owned[1]?.buildOutputs).toContain('lib/**');
		// The user-editable bundler entry is the product's file, not a build output.
		expect(owned[1]?.buildOutputs.some((glob) => glob.includes('esbuild.mjs') && !glob.includes('gen-esbuild'))).toBe(false);
	});

	it('never patches what an install regenerates', () => {
		// ##THEIA-FORBIDDEN-TARGETS
		expect(FORBIDDEN_PATCH_TARGETS).toEqual(['dev-packages/cli/patches/**', 'package-lock.json', '**/src-gen/**']);
	});
});

describe('layers', () => {
	const context = (moduleText: string, manifest: unknown): ServiceOverrideContext => ({
		serviceId: 'EditorManager',
		modulePath: 'src/browser/acme-frontend-module.ts',
		moduleText,
		read: (path: string) => (path === 'package.json' && manifest !== null ? JSON.stringify(manifest) : null)
	});

	const MODULE = [
		"import { ContainerModule } from '@theia/core/shared/inversify';",
		"import { EditorManager } from '@theia/editor/lib/browser';",
		"import { AcmeEditorManager } from './acme-editor-manager';",
		'',
		'export default new ContainerModule(({ rebind }) => {',
		'\trebind(EditorManager).to(AcmeEditorManager).inSingletonScope();',
		'});'
	].join('\n');

	it('overrides by rebind, and by nothing else', () => {
		// ##THEIA-OVERRIDE-IS-REBIND
		expect(serviceOverride.registrationCall).toBe('rebind');
	});

	it('accepts a rebind whose package depends on the package that binds the service', () => {
		// ##THEIA-OVERRIDE-VERIFIER, the accepting half.
		expect(overrideProblems(context(MODULE, { name: '@acme/theia-product', dependencies: { '@theia/editor': '1.75.0' } }))).toEqual([]);
	});

	it('refuses a rebind without the dependency edge that puts it later in the load order', () => {
		const problems = overrideProblems(context(MODULE, { name: '@acme/theia-product', dependencies: { '@theia/core': '1.75.0' } }));
		expect(problems).toHaveLength(1);
		expect(problems[0]?.detail).toContain('@theia/editor');
		expect(problems[0]?.hint).toContain('dependencies');
	});

	it('refuses a module that is not a container module of the root container', () => {
		// ##THEIA-OVERRIDE-CHILD-CONTAINERS: the limitation is named, not guessed.
		const child = MODULE.replace('export default new ContainerModule(({ rebind }) => {', 'export function bindLater(child) {').replace(
			'});',
			'}'
		);
		const problems = overrideProblems(context(child, { dependencies: { '@theia/editor': '1.75.0' } }));
		expect(problems.some((problem) => problem.detail.includes('ContainerModule'))).toBe(true);
	});

	it('needs no edge for a service the own package binds itself', () => {
		const local = MODULE.replace(
			"import { EditorManager } from '@theia/editor/lib/browser';",
			"import { EditorManager } from './acme-editor';"
		);
		expect(overrideProblems(context(local, { name: '@acme/theia-product' }))).toEqual([]);
	});

	it('reads the package a service identifier comes from', () => {
		expect(importedPackageOf("import { A, B } from '@theia/core/lib/browser';", 'B')).toBe('@theia/core');
		expect(importedPackageOf("import { A } from 'inversify';", 'A')).toBe('inversify');
		expect(importedPackageOf("import { A } from '@theia/core';", 'Missing')).toBeNull();
		expect(packageNameOf('@theia/editor/lib/browser')).toBe('@theia/editor');
	});
});

describe('build', () => {
	it('installs with npm ci and nothing else', () => {
		// ##THEIA-INSTALL
		expect(makeBuild(CONFIG).install).toEqual([{ label: 'install', command: 'npm', args: ['ci'] }]);
	});

	it('names one dependency root, because this monorepo installs once', () => {
		// ##THEIA-DEPENDENCY-ROOTS: no `build/` install root exists in this
		// upstream, so a build profile must not wait for a receipt inside one.
		expect(makeBuild(CONFIG).dependencyRoots).toEqual(['node_modules']);
	});

	it('lints the own package by its workspace first, and then the whole tree', () => {
		// ##THEIA-LINT: `lerna --scope` cannot see a package the tool excludes
		// from git, so the own package is run by workspace; the full-tree run is
		// upstream's own and covers everything else.
		const [own, all] = hygieneOf('packages/acme');
		expect(own?.args).toEqual(['run', 'lint', '--workspace', 'packages/acme']);
		expect(all?.args).toEqual(['run', 'lint']);
	});

	it('runs the own tests as a whole package rather than over a path glob', () => {
		// ##THEIA-TEST-RUNNERS
		expect(ownTestsOf('packages/acme').args).toEqual(['run', 'test', '--workspace', 'packages/acme']);
		expect(makeBuild(CONFIG).ownTests('packages/acme')?.args).toEqual(['run', 'test', '--workspace', 'packages/acme']);
	});

	it('compiles the tree and the own package before it bundles the application', () => {
		// ##THEIA-PACKAGE-BUILD: the bundler of this family does not fail over a
		// package whose lib/ is missing - it leaves a runtime require and reports
		// a clean pass - so a build that started at the bundle produced a package
		// without one line of the product's own code. The order is the answer:
		// the tree, then the own package (##THEIA-COMPILE), then the bundle.
		expect(packageBuildOf('examples/electron', 'packages/acme').map((command) => [command.label, ...command.args])).toEqual([
			['compile tree', 'run', 'compile'],
			['compile own package', 'run', 'compile', '--workspace', 'packages/acme'],
			['package', 'exec', '--no', '--workspace', 'examples/electron', '--', 'theia', 'build']
		]);
		expect(makeBuild(CONFIG).packageBuild).toEqual(packageBuildOf(CONFIG.applicationRoot, CONFIG.ownRoot));
		// The family's build is the same three commands whatever the product
		// declares; what follows it is the separate answer below.
		expect(makeBuild({ ...CONFIG, packageScript: 'package:linux' }).packageBuild).toHaveLength(3);
	});

	it('stamps nothing into the built application', () => {
		// ##THEIA-NO-STAMPS
		expect(makeBuild(CONFIG).packageStamps).toEqual([]);
	});

	it('continues into the packaging script the product declares, and only then', () => {
		// ##THEIA-PACKAGE-BUILD: upstream ships no packager, so the product's half
		// exists only when `typeConfig.packageScript` names one; what it runs is
		// the product's business and the type never names a packager.
		expect(packageDistributableOf('examples/electron')).toEqual([]);
		expect(makeBuild(CONFIG).packageDistributable).toEqual([]);
		const commands = packageDistributableOf('examples/electron', 'package:linux');
		expect(commands).toEqual([
			{
				label: 'package distributable',
				command: 'npm',
				args: ['run', 'package:linux', '--workspace', 'examples/electron']
			}
		]);
		expect(makeBuild({ ...CONFIG, packageScript: 'package:linux' }).packageDistributable).toEqual(commands);
	});

	it('names both of its channels as the default of a run that names none', () => {
		// ##THEIA-BUILD-CHANNELS: a default that left the bundle channel out would
		// mean the application is never bundled by a build profile.
		expect(makeBuild(CONFIG).defaultChannels).toEqual(['typecheck', 'bundle']);
	});

	it('names the application directory the packager writes its result into', () => {
		// ##THEIA-PACKAGE-OUTPUTS: inside the tree, so `codkit package` can print it.
		expect(packageOutputsOf('examples/electron')).toEqual(['examples/electron/dist/']);
		expect(makeBuild(CONFIG).packageOutputs).toEqual([`${CONFIG.applicationRoot}/dist/`]);
	});

	it('leaves no tracked file of the tree rewritten behind it', () => {
		// ##THEIA-PACKAGE-SCRATCH: both halves write into the application's own
		// build directories, so this family has no packaging residue to put back.
		expect(makeBuild(CONFIG).packageScratch).toEqual([]);
	});

	it('rejects an empty packaging script rather than running npm run with no name', () => {
		expect(configSchema.safeParse({ ...CONFIG, packageScript: '' }).success).toBe(false);
		expect(configSchema.safeParse({ ...CONFIG, packageScript: 'package:linux' }).success).toBe(true);
		// The section stays closed: an unknown field is still a refusal.
		expect(configSchema.safeParse({ ...CONFIG, packageScripts: 'package:linux' }).success).toBe(false);
	});

	it('answers two watch channels as data, with the boundaries of the two compilers', () => {
		// ##THEIA-BUILD-CHANNELS
		const profile = watchProfileOf(CONFIG) as { channels: Record<string, { script: string; passEnd: string[]; errorCountLine: string[] }> };
		expect(Object.keys(profile.channels)).toEqual(['typecheck', 'bundle']);
		expect(profile.channels['typecheck']?.script).toBe('watch:compile');
		expect(profile.channels['bundle']?.script).toBe('watch:bundle');
		// The lines of upstream's own esbuild problem matcher.
		const end = new RegExp(profile.channels['bundle']?.passEnd[0] ?? '');
		expect(end.test('[watch/browser] Finished with 0 errors in 812ms.')).toBe(true);
		const count = new RegExp(profile.channels['bundle']?.errorCountLine[0] ?? '');
		expect('[watch/electron] Finished with 3 errors in 91ms.'.match(count)?.[1]).toBe('3');
		// The lines of the TypeScript watch, stamped and unstamped alike.
		const typecheckEnd = new RegExp(profile.channels['typecheck']?.passEnd[0] ?? '');
		expect(typecheckEnd.test('[10:11:12 AM] Found 0 errors. Watching for file changes.')).toBe(true);
		expect(typecheckEnd.test('Found 12 errors. Watching for file changes.')).toBe(true);
	});

	it('takes the names of the watch scripts from the patch set', () => {
		const profile = watchProfileOf({ ...CONFIG, watchScripts: { bundle: 'watch:acme:bundle' } }) as {
			channels: Record<string, { script: string }>;
		};
		expect(profile.channels['bundle']?.script).toBe('watch:acme:bundle');
	});
});

describe('advisory, standards and conventions', () => {
	it('reads the six files an upgrade of this family turns on', () => {
		// ##THEIA-ADVISORY-READERS
		const readers = makeAdvisory('examples/electron').readers;
		expect(readers.map((reader) => reader.id)).toEqual([
			'monorepo-version',
			'node-engine',
			'workspace-packages',
			'extension-entry-kinds',
			'application-schema',
			'application-electron'
		]);
		expect(readers.flatMap((reader) => reader.paths)).toContain('examples/electron/package.json');
	});

	it('reads the version of the monorepo out of lerna.json', () => {
		const reader = makeAdvisory('examples/electron').readers[0];
		const files = new Map([[LERNA_MANIFEST_PATH, JSON.stringify({ version: '1.75.0', npmClient: 'npm', packages: ['packages/*'] })]]);
		expect(reader?.read(files)).toEqual({ version: '1.75.0', npmClient: 'npm' });
		expect(reader?.meaning('1.74.0', '1.75.0')).toContain('version of the monorepo');
	});

	it('delivers the seam catalogue of this family', () => {
		expect(standards.packages).toEqual(['seams-theia']);
	});

	it('divides interventions by the processes an application has, not by a source tree', () => {
		// ##THEIA-SUBSYSTEMS
		expect(SUBSYSTEMS).toContain('frontend');
		expect(SUBSYSTEMS).toContain('electron');
		expect(SUBSYSTEMS).not.toContain('workbench');
	});
});
