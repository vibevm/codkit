// The plan of `codkit package`, its stamps and its output matcher (PROP-007
// ##CMD-PACKAGE, PROP-016 ##TYPE-AREA-BUILD).
//
// The plan is asserted as a list rather than inferred from a run, because the
// order is the contract: the guard before any write, the overlay before the
// build, the stamps before the commands that need them, and the restore last.
// The rollback itself is exercised over a real tree with a failing packager.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { packageOutputPaths, packageStamps, packageStepPlan, runPackage } from '../../src/lib/packageEngine.ts';
import type { PackageCommand } from '../../src/lib/packageEngine.ts';
import { stubType } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

const BOTH_HALVES = stubType({});

describe('the plan of one package run', () => {
	it('guards, materializes, stamps, builds and puts the tree back, in that order', () => {
		expect(packageStepPlan(BOTH_HALVES, { keepOverlay: false, skipTypeBuild: false })).toEqual([
			'drift guard',
			'overlay apply',
			'stamps',
			'package build',
			'package distributable',
			'outputs',
			'restore'
		]);
	});

	it('drops the restore under --keep-overlay and the type build under --skip-type-build', () => {
		expect(packageStepPlan(BOTH_HALVES, { keepOverlay: true, skipTypeBuild: false })).not.toContain('restore');
		expect(packageStepPlan(BOTH_HALVES, { keepOverlay: false, skipTypeBuild: true })).toEqual([
			'drift guard',
			'overlay apply',
			'stamps',
			'package distributable',
			'outputs',
			'restore'
		]);
	});

	it('leaves out a half the project type does not answer with', () => {
		const noDistributable = stubType({ build: { ...BOTH_HALVES.build, packageDistributable: [] } });
		const nothing = stubType({ build: { ...BOTH_HALVES.build, packageBuild: [], packageDistributable: [] } });

		expect(packageStepPlan(noDistributable, { keepOverlay: false, skipTypeBuild: false })).not.toContain('package distributable');
		expect(packageStepPlan(nothing, { keepOverlay: false, skipTypeBuild: false })).toEqual([
			'drift guard',
			'overlay apply',
			'stamps',
			'outputs',
			'restore'
		]);
	});
});

describe('the stamps of the run', () => {
	it('fills each name the type declares from the tree head and the pin', () => {
		const treeDir = makeTempRoot('package-stamps');
		runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: treeDir });
		writeFileSync(join(treeDir, 'a.txt'), 'a\n', 'utf8');
		runGit({ args: ['add', 'a.txt'], cwd: treeDir });
		runGit({
			args: ['commit', '--quiet', '-m', 'one'],
			cwd: treeDir,
			env: {
				GIT_AUTHOR_NAME: 'Fixture',
				GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
				GIT_COMMITTER_NAME: 'Fixture',
				GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
			}
		});
		const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: treeDir }).stdout.trim();
		const config = {
			pin: { tag: '9.9.9', sha: head, date: '2026-09-09' },
			typeConfig: { ownRoot: 'source/own' }
		} as unknown as Parameters<typeof packageStamps>[1];

		const type = stubType({
			build: {
				...BOTH_HALVES.build,
				packageStamps: [
					{ name: 'HEAD_OF_THE_TREE', source: 'tree-head' },
					{ name: 'QUALITY', source: 'pin-tag' },
					{ name: 'PIN_DATE', source: 'pin-date' }
				]
			}
		});

		expect(packageStamps(type, config, treeDir)).toEqual({ HEAD_OF_THE_TREE: head, QUALITY: '9.9.9', PIN_DATE: '2026-09-09' });
	});

	it('is empty for a family that stamps nothing', () => {
		const type = stubType({ build: { ...BOTH_HALVES.build, packageStamps: [] } });
		const config = { pin: { tag: '1.0.0', sha: 'x', date: '2026-01-01' } } as unknown as Parameters<typeof packageStamps>[1];

		expect(packageStamps(type, config, makeTempRoot('package-no-stamps'))).toEqual({});
	});
});

describe('the outputs the type names', () => {
	const treeDir = makeTempRoot('package-outputs');
	mkdirSync(join(treeDir, '.build', 'package'), { recursive: true });
	writeFileSync(join(treeDir, '.build', 'package', 'app.bin'), 'x', 'utf8');
	writeFileSync(join(treeDir, '.build', 'app-1.tar'), 'x', 'utf8');
	writeFileSync(join(treeDir, '.build', 'other.txt'), 'x', 'utf8');

	function warnings(patterns: readonly string[]): { readonly found: readonly string[]; readonly warned: string[] } {
		const warned: string[] = [];
		const found = packageOutputPaths(treeDir, patterns, (text) => warned.push(text));
		return { found, warned };
	}

	it('reports a directory pattern and a wildcard, and nothing that is not there', () => {
		expect(warnings(['.build/package/', '.build/app-*.tar', '.build/missing/']).found).toEqual(['.build/package/', '.build/app-1.tar']);
	});

	it('never lets a wildcard cross a directory boundary', () => {
		expect(warnings(['.build/*']).found).toEqual(['.build/app-1.tar', '.build/other.txt', '.build/package/']);
		expect(warnings(['*.tar']).found).toEqual([]);
	});

	it('skips a pattern that would leave the tree, and says so', () => {
		const outcome = warnings(['../beside-the-tree/', '.build/app-1.tar']);

		expect(outcome.found).toEqual(['.build/app-1.tar']);
		expect(outcome.warned[0]).toContain('../beside-the-tree/');
	});

	it('answers nothing for a type that names no output', () => {
		expect(warnings([]).found).toEqual([]);
	});
});

describe('a packager that fails', () => {
	it('leaves the overlay target back at the pin', () => {
		const fixture = makeSyncFixture('package-rollback');
		expect(fixture.sync().exitCode).toBe(0);
		const atPin = runGit({ args: ['show', `${fixture.config.pin.sha}:manifest.json`], cwd: fixture.treeDir }).stdout;
		const target = join(fixture.treeDir, 'manifest.json');
		expect(readFileSync(target, 'utf8')).toBe(atPin);

		const seen: PackageCommand[] = [];
		const result = runPackage({
			patchesDir: fixture.patchesDir,
			resolution: fixture.resolution,
			config: fixture.config,
			type: BOTH_HALVES,
			out: silentOutput(),
			flags: { keepOverlay: false, skipTypeBuild: false },
			timeoutMs: null,
			runCommand: (command) => {
				seen.push(command);
				// The target is materialized while the packager runs, and only then.
				expect(readFileSync(target, 'utf8')).not.toBe(atPin);
				return { status: 2, stdout: 'packaging log line\n', stderr: 'boom\n' };
			}
		});

		expect(result.exitCode).toBe(1);
		// The second half never started, and the first one was handed the stamps.
		expect(seen.map((command) => command.label)).toEqual(['package']);
		expect(seen[0]?.env['BUILD_QUALITY']).toBe(fixture.config.pin.tag);
		expect(result.materialized).toEqual(['manifest.json']);
		expect(result.restored).toEqual(['manifest.json']);
		expect(readFileSync(target, 'utf8')).toBe(atPin);
		expect(existsSync(join(fixture.treeDir, 'manifest.overrides.json'))).toBe(true);
	});
});

function silentOutput(): Output {
	return new Output({
		command: 'package',
		version: '0.0.0',
		jsonMode: false,
		streams: { writeOut: () => undefined, writeErr: () => undefined }
	});
}
