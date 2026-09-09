/** @scope spec://codkit/modules/codkit/PROP-008#renames */
// unit: PROP-008 sec. 6 and PROP-013 ##UT-RENAMES.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import { detectRenames, parseRenameNameStatus, planPatchArtifactRename, type RenameGitRunner } from '../../src/lib/renames.ts';
import type { GitBytesResult, GitEnv, RunGitOptions } from '../../src/lib/gitx.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { CkError } from '../../src/lib/messages.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

function result(stdout: string | Uint8Array, status = 0, stderr = ''): GitBytesResult {
	return { status, stdout: typeof stdout === 'string' ? encodeUtf8(stdout) : stdout, stderr };
}

function sequence(outputs: readonly GitBytesResult[]): { readonly git: RenameGitRunner; readonly calls: readonly RunGitOptions[] } {
	const calls: RunGitOptions[] = [];
	let index = 0;
	return {
		git(options) {
			calls.push(options);
			const output = outputs[index];
			index += 1;
			if (output === undefined) {
				throw new Error(`unexpected git call ${JSON.stringify(options.args)}`);
			}
			return output;
		},
		calls
	};
}

function successfulDiff(stdout: string, stderr = ''): readonly GitBytesResult[] {
	return [result(`${OLD_SHA}\n`), result(`${NEW_SHA}\n`), result(stdout, 0, stderr)];
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function codeOf(run: () => unknown): string {
	try {
		run();
		throw new Error('expected a CkError');
	} catch (error) {
		expect(error).toBeInstanceOf(CkError);
		return (error as CkError).code;
	}
}

describe('rename detection', () => {
	afterAll(() => {
		cleanupTempRoots();
	});

	it('parses every R record from strict UTF-8 NUL bytes and skips other complete records', () => {
		const stdout = ['M', 'kept.ts', 'R100', 'old name.ts', 'new name.ts', 'A', 'added.ts', 'R096', 'старый.ts', 'новый.ts', ''].join('\0');

		expect(parseRenameNameStatus(encodeUtf8(stdout))).toEqual([
			{ from: 'old name.ts', to: 'new name.ts', similarity: 100, needsReview: false },
			{ from: 'старый.ts', to: 'новый.ts', similarity: 96, needsReview: true }
		]);
	});

	it.each([
		'M\0path.ts',
		'R101\0old.ts\0new.ts\0',
		'R99\0old.ts\0new.ts\0',
		'C101\0old.ts\0new.ts\0',
		'R100\0old.ts\0',
		'R100\0\0new.ts\0',
		'Q\0path.ts\0'
	])('rejects malformed name-status output: %j', (stdout) => {
		expect(() => parseRenameNameStatus(encodeUtf8(stdout))).toThrow(CkError);
	});

	it('rejects raw invalid UTF-8, C0/DEL, and a literal replacement character', () => {
		expect(codeOf(() => parseRenameNameStatus(new Uint8Array([0x52, 0x31, 0x30, 0x30, 0x00, 0xff, 0x00])))).toBe('ENCODING');
		for (const path of ['old\nname.ts', 'old\u007fname.ts', 'old\ufffdname.ts', 'CON', 'old:name.ts']) {
			expect(() => parseRenameNameStatus(encodeUtf8(`R100\0${path}\0new.ts\0`))).toThrow(CkError);
		}
	});

	it('preflights both refs as commits, diffs resolved SHAs with -l0, then filters exact old targets in memory', () => {
		const fake = sequence(successfulDiff('R100\0from.ts\0to.ts\0R096\0other.ts\0other-new.ts\0'));

		expect(
			detectRenames({ cwd: '/upstream', oldPin: 'old-tag', newPin: 'new-tag', threshold: 90, fromTargets: ['from.ts'] }, fake.git)
		).toEqual([{ from: 'from.ts', to: 'to.ts', similarity: 100, needsReview: false }]);
		expect(fake.calls).toEqual([
			{ cwd: '/upstream', args: ['rev-parse', '--verify', '--quiet', 'old-tag^{commit}'] },
			{ cwd: '/upstream', args: ['rev-parse', '--verify', '--quiet', 'new-tag^{commit}'] },
			{ cwd: '/upstream', args: ['diff', '--name-status', '-z', '-M90%', '-l0', OLD_SHA, NEW_SHA] }
		]);
	});

	it('rejects an exhaustive-detection-skipped warning instead of accepting a partial map', () => {
		const fake = sequence(successfulDiff('', 'warning: exhaustive rename detection was skipped due to too many files'));
		expect(() => detectRenames({ cwd: '/upstream', oldPin: 'old', newPin: 'new' }, fake.git)).toThrow(/incomplete rename detection/);
	});

	it.each([-1, 1.5, 101, Number.NaN])('rejects invalid threshold %j before running git', (threshold) => {
		const fake = sequence([]);
		expect(() => detectRenames({ cwd: '/upstream', oldPin: 'old', newPin: 'new', threshold }, fake.git)).toThrow(CkError);
		expect(fake.calls).toHaveLength(0);
	});

	it.each([
		{ oldPin: '', newPin: 'new' },
		{ oldPin: '-old', newPin: 'new' },
		{ oldPin: 'old pin', newPin: 'new' },
		{ oldPin: 'old', newPin: ' new' }
	])('rejects unsafe refs before running git: %j', ({ oldPin, newPin }) => {
		const fake = sequence([]);
		expect(() => detectRenames({ cwd: '/upstream', oldPin, newPin }, fake.git)).toThrow(CkError);
		expect(fake.calls).toHaveLength(0);
	});

	it('reports a ref that does not resolve to a commit as PIN-UNREACHABLE', () => {
		const fake = sequence([result('', 1, 'not a commit')]);
		expect(codeOf(() => detectRenames({ cwd: '/upstream', oldPin: 'blob', newPin: 'new' }, fake.git))).toBe('PIN-UNREACHABLE');
		expect(fake.calls).toHaveLength(1);
	});

	it('finds R100 and edited renames with renameLimit=1, supports annotated tags, and filters by old target only', () => {
		const cwd = makeTempRoot('renames-real-git');
		fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
		const exactFrom = 'src/exact old ü.ts';
		const exactTo = 'src/exact new λ.ts';
		const editedFrom = 'src/edited old.ts';
		const editedTo = 'src/edited new.ts';
		const otherFrom = 'src/other old.ts';
		const otherTo = 'src/other new.ts';
		write(cwd, exactFrom, 'an exact and distinctive rename\n');
		write(cwd, editedFrom, Array.from({ length: 80 }, (_, index) => `first distinctive line ${index}`).join('\n') + '\n');
		write(cwd, otherFrom, Array.from({ length: 80 }, (_, index) => `second distinctive line ${index}`).join('\n') + '\n');
		write(cwd, 'src/stable.ts', 'before\n');
		const oldPin = fixtureCommit(cwd, 'fixture: old rename pin', '2026-01-01T02:00:00Z');

		fixtureGit(cwd, ['mv', exactFrom, exactTo]);
		fixtureGit(cwd, ['mv', editedFrom, editedTo]);
		fixtureGit(cwd, ['mv', otherFrom, otherTo]);
		write(
			cwd,
			editedTo,
			Array.from({ length: 80 }, (_, index) => (index === 40 ? 'first changed' : `first distinctive line ${index}`)).join('\n') + '\n'
		);
		write(
			cwd,
			otherTo,
			Array.from({ length: 80 }, (_, index) => (index === 30 ? 'second changed' : `second distinctive line ${index}`)).join('\n') + '\n'
		);
		write(cwd, 'src/stable.ts', 'after\n');
		const newPin = fixtureCommit(cwd, 'fixture: new rename pin', '2026-01-01T02:01:00Z');
		fixtureGit(cwd, ['config', '--local', 'diff.renameLimit', '1']);
		const tagEnv: GitEnv = {
			GIT_COMMITTER_NAME: 'fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_DATE: '2026-01-01T02:02:00Z'
		};
		fixtureGit(cwd, ['tag', '-a', 'old-annotated', '-m', 'old annotated', oldPin], tagEnv);
		fixtureGit(cwd, ['tag', '-a', 'new-annotated', '-m', 'new annotated', newPin], tagEnv);
		const headBefore = runGit({ args: ['rev-parse', 'HEAD'], cwd }).stdout;
		const statusBefore = runGit({ args: ['status', '--porcelain'], cwd }).stdout;

		const renames = detectRenames({ cwd, oldPin: 'old-annotated', newPin: 'new-annotated', threshold: 50 });
		expect(renames).toHaveLength(3);
		expect(renames.find((rename) => rename.from === exactFrom)).toEqual({
			from: exactFrom,
			to: exactTo,
			similarity: 100,
			needsReview: false
		});
		for (const from of [editedFrom, otherFrom]) {
			const rename = renames.find((candidate) => candidate.from === from);
			expect(rename?.similarity).toBeGreaterThanOrEqual(50);
			expect(rename?.similarity).toBeLessThan(100);
			expect(rename?.needsReview).toBe(true);
		}
		expect(detectRenames({ cwd, oldPin, newPin, fromTargets: [editedFrom] })).toEqual([
			expect.objectContaining({ from: editedFrom, to: editedTo })
		]);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd }).stdout).toBe(headBefore);
		expect(runGit({ args: ['status', '--porcelain'], cwd }).stdout).toBe(statusBefore);

		const blob = fixtureGit(cwd, ['rev-parse', `${oldPin}:${editedFrom}`]).stdout.trim();
		const tree = fixtureGit(cwd, ['rev-parse', `${oldPin}^{tree}`]).stdout.trim();
		for (const ref of [blob, tree, `${oldPin}..${newPin}`]) {
			expect(codeOf(() => detectRenames({ cwd, oldPin: ref, newPin }))).toBe('PIN-UNREACHABLE');
		}
	});
});

describe('planPatchArtifactRename', () => {
	const rename = {
		from: 'source/platform/agent/remoteClient.ts',
		to: 'source/platform/agent/client.ts',
		similarity: 96,
		needsReview: true
	} as const;

	it('orders explicit exact replacements before the move and requires an absent destination', () => {
		const plan = planPatchArtifactRename({
			rename,
			referenceReplacements: [
				{
					area: 'contract-test',
					file: 'delta/own/test/agent.test.ts',
					from: 'source/platform/agent/remoteClient.ts',
					to: 'source/platform/agent/client.ts'
				},
				{
					area: 'own-import',
					file: 'delta/own/agent/client.ts',
					from: '../platform/agent/remoteClient.js',
					to: '../platform/agent/client.js'
				}
			]
		});

		expect(plan.preconditions).toEqual([{ kind: 'destination-absent', path: 'delta/patches/source__platform__agent__client.ts.ckpatch' }]);
		expect(plan.operations.map((operation) => operation.kind)).toEqual(['replace', 'replace', 'replace', 'replace', 'move']);
		expect(plan.operations[3]).toEqual({
			kind: 'replace',
			area: 'own-import',
			file: 'delta/own/agent/client.ts',
			from: '../platform/agent/remoteClient.js',
			to: '../platform/agent/client.js'
		});
		expect(plan.operations.at(-1)).toEqual({
			kind: 'move',
			from: 'delta/patches/source__platform__agent__remoteClient.ts.ckpatch',
			to: 'delta/patches/source__platform__agent__client.ts.ckpatch'
		});
		expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
	});

	it('does not let an extra runtime kind overwrite the replace discriminator', () => {
		const injected = {
			area: 'own-import',
			file: 'delta/own/agent/client.ts',
			from: '../remoteClient.js',
			to: '../client.js',
			kind: 'move'
		} as unknown as NonNullable<Parameters<typeof planPatchArtifactRename>[0]['referenceReplacements']>[number];
		const plan = planPatchArtifactRename({ rename, referenceReplacements: [injected] });
		expect(plan.operations[2]).toMatchObject({ kind: 'replace', area: 'own-import' });
	});

	it('rejects identical targets, duplicate replacements, collisions, controls, and destination use', () => {
		expect(() => planPatchArtifactRename({ rename: { ...rename, to: rename.from } })).toThrow(CkError);
		const reference = { area: 'own-import', file: 'delta/own/a.ts', from: '../old.js', to: '../new.js' } as const;
		expect(() => planPatchArtifactRename({ rename, referenceReplacements: [reference, reference] })).toThrow(/duplicate replacements/);
		expect(() =>
			planPatchArtifactRename({
				rename,
				referenceReplacements: [reference, { ...reference, to: '../different.js' }]
			})
		).toThrow(/colliding replacements/);
		expect(() =>
			planPatchArtifactRename({
				rename,
				referenceReplacements: [reference, { ...reference, from: '../new.js', to: '../newer.js' }]
			})
		).toThrow(/chained replacements collide/);
		expect(() => planPatchArtifactRename({ rename, referenceReplacements: [{ ...reference, from: '../old\n.js' }] })).toThrow(CkError);
		expect(() =>
			planPatchArtifactRename({
				rename,
				referenceReplacements: [{ ...reference, file: 'delta/patches/source__platform__agent__client.ts.ckpatch' }]
			})
		).toThrow(/destination-absent/);
	});
});
