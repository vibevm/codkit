// The data answers of the type, each against the fact of modules/vscode it
// carries: the overlay targets and the dev channel, the build commands and the
// watch profile, the advisory readers, the conventions defaults and the runtime
// delivery.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADVISORY_PATHS, advisory } from '../src/advisory.ts';
import { build, makeBuild, packageStampsOf, WATCH_PROFILE_PATH, windowsSdkEnvironment } from '../src/build.ts';
import { conventions } from '../src/conventions.ts';
import { identity } from '../src/identity.ts';
import { layers, PRODUCT_JSON_TARGET, PRODUCT_OVERRIDES_FILE } from '../src/layers.ts';
import { runtime } from '../src/runtime.ts';
import { standards } from '../src/standards.ts';

describe('upstream identity', () => {
	it('accepts a release tag of this family and refuses a shape it never uses', () => {
		expect(identity.tagPattern.test('1.135.0')).toBe(true);
		expect(identity.tagPattern.test('v1.135.0')).toBe(false);
		expect(identity.tagPattern.test('1.135')).toBe(false);
	});

	it('fingerprints a healthy tree by the manifest, the product file and the source root', () => {
		expect(identity.fingerprints.map((print) => print.path)).toEqual(['package.json', 'product.json', 'src/vs']);
		expect(identity.fingerprints.every((print) => print.why.length > 0)).toBe(true);
	});
});

describe('the layers this family shapes', () => {
	it('makes the product manifest the only target with a dev channel', () => {
		const withChannel = layers.overlayTargets.filter((target) => target.devChannel !== null);
		expect(withChannel.map((target) => target.path)).toEqual([PRODUCT_JSON_TARGET]);
		expect(withChannel[0]?.devChannel).toBe(PRODUCT_OVERRIDES_FILE);
	});

	it('names the keys the packaging step stamps and the keys a non-manifest target admits', () => {
		const manifest = layers.overlayTargets.find((target) => target.path === PRODUCT_JSON_TARGET);
		expect(manifest?.stampedKeys).toEqual(['commit', 'date', 'checksums', 'version']);
		expect(manifest?.allowedKeys).toBeNull();
		const treeManifest = layers.overlayTargets.find((target) => target.path === 'package.json');
		expect(treeManifest?.allowedKeys).toEqual(['scripts']);
	});

	it('proves a service override by the registration call of this family', () => {
		expect(layers.serviceOverride?.registrationCall).toBe('registerSingleton');
		expect(layers.serviceOverride?.forbiddenReason.length).toBeGreaterThan(0);
	});

	it('materializes an own extension out of its own delta root', () => {
		expect(layers.ownExtensions?.deltaRoot).toBe('delta/own-extensions');
		expect(layers.ownExtensions?.manifestFile).toBe('package.json');
		expect(layers.ownExtensions?.namePattern.test('acme-pack')).toBe(true);
		expect(layers.ownExtensions?.namePattern.test('../escape')).toBe(false);
	});

	it('locates the entry modules a graft of the entry-module layer targets', () => {
		expect(layers.entryModule?.entries).toContain('src/vs/workbench/workbench.common.main.ts');
	});
});

describe('build and test', () => {
	it('runs the hygiene gate before the lint gate', () => {
		expect(build.hygiene.map((command) => command.args.join(' '))).toEqual(['run hygiene', 'run eslint']);
	});

	it('names both install roots of the distribution', () => {
		// ##VSCODE-DEPENDENCY-ROOTS: the tree installs twice, so a supply kit that
		// restored only the first root has not restored the dependencies.
		expect(build.dependencyRoots).toEqual(['node_modules', 'build/node_modules']);
	});

	it('runs the own tests over the leaf of the own root, in the layers node can load', () => {
		const command = build.ownTests('src/vs/patchset');
		expect(command?.args).toEqual(['run', 'test-node', '--', '--runGlob', 'vs/patchset/**/test/{common,node}/**/*.test.js']);
		expect(build.ownTests('')).toBeNull();
	});

	it('ships a pass-boundary profile that is a readable document with the four channels', () => {
		expect(existsSync(WATCH_PROFILE_PATH)).toBe(true);
		const profile = JSON.parse(readFileSync(WATCH_PROFILE_PATH, 'utf8')) as { channels: Record<string, { script: string }> };
		expect(Object.keys(profile.channels).sort()).toEqual(['copilot', 'extensions', 'transpile', 'typecheck']);
		expect(profile.channels['transpile']?.script).toBe('watch-client-transpile');
	});

	it('stamps the packaged build from the tree head and the pin', () => {
		expect(build.packageStamps).toEqual([
			{ name: 'BUILD_SOURCEVERSION', source: 'tree-head' },
			{ name: 'VSCODE_QUALITY', source: 'pin-tag' }
		]);
	});

	it('takes the quality channel from the patch set when it names one', () => {
		// ##VSCODE-QUALITY-IS-A-PRODUCT-ANSWER: the channel is a property of the
		// product, so a patch set that names it gets that word instead of a tag
		// of the upstream, which is a version string and no channel at all.
		expect(makeBuild({ ownRoot: 'src/vs/patchset', quality: 'stable' }).packageStamps).toEqual([
			{ name: 'BUILD_SOURCEVERSION', source: 'tree-head' },
			{ name: 'VSCODE_QUALITY', source: 'literal', value: 'stable' }
		]);
		expect(packageStampsOf('insider')).toContainEqual({ name: 'VSCODE_QUALITY', source: 'literal', value: 'insider' });
		// A patch set that names none reads exactly as it did before the field.
		expect(makeBuild({ ownRoot: 'src/vs/patchset' }).packageStamps).toEqual(build.packageStamps);
	});

	it('names the two channels a run that names none starts', () => {
		// ##VSCODE-BUILD-CHANNELS-DEFAULT: the profile declares four; the default
		// is the pair that compiles the product itself.
		expect(build.defaultChannels).toEqual(['transpile', 'typecheck']);
	});

	it('names the manifests its packager rewrites while it packages', () => {
		// ##VSCODE-PACKAGE-SCRATCH: the bundling of a built-in add-on edits the
		// add-on's own manifest in place, so a successful run leaves a tracked
		// file of the upstream changed until `codkit package` puts it back.
		expect(build.packageScratch).toEqual(['extensions/*/package.json']);
	});

	it('names no package output for a raw bundle, because its packager writes beside the managed tree', () => {
		// ##VSCODE-PACKAGE-OUTPUTS: the gulp task of this family writes a sibling
		// directory of the tree, and the contract keeps the patterns inside it;
		// only the installer targets, which write inside the tree, name outputs.
		expect(build.packageOutputs).toEqual([]);
		expect(build.packageDistributable).toEqual([]);
		expect(build.packageBuild).toHaveLength(1);
		expect(build.packageTargets?.map((target) => target.id)).toEqual([
			'windows-x64',
			'windows-arm64',
			'linux-x64',
			'linux-arm64',
			'linux-armhf',
			'macos-x64',
			'macos-arm64',
			'linux-x64-tar',
			'linux-x64-deb',
			'linux-x64-rpm'
		]);
		expect(build.packageTargets?.filter((target) => target.outputs !== undefined).map((target) => target.id)).toEqual([
			'linux-x64-tar',
			'linux-x64-deb',
			'linux-x64-rpm'
		]);
		expect(makeBuild({ ownRoot: 'src/vs/patchset', packageTargets: ['windows-x64'] }).defaultPackageTargets).toEqual(['windows-x64']);
	});

	it('discovers the newest Windows SDK signing tool before a Windows package spawn', () => {
		const root = mkdtempSync(join(tmpdir(), 'codkit-windows-sdk-'));
		const older = join(root, 'Windows Kits', '10', 'bin', '10.0.1', 'x64');
		const newer = join(root, 'Windows Kits', '10', 'bin', '10.0.2', 'x64');
		mkdirSync(older, { recursive: true });
		mkdirSync(newer, { recursive: true });
		writeFileSync(join(older, 'signtool.exe'), 'old');
		writeFileSync(join(newer, 'signtool.exe'), 'new');
		const prepared = windowsSdkEnvironment({ 'ProgramFiles(x86)': root, PATH: 'C:\\base' });
		expect(prepared['PATH']).toContain(newer);
	});

	it('knows the argv of a watcher somebody else started over the same tree', () => {
		expect(build.foreignWatcherMarkers).toEqual(['build/next/index.ts transpile --watch', 'gulp watch-']);
	});
});

describe('the upgrade advisory', () => {
	it('reads the toolchain files of the distribution, each named once', () => {
		expect(advisory.readers.map((reader) => reader.id)).toEqual([
			'node-version',
			'package-manifest',
			'package-lock',
			'npm-directories',
			'built-in-extensions',
			'electron-versions'
		]);
		expect(ADVISORY_PATHS).toEqual([
			'.nvmrc',
			'package.json',
			'package-lock.json',
			'build/npm/dirs.ts',
			'product.json',
			'build/lib/electron.ts'
		]);
	});
});

describe('conventions, standards and the runtime', () => {
	it('admits the top-level areas of the source tree as subsystems of an id', () => {
		expect(conventions.subsystems).toEqual(['workbench', 'editor', 'platform', 'extensions', 'build', 'product', 'base', 'server', 'test']);
	});

	it('protects the bootstrap services from a late re-registration', () => {
		expect(conventions.forbiddenServiceIds).toContain('IProductService');
		expect(new Set(conventions.forbiddenServiceIds).size).toBe(conventions.forbiddenServiceIds.length);
		expect([...conventions.forbiddenServiceIds].sort()).toEqual([...conventions.forbiddenServiceIds]);
	});

	it('delivers its own seam catalogue and its own runtime library', () => {
		expect(standards.packages).toEqual(['seams-vscode']);
		expect(runtime.packageId).toBe('runtime-vscode');
		expect(runtime.targetDirName).toBe('codkit');
		expect(runtime.nextSteps('src/vs/patchset').join('\n')).toContain('src/vs/patchset/codkit/~');
	});
});
