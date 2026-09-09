// The plan of `codkit package`, its stamps and its output matcher (PROP-007
// ##CMD-PACKAGE, PROP-016 ##TYPE-AREA-BUILD).
//
// The plan is asserted as a list rather than inferred from a run, because the
// order is the contract: the guard before any write, the overlay before the
// build, the stamps before the commands that need them, and the restore last.
// The rollback itself is exercised over a real tree with a failing packager.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { packageStamps, packageStepPlan, runPackage } from '../../src/lib/packageEngine.ts';
import { packageOutputPaths, packageScratchPaths } from '../../src/lib/packagePaths.ts';
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
			'scratch restore',
			'restore'
		]);
	});

	it('drops the restore under --keep-overlay and the type build under --skip-type-build', () => {
		const kept = packageStepPlan(BOTH_HALVES, { keepOverlay: true, skipTypeBuild: false });
		expect(kept).not.toContain('restore');
		// The residue of the packager is nobody's overlay: the flag never keeps it.
		expect(kept).toContain('scratch restore');
		expect(packageStepPlan(BOTH_HALVES, { keepOverlay: false, skipTypeBuild: true })).toEqual([
			'drift guard',
			'overlay apply',
			'stamps',
			'package distributable',
			'outputs',
			'scratch restore',
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
			'scratch restore',
			'restore'
		]);
		// A type that names no scratch path has no such step at all.
		expect(
			packageStepPlan(stubType({ build: { ...BOTH_HALVES.build, packageScratch: [] } }), { keepOverlay: false, skipTypeBuild: false })
		).not.toContain('scratch restore');
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

		expect(packageStamps(type, config, treeDir, {})).toEqual([
			{ name: 'HEAD_OF_THE_TREE', value: head, fromEnvironment: false },
			{ name: 'QUALITY', value: '9.9.9', fromEnvironment: false },
			{ name: 'PIN_DATE', value: '2026-09-09', fromEnvironment: false }
		]);
	});

	it('keeps the value the operator exported, and fills an empty one from the type', () => {
		const treeDir = makeTempRoot('package-stamps-env');
		const config = { pin: { tag: '9.9.9', sha: 'x', date: '2026-09-09' } } as unknown as Parameters<typeof packageStamps>[1];
		const type = stubType({
			build: {
				...BOTH_HALVES.build,
				packageStamps: [
					{ name: 'QUALITY', source: 'pin-tag' },
					{ name: 'PIN_DATE', source: 'pin-date' }
				]
			}
		});

		expect(packageStamps(type, config, treeDir, { QUALITY: 'stable', PIN_DATE: '' })).toEqual([
			{ name: 'QUALITY', value: 'stable', fromEnvironment: true },
			{ name: 'PIN_DATE', value: '2026-09-09', fromEnvironment: false }
		]);
	});

	it('takes the value the type itself answers with for a literal stamp', () => {
		const treeDir = makeTempRoot('package-stamps-literal');
		const config = { pin: { tag: '9.9.9', sha: 'x', date: '2026-09-09' } } as unknown as Parameters<typeof packageStamps>[1];
		const type = stubType({ build: { ...BOTH_HALVES.build, packageStamps: [{ name: 'QUALITY', source: 'literal', value: 'insider' }] } });

		expect(packageStamps(type, config, treeDir, {})).toEqual([{ name: 'QUALITY', value: 'insider', fromEnvironment: false }]);
	});

	it('is empty for a family that stamps nothing', () => {
		const type = stubType({ build: { ...BOTH_HALVES.build, packageStamps: [] } });
		const config = { pin: { tag: '1.0.0', sha: 'x', date: '2026-01-01' } } as unknown as Parameters<typeof packageStamps>[1];

		expect(packageStamps(type, config, makeTempRoot('package-no-stamps'), {})).toEqual([]);
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

describe('the scratch paths the packager rewrites', () => {
	it('names only the declared paths the run actually changed', () => {
		const treeDir = makeTempRoot('package-scratch');
		writeGitFixture(treeDir, ['package.json', 'addons/one/package.json', 'addons/two/package.json', 'resources/icon.bin']);
		writeFileSync(join(treeDir, 'package.json'), '{"version":"1.0.0-package"}\n', 'utf8');
		writeFileSync(join(treeDir, 'addons', 'one', 'package.json'), '{"bumped":true}\n', 'utf8');
		writeFileSync(join(treeDir, 'resources', 'icon.bin'), 'changed', 'utf8');
		const warned: string[] = [];
		const found = (patterns: readonly string[]): readonly string[] => packageScratchPaths(treeDir, patterns, (text) => warned.push(text));

		// The wildcard matches the changed manifest and not the untouched one.
		expect(found(['addons/*/package.json'])).toEqual(['addons/one/package.json']);
		// A pattern nothing changed under yields nothing at all.
		expect(found(['addons/two/package.json'])).toEqual([]);
		// A wildcard never crosses a directory boundary.
		expect(found(['*/package.json'])).toEqual([]);
		expect(found(['package.json', 'resources/'])).toEqual(['package.json', 'resources/icon.bin']);
		expect(warned).toEqual([]);
	});

	it('skips a pattern that would leave the tree, and says so', () => {
		const treeDir = makeTempRoot('package-scratch-escape');
		writeGitFixture(treeDir, ['package.json']);
		writeFileSync(join(treeDir, 'package.json'), '{"version":"1.0.0-package"}\n', 'utf8');
		const warned: string[] = [];

		expect(packageScratchPaths(treeDir, ['../beside-the-tree/', 'package.json'], (text) => warned.push(text))).toEqual(['package.json']);
		expect(warned[0]).toContain('../beside-the-tree/');
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
			// The stamps come from the type and the pin, whatever this machine exports.
			env: {},
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

/** A git repository whose tip carries the named files, one line each. */
function writeGitFixture(treeDir: string, files: readonly string[]): void {
	runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: treeDir });
	for (const relative of files) {
		mkdirSync(dirname(join(treeDir, relative)), { recursive: true });
		writeFileSync(join(treeDir, relative), 'at the tip\n', 'utf8');
	}
	runGit({ args: ['add', '--all'], cwd: treeDir });
	runGit({
		args: ['commit', '--quiet', '-m', 'tip'],
		cwd: treeDir,
		env: {
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
		}
	});
}

function silentOutput(): Output {
	return new Output({
		command: 'package',
		version: '0.0.0',
		jsonMode: false,
		streams: { writeOut: () => undefined, writeErr: () => undefined }
	});
}
