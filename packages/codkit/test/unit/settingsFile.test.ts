import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings, settingsFilePath } from '../../src/lib/settingsFile.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterEach(cleanupTempRoots);

describe('user settings', () => {
	it('uses exactly ~/.codkit/settings.json and tolerates an absent file', () => {
		const home = makeTempRoot('home');
		const path = settingsFilePath(home);
		expect(path).toBe(join(home, '.codkit', 'settings.json'));
		expect(loadSettings(path)).toEqual({ codkitSettings: 1 });
	});

	it('loads strict version-1 absolute root paths', () => {
		const home = makeTempRoot('home');
		const path = settingsFilePath(home);
		mkdirSync(dirname(path), { recursive: true });
		const fork = makeTempRoot('fork');
		const patches = makeTempRoot('patches');
		writeFileSync(path, `${JSON.stringify({ codkitSettings: 1, forkDir: fork, patchesDir: patches })}\n`);
		expect(loadSettings(path)).toEqual({ codkitSettings: 1, forkDir: fork, patchesDir: patches });
	});

	it('does not validate a known lower-priority field that is shadowed independently', () => {
		const home = makeTempRoot('home');
		const path = settingsFilePath(home);
		mkdirSync(dirname(path), { recursive: true });
		const fork = makeTempRoot('fork');
		writeFileSync(path, `${JSON.stringify({ codkitSettings: 1, forkDir: fork, patchesDir: 'shadowed-relative' })}\n`);
		expect(loadSettings(path, { forkDir: true, patchesDir: false })).toEqual({ codkitSettings: 1, forkDir: fork });
	});

	it.each([
		{ codkitSettings: 2 },
		{ codkitSettings: 1, forkDir: 'relative' },
		{ codkitSettings: 1, patchesDir: '' },
		{ codkitSettings: 1, extra: true }
	])('rejects invalid or legacy settings: %j', (body) => {
		const path = join(makeTempRoot('home'), 'settings.json');
		writeFileSync(path, JSON.stringify(body));
		expect(() => loadSettings(path)).toThrow();
	});
});
