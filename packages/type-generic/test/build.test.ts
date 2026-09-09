// What the build skeleton runs over a plain git upstream (PROP-016
// ##TYPE-AREA-BUILD, ##TYPE-GENERIC).

import { describe, expect, it } from 'vitest';
import { makeBuild, projectTypeFor, watchProfileOf } from '../src/index.ts';

/** One declared watch channel, with the pass boundaries a patch set writes. */
function channel(script: string): { script: string; passStart: string[]; passEnd: string[]; errorLine: string[] } {
	return { script, passStart: ['^Starting$'], passEnd: ['^Done$'], errorLine: ['^(.+?):(\\d+): error (.+)$'] };
}

describe('the declared commands', () => {
	it('runs nothing a patch set did not declare', () => {
		const build = makeBuild({ ownRoot: 'own' });
		expect(build.install).toEqual([]);
		expect(build.hygiene).toEqual([]);
		expect(build.ownTests('own')).toBeNull();
		expect(build.packageBuild).toEqual([]);
		expect(build.packageStamps).toEqual([]);
		expect(build.foreignWatcherMarkers).toEqual([]);
		expect(build.watchProfilePath).toBeNull();
		expect(build.watchProfile).toBeUndefined();
	});

	it('still names the one dependency root npm writes into', () => {
		// Where an install lands is not a declaration of the patch set: npm writes
		// into `node_modules/` of the directory the build profile runs it in.
		expect(makeBuild({ ownRoot: 'own' }).dependencyRoots).toEqual(['node_modules']);
	});

	it('turns the declared install and lint commands into the steps of the skeleton', () => {
		const build = makeBuild({
			ownRoot: 'own',
			commands: { install: 'npm ci', lint: ['npm run lint', ['make', 'check']] }
		});
		expect(build.install).toEqual([{ label: 'install', command: 'npm', args: ['ci'] }]);
		expect(build.hygiene).toEqual([
			{ label: 'lint 1', command: 'npm', args: ['run', 'lint'] },
			{ label: 'lint 2', command: 'make', args: ['check'] }
		]);
	});

	it('restricts the own tests to the own root, behind the flag the runner takes', () => {
		const withFlag = makeBuild({ ownRoot: 'own', commands: { test: { command: 'npm test', ownGlobArg: '--glob' } } });
		expect(withFlag.ownTests('src/own')).toEqual({
			label: 'own tests',
			command: 'npm',
			args: ['test', '--glob', 'src/own/**/*.test.*']
		});

		const bare = makeBuild({ ownRoot: 'own', commands: { test: { command: ['node', '--test'] } } });
		expect(bare.ownTests('own')).toEqual({ label: 'own tests', command: 'node', args: ['--test', 'own/**/*.test.*'] });
		expect(bare.ownTests('')).toBeNull();
	});
});

describe('the watch profile a configured type answers', () => {
	it('is absent when no compile channel is declared', () => {
		expect(watchProfileOf([])).toBeUndefined();
		expect(watchProfileOf(undefined)).toBeUndefined();
	});

	it('is one channel per declared script, named after it unless the patch set named it', () => {
		const profile = watchProfileOf([channel('watch'), { ...channel('watch-css'), channel: 'css' }]) as {
			codkitBuildWatch: number;
			channels: Record<string, { script: string; passStart: string[]; passEnd: string[] }>;
		};
		expect(profile.codkitBuildWatch).toBe(1);
		expect(Object.keys(profile.channels)).toEqual(['watch', 'css']);
		expect(profile.channels['watch']?.script).toBe('watch');
		expect(profile.channels['watch']?.passStart).toEqual(['^Starting$']);
		expect(profile.channels['watch']?.passEnd).toEqual(['^Done$']);
		expect(profile.channels['css']?.script).toBe('watch-css');
	});

	it('travels on the type the section built', () => {
		expect(projectTypeFor({ ownRoot: 'own', commands: { compile: [channel('watch')] } }).build.watchProfile).toBeDefined();
		expect(projectTypeFor({ ownRoot: 'own' }).build.watchProfile).toBeUndefined();
	});
});
