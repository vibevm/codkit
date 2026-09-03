import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLocations } from '../../src/lib/paths.ts';
import type { CodkitSettings } from '../../src/lib/settingsFile.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const EMPTY: CodkitSettings = { codkitSettings: 1 };

afterEach(cleanupTempRoots);

describe('location source precedence', () => {
	it('resolves each root independently as flag > env > settings', () => {
		const cwd = makeTempRoot('cwd');
		const flagFork = makeTempRoot('flag-fork');
		const envFork = makeTempRoot('env-fork');
		const envPatches = makeTempRoot('env-patches');
		const settingsPatches = makeTempRoot('settings-patches');
		const locations = resolveLocations(
			{ forkDir: flagFork, patchesDir: null },
			{ CODKIT_FORK_DIR: envFork, CODKIT_PATCHES_DIR: envPatches },
			{ codkitSettings: 1, forkDir: envFork, patchesDir: settingsPatches },
			cwd
		);
		expect(locations.forkDir).toMatchObject({ path: flagFork, source: 'flag', exists: true });
		expect(locations.patchesDir).toMatchObject({ path: envPatches, source: 'env', exists: true });
	});

	it('uses settings when flags and environment are absent', () => {
		const fork = makeTempRoot('settings-fork');
		const patches = makeTempRoot('settings-patches');
		const locations = resolveLocations({ forkDir: null, patchesDir: null }, {}, { codkitSettings: 1, forkDir: fork, patchesDir: patches });
		expect(locations.forkDir?.source).toBe('settings');
		expect(locations.patchesDir?.source).toBe('settings');
	});

	it('has no project-local or sibling fallback', () => {
		expect(resolveLocations({ forkDir: null, patchesDir: null }, {}, EMPTY)).toEqual({ patchesDir: null, forkDir: null });
	});
});

describe('location path handling', () => {
	it('anchors relative CLI and environment paths at cwd', () => {
		const cwd = makeTempRoot('cwd');
		mkdirSync(join(cwd, 'fork'));
		mkdirSync(join(cwd, 'patches'));
		const locations = resolveLocations({ forkDir: 'fork', patchesDir: null }, { CODKIT_PATCHES_DIR: 'patches' }, EMPTY, cwd);
		expect(locations.forkDir?.path).toBe(join(cwd, 'fork'));
		expect(locations.patchesDir?.path).toBe(join(cwd, 'patches'));
	});

	it('realpaths existing symlinks and normalizes missing paths', () => {
		const cwd = makeTempRoot('cwd');
		const target = makeTempRoot('target');
		const link = join(cwd, 'fork-link');
		symlinkSync(target, link, 'dir');
		const locations = resolveLocations({ forkDir: link, patchesDir: join(cwd, 'a', '..', 'missing') }, {}, EMPTY, cwd);
		expect(locations.forkDir).toMatchObject({ path: target, exists: true });
		expect(locations.patchesDir).toMatchObject({ path: join(cwd, 'missing'), exists: false });
	});

	it('rejects an explicitly empty higher-priority source', () => {
		expect(() => resolveLocations({ forkDir: '', patchesDir: null }, { CODKIT_FORK_DIR: makeTempRoot('env') }, EMPTY)).toThrow(
			/fork directory from flag is empty/
		);
	});
});
