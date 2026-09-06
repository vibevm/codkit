// e2e: the third half of the drift guard - commits made in the fork tree are
// work, and the destructive commands refuse to cross them (PROP-008
// ##TREE-COMMITS-ARE-WORK, acceptance scenario S18 of FEAT-002).
//
// Before the campaign, a commit in the tree was invisible: `load` rebuilt the
// branch over it, `save` answered "nothing to save", and the work survived only
// in the reflog. Every refusal here must therefore prove more than an exit
// code: HEAD, the working files and the patchset artifacts must be exactly as
// they were.
//
// The commits are made with the tree hook visible (gitLocal) and bypassed the
// two ways a human can: --no-verify, and CODKIT_INTERNAL_COMMIT=1 (F12).

import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitLocal } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const IDENTITY: GitEnv = {
	GIT_AUTHOR_NAME: 'human',
	GIT_AUTHOR_EMAIL: 'human@example.invalid',
	GIT_AUTHOR_DATE: '2026-09-06T10:20:00Z',
	GIT_COMMITTER_NAME: 'human',
	GIT_COMMITTER_EMAIL: 'human@example.invalid',
	GIT_COMMITTER_DATE: '2026-09-06T10:20:00Z'
};

const MARKER_BLOCK_NOTE = '// (hook body lives in patchset own code; this block only delegates)';

afterAll(() => {
	cleanupTempRoots();
});

/** One commit in the fork tree, hook visible, bypassed the named way (F12). */
function commitInTree(fixture: CliFixture, message: string, line: string, bypass: '--no-verify' | 'internal', dateIso: string): string {
	const target = fixture.treePath(EXAMPLE_PART_PATH);
	const text = readFileSync(target, 'utf8');
	// Inside the applied state the line goes into the patch's marker block; on
	// the bare pin (the detached-HEAD fixture) the block does not exist yet and
	// the line simply lands at the end - the guard speaks before any content is
	// read, and the commit itself is what matters.
	const at = text.indexOf(MARKER_BLOCK_NOTE);
	writeFileSync(target, at === -1 ? `${text}${line}\n` : `${text.slice(0, at)}${line}\n\t\t${text.slice(at)}`, 'utf8');
	const args = ['commit', '--quiet', '--all', '--message', message, ...(bypass === '--no-verify' ? ['--no-verify'] : [])];
	const env: GitEnv = { ...IDENTITY, GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso };
	const result = gitLocal({ args, cwd: fixture.treeDir, env: bypass === 'internal' ? { ...env, CODKIT_INTERNAL_COMMIT: '1' } : env });
	expect(result.status).toBe(0);
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

function headOf(fixture: CliFixture): string {
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

function isAncestor(fixture: CliFixture, sha: string): boolean {
	return fixture.git(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
}

describe('S18: two commits in the fork tree stop every destructive command', () => {
	let fixture: CliFixture;
	let first: string;
	let second: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-s18');
		expect(fixture.run(['load']).status).toBe(0);
		first = commitInTree(fixture, 'work: first tree commit', '// first committed line', '--no-verify', '2026-09-06T10:21:00Z');
		second = commitInTree(fixture, 'work: second tree commit', '// second committed line', '--no-verify', '2026-09-06T10:22:00Z');
	});

	it('load refuses with CK-E-DIRTY-TREE and touches nothing', () => {
		const headBefore = headOf(fixture);
		const fileBefore = readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8');
		const statusBefore = fixture.git(['status', '--porcelain']).stdout;

		const outcome = fixture.json(['load']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.message).toBe('2 commit(s) in the fork tree since the last codkit apply are not in patchset yet');
		expect(outcome.envelope.errors[0]?.hint).toContain('codkit save');
		expect(outcome.envelope.data['dirtyFiles']).toContain(`commit ${first.slice(0, 8)} "work: first tree commit" (not in patchset)`);
		expect(outcome.envelope.data['dirtyFiles']).toContain(`commit ${second.slice(0, 8)} "work: second tree commit" (not in patchset)`);
		// Nothing was rebuilt and nothing was reverted: HEAD stands, the committed
		// lines are in the working file, and both commits are its ancestors.
		expect(headOf(fixture)).toBe(headBefore);
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toBe(fileBefore);
		expect(fixture.git(['status', '--porcelain']).stdout).toBe(statusBefore);
		expect(isAncestor(fixture, first)).toBe(true);
		expect(isAncestor(fixture, second)).toBe(true);
	});

	it('ci --profile verify refuses the same way', () => {
		const headBefore = headOf(fixture);

		const outcome = fixture.json(['ci', '--profile', 'verify']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.message).toBe('2 commit(s) in the fork tree since the last codkit apply are not in patchset');
		expect(headOf(fixture)).toBe(headBefore);
	});

	it('status reports the commits instead of asking for a reload', () => {
		const outcome = fixture.json(['status']);

		expect(outcome.run.status).toBe(1);
		const reported = outcome.envelope.data['treeCommits'] as { base: string; count: number; commits: { sha: string; subject: string }[] };
		expect(reported.count).toBe(2);
		expect(reported.commits.map((commit) => commit.subject)).toEqual(['work: first tree commit', 'work: second tree commit']);
		expect(reported.commits.map((commit) => commit.sha)).toEqual([first, second]);
		expect(reported.base).toMatch(/^[0-9a-f]{40}$/);
		expect(outcome.envelope.messages.some((message) => message.text.startsWith('reload needed'))).toBe(false);
		expect(outcome.envelope.messages.some((message) => message.text.startsWith('tree commits not in patchset: 2'))).toBe(true);
		expect(outcome.envelope.messages.some((message) => message.text.includes('codkit save'))).toBe(true);
	});

	it('--fresh does not lift the refusal', () => {
		const headBefore = headOf(fixture);

		const outcome = fixture.json(['load', '--fresh']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.message).toContain('2 commit(s) in the fork tree');
		expect(headOf(fixture)).toBe(headBefore);
	});
});

describe('CK-E-TREE-HEAD: HEAD off the generated branch while carrying work (D8)', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-head');
		expect(fixture.run(['load']).status).toBe(0);
		// The second sanctioned bypass of the tree hook: the internal variable.
		fixture.git(['checkout', '--quiet', '--detach', fixture.upstream.t1.sha]);
		commitInTree(fixture, 'work on a detached head', '// detached line', 'internal', '2026-09-06T10:23:00Z');
	});

	it('load names the position and the way back', () => {
		const outcome = fixture.json(['load']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-TREE-HEAD']);
		expect(outcome.envelope.errors[0]?.message).toBe('HEAD is on detached with 1 commit(s) not in patchset');
		expect(outcome.envelope.errors[0]?.hint).toContain(`git switch ${fixture.branch}`);
		expect(outcome.envelope.errors[0]?.hint).toContain('codkit save');
	});

	it('save refuses the same state', () => {
		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-TREE-HEAD']);
	});
});
