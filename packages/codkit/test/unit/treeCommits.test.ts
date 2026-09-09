// The tree-commit detector (PROP-008 ##TREE-COMMITS-ARE-WORK): commits of the
// fork tree's first-parent line above the last generated tip are work, and the
// cases here are the states of decision D2 - the walks, the anomaly below the
// generated tip, and the D8 refusals read from the same state. The commits are
// empty on purpose: an empty commit leaves the working tree identical to HEAD,
// so nothing but the third half of the drift guard can see them.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitLocal, runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { CkError } from '../../src/lib/messages.ts';
import { runSync } from '../../src/lib/syncEngine.ts';
import {
	COMMIT_AUTHOR_EMAIL,
	CONSUMED_REF_PREFIX,
	foreignCommits,
	parseRevListRecords,
	recordConsumedRef,
	treeHeadError
} from '../../src/lib/treeCommits.ts';
import type { TreeCommit } from '../../src/lib/treeCommits.ts';
import { driftDirty } from '../../src/lib/driftGuard.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const IDENTITY: GitEnv = {
	GIT_AUTHOR_NAME: 'human',
	GIT_AUTHOR_EMAIL: 'human@example.invalid',
	GIT_AUTHOR_DATE: '2026-09-06T10:00:00Z',
	GIT_COMMITTER_NAME: 'human',
	GIT_COMMITTER_EMAIL: 'human@example.invalid',
	GIT_COMMITTER_DATE: '2026-09-06T10:00:00Z'
};

let fixture: SyncFixture;

beforeAll(() => {
	fixture = makeSyncFixture('treecommits');
	expect(fixture.sync().exitCode).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

function branch(): string {
	return `${fixture.config.generatedBranchPrefix}${fixture.config.pin.tag}`;
}

function refOf(name: string): string {
	return `refs/heads/${name}`;
}

function revParse(ref: string): string {
	const sha = runGit({ args: ['rev-parse', ref], cwd: fixture.treeDir }).stdout.trim();
	expect(sha).toMatch(/^[0-9a-f]{40}$/);
	return sha;
}

/** An empty human commit; `--no-verify` walks past the tree hook, as F12 allows. */
function humanCommit(subject: string, dateIso: string): string {
	const result = gitLocal({
		args: ['commit', '--quiet', '--allow-empty', '--no-verify', '--message', subject],
		cwd: fixture.treeDir,
		env: { ...IDENTITY, GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
	});
	expect(result.status).toBe(0);
	return revParse('HEAD');
}

/** A commit that carries every marker of a generated one (F13), via plumbing. */
function generatedCommitOn(parent: string, subject: string): string {
	const tree = revParse(`${parent}^{tree}`);
	const result = runGit({
		args: [
			'commit-tree',
			tree,
			'-p',
			parent,
			'-m',
			subject,
			'-m',
			`Codkit-Upstream-Pin: ${fixture.config.pin.tag}@${fixture.config.pin.sha}`
		],
		cwd: fixture.treeDir,
		env: {
			GIT_AUTHOR_NAME: 'codkit',
			GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
			GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z',
			GIT_COMMITTER_NAME: 'codkit',
			GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
			GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z'
		}
	});
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

function state() {
	return foreignCommits(fixture.treeDir, fixture.config.pin.sha, branch());
}

describe('foreignCommits over a loaded tree', () => {
	it('sees no foreign commits right after a load', () => {
		const current = state();
		expect(current.commits).toEqual([]);
		expect(current.headCommits).toEqual([]);
		expect(current.branchCommits).toEqual([]);
		expect(current.onGeneratedBranch).toBe(true);
		expect(current.branchExists).toBe(true);
		expect(current.anomaly).toBeNull();
		expect(current.headRef).toBe(refOf(branch()));
		// The base is the generated tip itself, never the pin: the patch set is
		// not empty, and its commits are all codkit's own.
		expect(current.base).toBe(revParse(refOf(branch())));
	});

	it('reports one foreign commit with its subject and author', () => {
		const sha = humanCommit('one line of local work', '2026-09-06T10:01:00Z');
		const current = state();
		expect(current.commits.map((commit) => commit.sha)).toEqual([sha]);
		const only = current.commits[0] as TreeCommit;
		expect(only.subject).toBe('one line of local work');
		expect(only.authorName).toBe('human');
		expect(only.authorEmail).toBe('human@example.invalid');
		expect(only.authorDate).toContain('2026-09-06');
		expect(current.base).not.toBe(sha);
		// The tree is exactly as loaded otherwise: the commit is empty.
		expect(runGit({ args: ['status', '--porcelain'], cwd: fixture.treeDir }).stdout).toBe('');
		gitLocal({ args: ['reset', '--quiet', '--hard', 'HEAD~1'], cwd: fixture.treeDir });
	});

	it('reports three foreign commits oldest first', () => {
		const first = humanCommit('work: first', '2026-09-06T10:02:00Z');
		const second = humanCommit('work: second', '2026-09-06T10:03:00Z');
		const third = humanCommit('work: third', '2026-09-06T10:04:00Z');
		const current = state();
		expect(current.commits.map((commit) => commit.sha)).toEqual([first, second, third]);
		expect(current.commits.map((commit) => commit.subject)).toEqual(['work: first', 'work: second', 'work: third']);
		gitLocal({ args: ['reset', '--quiet', '--hard', 'HEAD~3'], cwd: fixture.treeDir });
		expect(state().commits).toEqual([]);
	});
});

describe('foreignCommits when HEAD is not on the generated branch', () => {
	it('sees foreign commits that live only on the branch, and that is dirt, not a tree-head refusal', () => {
		const stray = humanCommit('committed on the branch, then abandoned', '2026-09-06T10:05:00Z');
		runGit({ args: ['checkout', '--quiet', '--detach', fixture.config.pin.sha], cwd: fixture.treeDir });
		try {
			const current = state();
			expect(current.onGeneratedBranch).toBe(false);
			expect(current.branchExists).toBe(true);
			expect(current.headCommits).toEqual([]);
			expect(current.branchCommits.map((commit) => commit.sha)).toEqual([stray]);
			expect(current.commits.map((commit) => commit.sha)).toEqual([stray]);
			// Work exists, but not at HEAD: the guard refuses as dirt; the D8
			// refusal is for work the HEAD carries.
			expect(treeHeadError(current, branch())).toBeNull();
		} finally {
			runGit({ args: ['checkout', '--quiet', branch()], cwd: fixture.treeDir });
			gitLocal({ args: ['reset', '--quiet', '--hard', 'HEAD~1'], cwd: fixture.treeDir });
		}
	});

	it('refuses a detached HEAD that carries work while the branch exists (D8)', () => {
		runGit({ args: ['checkout', '--quiet', '--detach', fixture.config.pin.sha], cwd: fixture.treeDir });
		const stray = humanCommit('work on a detached head', '2026-09-06T10:06:00Z');
		try {
			const current = state();
			expect(current.onGeneratedBranch).toBe(false);
			expect(current.headCommits.map((commit) => commit.sha)).toEqual([stray]);
			const error = treeHeadError(current, branch());
			expect(error).toBeInstanceOf(CkError);
			expect(error?.code).toBe('TREE-HEAD');
			expect(error?.message).toBe('HEAD is on detached with 1 commit(s) not in patchset');
			expect(error?.hint).toContain(`git switch ${branch()}`);
		} finally {
			runGit({ args: ['checkout', '--quiet', branch()], cwd: fixture.treeDir });
		}
	});

	it('names the ref when HEAD carries work on a foreign branch', () => {
		runGit({ args: ['checkout', '--quiet', '-b', 'ck-side-work'], cwd: fixture.treeDir });
		humanCommit('work on a side branch', '2026-09-06T10:07:00Z');
		try {
			const error = treeHeadError(state(), branch());
			expect(error?.message).toBe(`HEAD is on ${refOf('ck-side-work')} with 1 commit(s) not in patchset`);
		} finally {
			runGit({ args: ['checkout', '--quiet', branch()], cwd: fixture.treeDir });
			runGit({ args: ['branch', '--quiet', '-D', 'ck-side-work'], cwd: fixture.treeDir });
		}
	});
});

describe('foreignCommits when the generated branch does not exist', () => {
	it('takes the pin as the base, with or without work above it (F19)', () => {
		const generatedTip = revParse(refOf(branch()));
		runGit({ args: ['checkout', '--quiet', '--detach', fixture.config.pin.sha], cwd: fixture.treeDir });
		runGit({ args: ['update-ref', '-d', refOf(branch())], cwd: fixture.treeDir });
		try {
			const clean = state();
			expect(clean.branchExists).toBe(false);
			expect(clean.commits).toEqual([]);
			expect(clean.base).toBe(fixture.config.pin.sha);
			expect(treeHeadError(clean, branch())).toBeNull();

			// Wherever HEAD is, commits above the pin are work while the branch
			// does not exist: the first load after clone (D8).
			const work = humanCommit('work before the first load', '2026-09-06T10:08:00Z');
			const withWork = state();
			expect(withWork.base).toBe(fixture.config.pin.sha);
			expect(withWork.commits.map((commit) => commit.sha)).toEqual([work]);
			expect(treeHeadError(withWork, branch())).toBeNull();
		} finally {
			// Put the fixture back the way load left it.
			runGit({ args: ['update-ref', refOf(branch()), generatedTip], cwd: fixture.treeDir });
			runGit({ args: ['checkout', '--quiet', branch()], cwd: fixture.treeDir });
		}
	});
});

describe('the anomaly below the generated tip (D2 item 4)', () => {
	it('refuses when a foreign commit sits below the topmost generated one', () => {
		const stray = humanCommit('work that ended up below a generated tip', '2026-09-06T10:09:00Z');
		const fake = generatedCommitOn(stray, 'codkit: regenerate over foreign work');
		runGit({ args: ['update-ref', refOf(branch()), fake], cwd: fixture.treeDir });
		try {
			const current = state();
			expect(current.anomaly).not.toBeNull();
			expect(current.anomaly?.commit.sha).toBe(stray);
			expect(current.anomaly?.base).toBe(fake);
			const error = treeHeadError(current, branch());
			expect(error?.code).toBe('TREE-HEAD');
			expect(error?.message).toContain(`history of ${branch()} below the generated tip was rewritten`);
			expect(error?.message).toContain(stray.slice(0, 8));
			expect(error?.hint).toContain(`reset the branch to ${fake.slice(0, 8)}`);
			expect(error?.hint).toContain(CONSUMED_REF_PREFIX);
		} finally {
			runGit({ args: ['update-ref', refOf(branch()), stray], cwd: fixture.treeDir });
			gitLocal({ args: ['reset', '--quiet', '--hard', 'HEAD~1'], cwd: fixture.treeDir });
		}
	});
});

describe('the third half inside the drift guard', () => {
	it('counts empty commits as dirt git status cannot see', () => {
		const first = humanCommit('guard sees the first', '2026-09-06T10:10:00Z');
		const second = humanCommit('guard sees the second', '2026-09-06T10:11:00Z');
		try {
			const drift = driftDirty(fixture.treeDir, fixture.config.ownDirName, fixture.patchesDir, {
				generated: { pinSha: fixture.config.pin.sha, branch: branch() }
			});
			expect(drift.upstream).toEqual([]);
			expect(drift.commits.map((commit) => commit.sha)).toEqual([first, second]);
			expect(drift.dirty).toBe(true);
			expect(drift.files).toContain(`commit ${first.slice(0, 8)} "guard sees the first" (not in patchset)`);
		} finally {
			gitLocal({ args: ['reset', '--quiet', '--hard', 'HEAD~2'], cwd: fixture.treeDir });
		}
	});

	it('makes the forceApply recovery refuse over tree commits', () => {
		humanCommit('recovery must not cross this', '2026-09-06T10:12:00Z');
		try {
			const out = new Output({ command: 'load', version: 'test', jsonMode: false });
			let thrown: unknown;
			try {
				runSync({
					patchesDir: fixture.patchesDir,
					resolution: fixture.resolution,
					config: fixture.config,
					out,
					fresh: false,
					dryRun: false,
					verbose: false,
					forceApply: true
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(CkError);
			expect((thrown as CkError).code).toBe('DIRTY-TREE');
			expect((thrown as CkError).message).toContain('forced load recovery');
		} finally {
			gitLocal({ args: ['reset', '--quiet', '--hard', 'HEAD~1'], cwd: fixture.treeDir });
		}
	});
});

describe('recordConsumedRef', () => {
	it('keeps the former HEAD reachable under refs/codkit/consumed/', () => {
		const sha = revParse('HEAD');
		const ref = recordConsumedRef(fixture.treeDir, sha, () => new Date('2026-09-06T12:34:56Z'));
		expect(ref).toBe(`${CONSUMED_REF_PREFIX}20260906T123456Z-${sha.slice(0, 7)}`);
		expect(revParse(ref)).toBe(sha);
	});
});

describe('the refusal order over a shared generated ref (D7 ruling of 2026-09-06)', () => {
	it('names the sharing sibling before any dirt verdict, and advises no save', () => {
		// Spike S0.12: the sibling's commit on the shared branch moves the ref
		// and leaves THIS tree's index staged against a HEAD nobody here moved.
		// The phantom dirt must be refused by its cause - the sharing - and the
		// old "run codkit save" hint must not appear: it would swallow the
		// neighbour's work into this patch set as a local edit.
		const generatedTip = revParse(refOf(branch()));
		const sibling = join(makeTempRoot('treecommits-sibling'), 'sibling');
		mkdirSync(dirname(sibling), { recursive: true });
		runGit({ args: ['worktree', 'add', '--quiet', '--detach', sibling], cwd: fixture.treeDir });
		runGit({ args: ['symbolic-ref', 'HEAD', refOf(branch())], cwd: sibling });
		// A content commit, not an empty one: only a real change on the shared
		// ref leaves this tree's index looking staged against the moved HEAD -
		// the phantom dirt of S0.12.
		writeFileSync(join(sibling, 'sibling-note.txt'), 'work in the sibling\n', 'utf8');
		const committed = runGit({
			args: ['-c', 'user.email=sibling@example.invalid', '-c', 'user.name=sibling', 'add', '--', 'sibling-note.txt'],
			cwd: sibling
		});
		expect(committed.status).toBe(0);
		const moved = runGit({
			args: [
				'-c',
				'user.email=sibling@example.invalid',
				'-c',
				'user.name=sibling',
				'commit',
				'--quiet',
				'--message',
				'work in the sibling'
			],
			cwd: sibling
		});
		expect(moved.status).toBe(0);
		const phantomDirt = runGit({ args: ['status', '--porcelain'], cwd: fixture.treeDir }).stdout;
		expect(phantomDirt).not.toBe('');
		try {
			const lines: string[] = [];
			const out = new Output({
				command: 'load',
				version: 'test',
				jsonMode: false,
				streams: { writeOut: (chunk) => lines.push(chunk), writeErr: (chunk) => lines.push(chunk) }
			});
			const refused = runSync({
				patchesDir: fixture.patchesDir,
				resolution: fixture.resolution,
				config: fixture.config,
				out,
				fresh: false,
				dryRun: false,
				verbose: false
			});
			expect(refused.exitCode).toBe(2);
			expect(refused.status).toBe('unfit');
			const text = lines.join('\n');
			expect(text).toContain('CK-E-WORKTREE-REF-SHARED');
			expect(text).toContain(sibling);
			expect(text).not.toContain('CK-E-DIRTY-TREE');
			expect(text).not.toContain('codkit save');
			// The refusal touched nothing: the phantom dirt is the sibling's
			// doing and stays exactly as it was.
			expect(runGit({ args: ['status', '--porcelain'], cwd: fixture.treeDir }).stdout).toBe(phantomDirt);
		} finally {
			runGit({ args: ['worktree', 'remove', '--force', '--quiet', sibling], cwd: fixture.treeDir });
			// The sibling's commit moved the shared branch; put it back so the
			// fixture is the tree load left.
			runGit({ args: ['reset', '--quiet', '--hard', generatedTip], cwd: fixture.treeDir });
		}
	});
});

describe('parseRevListRecords', () => {
	it('cuts records on the commit line, not on newlines or NULs (S0.2)', () => {
		const withTrailer = '1f0f9b95acb0b1cf2d1e1d5f8a4d3c2b1a098765';
		const bare = '2e1f9b95acb0b1cf2d1e1d5f8a4d3c2b1a098766';
		const pin = '3d1f9b95acb0b1cf2d1e1d5f8a4d3c2b1a098767';
		// The records carry NUL separators and the trailer's own trailing
		// newline; a plain '\0' string constant keeps them readable without the
		// octal-adjacent escape a template literal forbids.
		const nul = '\0';
		const stdout =
			`commit ${withTrailer}\n` +
			`${withTrailer}${nul}codkit@patchset.invalid${nul}t1@${pin}\n${nul}codkit${nul}codkit@patchset.invalid${nul}2026-01-02T00:00:00Z${nul}codkit: generated\n` +
			`commit ${bare}\n` +
			`${bare}${nul}human@example.invalid${nul}${nul}human${nul}human@example.invalid${nul}2026-09-06T10:00:00+03:00${nul}work by hand\n`;
		const records = parseRevListRecords(stdout);
		expect(records.map((record) => record.sha)).toEqual([withTrailer, bare]);
		// The trailer placeholder adds its own newline before the NUL; both it
		// and the record terminator are stripped, not trusted as separators.
		expect(records[0]?.pinTrailer).toBe(`t1@${pin}`);
		expect(records[0]?.recordedAuthorEmail).toBe(COMMIT_AUTHOR_EMAIL);
		expect(records[0]?.subject).toBe('codkit: generated');
		expect(records[1]?.pinTrailer).toBe('');
		expect(records[1]?.subject).toBe('work by hand');
		expect(records[1]?.authorName).toBe('human');
	});
});
