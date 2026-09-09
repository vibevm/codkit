// e2e: commits made in the fork tree are work (PROP-008
// ##TREE-COMMITS-ARE-WORK). The destructive commands refuse to cross them
// (acceptance scenario S18 of FEAT-002), and `save` replays them: every
// committed state becomes its own patchset commit with the original subject,
// author and date plus a `Codkit-Tree-Commit` trailer, the consumed commits
// stay reachable under refs/codkit/consumed/, and the tree ends clean
// (S17a/b/c, S19; `--squash` folds the states into one commit).
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
import { applyUnified } from '../../src/lib/applyUnified.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import { loadConventions } from '../../src/lib/conventionsFile.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { parseCkpatch } from '../../src/lib/patchFormat.ts';
import { runSync } from '../../src/lib/syncEngine.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { CODKIT_E2E_TEST_BUILD, makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture, Envelope, Run } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { SAVE_REPLAY_CRASH_ENV, SAVE_REPLAY_CRASH_EXIT_CODE } from '../../src/lib/saveReplay.ts';

const UTIL_PATH = 'src/vs/base/common/util.ts';
const UTIL_PATCH = 'delta/patches/src__vs__base__common__util.ts.ckpatch';
const EXAMPLE_PATCH = 'delta/patches/src__vs__workbench__browser__parts__example__examplePart.ts.ckpatch';
const UTIL_BLOCK_ID = 'CK-base-905';
/** The fixture's own-code pair: one file, its patchset source and tree target. */
const OWN_IN_PATCHSET = 'delta/own/hello.ts';
const OWN_IN_TREE = 'src/vs/patchset/hello.ts';

const IDENTITY: GitEnv = {
	GIT_AUTHOR_NAME: 'human',
	GIT_AUTHOR_EMAIL: 'human@example.invalid',
	GIT_AUTHOR_DATE: '2026-09-06T10:20:00Z',
	GIT_COMMITTER_NAME: 'human',
	GIT_COMMITTER_EMAIL: 'human@example.invalid',
	GIT_COMMITTER_DATE: '2026-09-06T10:20:00Z'
};

const MARKER_BLOCK_NOTE = '// (hook body lives in patchset/ own code; this block only delegates)';

afterAll(() => {
	cleanupTempRoots();
});

type TreeAuthor = { readonly name: string; readonly email: string };

/**
 * One commit in the fork tree, hook visible, bypassed the named way (F12).
 * `line === null` commits without touching any file (an empty commit needs
 * `--allow-empty` in `extra`); the line lands inside the patch's marker block,
 * or at the very end of the file on the bare pin of the detached-HEAD fixture.
 */
function commitInTree(
	fixture: CliFixture,
	message: string,
	line: string | null,
	bypass: '--no-verify' | 'internal',
	dateIso: string,
	author: TreeAuthor = { name: 'human', email: 'human@example.invalid' },
	extra: readonly string[] = []
): string {
	const target = fixture.treePath(EXAMPLE_PART_PATH);
	if (line !== null) {
		const text = readFileSync(target, 'utf8');
		const at = text.indexOf(MARKER_BLOCK_NOTE);
		writeFileSync(target, at === -1 ? `${text}${line}\n` : `${text.slice(0, at)}${line}\n\t\t${text.slice(at)}`, 'utf8');
	}
	const args = ['commit', '--quiet', '--all', '--message', message, ...extra, ...(bypass === '--no-verify' ? ['--no-verify'] : [])];
	const env: GitEnv = {
		...IDENTITY,
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_AUTHOR_DATE: dateIso,
		GIT_COMMITTER_DATE: dateIso
	};
	const result = gitLocal({ args, cwd: fixture.treeDir, env: bypass === 'internal' ? { ...env, CODKIT_INTERNAL_COMMIT: '1' } : env });
	expect(result.status, result.stderr).toBe(0);
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

function headOf(fixture: CliFixture): string {
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

/** A tree commit without helper magic: whatever is staged, `--no-verify`. */
function commitRaw(fixture: CliFixture, message: string, dateIso: string): string {
	const result = gitLocal({
		args: ['commit', '--quiet', '--all', '--message', message, '--no-verify'],
		cwd: fixture.treeDir,
		env: { ...IDENTITY, GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
	});
	expect(result.status, result.stderr).toBe(0);
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

/** Apply the artifact as it stands at patchset commit `sha` to the pin bytes. */
function artifactStateAt(fixture: CliFixture, sha: string, artifact: string, pinSha: string): Uint8Array {
	const bytes = fixture.patchGit(['show', `${sha}:${artifact}`]).stdout;
	const parsed = parseCkpatch(Buffer.from(bytes, 'utf8'), loadConventions(fixture.patchesDir), artifact);
	const pin = fixture.git(['show', `${pinSha}:${EXAMPLE_PART_PATH}`]).stdout;
	return applyUnified(Buffer.from(pin, 'utf8'), parsed);
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

/** Three commits by three people, plus whatever remainder the fixture adds. */
type ReplayTriple = {
	readonly fixture: CliFixture;
	readonly first: string;
	readonly second: string;
	readonly third: string;
	readonly headBefore: string;
};

function makeReplayTriple(label: string, remainder: boolean): ReplayTriple {
	const fixture = makeCliFixture(label);
	expect(fixture.run(['load']).status).toBe(0);
	const headBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
	const first = commitInTree(fixture, 'work: alice adds the area log', '// alice committed line', '--no-verify', '2026-09-06T11:01:00Z', {
		name: 'alice',
		email: 'alice@example.invalid'
	});
	const second = commitInTree(fixture, 'work: bob extends it', '// bob committed line', '--no-verify', '2026-09-06T11:02:00Z', {
		name: 'bob',
		email: 'bob@example.invalid'
	});
	const third = commitInTree(fixture, 'work: carol finishes the series', '// carol committed line', '--no-verify', '2026-09-06T11:03:00Z', {
		name: 'carol',
		email: 'carol@example.invalid'
	});
	if (remainder) {
		dirtyUtilBlock(fixture, '// uncommitted remainder line');
	}
	return { fixture, first, second, third, headBefore };
}

describe('S17b: three commits replay one by one, the remainder stays uncommitted', () => {
	let setup: ReplayTriple;
	let outcome: { run: Run; envelope: Envelope };

	beforeAll(() => {
		setup = makeReplayTriple('treecommits-s17b', true);
		outcome = setup.fixture.json(['save']);
		expect(outcome.run.status, outcome.run.stderr).toBe(0);
	});

	it('makes one patchset commit per tree commit with its subject, author and date', () => {
		const commits = patchsetCommitsSince(setup.fixture, setup.headBefore);
		expect(commits.map((commit) => commit.subject)).toEqual([
			'work: alice adds the area log',
			'work: bob extends it',
			'work: carol finishes the series'
		]);
		expect(commits.map((commit) => commit.authorName)).toEqual(['alice', 'bob', 'carol']);
		expect(commits.map((commit) => commit.authorEmail)).toEqual(['alice@example.invalid', 'bob@example.invalid', 'carol@example.invalid']);
		expect(commits.map((commit) => commit.authorDate)).toEqual(['2026-09-06T11:01:00Z', '2026-09-06T11:02:00Z', '2026-09-06T11:03:00Z']);
		expect(commits.map((commit) => commit.trailers)).toEqual([[setup.first], [setup.second], [setup.third]]);
	});

	it('reproduces each tree commit state from the patchset history', () => {
		// The real proof that replay preserved history: the artifact as each
		// patchset commit holds it, applied to the pin, is the file as the
		// corresponding tree commit held it - not merely a commit count.
		const pin = setup.fixture.upstream.t1.sha;
		const commits = patchsetCommitsSince(setup.fixture, setup.headBefore);
		for (const [index, treeSha] of [setup.first, setup.second, setup.third].entries()) {
			const replayed = Buffer.from(artifactStateAt(setup.fixture, commits[index]?.sha ?? '', EXAMPLE_PATCH, pin)).toString('utf8');
			const held = setup.fixture.git(['show', `${treeSha}:${EXAMPLE_PART_PATH}`]).stdout;
			expect(replayed, `replay commit ${index}`).toBe(held);
		}
	});

	it('leaves the uncommitted remainder in the patchset working tree, uncommitted', () => {
		// A new artifact, held untracked: the replay commits the tree's history,
		// and the remainder stays work in progress exactly as an uncommitted
		// edit would.
		expect(fixtureStatus(setup.fixture)).toBe(`?? ${UTIL_PATCH}`);
		expect(readFileSync(setup.fixture.patchesPath(UTIL_PATCH), 'utf8')).toContain('// uncommitted remainder line');
		const texts = outcome.envelope.messages.map((message) => message.text);
		expect(texts).toContain('replayed 3 tree commit(s) into patchset history');
	});

	it('ends with a clean tree and consumed refs', () => {
		expect(setup.fixture.git(['status', '--porcelain']).stdout).toBe('');
		expect(consumedRefs(setup.fixture).map((row) => row.sha)).toEqual([setup.third]);
	});
});

describe('S17b with --commit --message: the remainder becomes the fourth commit', () => {
	let setup: ReplayTriple;

	beforeAll(() => {
		setup = makeReplayTriple('treecommits-s17b-commit', true);
		const outcome = setup.fixture.json(['save', '--commit', '--message', 'codkit save: the remainder']);
		expect(outcome.run.status, outcome.run.stderr).toBe(0);
	});

	it('replays the three commits and commits the remainder with the given message', () => {
		const commits = patchsetCommitsSince(setup.fixture, setup.headBefore);
		expect(commits.map((commit) => commit.subject)).toEqual([
			'work: alice adds the area log',
			'work: bob extends it',
			'work: carol finishes the series',
			'codkit save: the remainder'
		]);
		expect(commits.map((commit) => commit.trailers)).toEqual([[setup.first], [setup.second], [setup.third], []]);
		// The fourth commit carries exactly the remainder's artifact.
		const remainder = commits[3]?.sha ?? '';
		expect(setup.fixture.patchGit(['show', '--name-only', '--format=', remainder]).stdout.trim()).toBe(UTIL_PATCH);
		expect(fixtureStatus(setup.fixture)).toBe('');
	});
});

describe('S17b with --squash: one commit folds the three, each named by a trailer', () => {
	let setup: ReplayTriple;

	beforeAll(() => {
		setup = makeReplayTriple('treecommits-s17b-squash', false);
		const outcome = setup.fixture.json(['save', '--squash']);
		expect(outcome.run.status, outcome.run.stderr).toBe(0);
	});

	it('folds the three tree commits into a single patchset commit', () => {
		const commits = patchsetCommitsSince(setup.fixture, setup.headBefore);
		expect(commits.length).toBe(1);
		const message = setup.fixture.patchGit(['log', '-1', '--format=%B']).stdout;
		expect(message).toContain('codkit save: squash of 3 tree commit(s)');
		expect(message).toContain(`${setup.first} work: alice adds the area log`);
		expect(message).toContain(`${setup.second} work: bob extends it`);
		expect(message).toContain(`${setup.third} work: carol finishes the series`);
		expect(commits[0]?.trailers).toEqual([setup.first, setup.second, setup.third]);
		expect(consumedRefs(setup.fixture).map((row) => row.sha)).toEqual([setup.third]);
	});
});

describe('S17c: an intermediate commit outside any marker refuses the whole save', () => {
	let fixture: CliFixture;
	let second: string;
	let third: string;
	let headBefore: string;
	let fileBefore: string;
	let exampleBefore: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-s17c');
		expect(fixture.run(['load']).status).toBe(0);
		headBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		commitInTree(fixture, 'work: clean first commit', '// first committed line', '--no-verify', '2026-09-06T11:10:00Z');
		// The second commit adds a line at the very end of the file - outside
		// every marker block, the one edit a patch is never allowed to carry.
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		const clean = readFileSync(target, 'utf8');
		writeFileSync(target, `${clean}// outside every marker block\n`, 'utf8');
		second = commitRaw(fixture, 'work: the outside edit', '2026-09-06T11:11:00Z');
		third = commitInTree(fixture, 'work: clean third commit', '// third committed line', '--no-verify', '2026-09-06T11:12:00Z');
		fileBefore = readFileSync(target, 'utf8');
		exampleBefore = readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
	});

	it('refuses with CK-E-HUNK-OUTSIDE-MARKER naming the sha and subject', () => {
		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(1);
		// The states that still carry the outside line each refuse - the second
		// commit introduced it, and the third and the worktree inherit it.
		expect(outcome.envelope.errors.length).toBeGreaterThanOrEqual(1);
		expect(outcome.envelope.errors.every((error) => error.code === 'CK-E-HUNK-OUTSIDE-MARKER')).toBe(true);
		expect(outcome.envelope.errors[0]?.message).toContain(`tree commit ${second.slice(0, 8)} "work: the outside edit":`);
	});

	it('leaves patchset without a new commit or artifact, and the tree untouched', () => {
		expect(fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
		expect(fixtureStatus(fixture)).toBe('');
		expect(readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8')).toBe(exampleBefore);
		expect(headOf(fixture)).toBe(third);
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toBe(fileBefore);
		expect(consumedRefs(fixture)).toEqual([]);
	});
});

describe('S17c reverted: only the per-state pass sees the violation', () => {
	let fixture: CliFixture;
	let second: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-s17c-reverted');
		expect(fixture.run(['load']).status).toBe(0);
		commitInTree(fixture, 'work: clean first commit', '// first committed line', '--no-verify', '2026-09-06T11:20:00Z');
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		const clean = readFileSync(target, 'utf8');
		writeFileSync(target, `${clean}// outside every marker block\n`, 'utf8');
		second = commitRaw(fixture, 'work: the outside edit', '2026-09-06T11:21:00Z');
		// The third commit reverts the outside line, so the FINAL state of the
		// tree is clean: a one-pass implementation that plans only the final
		// state would accept this save (prediction P4).
		writeFileSync(target, clean, 'utf8');
		commitRaw(fixture, 'work: revert the outside edit', '2026-09-06T11:22:00Z');
	});

	it('still refuses, naming the intermediate commit', () => {
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).not.toContain('// outside every marker block');
		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-HUNK-OUTSIDE-MARKER']);
		expect(outcome.envelope.errors[0]?.message).toContain(`tree commit ${second.slice(0, 8)} "work: the outside edit":`);
	});
});

describe('idempotency: a save interrupted after the first replay commit resumes without duplicates', () => {
	let fixture: CliFixture;
	let first: string;
	let second: string;
	let headBefore: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-replay-resume');
		expect(fixture.run(['load']).status).toBe(0);
		headBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		first = commitInTree(fixture, 'work: first tree commit', '// first committed line', '--no-verify', '2026-09-06T11:30:00Z');
		second = commitInTree(fixture, 'work: second tree commit', '// second committed line', '--no-verify', '2026-09-06T11:31:00Z');
	});

	it('crashes at the replayCheckpoint seam right after the first state commit', () => {
		const crashed = fixture.run(['save'], {
			[CODKIT_E2E_TEST_BUILD]: '1',
			[SAVE_REPLAY_CRASH_ENV]: 'state-committed'
		});

		expect(crashed.status).toBe(SAVE_REPLAY_CRASH_EXIT_CODE);
		// One replay commit exists; the tree was not rebuilt and still holds
		// both commits.
		const commits = patchsetCommitsSince(fixture, headBefore);
		expect(commits.map((commit) => commit.trailers)).toEqual([[first]]);
		expect(headOf(fixture)).toBe(second);
		expect(consumedRefs(fixture)).toEqual([]);
	});

	it('the resumed save skips the replayed commit and finishes the rest', () => {
		const outcome = fixture.json(['save']);

		expect(outcome.run.status, outcome.run.stderr).toBe(0);
		const texts = outcome.envelope.messages.map((message) => message.text);
		expect(texts).toContain('1 tree commit(s) are already replayed into patchset; skipped');
		expect(texts).toContain('replayed 1 tree commit(s) into patchset history');
		// Each tree commit is named exactly once across the whole history.
		const commits = patchsetCommitsSince(fixture, headBefore);
		expect(commits.map((commit) => commit.subject)).toEqual(['work: first tree commit', 'work: second tree commit']);
		expect(commits.map((commit) => commit.trailers)).toEqual([[first], [second]]);
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
		expect(consumedRefs(fixture).map((row) => row.sha)).toEqual([second]);
	});

	it('a third save is a no-op', () => {
		const outcome = fixture.run(['save']);

		expect(outcome.status).toBe(0);
		expect(outcome.stdout).toContain('nothing to save');
	});
});

describe('an empty tree commit is skipped, visibly', () => {
	let fixture: CliFixture;
	let empty: string;
	let headBefore: string;
	let outcome: { run: Run; envelope: Envelope };

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-empty-state');
		expect(fixture.run(['load']).status).toBe(0);
		headBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		commitInTree(fixture, 'work: first real edit', '// first committed line', '--no-verify', '2026-09-06T11:40:00Z');
		empty = commitInTree(fixture, 'chore: an empty tree commit', null, '--no-verify', '2026-09-06T11:41:00Z', undefined, ['--allow-empty']);
		commitInTree(fixture, 'work: third real edit', '// third committed line', '--no-verify', '2026-09-06T11:42:00Z');
		outcome = fixture.json(['save']);
		expect(outcome.run.status, outcome.run.stderr).toBe(0);
	});

	it('replays only the states that change an artifact, and says which one was skipped', () => {
		const commits = patchsetCommitsSince(fixture, headBefore);
		expect(commits.map((commit) => commit.subject)).toEqual(['work: first real edit', 'work: third real edit']);
		const texts = outcome.envelope.messages.map((message) => message.text);
		expect(texts).toContain(
			`tree commit ${empty.slice(0, 8)} "chore: an empty tree commit" changes no artifact; no patchset commit for it`
		);
		// The empty commit is still consumed with the rest of the line.
		expect(consumedRefs(fixture).length).toBe(1);
	});
});

describe('a malformed Cause: trailer in a tree commit blocks the replay', () => {
	let fixture: CliFixture;
	let bad: string;
	let headBefore: string;
	let exampleBefore: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-bad-cause');
		expect(fixture.run(['load']).status).toBe(0);
		headBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		const text = readFileSync(target, 'utf8');
		const at = text.indexOf(MARKER_BLOCK_NOTE);
		writeFileSync(
			target,
			at === -1 ? `${text}// committed line\n` : `${text.slice(0, at)}// committed line\n\t\t${text.slice(at)}`,
			'utf8'
		);
		bad = commitRaw(fixture, 'work: the cause commit\n\nCause: not-a-sha', '2026-09-06T11:50:00Z');
		exampleBefore = readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
	});

	it('refuses naming the commit and the trailer, writing nothing', () => {
		const fileBefore = readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8');

		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-CONFIG']);
		expect(outcome.envelope.errors[0]?.message).toContain(`tree commit ${bad.slice(0, 8)} "work: the cause commit":`);
		expect(outcome.envelope.errors[0]?.message).toContain('the Cause: trailer must be a 40-character upstream sha, got "not-a-sha"');
		// The refusal is a pass-1 refusal: no commit, no artifact, no tree move.
		expect(fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()).toBe(headBefore);
		expect(fixtureStatus(fixture)).toBe('');
		expect(readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8')).toBe(exampleBefore);
		expect(headOf(fixture)).toBe(bad);
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toBe(fileBefore);
	});
});

describe('--squash without tree commits is a no-op that says so', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-squash-noop');
		expect(fixture.run(['load']).status).toBe(0);
	});

	it('says there is nothing to fold and nothing to save', () => {
		const outcome = fixture.run(['save', '--squash']);

		expect(outcome.status).toBe(0);
		expect(outcome.stdout).toContain('--squash: no tree commits in the fork tree to fold');
		expect(outcome.stdout).toContain('nothing to save');
	});
});

describe('load --discard: dropping tree commits on purpose (D11)', () => {
	let fixture: CliFixture;
	let first: string;
	let second: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-discard');
		expect(fixture.run(['load']).status).toBe(0);
		first = commitInTree(fixture, 'work: first tree commit', '// first committed line', '--no-verify', '2026-09-06T11:00:00Z');
		second = commitInTree(fixture, 'work: second tree commit', '// second committed line', '--no-verify', '2026-09-06T11:01:00Z');
	});

	it('drops them: exit 0, files back, the line kept only by the consumed ref', () => {
		const outcome = fixture.json(['load', '--discard']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		const refs = consumedRefs(fixture);
		expect(refs.length).toBe(1);
		const kept = refs[0];
		// The ref points at the tree's former HEAD, and through it the whole line.
		expect(kept?.sha).toBe(second);
		expect(kept?.ref).toMatch(/^refs\/codkit\/consumed\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/);
		expect(
			outcome.envelope.messages.some(
				(message) => message.text === `discarded 2 commit(s): ${first.slice(0, 8)}..${second.slice(0, 8)}; kept as ${kept?.ref}`
			)
		).toBe(true);
		// Both halves of the criterion, asserted separately: unreachable from
		// HEAD (the drop happened) and reachable from the ref (nothing was lost).
		expect(isAncestor(fixture, first)).toBe(false);
		expect(isAncestor(fixture, second)).toBe(false);
		expect(fixture.git(['merge-base', '--is-ancestor', first, kept?.ref ?? '']).status).toBe(0);
		expect(fixture.git(['merge-base', '--is-ancestor', second, kept?.ref ?? '']).status).toBe(0);
		// The working files are back at the applied state, the tree is clean and
		// back on the generated branch.
		const file = readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8');
		expect(file).not.toContain('// first committed line');
		expect(file).not.toContain('// second committed line');
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
		expect(fixture.git(['symbolic-ref', 'HEAD']).stdout.trim()).toBe(`refs/heads/${fixture.branch}`);
		expect(outcome.envelope.data['discarded']).toEqual([first, second]);
		expect(outcome.envelope.data['discardedRef']).toBe(kept?.ref);
	});

	it('without commits it is an honest no-op, not a pretend discard', () => {
		const outcome = fixture.json(['load', '--discard']);

		expect(outcome.run.status).toBe(0);
		expect(
			outcome.envelope.messages.some((message) => message.text === 'discard: no fork-tree commits above the generated tip; nothing to drop')
		).toBe(true);
		// Still exactly the one ref the real discard left behind.
		expect(consumedRefs(fixture).length).toBe(1);
	});
});

describe('--ci never discards: the decision is interactive only (D11)', () => {
	let fixture: CliFixture;
	let first: string;
	let second: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-discard-ci');
		expect(fixture.run(['load']).status).toBe(0);
		first = commitInTree(fixture, 'work: first tree commit', '// first committed line', '--no-verify', '2026-09-06T11:05:00Z');
		second = commitInTree(fixture, 'work: second tree commit', '// second committed line', '--no-verify', '2026-09-06T11:06:00Z');
	});

	it('refuses with exit 2 and the commits stay reachable from HEAD', () => {
		const outcome = fixture.json(['load', '--discard', '--ci']);

		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-CONFIG']);
		expect(outcome.envelope.errors[0]?.message).toContain('--discard');
		// A non-interactive run does not discard work: nothing moved.
		expect(isAncestor(fixture, first)).toBe(true);
		expect(isAncestor(fixture, second)).toBe(true);
		expect(consumedRefs(fixture)).toEqual([]);
	});
});

describe('--discard lifts only the commits half of the guard (D11)', () => {
	let fixture: CliFixture;
	let committed: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-discard-mixed');
		expect(fixture.run(['load']).status).toBe(0);
		committed = commitInTree(fixture, 'work: the committed part', '// committed line', '--no-verify', '2026-09-06T11:10:00Z');
		// An uncommitted edit on top: the same insertion the commits use, minus
		// the commit itself. The flag speaks about commits, never about edits.
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		const text = readFileSync(target, 'utf8');
		const at = text.indexOf(MARKER_BLOCK_NOTE);
		writeFileSync(
			target,
			at === -1 ? `${text}// uncommitted line\n` : `${text.slice(0, at)}// uncommitted line\n\t\t${text.slice(at)}`,
			'utf8'
		);
	});

	it('refuses over the uncommitted edit and drops nothing', () => {
		const outcome = fixture.json(['load', '--discard']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.message).toBe('1 commit(s) in the fork tree since the last codkit apply are not in patchset yet');
		// Nothing moved: the commit is still in HEAD's history, the edit is
		// still in the file, and no consumed ref exists.
		expect(isAncestor(fixture, committed)).toBe(true);
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain('// uncommitted line');
		expect(consumedRefs(fixture)).toEqual([]);
	});
});

describe('the commits refusal is not subordinate to the own-side verdict (P6B)', () => {
	// The state every test here builds: own code moved only on the patch-set
	// side (the guard verdict is `patchset-side`, ##PATCHSET-SIDE-EDIT-RULE)
	// while foreign commits stand on the generated branch. Phase 2 of the
	// campaign wired the commits refusal inside that verdict, so this exact
	// state warned and continued, and the rebuild dropped the commits with no
	// consumed ref - reachable from the reflog alone. The pair of tests below
	// proves each half: the refusal over the commits, and - through the
	// discard run, where the verdict still speaks - that the dirt really is
	// patchset-side, so only the commits half is what refused.
	let fixture: CliFixture;
	let first: string;
	let second: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-own-side-commits');
		expect(fixture.run(['load']).status).toBe(0);
		const edited = '// the patchset side moved\nexport function hello(name: string): string {\n\treturn name;\n}\n';
		writeFileSync(fixture.patchesPath(OWN_IN_PATCHSET), edited, 'utf8');
		first = commitInTree(fixture, 'work: first tree commit', '// first committed line', '--no-verify', '2026-09-06T11:55:00Z');
		second = commitInTree(fixture, 'work: second tree commit', '// second committed line', '--no-verify', '2026-09-06T11:56:00Z');
	});

	it('load refuses over the commits; no own-side verdict may waive it', () => {
		const headBefore = headOf(fixture);
		const fileBefore = readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8');

		const outcome = fixture.json(['load']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.message).toBe('2 commit(s) in the fork tree since the last codkit apply are not in patchset yet');
		expect(outcome.envelope.data['dirtyFiles']).toContain(`commit ${first.slice(0, 8)} "work: first tree commit" (not in patchset)`);
		expect(outcome.envelope.data['dirtyFiles']).toContain(`commit ${second.slice(0, 8)} "work: second tree commit" (not in patchset)`);
		// The patchset-side verdict is not the answer over commits: its warning
		// must not appear where the refusal stands.
		expect(outcome.envelope.messages.some((message) => message.code === 'CK-W-PATCHSET-SIDE-EDIT')).toBe(false);
		// Nothing moved: HEAD stands on the commits, the committed lines are in
		// the working file, and no consumed ref exists.
		expect(headOf(fixture)).toBe(headBefore);
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toBe(fileBefore);
		expect(isAncestor(fixture, first)).toBe(true);
		expect(isAncestor(fixture, second)).toBe(true);
		expect(consumedRefs(fixture)).toEqual([]);
	});

	it('the same state with --discard proceeds, warns about the own side, and writes the consumed ref', () => {
		const outcome = fixture.json(['load', '--discard']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		// The verdict under the same dirt is really patchset-side: it warns and
		// applies the patchset version rather than refusing - so the refusal
		// above was the commits half alone, decided before any verdict.
		expect(outcome.envelope.messages.some((message) => message.code === 'CK-W-PATCHSET-SIDE-EDIT')).toBe(true);
		expect(readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8')).toContain('// the patchset side moved');
		const refs = consumedRefs(fixture);
		expect(refs.length).toBe(1);
		expect(refs[0]?.sha).toBe(second);
		expect(isAncestor(fixture, first)).toBe(false);
		expect(isAncestor(fixture, second)).toBe(false);
		expect(fixture.git(['merge-base', '--is-ancestor', first, refs[0]?.ref ?? '']).status).toBe(0);
		expect(fixture.git(['merge-base', '--is-ancestor', second, refs[0]?.ref ?? '']).status).toBe(0);
		expect(outcome.envelope.data['discarded']).toEqual([first, second]);
		expect(outcome.envelope.data['discardedRef']).toBe(refs[0]?.ref);
	});
});

describe('the patchset-side warning stands when there are no commits', () => {
	it('warns CK-W-PATCHSET-SIDE-EDIT and applies the patchset version', () => {
		const fixture = makeCliFixture('treecommits-own-side-clean');
		expect(fixture.run(['load']).status).toBe(0);
		const edited = '// the patchset side moved\nexport function hello(name: string): string {\n\treturn name;\n}\n';
		writeFileSync(fixture.patchesPath(OWN_IN_PATCHSET), edited, 'utf8');

		const outcome = fixture.json(['load']);

		// No commits, so the commits half has nothing to say: the own-side
		// verdict is the whole guard here, and a patchset-side move stays a
		// warning that applies the patchset version - the fix must not turn it
		// into a refusal.
		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		expect(outcome.envelope.messages.some((message) => message.code === 'CK-W-PATCHSET-SIDE-EDIT')).toBe(true);
		expect(readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8')).toBe(edited);
	});
});

describe('a crash during load --discard cannot lose the dropped line (ref written before the rebuild)', () => {
	let fixture: CliFixture;
	let first: string;
	let second: string;

	beforeAll(() => {
		fixture = makeCliFixture('treecommits-discard-crash');
		expect(fixture.run(['load']).status).toBe(0);
		first = commitInTree(fixture, 'work: first tree commit', '// first committed line', '--no-verify', '2026-09-06T11:15:00Z');
		second = commitInTree(fixture, 'work: second tree commit', '// second committed line', '--no-verify', '2026-09-06T11:16:00Z');
	});

	it('keeps the commits reachable from refs/codkit/consumed at the worktree-moved crash point', () => {
		const config = loadConfig(fixture.patchesDir);
		if (config === null) throw new Error('missing fixture config');
		const out = new Output({ command: 'load', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
		expect(() =>
			runSync({
				patchesDir: fixture.patchesDir,
				resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null },
				config,
				out,
				fresh: false,
				dryRun: false,
				verbose: false,
				discardTreeCommits: true,
				checkpoint(at) {
					if (at === 'worktree-moved') throw new Error('crash:worktree-moved');
				}
			})
		).toThrow('crash:worktree-moved');

		// The decisive read is the ref itself, not the code path: the crash sits
		// after the rebuild moved HEAD off the dropped line, and the line must
		// already be kept by refs/codkit/consumed/* rather than by the reflog
		// alone - verbatim the defect this campaign was created to remove.
		const refs = consumedRefs(fixture);
		expect(refs.length).toBe(1);
		expect(refs[0]?.sha).toBe(second);
		expect(fixture.git(['merge-base', '--is-ancestor', first, refs[0]?.ref ?? '']).status).toBe(0);
		expect(fixture.git(['merge-base', '--is-ancestor', second, refs[0]?.ref ?? '']).status).toBe(0);
		// The crash window is real: HEAD has already moved off the line.
		expect(isAncestor(fixture, second)).toBe(false);
	});
});
