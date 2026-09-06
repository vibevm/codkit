// e2e: commits made in the fork tree are work (PROP-008
// ##TREE-COMMITS-ARE-WORK). The destructive commands refuse to cross them
// (acceptance scenario S18 of FEAT-002), and `save` replays them: every
// committed state becomes its own patchset commit with the original subject,
// author and date plus a `Codkit-Tree-Commit` trailer, the consumed commits
// stay reachable under refs/codkit/consumed/, and the tree ends clean
// (S17a, S19).
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

const UTIL_PATH = 'src/vs/base/common/util.ts';
const UTIL_PATCH = 'delta/patches/src__vs__base__common__util.ts.ckpatch';
const EXAMPLE_PATCH = 'delta/patches/src__vs__workbench__browser__parts__example__examplePart.ts.ckpatch';
const UTIL_BLOCK_ID = 'CK-base-905';

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
	expect(result.status, result.stderr).toBe(0);
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

function headOf(fixture: CliFixture): string {
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

/**
 * The patchset status of the delta only, trimmed: `.codkit/` scratch (diff
 * temporaries, tree cache, locks) is runtime state a save legitimately leaves
 * behind (F24), and it is neither a commit nor an artifact.
 */
function fixtureStatus(fixture: CliFixture): string {
	return fixture.patchGit(['status', '--porcelain', '--', 'delta/']).stdout.trim();
}

function isAncestor(fixture: CliFixture, sha: string): boolean {
	return fixture.git(['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;
}

/** The consumed refs `save` leaves behind, as `ref -> sha` rows. */
function consumedRefs(fixture: CliFixture): readonly { ref: string; sha: string }[] {
	return fixture
		.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/codkit/consumed/'])
		.stdout.trim()
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => {
			const [ref = '', sha = ''] = line.split(' ');
			return { ref, sha };
		});
}

/** Put a line inside the marker block `id` of `text`. */
function fillBlock(text: string, id: string, line: string): string {
	const at = text.indexOf(`// codkit:begin ${id}`);
	if (at === -1) {
		throw new Error(`the block ${id} is not in the file`);
	}
	const endOfBegin = text.indexOf('\n', at) + 1;
	return `${text.slice(0, endOfBegin)}${line}\n${text.slice(endOfBegin)}`;
}

/** One patchset commit as the replay assertions read it. */
type PatchsetCommit = {
	readonly sha: string;
	readonly subject: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly trailers: readonly string[];
};

/** Patchset commits since `since`, oldest first, with their replay trailers. */
function patchsetCommitsSince(fixture: CliFixture, since: string): readonly PatchsetCommit[] {
	const rows = fixture.patchGit(['log', '--reverse', '--format=%H%x00%s%x00%an%x00%ae%x00%aI', `${since}..HEAD`]).stdout.trim();
	return (rows === '' ? [] : rows.split('\n')).map((row) => {
		const [sha = '', subject = '', authorName = '', authorEmail = '', authorDate = ''] = row.split('\0');
		const trailers = fixture
			.patchGit(['log', '-1', '--format=%(trailers:key=Codkit-Tree-Commit,valueonly)', sha])
			.stdout.trim()
			.split('\n')
			.filter((line) => line !== '');
		return { sha, subject, authorName, authorEmail, authorDate, trailers };
	});
}

/** Scaffold a marker block in util.ts and leave one uncommitted line inside it. */
function dirtyUtilBlock(fixture: CliFixture, line: string): void {
	const outcome = fixture.json([
		'marker',
		'new',
		UTIL_PATH,
		'--id',
		UTIL_BLOCK_ID,
		'--type',
		'hook',
		'--owner',
		'workbench-core',
		'--reason',
		'uncommitted half'
	]);
	expect(outcome.run.status).toBe(0);
	const target = fixture.treePath(UTIL_PATH);
	writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), UTIL_BLOCK_ID, line), 'utf8');
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

describe('S17a: everything committed in the fork tree - save extracts it', () => {
	let fixture: CliFixture;
	let first: string;
	let second: string;
	let headBefore: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-s17a');
		expect(fixture.run(['load']).status).toBe(0);
		headBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		first = commitInTree(fixture, 'work: first tree commit', '// first committed line', '--no-verify', '2026-09-06T10:30:00Z');
		second = commitInTree(fixture, 'work: second tree commit', '// second committed line', '--no-verify', '2026-09-06T10:31:00Z');
		const outcome = fixture.json(['save']);
		expect(outcome.run.status).toBe(0);
	});

	it('puts the lines of both commits into the patch artifact', () => {
		const patch = readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
		expect(patch).toContain('// first committed line');
		expect(patch).toContain('// second committed line');
	});

	it('keeps the consumed commits reachable under refs/codkit/consumed/', () => {
		const refs = consumedRefs(fixture);
		expect(refs.length).toBe(1);
		// The ref points at the tree's former HEAD, which stood at the second
		// commit when the save started, and through it the whole consumed line.
		expect(refs[0]?.sha).toBe(second);
		expect(refs[0]?.ref).toMatch(/^refs\/codkit\/consumed\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/);
	});

	it('replays both commits as their own patchset commits', () => {
		const commits = patchsetCommitsSince(fixture, headBefore);
		expect(commits.map((commit) => commit.subject)).toEqual(['work: first tree commit', 'work: second tree commit']);
		expect(commits.map((commit) => commit.authorName)).toEqual(['human', 'human']);
		expect(commits.map((commit) => commit.authorEmail)).toEqual(['human@example.invalid', 'human@example.invalid']);
		// The author dates are the ones the tree commits were made with, one
		// minute apart: the patchset history carries the original chronology.
		expect(commits.map((commit) => commit.authorDate)).toEqual(['2026-09-06T10:30:00Z', '2026-09-06T10:31:00Z']);
		expect(commits.map((commit) => commit.trailers)).toEqual([[first], [second]]);
		// The committer is whoever ran the command, the same one for both.
		expect(new Set(commits.map((commit) => fixture.patchGit(['log', '-1', '--format=%cn <%ce>', commit.sha]).stdout.trim())).size).toBe(1);
	});

	it('leaves the tree clean and on the generated branch', () => {
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
		expect(fixture.git(['symbolic-ref', 'HEAD']).stdout.trim()).toBe(`refs/heads/${fixture.branch}`);
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain('// first committed line');
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain('// second committed line');
	});

	it('says nothing to save the second time', () => {
		const outcome = fixture.run(['save']);

		expect(outcome.status).toBe(0);
		expect(outcome.stdout).toContain('nothing to save');
	});

	it('load afterwards reports up to date', () => {
		const outcome = fixture.run(['load']);

		expect(outcome.status).toBe(0);
		expect(outcome.stdout).toContain('up to date');
	});
});

describe('S19: half committed, half uncommitted - save extracts both', () => {
	let fixture: CliFixture;
	let committed: string;
	let headBefore: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-s19');
		expect(fixture.run(['load']).status).toBe(0);
		headBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		committed = commitInTree(fixture, 'work: the committed half', '// committed half line', '--no-verify', '2026-09-06T10:40:00Z');
		dirtyUtilBlock(fixture, '// uncommitted half line');
		const outcome = fixture.json(['save']);
		expect(outcome.run.status).toBe(0);
	});

	it('extracts both halves into their artifacts', () => {
		const examplePatch = readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
		expect(examplePatch).toContain('// committed half line');
		const utilPatch = readFileSync(fixture.patchesPath(UTIL_PATCH), 'utf8');
		expect(utilPatch).toContain('// uncommitted half line');
	});

	it('keeps the committed line in the tree and leaves the tree clean', () => {
		// The file that carried the committed line still carries it: the
		// rebuild reproduces the state the commit held instead of rewriting it
		// away, which was the loss path of F9.
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain('// committed half line');
		expect(readFileSync(fixture.treePath(UTIL_PATH), 'utf8')).toContain('// uncommitted half line');
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
		expect(fixture.git(['symbolic-ref', 'HEAD']).stdout.trim()).toBe(`refs/heads/${fixture.branch}`);
	});

	it('replays the committed half as its own commit and leaves the uncommitted half uncommitted', () => {
		expect(consumedRefs(fixture).map((row) => row.sha)).toEqual([committed]);
		const commits = patchsetCommitsSince(fixture, headBefore);
		expect(commits.map((commit) => commit.subject)).toEqual(['work: the committed half']);
		expect(commits.map((commit) => commit.trailers)).toEqual([[committed]]);
		// The uncommitted half reached its artifact, and that artifact is the
		// one change patchset holds without a commit - the default replay
		// commits the tree's history, and the worktree remainder stays work in
		// progress exactly as an uncommitted edit would. The artifact is new
		// (util.ts carried no patch before), so patchset holds it untracked.
		expect(fixtureStatus(fixture)).toBe(`?? ${UTIL_PATCH}`);
	});
});

describe('save <path> over tree commits: the branch is not theirs to take', () => {
	let fixture: CliFixture;
	let committed: string;
	let branchTipBefore: string;
	let outcome: { run: { status: number }; envelope: { messages: { level: string; text: string }[] } };

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-scoped');
		expect(fixture.run(['load']).status).toBe(0);
		branchTipBefore = fixture.git(['rev-parse', `refs/heads/${fixture.branch}`]).stdout.trim();
		committed = commitInTree(fixture, 'work outside the named path', '// outside line', '--no-verify', '2026-09-06T10:50:00Z');
		dirtyUtilBlock(fixture, '// named path line');
		outcome = fixture.json(['save', UTIL_PATH]);
		expect(outcome.run.status).toBe(0);
	});

	it('extracts only the named path', () => {
		const utilPatch = readFileSync(fixture.patchesPath(UTIL_PATCH), 'utf8');
		expect(utilPatch).toContain('// named path line');
		const examplePatch = readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
		expect(examplePatch).not.toContain('// outside line');
	});

	it('leaves the branch and the commits exactly where they were', () => {
		// The human commit moved the branch to itself before the save ran;
		// the scoped save must not move it anywhere further, and must not
		// consume the commit.
		expect(branchTipBefore).not.toBe(committed);
		expect(fixture.git(['rev-parse', `refs/heads/${fixture.branch}`]).stdout.trim()).toBe(committed);
		expect(headOf(fixture)).toBe(committed);
		expect(isAncestor(fixture, committed)).toBe(true);
		expect(consumedRefs(fixture)).toEqual([]);
	});

	it('says that the tree commits stay until a full save', () => {
		const texts = outcome.envelope.messages.map((message) => message.text);
		expect(texts.some((text) => text.startsWith('1 changed path(s) are outside the paths given to save'))).toBe(true);
		expect(texts).toContain('1 tree commit(s) stay in the tree until a full save');
	});
});
