// The answers of the `vscode-extension` type, area by area, against the facts
// of the family (spec://codkit/modules/vscode-extension/PROP-002, PROP-003,
// PROP-004, PROP-005). Nothing here runs an editor: every assertion is about
// what the type says, over a synthetic extension `acme-sample` of the
// publisher `acme`.

import { isBrokenArtifact } from '@codkit/type-api';
import type { PreviewRequest } from '@codkit/type-api';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	cleanupWhitelistOf,
	configurationKeys,
	DEFAULT_CHANNELS,
	defaultChannelsOf,
	dependencyRootsOf,
	entryModulesOf,
	filesOf,
	fingerprintsOf,
	FORBIDDEN_PATCH_TARGETS,
	FOREIGN_WATCHER_MARKERS,
	hygieneOf,
	installOf,
	LOCKFILES,
	makeAdvisory,
	makeBuild,
	makeIdentity,
	makeLayers,
	makeLayout,
	makePreview,
	manifestPathOf,
	ownTestsOf,
	packageBuildOf,
	packageDistributableOf,
	packageOutputsOf,
	readersFor,
	ROOT_MANIFEST_PATH,
	runScript,
	standards,
	SUBSYSTEMS,
	watchProfileOf
} from '../src/index.ts';
import type { PackageManager, VsxTypeConfig } from '../src/index.ts';
import { FULL, MINIMAL, rootManifest, sampleManifest } from './support/config.ts';

const FULL_MANIFEST = manifestPathOf(FULL.extensionRoot);

/** The content problem of one fingerprint over the files handed to it, or null. */
function problemOf(config: VsxTypeConfig, path: string, files: Readonly<Record<string, string | null>>): string | null {
	const fingerprint = fingerprintsOf(config).find((candidate) => candidate.path === path);
	expect(fingerprint, path).toBeDefined();
	return fingerprint?.contentProblem?.(new Map(Object.entries(files))) ?? null;
}

describe('identity', () => {
	it('takes a release tag with or without the v and refuses a tag that moves', () => {
		// ##VSX-PIN-TAGS
		const pattern = makeIdentity(MINIMAL).tagPattern;
		expect(pattern.test('v1.2.3')).toBe(true);
		expect(pattern.test('1.2.3')).toBe(true);
		expect(pattern.test('latest')).toBe(false);
		expect(pattern.test('nightly')).toBe(false);
		expect(pattern.test('v1.2.3-rc.1')).toBe(false);
	});

	it('takes the release train a repository declares instead', () => {
		const identity = makeIdentity(FULL);
		expect(identity.tagPattern.test('release-1.2.3')).toBe(true);
		expect(identity.tagPattern.test('v1.2.3')).toBe(false);
		expect(identity.tagShape).toContain('typeConfig.tagPattern');
	});

	it('proves a repository that is one extension by its manifest alone', () => {
		// ##VSX-TREE-FINGERPRINT
		expect(fingerprintsOf(MINIMAL).map((print) => [print.path, print.kind])).toEqual([['package.json', 'file']]);
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest() })).toBeNull();
	});

	it('proves a monorepo by the extension manifest and the root manifest', () => {
		expect(fingerprintsOf(FULL).map((print) => print.path)).toEqual([FULL_MANIFEST, ROOT_MANIFEST_PATH]);
		const files = { [FULL_MANIFEST]: sampleManifest(), [ROOT_MANIFEST_PATH]: rootManifest() };
		expect(problemOf(FULL, FULL_MANIFEST, files)).toBeNull();
		expect(problemOf(FULL, ROOT_MANIFEST_PATH, files)).toBeNull();
	});

	it('accepts an extension that contributes without a main, and refuses a package that is none', () => {
		expect(
			problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ main: undefined, browser: './dist/web.js' }) })
		).toBeNull();
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ main: undefined, contributes: undefined }) })).toContain(
			'main, browser, contributes'
		);
	});

	it('refuses a manifest without engines.vscode, a name or a publisher', () => {
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ engines: { node: '>=20' } }) })).toContain(
			'engines.vscode'
		);
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ engines: undefined }) })).toContain('engines.vscode');
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ publisher: '' }) })).toContain('publisher');
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ name: undefined }) })).toContain('name');
	});

	it('refuses a manifest that is not an object, and a manifest that is not JSON as broken', () => {
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': '["acme-sample"]' })).toContain('JSON object');
		// ##VSX-TREE-FINGERPRINT: `CK-E-ARTIFACT-BROKEN` naming the file.
		let thrown: unknown = null;
		try {
			problemOf(MINIMAL, 'package.json', { 'package.json': '{ not json' });
		} catch (error) {
			thrown = error;
		}
		expect(isBrokenArtifact(thrown)).toBe(true);
		expect(thrown instanceof Error ? thrown.message : '').toContain('package.json');
	});

	it('refuses a root manifest that declares no workspaces', () => {
		const files = { [FULL_MANIFEST]: sampleManifest(), [ROOT_MANIFEST_PATH]: rootManifest({ workspaces: undefined }) };
		expect(problemOf(FULL, ROOT_MANIFEST_PATH, files)).toContain('workspaces');
	});

	it('refuses a root manifest whose packageManager disagrees with the declaration, and proves nothing without it', () => {
		// ##VSX-PACKAGE-MANAGER-FINGERPRINT
		const yarn = { [FULL_MANIFEST]: sampleManifest(), [ROOT_MANIFEST_PATH]: rootManifest({ packageManager: 'yarn@4.5.0' }) };
		const problem = problemOf(FULL, ROOT_MANIFEST_PATH, yarn);
		expect(problem).toContain('yarn');
		expect(problem).toContain('pnpm');
		const silent = { [FULL_MANIFEST]: sampleManifest(), [ROOT_MANIFEST_PATH]: rootManifest({ packageManager: undefined }) };
		expect(problemOf(FULL, ROOT_MANIFEST_PATH, silent)).toBeNull();
		// A repository that is one extension carries the field in the same file.
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ packageManager: 'bun@1.1.0' }) })).toContain('bun');
		expect(problemOf(MINIMAL, 'package.json', { 'package.json': sampleManifest({ packageManager: 'npm@10.8.0' }) })).toBeNull();
	});
});

describe('layout', () => {
	it('refuses an own root outside <extensionRoot>/src/ and takes one under it', () => {
		// ##VSX-OWN-ROOT
		const layout = makeLayout(FULL);
		expect(layout.ownRootProblem('packages/acme-sample/src/own')).toBeNull();
		expect(layout.ownRootProblem('packages/acme-sample/src/own/deeper')).toBeNull();
		expect(layout.ownRootProblem('packages/acme-sample/own')).toContain('packages/acme-sample/src/');
		expect(layout.ownRootProblem('packages/acme-sample/src')).toContain('packages/acme-sample/src/');
		expect(makeLayout(MINIMAL).ownRootProblem('src/acme')).toBeNull();
		expect(makeLayout(MINIMAL).ownRootProblem('lib/acme')).toContain('src/');
	});

	it('owns exactly one directory with no build outputs inside it, and no extension path', () => {
		// ##VSX-ONE-OWNED-DIRECTORY, ##VSX-NO-OWN-EXTENSION-PATH
		expect(makeLayout(FULL).ownRoots({ ownRoot: FULL.ownRoot })).toEqual([{ path: FULL.ownRoot, role: 'own', buildOutputs: [] }]);
		expect(makeLayout(FULL).ownExtensionPath('sample')).toBeNull();
	});

	it('keeps the outputs of the install, the build, the packager and the test host', () => {
		// ##VSX-CLEANUP-WHITELIST: anchored at the extension root, plus the patch set's own.
		expect(cleanupWhitelistOf(FULL)).toEqual([
			'node_modules/',
			'packages/acme-sample/dist/',
			'packages/acme-sample/out/',
			'packages/acme-sample/*.vsix',
			'.vscode-test/',
			'**/.turbo/',
			'.eslintcache',
			'*.tsbuildinfo',
			'packages/acme-sample/.cache/'
		]);
		// A repository that is one extension anchors them at the tree root.
		expect(cleanupWhitelistOf(MINIMAL)).toContain('/dist/');
		expect(cleanupWhitelistOf(MINIMAL)).toContain('/out/');
		expect(cleanupWhitelistOf(MINIMAL)).toContain('/*.vsix');
		expect(makeLayout(MINIMAL).cleanupWhitelist).toEqual(cleanupWhitelistOf(MINIMAL));
	});

	it('never patches a lockfile of any of the four managers', () => {
		// ##VSX-FORBIDDEN-TARGETS: the overlay targets are added by the engine.
		expect(FORBIDDEN_PATCH_TARGETS).toEqual(LOCKFILES);
		expect(LOCKFILES).toEqual(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
		expect(makeLayout(FULL).forbiddenPatchTargets).toEqual(LOCKFILES);
	});
});

describe('layers', () => {
	it('targets the extension manifest, open and without a dev channel, and the locale manifests the patch set names', () => {
		// ##VSX-MANIFEST-OVERLAY, ##VSX-LOCALE-MANIFEST-OVERLAYS, ##VSX-NO-DEV-CHANNEL
		const targets = makeLayers(FULL).overlayTargets;
		expect(targets.map((target) => target.path)).toEqual([
			'packages/acme-sample/package.json',
			'packages/acme-sample/package.nls.json',
			'packages/acme-sample/package.nls.ru.json'
		]);
		expect(targets.every((target) => target.devChannel === null && target.allowedKeys === null && target.stampedKeys.length === 0)).toBe(
			true
		);
		// Nothing is named from the tree: without a declaration there is the manifest alone.
		expect(makeLayers(MINIMAL).overlayTargets.map((target) => target.path)).toEqual(['package.json']);
	});

	it('names the activation modules as the entry modules, the family default when none is declared', () => {
		// ##VSX-ENTRY-MODULE
		expect(entryModulesOf(MINIMAL)).toEqual(['src/extension.ts']);
		expect(makeLayers(FULL).entryModule?.entries).toEqual([
			'packages/acme-sample/src/extension.ts',
			'packages/acme-sample/src/webview/main.ts'
		]);
		expect(makeLayers(FULL).entryModule?.why).toContain('activate');
	});

	it('has no own extensions and no service override', () => {
		// ##VSX-NO-OWN-EXTENSIONS, ##VSX-NO-SERVICE-OVERRIDE
		expect(makeLayers(FULL).ownExtensions).toBeNull();
		expect(makeLayers(FULL).serviceOverride).toBeNull();
	});
});

describe('build', () => {
	const MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

	it('installs with the frozen install of the declared manager', () => {
		// ##VSX-INSTALL
		expect(installOf('npm')).toEqual([{ label: 'install', command: 'npm', args: ['ci'] }]);
		expect(installOf('pnpm')[0]?.args).toEqual(['install', '--frozen-lockfile']);
		expect(installOf('yarn')[0]?.args).toEqual(['install', '--immutable']);
		expect(installOf('bun')[0]?.args).toEqual(['install', '--frozen-lockfile']);
		expect(makeBuild(MINIMAL).install[0]?.command).toBe('npm');
		expect(makeBuild(FULL).install[0]?.command).toBe('pnpm');
	});

	it('spells a script of the manifest for each manager, in a monorepo and in a repository that is one extension', () => {
		// ##VSX-RUN-SCRIPT
		const monorepo = Object.fromEntries(
			MANAGERS.map((manager) => [manager, runScript(manager, 'packages/acme-sample', 'compile', 'build')])
		);
		expect(monorepo['npm']).toEqual({ label: 'build', command: 'npm', args: ['run', 'compile', '--workspace', 'packages/acme-sample'] });
		expect(monorepo['pnpm']).toEqual({ label: 'build', command: 'pnpm', args: ['-C', 'packages/acme-sample', 'run', 'compile'] });
		expect(monorepo['yarn']).toEqual({ label: 'build', command: 'yarn', args: ['--cwd', 'packages/acme-sample', 'run', 'compile'] });
		expect(monorepo['bun']).toEqual({ label: 'build', command: 'bun', args: ['run', '--cwd', 'packages/acme-sample', 'compile'] });
		const single = Object.fromEntries(MANAGERS.map((manager) => [manager, runScript(manager, '.', 'compile', 'build')]));
		expect(single['npm']?.args).toEqual(['run', 'compile']);
		expect(single['pnpm']?.args).toEqual(['-C', '.', 'run', 'compile']);
		expect(single['yarn']?.args).toEqual(['--cwd', '.', 'run', 'compile']);
		expect(single['bun']?.args).toEqual(['run', '--cwd', '.', 'compile']);
	});

	it('names one dependency root, and the extension root as a second one in a monorepo', () => {
		// ##VSX-DEPENDENCY-ROOTS
		expect(dependencyRootsOf(MINIMAL)).toEqual(['node_modules']);
		expect(dependencyRootsOf(FULL)).toEqual(['node_modules', 'packages/acme-sample/node_modules']);
		expect(dependencyRootsOf({ ...MINIMAL, monorepo: true })).toEqual(['node_modules']);
	});

	it('lints with the declared scripts in order, the one script lint by default', () => {
		// ##VSX-LINT
		expect(hygieneOf(MINIMAL)).toEqual([{ label: 'lint', command: 'npm', args: ['run', 'lint'] }]);
		expect(hygieneOf(FULL).map((command) => command.args)).toEqual([
			['-C', 'packages/acme-sample', 'run', 'lint'],
			['-C', 'packages/acme-sample', 'run', 'lint:types']
		]);
		expect(hygieneOf({ ...MINIMAL, scripts: { lint: [] } })).toEqual([]);
	});

	it('runs the declared runner over the own root, and none when the patch set declared none', () => {
		// ##VSX-OWN-TESTS
		expect(ownTestsOf(MINIMAL, 'src/acme')).toBeNull();
		expect(makeBuild(MINIMAL).ownTests('src/acme')).toBeNull();
		expect(ownTestsOf(FULL, FULL.ownRoot)).toEqual({
			label: 'own tests',
			command: 'vitest',
			args: ['run', '--dir', 'packages/acme-sample/src/own/**/*.test.*']
		});
		const bare = ownTestsOf({ ...MINIMAL, scripts: { test: { command: ['node', '--test'] } } }, 'src/acme');
		expect(bare).toEqual({ label: 'own tests', command: 'node', args: ['--test', 'src/acme/**/*.test.*'] });
	});

	it('answers the two default channels as data, with the esbuild and TypeScript watch lines', () => {
		// ##VSX-BUILD-CHANNELS
		const profile = watchProfileOf(MINIMAL) as {
			codkitBuildWatch: number;
			channels: Record<string, { script: string; passStart: string[]; passEnd: string[]; errorLine: string[]; errorCountLine: string[] }>;
		};
		expect(profile.codkitBuildWatch).toBe(1);
		expect(Object.keys(profile.channels)).toEqual(['bundle', 'typecheck']);
		expect(profile.channels['bundle']?.script).toBe('watch:esbuild');
		expect(profile.channels['typecheck']?.script).toBe('watch:tsc');
		expect(new RegExp(profile.channels['bundle']?.passStart[0] ?? '').test('[watch] build started')).toBe(true);
		expect(new RegExp(profile.channels['bundle']?.passEnd[0] ?? '').test('[watch] build finished')).toBe(true);
		expect('3 errors'.match(new RegExp(profile.channels['bundle']?.errorCountLine[0] ?? ''))?.[1]).toBe('3');
		expect(new RegExp(profile.channels['bundle']?.errorLine[0] ?? '').test('✘ [ERROR] Could not resolve "vscode"')).toBe(true);
		const typecheckEnd = new RegExp(profile.channels['typecheck']?.passEnd[0] ?? '');
		expect(typecheckEnd.test('[10:11:12 AM] Found 0 errors. Watching for file changes.')).toBe(true);
		expect(typecheckEnd.test('Found 2 errors. Watching for file changes.')).toBe(true);
		expect(makeBuild(MINIMAL).defaultChannels).toEqual(DEFAULT_CHANNELS);
		expect(DEFAULT_CHANNELS).toEqual(['bundle', 'typecheck']);
		expect(makeBuild(MINIMAL).watchProfilePath).toBeNull();
	});

	it('replaces the channels whole with the declared ones, which become the default of a bare run', () => {
		const profile = watchProfileOf(FULL) as { channels: Record<string, { script: string; errorLine: string[]; errorCountLine: string[] }> };
		expect(Object.keys(profile.channels)).toEqual(['bundle']);
		expect(profile.channels['bundle']?.script).toBe('watch:bundle');
		expect(profile.channels['bundle']?.errorLine).toEqual([]);
		expect(profile.channels['bundle']?.errorCountLine).toEqual(['^(\\d+) errors?$']);
		expect(defaultChannelsOf(FULL)).toEqual(['bundle']);
		// A channel without a name is named after its script.
		const unnamed = {
			...MINIMAL,
			watch: { channels: [{ script: 'watch:web', passStart: ['^a$'], passEnd: ['^b$'], errorCountLine: ['^(\\d+)$'] }] }
		};
		expect(defaultChannelsOf(unnamed)).toEqual(['watch:web']);
	});

	it('refuses the two commands the default channels start as foreign watchers', () => {
		// ##VSX-FOREIGN-WATCHER-MARKERS
		expect(FOREIGN_WATCHER_MARKERS).toEqual(['esbuild --watch', 'tsc --watch']);
		expect(makeBuild(FULL).foreignWatcherMarkers).toEqual(FOREIGN_WATCHER_MARKERS);
	});

	it('builds with one command, the declared build script, compile by default', () => {
		// ##VSX-PACKAGE-BUILD
		expect(packageBuildOf(MINIMAL)).toEqual([{ label: 'build', command: 'npm', args: ['run', 'compile'] }]);
		expect(packageBuildOf(FULL)).toEqual([{ label: 'build', command: 'pnpm', args: ['-C', 'packages/acme-sample', 'run', 'build'] }]);
	});

	it('continues into the packaging script the product declares, and only then', () => {
		// ##VSX-PACKAGE-DISTRIBUTABLE, ##DECISION-VSX-PACKAGE-SCRIPT-IS-THE-PRODUCTS
		expect(packageDistributableOf(MINIMAL)).toEqual([]);
		expect(makeBuild(MINIMAL).packageDistributable).toEqual([]);
		expect(packageDistributableOf(FULL)).toEqual([
			{ label: 'package distributable', command: 'pnpm', args: ['-C', 'packages/acme-sample', 'run', 'vsix'] }
		]);
		expect(packageDistributableOf({ ...MINIMAL, scripts: { package: 'vsix' } })).toEqual([
			{ label: 'package distributable', command: 'npm', args: ['run', 'vsix'] }
		]);
	});

	it('names the vsix of the extension root as the output, or the patterns the patch set names', () => {
		// ##VSX-PACKAGE-OUTPUTS
		expect(packageOutputsOf(MINIMAL)).toEqual(['dist/*.vsix']);
		expect(packageOutputsOf({ ...MINIMAL, extensionRoot: 'ext', ownRoot: 'ext/src/own' })).toEqual(['ext/dist/*.vsix']);
		expect(packageOutputsOf(FULL)).toEqual(['packages/acme-sample/build/*.vsix']);
	});

	it('stamps nothing by default and the declared literals otherwise, and names the declared scratch', () => {
		// ##VSX-STAMPS, ##VSX-PACKAGE-SCRATCH
		expect(makeBuild(MINIMAL).packageStamps).toEqual([]);
		expect(makeBuild(MINIMAL).packageScratch).toEqual([]);
		expect(makeBuild(FULL).packageStamps).toEqual([{ name: 'ACME_CHANNEL', source: 'literal', value: 'stable' }]);
		expect(makeBuild(FULL).packageScratch).toEqual(['packages/acme-sample/package.json']);
	});
});

describe('preview', () => {
	const stateDir = join('C:', 'patches', '.codkit', 'preview', 'development');
	const treeDir = join('C:', 'trees', 'acme');
	const request = (overrides: Partial<PreviewRequest> = {}): PreviewRequest => ({
		treeDir,
		mode: 'development',
		host: join('C:', 'editors', 'code'),
		stateDir,
		workspaceDir: null,
		artifact: null,
		...overrides
	});

	it('lists two modes, development first and by default, and the executable code as the host', () => {
		// ##VSX-PREVIEW-MODES, ##VSX-PREVIEW-HOST
		const preview = makePreview(MINIMAL);
		expect(preview.modes).toEqual(['development', 'artifact']);
		expect(preview.defaultMode).toBe('development');
		expect(preview.defaultHost).toBe('code');
	});

	it('runs the development host over the built extension root, isolated under the state directory', () => {
		// ##VSX-PREVIEW-DEVELOPMENT, ##VSX-PREVIEW-ISOLATION
		const recipe = makePreview(FULL).recipe(request({ workspaceDir: join('C:', 'work', 'sample') }));
		expect(recipe.needsArtifact).toBe(false);
		expect(recipe.prepare).toEqual(packageBuildOf(FULL));
		expect(recipe.launch.command).toBe(join('C:', 'editors', 'code'));
		expect(recipe.launch.args).toEqual([
			`--extensionDevelopmentPath=${join(treeDir, 'packages', 'acme-sample')}`,
			'--user-data-dir',
			join(stateDir, 'user-data'),
			'--extensions-dir',
			join(stateDir, 'extensions'),
			'--new-window',
			join('C:', 'work', 'sample')
		]);
		expect(recipe.isolation).toEqual({ userDataDir: join(stateDir, 'user-data'), extensionsDir: join(stateDir, 'extensions') });
		for (const directory of [recipe.isolation.userDataDir, recipe.isolation.extensionsDir]) {
			expect(recipe.launch.args).toContain(directory);
			expect(directory.startsWith(`${stateDir}${sep}`)).toBe(true);
		}
		// A repository that is one extension is developed from the tree root itself.
		expect(makePreview(MINIMAL).recipe(request()).launch.args[0]).toBe(`--extensionDevelopmentPath=${treeDir}`);
	});

	it('installs the artifact into the isolated profile and opens the host on it', () => {
		// ##VSX-PREVIEW-ARTIFACT
		const artifact = join(treeDir, 'packages', 'acme-sample', 'build', 'acme-sample-1.2.3.vsix');
		const recipe = makePreview(FULL).recipe(request({ mode: 'artifact', artifact, workspaceDir: null }));
		expect(recipe.needsArtifact).toBe(true);
		expect(recipe.prepare).toEqual([
			{
				label: 'install extension',
				command: join('C:', 'editors', 'code'),
				args: [
					'--install-extension',
					artifact,
					'--extensions-dir',
					join(stateDir, 'extensions'),
					'--user-data-dir',
					join(stateDir, 'user-data'),
					'--force'
				]
			}
		]);
		expect(recipe.launch.args).toEqual([
			'--user-data-dir',
			join(stateDir, 'user-data'),
			'--extensions-dir',
			join(stateDir, 'extensions'),
			'--new-window',
			// The configured default workspace, tree-relative, when the run names none.
			join(treeDir, 'samples', 'workspace')
		]);
		for (const command of [recipe.prepare[0], recipe.launch]) {
			expect(command?.args).toContain(recipe.isolation.userDataDir);
			expect(command?.args).toContain(recipe.isolation.extensionsDir);
		}
		// Before the engine hands the artifact over, the recipe prepares nothing and still asks for it.
		const asked = makePreview(MINIMAL).recipe(request({ mode: 'artifact' }));
		expect(asked.needsArtifact).toBe(true);
		expect(asked.prepare).toEqual([]);
		expect(makePreview(MINIMAL).recipe(request({ mode: 'artifact' })).launch.args).not.toContain(join(treeDir, 'samples', 'workspace'));
	});
});

describe('advisory', () => {
	const files = (manifest: string, root: string | null = rootManifest()) =>
		filesOf({ [FULL_MANIFEST]: manifest, [ROOT_MANIFEST_PATH]: root });

	it('reads the six values an upgrade of this family turns on, over the extension manifest', () => {
		// ##VSX-ADVISORY-READERS
		const readers = readersFor(FULL);
		expect(readers.map((reader) => reader.id)).toEqual([
			'engines-vscode',
			'manifest-version',
			'configuration-keys',
			'activation-events',
			'package-manager',
			'locale-manifests'
		]);
		expect(readers.slice(0, 4).every((reader) => reader.paths.length === 1 && reader.paths[0] === FULL_MANIFEST)).toBe(true);
		expect(readers.find((reader) => reader.id === 'package-manager')?.paths).toEqual([ROOT_MANIFEST_PATH]);
		expect(readers.find((reader) => reader.id === 'locale-manifests')?.paths).toEqual([
			'packages/acme-sample/package.nls.json',
			'packages/acme-sample/package.nls.ru.json'
		]);
		// A repository that is one extension has no root manifest of its own to read the manager from.
		expect(readersFor(MINIMAL).map((reader) => reader.id)).not.toContain('package-manager');
		expect(makeAdvisory(MINIMAL).readers.length).toBe(5);
	});

	it('reads the values of the manifest and says what each change means', () => {
		// ##VSX-ADVISORY-MEANINGS
		const byId = new Map(readersFor(FULL).map((reader) => [reader.id, reader]));
		const current = files(sampleManifest());
		expect(byId.get('engines-vscode')?.read(current)).toBe('^1.90.0');
		expect(byId.get('engines-vscode')?.changeIsNews).toBe(true);
		expect(byId.get('engines-vscode')?.meaning('^1.85.0', '^1.90.0')).toContain('preview host');
		expect(byId.get('manifest-version')?.read(current)).toBe('1.2.3');
		expect(byId.get('manifest-version')?.meaning('1.2.2', '1.2.3')).toContain('version policy');
		expect(byId.get('configuration-keys')?.read(current)).toEqual(['acmeSample.enabled', 'acmeSample.greeting']);
		expect(byId.get('activation-events')?.read(current)).toEqual(['onStartupFinished']);
		expect(byId.get('activation-events')?.meaning(['onStartupFinished'], ['*'])).toContain('entry module');
		expect(byId.get('package-manager')?.read(current)).toBe('pnpm@9.12.0');
		expect(byId.get('package-manager')?.meaning('pnpm@9.12.0', 'bun@1.1.0')).toContain('spelling');
		expect(byId.get('locale-manifests')?.meaning([], ['packages/acme-sample/package.nls.json'])).toContain('overlay target');
	});

	it('reports a renamed or removed configuration key and stays silent over an added one', () => {
		const reader = readersFor(FULL).find((candidate) => candidate.id === 'configuration-keys');
		expect(reader?.meaning(['a.one'], ['a.one', 'a.two'])).toBeNull();
		expect(reader?.meaning(['a.one', 'a.two'], ['a.one'])).toContain('renamed or removed');
		// Several sections are read as one set of keys.
		const sections = sampleManifest({
			contributes: { configuration: [{ properties: { 'b.two': {} } }, { properties: { 'a.one': {} } }] }
		});
		expect(configurationKeys(JSON.parse(sections) as { readonly [key: string]: unknown })).toEqual(['a.one', 'b.two']);
	});

	it('reads the locale manifests the patch set names for presence', () => {
		const reader = readersFor(FULL).find((candidate) => candidate.id === 'locale-manifests');
		const both = filesOf({ 'packages/acme-sample/package.nls.json': '{}', 'packages/acme-sample/package.nls.ru.json': '{}' });
		expect(reader?.read(both)).toEqual(['packages/acme-sample/package.nls.json', 'packages/acme-sample/package.nls.ru.json']);
		const one = filesOf({ 'packages/acme-sample/package.nls.json': '{}', 'packages/acme-sample/package.nls.ru.json': null });
		expect(reader?.read(one)).toEqual(['packages/acme-sample/package.nls.json']);
	});

	it('never throws on an absent file and refuses an unreadable one as broken', () => {
		const byId = new Map(readersFor(FULL).map((reader) => [reader.id, reader]));
		const absent = filesOf({ [FULL_MANIFEST]: null, [ROOT_MANIFEST_PATH]: null });
		expect(byId.get('engines-vscode')?.read(absent)).toBeNull();
		expect(byId.get('configuration-keys')?.read(absent)).toBeNull();
		expect(byId.get('package-manager')?.read(absent)).toBeNull();
		let thrown: unknown = null;
		try {
			byId.get('manifest-version')?.read(files('{ broken'));
		} catch (error) {
			thrown = error;
		}
		expect(isBrokenArtifact(thrown)).toBe(true);
	});
});

describe('standards and conventions', () => {
	it('delivers no package of its own in the first version', () => {
		// ##VSX-STANDARDS-PACKAGES
		expect(standards.packages).toEqual([]);
	});

	it('divides interventions by the surfaces of an extension and forbids no service id', () => {
		// ##VSX-CONVENTIONS
		expect(SUBSYSTEMS).toEqual(['extension', 'webview', 'i18n', 'assets', 'build', 'config', 'docs', 'test']);
	});
});
