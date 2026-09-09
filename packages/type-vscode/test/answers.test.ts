// The data answers of the type, each against the fact of modules/vscode it
// carries: the overlay targets and the dev channel, the build commands and the
// watch profile, the advisory readers, the conventions defaults and the runtime
// delivery.

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADVISORY_PATHS, advisory } from '../src/advisory.ts';
import { build, WATCH_PROFILE_PATH } from '../src/build.ts';
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

	it('names no package output, because its packager writes beside the managed tree', () => {
		// ##VSCODE-PACKAGE-OUTPUTS: the gulp task of this family writes a sibling
		// directory of the tree, and the contract keeps the patterns inside it.
		expect(build.packageOutputs).toEqual([]);
		expect(build.packageDistributable).toEqual([]);
		expect(build.packageBuild).toHaveLength(1);
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
