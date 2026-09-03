/** @scope spec://codkit/modules/codkit/PROP-008#cause */

import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findCause } from '../../src/lib/cause.ts';
import type { CauseGitRunner } from '../../src/lib/cause.ts';
import type { GitResult, RunGitOptions } from '../../src/lib/gitx.ts';
import { CkError } from '../../src/lib/messages.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const OLD_PIN = '1'.repeat(40);
const NEW_PIN = '2'.repeat(40);
const NEWEST = 'a'.repeat(40);
const MIDDLE = 'b'.repeat(40);
const EARLIEST = 'c'.repeat(40);
const DELETE = 'd'.repeat(40);
const RENAME = 'e'.repeat(40);
const TARGET = 'src/vs/workbench/example.ts';
const TARGET_PATHSPEC = `:(top,literal)${TARGET}`;

const OPTIONS = {
	cwd: '/upstream',
	oldPin: OLD_PIN,
	newPin: NEW_PIN,
	target: TARGET,
	ranges: [
		{ start: 12, end: 14 },
		{ start: 40, end: 40 }
	]
} as const;

function result(stdout: string, status = 0, stderr = ''): GitResult {
	return { status, stdout, stderr };
}

function sequence(outputs: readonly GitResult[]): { readonly git: CauseGitRunner; readonly calls: readonly RunGitOptions[] } {
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

describe('findCause', () => {
	afterAll(() => {
		cleanupTempRoots();
	});

	it('returns the only file commit as an exact cause without line tracing', () => {
		const fake = sequence([result(`${MIDDLE}\n`)]);

		expect(findCause(OPTIONS, fake.git)).toEqual({ sha: MIDDLE, approx: false });
		expect(fake.calls.map((call) => call.args)).toEqual([
			['log', '--format=%H', '--follow', `${OLD_PIN}..${NEW_PIN}`, '--', TARGET_PATHSPEC]
		]);
	});

	it('anchors cumulative diffs at oldPin and selects the earliest matching commit', () => {
		const fake = sequence([result(`${NEWEST}\n${MIDDLE}\n${EARLIEST}\n`), result('@@ -13,0 +14 @@\n+inserted\n')]);

		expect(findCause(OPTIONS, fake.git)).toEqual({ sha: EARLIEST, approx: false });
		expect(fake.calls.map((call) => call.args)).toEqual([
			['log', '--format=%H', '--follow', `${OLD_PIN}..${NEW_PIN}`, '--', TARGET_PATHSPEC],
			[
				'diff',
				'--unified=0',
				'--inter-hunk-context=0',
				'--diff-algorithm=myers',
				'--no-indent-heuristic',
				'--no-renames',
				'--no-color',
				'--text',
				OLD_PIN,
				EARLIEST,
				'--',
				TARGET_PATHSPEC
			]
		]);
	});

	it('runs the file and line history against a real isolated git repository', () => {
		const cwd = makeTempRoot('cause-real-git');
		fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
		writeFileSync(join(cwd, 'target.ts'), 'one\ntwo\nthree\n');
		const oldPin = fixtureCommit(cwd, 'fixture: old cause pin', '2026-01-01T01:00:00Z');
		writeFileSync(join(cwd, 'target.ts'), 'one\nTWO\nthree\n');
		const lineCause = fixtureCommit(cwd, 'fixture: change affected line', '2026-01-01T01:01:00Z');
		writeFileSync(join(cwd, 'target.ts'), 'ONE\nTWO\nthree\n');
		const newPin = fixtureCommit(cwd, 'fixture: change other line', '2026-01-01T01:02:00Z');

		expect(findCause({ cwd, oldPin, newPin, target: 'target.ts', ranges: [{ start: 2, end: 2 }] })).toEqual({
			sha: lineCause,
			approx: false
		});
	});

	it('keeps old-pin ranges anchored when a later change occupies those line numbers', () => {
		const cwd = makeTempRoot('cause-old-pin-range');
		fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
		const target = join(cwd, 'activitybarPart.ts');
		const lines = Array.from({ length: 150 }, (_, index) => `// old line ${index + 1}`);
		lines[116] = '\t\tsuper(Parts.ACTIVITYBAR_PART);';
		lines[117] = '';
		lines[118] = '\t\tthis._isCompact = configuration.compact;';
		lines[119] = '';
		lines[120] = '\t\tthis._register(configuration.onDidChange(() => {';
		lines[121] = '\t\t\tif (configuration.compactChanged) {';
		writeFileSync(target, `${lines.join('\n')}\n`);
		const oldPin = fixtureCommit(cwd, 'fixture: old activity bar', '2026-01-01T03:00:00Z');

		lines.splice(119, 0, '\t\tthis.isInactive = !hostService.hasFocus;');
		writeFileSync(target, `${lines.join('\n')}\n`);
		const expectedCause = fixtureCommit(cwd, 'fixture: add inactive state', '2026-01-01T03:01:00Z');

		const shiftedLines = Array.from({ length: 30 }, (_, index) => `\t// shifted composite line ${index + 1}`);
		shiftedLines[20] = '\tprivate get compositeSize(): number {';
		shiftedLines[21] = '\t\treturn this.actionHeight + this.actionGap;';
		shiftedLines[22] = '\t}';
		lines.splice(96, 0, ...shiftedLines);
		writeFileSync(target, `${lines.join('\n')}\n`);
		const shiftedCause = fixtureCommit(cwd, 'fixture: add composite sizing', '2026-01-01T03:02:00Z');

		const endpointRange = fixtureGit(cwd, ['show', `${shiftedCause}:activitybarPart.ts`])
			.stdout.split('\n')
			.slice(116, 122)
			.join('\n');
		expect(endpointRange).toContain('compositeSize');
		const endpointAnchored = fixtureGit(cwd, [
			'log',
			'-L117,122:activitybarPart.ts',
			`${oldPin}..${shiftedCause}`,
			'--format=%H',
			'--no-patch'
		]).stdout;
		expect(endpointAnchored.trim().split('\n')).toEqual([shiftedCause]);

		expect(findCause({ cwd, oldPin, newPin: shiftedCause, target: 'activitybarPart.ts', ranges: [{ start: 117, end: 122 }] })).toEqual({
			sha: expectedCause,
			approx: false
		});
	});

	it('ignores repository-local hunk and binary diff policy while narrowing', () => {
		const cwd = makeTempRoot('cause-isolated-diff');
		fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
		const target = join(cwd, 'target.ts');
		const lines = Array.from({ length: 12 }, (_, index) => `old line ${index + 1}`);
		writeFileSync(target, `${lines.join('\n')}\n`);
		const oldPin = fixtureCommit(cwd, 'fixture: isolated diff base', '2026-01-01T04:00:00Z');

		lines[0] = 'unrelated first line';
		lines[9] = 'unrelated tenth line';
		writeFileSync(target, `${lines.join('\n')}\n`);
		const unrelated = fixtureCommit(cwd, 'fixture: separated unrelated edits', '2026-01-01T04:01:00Z');
		lines[4] = 'relevant fifth line';
		writeFileSync(target, `${lines.join('\n')}\n`);
		const expectedCause = fixtureCommit(cwd, 'fixture: relevant middle edit', '2026-01-01T04:02:00Z');

		fixtureGit(cwd, ['config', 'diff.interHunkContext', '20']);
		const configuredDiff = fixtureGit(cwd, ['diff', '--unified=0', oldPin, unrelated, '--', 'target.ts']).stdout;
		expect(configuredDiff).toContain('@@ -1,10 +1,10 @@');
		writeFileSync(join(cwd, '.git', 'info', 'attributes'), 'target.ts binary\n');
		const attributedDiff = fixtureGit(cwd, ['diff', '--unified=0', oldPin, unrelated, '--', 'target.ts']).stdout;
		expect(attributedDiff).toContain('Binary files');

		expect(findCause({ cwd, oldPin, newPin: expectedCause, target: 'target.ts', ranges: [{ start: 5, end: 5 }] })).toEqual({
			sha: expectedCause,
			approx: false
		});
	});

	it('treats a canonical target containing pathspec syntax as a literal path', () => {
		const cwd = makeTempRoot('cause-literal-path');
		fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
		writeFileSync(join(cwd, '[ab].ts'), 'literal base\n');
		writeFileSync(join(cwd, 'a.ts'), 'glob base\n');
		const oldPin = fixtureCommit(cwd, 'fixture: literal path base', '2026-01-01T05:00:00Z');

		writeFileSync(join(cwd, 'a.ts'), 'unrelated glob match\n');
		const unrelated = fixtureCommit(cwd, 'fixture: change glob match only', '2026-01-01T05:01:00Z');
		writeFileSync(join(cwd, '[ab].ts'), 'literal cause\n');
		const expectedCause = fixtureCommit(cwd, 'fixture: change literal target', '2026-01-01T05:02:00Z');

		const ordinaryPathspec = fixtureGit(cwd, ['log', '--format=%H', `${oldPin}..${expectedCause}`, '--', '[ab].ts']).stdout;
		expect(ordinaryPathspec.trim().split('\n')).toEqual([expectedCause, unrelated]);
		expect(findCause({ cwd, oldPin, newPin: expectedCause, target: '[ab].ts', ranges: [{ start: 1, end: 1 }] })).toEqual({
			sha: expectedCause,
			approx: false
		});
	});

	it('queries the deletion commit directly for a known target-deleted outcome', () => {
		const fake = sequence([result(`${DELETE}\n`)]);

		expect(findCause({ ...OPTIONS, lifecycle: { outcome: 'target-deleted' } }, fake.git)).toEqual({ sha: DELETE, approx: false });
		expect(fake.calls[0]?.args).toEqual([
			'log',
			'--format=%H',
			'--diff-filter=D',
			'--follow',
			`${OLD_PIN}..${NEW_PIN}`,
			'--',
			TARGET_PATHSPEC
		]);
	});

	it('queries the rename commit directly for a known target-renamed outcome', () => {
		const newTarget = 'src/vs/workbench/renamed.ts';
		const fake = sequence([result(`${RENAME}\n`)]);

		expect(findCause({ ...OPTIONS, lifecycle: { outcome: 'target-renamed', newTarget } }, fake.git)).toEqual({
			sha: RENAME,
			approx: false
		});
		expect(fake.calls[0]?.args).toEqual([
			'log',
			'--format=%H',
			'--diff-filter=R',
			'--follow',
			`${OLD_PIN}..${NEW_PIN}`,
			'--',
			`:(top,literal)${newTarget}`
		]);
	});

	it('falls back to the earliest file commit with approx when successful diffs find no affected old-pin range', () => {
		const fake = sequence([
			result(`${NEWEST}\n${MIDDLE}\n${EARLIEST}\n`),
			result('@@ -1 +1 @@\n-old\n+new\n'),
			result('@@ -2 +2 @@\n-old\n+new\n'),
			result('@@ -3 +3 @@\n-old\n+new\n')
		]);

		expect(findCause(OPTIONS, fake.git)).toEqual({ sha: EARLIEST, approx: true });
	});

	it('uses an approximate file cause without diffing when the artifact has no line ranges', () => {
		const fake = sequence([result(`${NEWEST}\n${EARLIEST}\n`)]);

		expect(findCause({ ...OPTIONS, ranges: [] }, fake.git)).toEqual({ sha: EARLIEST, approx: true });
		expect(fake.calls).toHaveLength(1);
	});

	it('does not hide a failed range diff or lifecycle query as an approximate cause', () => {
		const diffFailure = sequence([result(`${NEWEST}\n${MIDDLE}\n${EARLIEST}\n`), result('', 128, 'fatal: corrupt object')]);
		expect(() => findCause(OPTIONS, diffFailure.git)).toThrow(/corrupt object/);

		const lifecycleFailure = sequence([result('', 128, 'fatal: corrupt object')]);
		expect(() => findCause({ ...OPTIONS, lifecycle: { outcome: 'target-deleted' } }, lifecycleFailure.git)).toThrow(/corrupt object/);
	});

	it('finds real rename and deletion commits even when line history could continue', () => {
		const cwd = makeTempRoot('cause-lifecycle');
		fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
		const oldTarget = join(cwd, 'old.ts');
		const newTarget = join(cwd, 'new.ts');
		writeFileSync(oldTarget, 'one\ntwo\n');
		const oldPin = fixtureCommit(cwd, 'fixture: lifecycle base', '2026-01-01T02:00:00Z');
		writeFileSync(oldTarget, 'one\nTWO\n');
		fixtureCommit(cwd, 'fixture: content before rename', '2026-01-01T02:01:00Z');
		renameSync(oldTarget, newTarget);
		const renameCause = fixtureCommit(cwd, 'fixture: rename target', '2026-01-01T02:02:00Z');

		expect(
			findCause({
				cwd,
				oldPin,
				newPin: renameCause,
				target: 'old.ts',
				ranges: [{ start: 2, end: 2 }],
				lifecycle: { outcome: 'target-renamed', newTarget: 'new.ts' }
			})
		).toEqual({ sha: renameCause, approx: false });

		rmSync(newTarget);
		const deleteCause = fixtureCommit(cwd, 'fixture: delete target', '2026-01-01T02:03:00Z');
		expect(
			findCause({
				cwd,
				oldPin: renameCause,
				newPin: deleteCause,
				target: 'new.ts',
				ranges: [{ start: 2, end: 2 }],
				lifecycle: { outcome: 'target-deleted' }
			})
		).toEqual({ sha: deleteCause, approx: false });
	});

	it('reports no commits as a typed failure', () => {
		const fake = sequence([result('')]);

		expect(() => findCause(OPTIONS, fake.git)).toThrow(CkError);
		try {
			findCause(OPTIONS, sequence([result('')]).git);
		} catch (error) {
			expect(error).toBeInstanceOf(CkError);
			expect((error as CkError).code).toBe('ARTIFACT-BROKEN');
			expect((error as CkError).message).toContain(`no commits touched it in ${OLD_PIN}..${NEW_PIN}`);
		}
	});
});
