/** @scope spec://codkit/modules/codkit/PROP-008#classify */
// Unit coverage for the caller-supplied, repository-immutable replay seam.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeUtf8Strict, encodeUtf8 } from '../../src/lib/bytes.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { formatPatchHeader, parseCkpatch } from '../../src/lib/patchFormat.ts';
import type { ParsedPatch } from '../../src/lib/patchFormat.ts';
import { replayPatch } from '../../src/lib/replayPatch.ts';
import type { ReplayPatchOptions } from '../../src/lib/replayPatch.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const TARGET = 'src/vs/replay.ts';
const BASE = 'a\nbase\nz\n';
const THEIRS = 'a\ncodkit\nz\n';

function patchOf(target = TARGET, expected = 'base', replacement = 'codkit'): ParsedPatch {
	const header = formatPatchHeader({
		id: 'CK-workbench-701',
		type: 'hook',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'exercise the shared patch replay primitive',
		link: 'none',
		cause: 'none',
		pin: `t1@${'1'.repeat(40)}`,
		contractTests: []
	});
	const body = [`--- a/${target}`, `+++ b/${target}`, '@@ -1,3 +1,3 @@', ' a', `-${expected}`, `+${replacement}`, ' z'];
	return parseCkpatch(encodeUtf8(`${header}${body.join('\n')}\n`), conventions(), 'delta/patches/replay.ckpatch');
}

function addPatch(target = TARGET): ParsedPatch {
	const header = formatPatchHeader({
		id: 'CK-workbench-702',
		type: 'hook',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'exercise add-file replay',
		link: 'none',
		cause: 'none',
		pin: `t1@${'2'.repeat(40)}`,
		contractTests: []
	});
	const body = ['--- /dev/null', `+++ b/${target}`, '@@ -0,0 +1,2 @@', '+created', '+by-codkit'];
	return parseCkpatch(encodeUtf8(`${header}${body.join('\n')}\n`), conventions(), 'delta/patches/add.ckpatch');
}

function options(overrides: Partial<ReplayPatchOptions> = {}): ReplayPatchOptions {
	return {
		treeDir: makeTempRoot('replay-patch'),
		targetPath: TARGET,
		base: encodeUtf8(BASE),
		baseExists: true,
		ours: encodeUtf8(BASE),
		oursExists: true,
		patch: patchOf(),
		...overrides
	};
}

function text(bytes: Uint8Array | null): string | null {
	if (bytes === null) return null;
	const value = decodeUtf8Strict(bytes);
	if (value === null) throw new Error('replay returned non-UTF-8 bytes');
	return value;
}

function caught(run: () => unknown): { readonly code: string; readonly message: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error('expected replay to fail');
}

afterAll(() => {
	cleanupTempRoots();
});

describe('replayPatch', () => {
	it('returns exact patched bytes and materials for a clean replay', () => {
		const base = encodeUtf8(BASE);
		const result = replayPatch(options({ base, ours: base }));

		expect(result.outcome).toBe('clean');
		expect(text(result.bytes)).toBe(THEIRS);
		expect(result.materials).toEqual({
			base,
			baseExists: true,
			ours: base,
			oursExists: true,
			theirs: encodeUtf8(THEIRS)
		});
	});

	it('classifies an exact replay after a non-overlapping edit as shifted', () => {
		const result = replayPatch(options({ ours: encodeUtf8(`${BASE}upstream-tail\n`) }));

		expect(result.outcome).toBe('shifted');
		expect(text(result.bytes)).toBe(`${THEIRS}upstream-tail\n`);
	});

	it('classifies a clean diff3 result that cannot apply exactly as merged', () => {
		const result = replayPatch(options({ ours: encodeUtf8(`prefix\n${BASE}`) }));

		expect(result.outcome).toBe('merged');
		expect(text(result.bytes)).toBe(`prefix\n${THEIRS}`);
	});

	it('returns exact diff3 conflict-marker bytes', () => {
		const result = replayPatch(options({ ours: encodeUtf8('a\nupstream\nz\n') }));
		const output = text(result.bytes);

		expect(result.outcome).toBe('conflict');
		expect(output).toContain('<<<<<<< ours\n');
		expect(output).toContain('||||||| base\n');
		expect(output).toContain('=======\n');
		expect(output).toContain('>>>>>>> theirs\n');
		expect(output).toContain('upstream');
		expect(output).toContain('codkit');
	});

	it('replays an add-file against absence and distinguishes an existing empty target', () => {
		const patch = addPatch();
		const absent = replayPatch(options({ base: new Uint8Array(0), baseExists: false, ours: new Uint8Array(0), oursExists: false, patch }));
		const existingEmpty = replayPatch(
			options({
				base: new Uint8Array(0),
				baseExists: false,
				ours: new Uint8Array(0),
				oursExists: true,
				patch,
				mergeFile: ({ theirs }) => ({ bytes: theirs, hasConflicts: false })
			})
		);

		expect(absent.outcome).toBe('clean');
		expect(text(absent.bytes)).toBe('created\nby-codkit\n');
		expect(absent.materials).toMatchObject({ baseExists: false, oursExists: false });
		expect(existingEmpty.outcome).toBe('merged');
		expect(text(existingEmpty.bytes)).toBe('created\nby-codkit\n');
	});

	it('returns target-deleted with complete materials and never invokes merge-file', () => {
		const result = replayPatch(
			options({
				ours: new Uint8Array(0),
				oursExists: false,
				mergeFile: () => {
					throw new Error('merge-file must not run for a deleted target');
				}
			})
		);

		expect(result.outcome).toBe('target-deleted');
		expect(result.bytes).toBeNull();
		expect(result.materials.ours).toEqual(new Uint8Array(0));
		expect(result.materials.oursExists).toBe(false);
		expect(text(result.materials.theirs)).toBe(THEIRS);
	});

	it('preserves the byte contract by failing loudly for binary input', () => {
		let mergeCalled = false;
		const baseFailure = caught(() => replayPatch(options({ base: new Uint8Array([0x00]), ours: new Uint8Array([0x00]) })));
		const oursFailure = caught(() =>
			replayPatch(
				options({
					ours: new Uint8Array([0xff]),
					mergeFile: () => {
						mergeCalled = true;
						return { bytes: new Uint8Array(0), hasConflicts: false };
					}
				})
			)
		);

		expect(baseFailure.code).toBe('ENCODING');
		expect(oursFailure.code).toBe('ENCODING');
		expect(mergeCalled).toBe(false);
	});

	it('propagates merge runner failures without returning a plausible outcome', () => {
		expect(() =>
			replayPatch(
				options({
					ours: encodeUtf8(`prefix\n${BASE}`),
					mergeFile: () => {
						throw new Error('merge runner exploded');
					}
				})
			)
		).toThrow('merge runner exploded');
	});

	it('fails loudly for malformed existence and patch-application inputs', () => {
		const malformed = caught(() => replayPatch(options({ base: new Uint8Array(0), baseExists: false })));
		let mergeCalled = false;
		const applyFailure = caught(() =>
			replayPatch(
				options({
					patch: patchOf(TARGET, 'not-base'),
					mergeFile: () => {
						mergeCalled = true;
						return { bytes: new Uint8Array(0), hasConflicts: false };
					}
				})
			)
		);

		expect(malformed.code).toBe('ARTIFACT-BROKEN');
		expect(applyFailure.code).toBe('ARTIFACT-BROKEN');
		expect(mergeCalled).toBe(false);
	});

	it('leaves refs, index, and work-tree state byte-for-byte unchanged', () => {
		const repository = makeTempRoot('replay-repository-state');
		fixtureGit(repository, ['init', '--quiet', '--initial-branch=main', '.']);
		writeFileSync(join(repository, 'tracked.txt'), 'committed\n');
		fixtureCommit(repository, 'fixture: replay state baseline', '2026-01-01T01:00:00Z');
		writeFileSync(join(repository, 'tracked.txt'), 'dirty\n');
		writeFileSync(join(repository, 'staged.txt'), 'staged\n');
		fixtureGit(repository, ['add', '--', 'staged.txt']);
		writeFileSync(join(repository, 'untracked.txt'), 'untracked\n');

		const headBefore = runGit({ args: ['rev-parse', 'HEAD'], cwd: repository }).stdout;
		const statusBefore = runGit({ args: ['status', '--porcelain=v1'], cwd: repository }).stdout;
		const indexBefore = readFileSync(join(repository, '.git', 'index'));
		const trackedBefore = readFileSync(join(repository, 'tracked.txt'));
		const stagedBefore = readFileSync(join(repository, 'staged.txt'));
		const untrackedBefore = readFileSync(join(repository, 'untracked.txt'));

		const result = replayPatch(options({ treeDir: repository, ours: encodeUtf8('a\nupstream\nz\n') }));

		expect(result.outcome).toBe('conflict');
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: repository }).stdout).toBe(headBefore);
		expect(runGit({ args: ['status', '--porcelain=v1'], cwd: repository }).stdout).toBe(statusBefore);
		expect(readFileSync(join(repository, '.git', 'index'))).toEqual(indexBefore);
		expect(readFileSync(join(repository, 'tracked.txt'))).toEqual(trackedBefore);
		expect(readFileSync(join(repository, 'staged.txt'))).toEqual(stagedBefore);
		expect(readFileSync(join(repository, 'untracked.txt'))).toEqual(untrackedBefore);
	});
});
