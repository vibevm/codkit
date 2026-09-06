// e2e: the conflict stop of the two-way `codkit sync` and its recovery
// (PROP-008 sec. 5a ##SYNC-CONFLICT-DIFF3, ##SYNC-ABORT, ##SYNC-CONTINUE;
// campaign TREE-COMMITS-SAVE Phase 8b, decisions D19 and D21).
//
// S26: both sides move F and the run answers with markers, not a refusal -
// diff3 inside the marker block, a live transaction carrying conflicts[] and
// the ours-snapshots, load/save refusing over it, and a simulated human
// resolution that `sync --continue` finishes: both changes in the artifact,
// the record gone.
//
// S27: `sync --abort` is the load-bearing half. The restore is proven by
// hashes captured before the run over bytes made distinctive on purpose - a
// restore from the wrong snapshot (base, theirs, anything but ours) cannot
// pass that comparison. The same proof runs after a crashed continuation,
// where the abort must also take this run's patchset commits off the branch
// and return the tree's branch and HEAD; and a foreign commit placed on top
// refuses the abort by name instead of being discarded.
//
// The crash matrix walks every atom through the seam and answers the
// acceptance question for both ways on: after each crash, --continue and
// --abort each reach a defined state, and the one that refuses says why.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitLocal } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { SYNC_TEST_CRASH_ENV, SYNC_TEST_CRASH_EXIT_CODE, SYNC_TRANSACTION_RELATIVE_PATH } from '../../src/lib/syncTransaction.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { CODKIT_E2E_TEST_BUILD, makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture, Envelope, Run } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

/** F: the file whose patch artifact the patchset side moves and the tree edits. */
const EXAMPLE_PATCH = 'delta/patches/src__vs__workbench__browser__parts__example__examplePart.ts.ckpatch';
/** G: the file the tree commits a change to, so a continuation has a replay atom. */
const UTIL_PATH = 'src/vs/base/common/util.ts';

const F_BLOCK_ID = 'CK-workbench-901';
const G_BLOCK_ID = 'CK-base-905';

const PATCHSET_LINE = '// the patchset side of F';
/** Distinctive on purpose (S27): pre-run bytes no wrong snapshot can reproduce. */
const TREE_LINE = '// the tree side of F, distinctive 5f27a1';
const G_COMMITTED_LINE = '// the committed side of G';

const IDENTITY: GitEnv = {
	GIT_AUTHOR_NAME: 'human',
	GIT_AUTHOR_EMAIL: 'human@example.invalid',
	GIT_AUTHOR_DATE: '2026-09-06T12:00:00Z',
	GIT_COMMITTER_NAME: 'human',
	GIT_COMMITTER_EMAIL: 'human@example.invalid',
	GIT_COMMITTER_DATE: '2026-09-06T12:00:00Z'
};

afterAll(() => {
	cleanupTempRoots();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Put a line inside the marker block `id` of `text`. */
function fillBlock(text: string, id: string, line: string): string {
	const at = text.indexOf(`// codkit:begin ${id}`);
	if (at === -1) {
		throw new Error(`the block ${id} is not in the file`);
	}
	const endOfBegin = text.indexOf('\n', at) + 1;
	return `${text.slice(0, endOfBegin)}${line}\n${text.slice(endOfBegin)}`;
}

/** Scaffold a marker block and leave one line inside it, uncommitted. */
function dirtyBlock(fixture: CliFixture, path: string, id: string, line: string): void {
	const outcome = fixture.json([
		'marker',
		'new',
		path,
		'--id',
		id,
		'--type',
		'hook',
		'--owner',
		'workbench-core',
		'--reason',
		'conflict materialization fixture'
	]);
	expect(outcome.run.status, outcome.run.stderr).toBe(0);
	const target = fixture.treePath(path);
	writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), id, `\t\t${line}`), 'utf8');
}

/** Scaffold, edit and commit one file of the tree, bypassing the hook (F12). */
function commitInTree(fixture: CliFixture, path: string, id: string, line: string, message: string): string {
	dirtyBlock(fixture, path, id, line);
	const result = gitLocal({
		args: ['commit', '--quiet', '--all', '--message', message, '--no-verify'],
		cwd: fixture.treeDir,
		env: IDENTITY
	});
	expect(result.status, result.stderr).toBe(0);
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

/**
 * Move a patch artifact on the patchset side: one added line inside the patch's
 * marker block, with the hunk count corrected, so the shifted artifact is a
 * valid patch that applies to the pin and carries a patchset-authored line.
 */
function shiftPatchsetArtifact(fixture: CliFixture, artifact: string, line: string): void {
	const path = fixture.patchesPath(artifact);
	const lines = readFileSync(path, 'utf8').split('\n');
	const out: string[] = [];
	let hunkHeader = -1;
	let inserted = false;
	for (const current of lines) {
		if (current.startsWith('@@ ')) {
			hunkHeader = out.length;
			out.push(current);
			continue;
		}
		out.push(current);
		if (!inserted && hunkHeader !== -1 && current.startsWith('+') && current.includes('codkit:begin')) {
			out.push(`+${line}`);
			inserted = true;
		}
	}
	expect(inserted, `the fixture artifact ${artifact} has no marker block to extend`).toBe(true);
	const header = out[hunkHeader] ?? '';
	const fixed = header.replace(
		/^(@@ -\d+(?:,\d+)? \+\d+)(?:,(\d+))? @@(.*)$/,
		(_all, prefix: string, count: string | undefined, rest: string) => {
			const was = count === undefined ? 1 : Number(count);
			return `${prefix},${was + 1} @@${rest}`;
		}
	);
	expect(fixed, `could not fix the hunk count of ${artifact}: "${header}"`).not.toBe(header);
	out[hunkHeader] = fixed;
	writeFileSync(path, out.join('\n'), 'utf8');
}

/** The simulated human: resolve one diff3 conflict by keeping ours and theirs, in that order. */
function resolveConflict(text: string, path: string): string {
	const start = text.indexOf('<<<<<<< ours');
	const end = text.indexOf('>>>>>>> theirs');
	if (start === -1 || end === -1) {
		throw new Error(`no conflict markers in ${path}`);
	}
	const afterEnd = text.indexOf('\n', end) + 1;
	const lines = text.slice(start, afterEnd).split('\n');
	const baseSeparator = lines.indexOf('||||||| base');
	const mergeSeparator = lines.indexOf('=======');
	const ours = lines.slice(1, baseSeparator);
	const theirs = lines.slice(mergeSeparator + 1, -2);
	return `${text.slice(0, start)}${[...ours, ...theirs].join('\n')}\n${text.slice(afterEnd)}`;
}

type ConflictFixture = {
	readonly fixture: CliFixture;
	readonly patchHeadBefore: string;
	readonly treeHeadBefore: string;
	readonly branchTipBefore: string;
	/** sha256 of the pre-run bytes, the comparison S27 shows rather than asserts. */
	readonly treeFileHash: string;
	readonly artifactHash: string;
};

/** The conflict state: F shifted in patchset AND edited in the tree; G committed when asked. */
function makeConflictState(label: string, withCommit: boolean): ConflictFixture {
	const fixture = makeCliFixture(label);
	expect(fixture.run(['load']).status).toBe(0);
	const patchHeadBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
	shiftPatchsetArtifact(fixture, EXAMPLE_PATCH, `\t\t${PATCHSET_LINE}`);
	// The tree edits F inside the block the fixture patch already carries (the
	// load materialized it), on the other side of the two repositories.
	const target = fixture.treePath(EXAMPLE_PART_PATH);
	writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), F_BLOCK_ID, `\t\t${TREE_LINE}`), 'utf8');
	if (withCommit) {
		commitInTree(fixture, UTIL_PATH, G_BLOCK_ID, `\t\t${G_COMMITTED_LINE}`, 'work: G commits the util change');
	}
	return {
		fixture,
		patchHeadBefore,
		treeHeadBefore: fixture.git(['rev-parse', 'HEAD']).stdout.trim(),
		branchTipBefore: fixture.git(['rev-parse', 'refs/heads/codkit/applied/t1']).stdout.trim(),
		treeFileHash: hashOf(fixture.treePath(EXAMPLE_PART_PATH)),
		artifactHash: hashOf(fixture.patchesPath(EXAMPLE_PATCH))
	};
}

function transactionPath(fixture: CliFixture): string {
	return join(fixture.patchesDir, ...SYNC_TRANSACTION_RELATIVE_PATH.split('/'));
}

function hashOf(absolute: string): string {
	return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

/** Patchset commits since `since`, oldest first, with their replay trailers. */
function patchsetCommitsSince(fixture: CliFixture, since: string): readonly { sha: string; subject: string; syncTrailers: string[] }[] {
	const rows = fixture.patchGit(['log', '--reverse', '--format=%H%x00%s', `${since}..HEAD`]).stdout.trim();
	return (rows === '' ? [] : rows.split('\n')).map((row) => {
		const [sha = '', subject = ''] = row.split('\0');
		const trailers = fixture
			.patchGit(['log', '-1', `--format=%(trailers:key=Codkit-Sync-Transaction,valueonly)`, sha])
			.stdout.trim()
			.split('\n')
			.filter((line) => line !== '');
		return { sha, subject, syncTrailers: trailers };
	});
}

// ---------------------------------------------------------------------------
// S26
// ---------------------------------------------------------------------------

describe('S26: the conflict materializes as diff3; a human resolves it; sync --continue finishes', () => {
	let setup: ConflictFixture;
	let outcome: { run: Run; envelope: Envelope };

	beforeAll(() => {
		setup = makeConflictState('sync-s26', true);
		outcome = setup.fixture.json(['sync']);
	});

	it('exits 1 naming the file, with the markers inside its codkit block', () => {
		expect(outcome.run.status).toBe(1);
		const [error] = outcome.envelope.errors;
		expect(error?.code).toBe('CK-E-BOTH-SIDES-EDITED');
		expect(error?.message).toContain(EXAMPLE_PART_PATH);
		expect(error?.message).toContain('diff3 markers');
		expect(error?.hint).toContain('codkit sync --continue');
		expect(error?.hint).toContain('codkit sync --abort');
		const treeFile = readFileSync(setup.fixture.treePath(EXAMPLE_PART_PATH), 'utf8');
		const begin = treeFile.indexOf(`// codkit:begin ${F_BLOCK_ID}`);
		const end = treeFile.indexOf(`// codkit:end ${F_BLOCK_ID}`);
		const conflictStart = treeFile.indexOf('<<<<<<< ours');
		// The markers sit inside the block, where the resolution has to keep them.
		expect(begin).toBeGreaterThan(-1);
		expect(conflictStart).toBeGreaterThan(begin);
		expect(conflictStart).toBeLessThan(end);
		expect(treeFile).toContain('<<<<<<< ours');
		expect(treeFile).toContain('||||||| base');
		expect(treeFile).toContain('>>>>>>> theirs');
		expect(treeFile).toContain(TREE_LINE);
		expect(treeFile).toContain(PATCHSET_LINE);
	});

	it('the transaction is live with conflicts[] and the ours-snapshot; load and save refuse over it', () => {
		expect(typeof outcome.envelope.data['transaction']).toBe('string');
		const record = JSON.parse(readFileSync(transactionPath(setup.fixture), 'utf8')) as {
			conflicts: { path: string; materialized: string | null }[];
			rewrite: { repo: string; path: string; blob: string | null }[];
		};
		expect(record.conflicts).toEqual([{ path: EXAMPLE_PART_PATH, materialized: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
		const ours = record.rewrite.find((entry) => entry.repo === 'tree' && entry.path === EXAMPLE_PART_PATH);
		expect(ours?.blob).toMatch(/^[0-9a-f]{40}$/);

		const load = setup.fixture.json(['load']);
		expect(load.run.status).toBe(1);
		expect(load.envelope.errors.map((error) => error.code)).toEqual(['CK-E-SYNC-IN-PROGRESS']);
		const save = setup.fixture.json(['save']);
		expect(save.run.status).toBe(1);
		expect(save.envelope.errors.map((error) => error.code)).toEqual(['CK-E-SYNC-IN-PROGRESS']);
		const status = setup.fixture.json(['status']);
		expect(
			status.envelope.messages.some((message) =>
				message.text.startsWith(`sync in progress: ${outcome.envelope.data['transaction']}, conflicts: 1`)
			)
		).toBe(true);
	});

	it('sync --continue refuses while the markers remain, naming the file', () => {
		const refused = setup.fixture.json(['sync', '--continue']);
		expect(refused.run.status).toBe(1);
		expect(refused.envelope.errors.map((error) => error.code)).toEqual(['CK-E-BOTH-SIDES-EDITED']);
		expect(refused.envelope.errors[0]?.message).toContain(EXAMPLE_PART_PATH);
		expect(refused.envelope.errors[0]?.message).toContain('markers');
		expect(existsSync(transactionPath(setup.fixture))).toBe(true);
	});

	it('after the resolution: exit 0, both changes in the artifact, G replayed, the record gone', () => {
		// The simulated human: keep both sides, inside the block.
		const target = setup.fixture.treePath(EXAMPLE_PART_PATH);
		writeFileSync(target, resolveConflict(readFileSync(target, 'utf8'), EXAMPLE_PART_PATH), 'utf8');

		const continued = setup.fixture.json(['sync', '--continue']);

		expect(continued.run.status, continued.run.stderr).toBe(0);
		expect(continued.envelope.data['status']).toBe('synced');
		const artifact = readFileSync(setup.fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
		expect(artifact).toContain(TREE_LINE);
		expect(artifact).toContain(PATCHSET_LINE);
		const treeFile = readFileSync(target, 'utf8');
		expect(treeFile).toContain(TREE_LINE);
		expect(treeFile).toContain(PATCHSET_LINE);
		// G reached patchset history as the transaction's own commit.
		const commits = patchsetCommitsSince(setup.fixture, setup.patchHeadBefore);
		expect(commits.map((commit) => commit.subject)).toEqual(['work: G commits the util change']);
		expect(commits[0]?.syncTrailers.length).toBe(1);
		expect(setup.fixture.git(['status', '--porcelain']).stdout).toBe('');
		expect(existsSync(transactionPath(setup.fixture))).toBe(false);
		const load = setup.fixture.run(['load']);
		expect(load.status).toBe(0);
		expect(load.stdout).toContain('up to date');
	});
});

// ---------------------------------------------------------------------------
// S27
// ---------------------------------------------------------------------------

describe('S27: sync --abort restores everything, proven by hashes of distinctive pre-run bytes', () => {
	it('after materialization: byte for byte, both HEADs, the artifact, no record', () => {
		const setup = makeConflictState('sync-s27-materialized', false);
		const treeStatusBefore = setup.fixture.git(['status', '--porcelain']).stdout;
		const stopped = setup.fixture.json(['sync']);
		expect(stopped.run.status).toBe(1);

		const aborted = setup.fixture.json(['sync', '--abort']);

		expect(aborted.run.status, aborted.run.stderr).toBe(0);
		expect(aborted.envelope.data['status']).toBe('aborted');
		// Shown, not merely asserted: the hashes captured before the run over
		// bytes made distinctive on purpose, against what the abort produced.
		const after = {
			treeFile: hashOf(setup.fixture.treePath(EXAMPLE_PART_PATH)),
			artifact: hashOf(setup.fixture.patchesPath(EXAMPLE_PATCH)),
			treeHead: setup.fixture.git(['rev-parse', 'HEAD']).stdout.trim(),
			branchTip: setup.fixture.git(['rev-parse', 'refs/heads/codkit/applied/t1']).stdout.trim(),
			patchsetHead: setup.fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()
		};
		process.stdout.write(
			`S27 abort-after-materialization hash proof: ${JSON.stringify(
				{
					before: {
						treeFile: setup.treeFileHash,
						artifact: setup.artifactHash,
						treeHead: setup.treeHeadBefore,
						branchTip: setup.branchTipBefore,
						patchsetHead: setup.patchHeadBefore
					},
					after
				},
				null,
				2
			)}\n`
		);
		expect(after.treeFile).toBe(setup.treeFileHash);
		expect(after.artifact).toBe(setup.artifactHash);
		expect(after.treeHead).toBe(setup.treeHeadBefore);
		expect(after.branchTip).toBe(setup.branchTipBefore);
		expect(after.patchsetHead).toBe(setup.patchHeadBefore);
		expect(setup.fixture.git(['status', '--porcelain']).stdout).toBe(treeStatusBefore);
		expect(existsSync(transactionPath(setup.fixture))).toBe(false);
	});

	it("after a crashed continuation: also takes this run's patchset commit off the branch", () => {
		const setup = makeConflictState('sync-s27-state-committed', true);
		expect(setup.fixture.json(['sync']).run.status).toBe(1);
		const target = setup.fixture.treePath(EXAMPLE_PART_PATH);
		writeFileSync(target, resolveConflict(readFileSync(target, 'utf8'), EXAMPLE_PART_PATH), 'utf8');

		const crashed = setup.fixture.run(['sync', '--continue'], {
			[CODKIT_E2E_TEST_BUILD]: '1',
			[SYNC_TEST_CRASH_ENV]: 'state-committed'
		});
		expect(crashed.status).toBe(SYNC_TEST_CRASH_EXIT_CODE);
		expect(patchsetCommitsSince(setup.fixture, setup.patchHeadBefore).length).toBe(1);

		const aborted = setup.fixture.json(['sync', '--abort']);

		expect(aborted.run.status, aborted.run.stderr).toBe(0);
		expect(setup.fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()).toBe(setup.patchHeadBefore);
		expect(patchsetCommitsSince(setup.fixture, setup.patchHeadBefore)).toEqual([]);
		expect(hashOf(target)).toBe(setup.treeFileHash);
		expect(hashOf(setup.fixture.patchesPath(EXAMPLE_PATCH))).toBe(setup.artifactHash);
		expect(setup.fixture.git(['rev-parse', 'HEAD']).stdout.trim()).toBe(setup.treeHeadBefore);
		expect(existsSync(transactionPath(setup.fixture))).toBe(false);
	});

	it('after a crashed rebuild: also returns the tree branch and HEAD', () => {
		const setup = makeConflictState('sync-s27-mark-written', true);
		expect(setup.fixture.json(['sync']).run.status).toBe(1);
		const target = setup.fixture.treePath(EXAMPLE_PART_PATH);
		writeFileSync(target, resolveConflict(readFileSync(target, 'utf8'), EXAMPLE_PART_PATH), 'utf8');
		const crashed = setup.fixture.run(['sync', '--continue'], {
			[CODKIT_E2E_TEST_BUILD]: '1',
			[SYNC_TEST_CRASH_ENV]: 'mark-written'
		});
		expect(crashed.status).toBe(SYNC_TEST_CRASH_EXIT_CODE);
		// The rebuild moved the branch before the crash; the abort must return it.
		expect(setup.fixture.git(['rev-parse', 'refs/heads/codkit/applied/t1']).stdout.trim()).not.toBe(setup.branchTipBefore);

		const aborted = setup.fixture.json(['sync', '--abort']);

		expect(aborted.run.status, aborted.run.stderr).toBe(0);
		expect(setup.fixture.git(['rev-parse', 'HEAD']).stdout.trim()).toBe(setup.treeHeadBefore);
		expect(setup.fixture.git(['rev-parse', 'refs/heads/codkit/applied/t1']).stdout.trim()).toBe(setup.branchTipBefore);
		expect(hashOf(target)).toBe(setup.treeFileHash);
		expect(hashOf(setup.fixture.patchesPath(EXAMPLE_PATCH))).toBe(setup.artifactHash);
		expect(setup.fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()).toBe(setup.patchHeadBefore);
		expect(existsSync(transactionPath(setup.fixture))).toBe(false);
	});

	it('a foreign commit on top refuses the abort, naming it, and touches nothing', () => {
		const setup = makeConflictState('sync-s27-foreign', false);
		expect(setup.fixture.json(['sync']).run.status).toBe(1);
		const foreign = gitLocal({
			args: ['commit', '--quiet', '--all', '--message', 'human: work above the stopped sync', '--no-verify'],
			cwd: setup.fixture.patchesDir,
			env: IDENTITY
		});
		expect(foreign.status, foreign.stderr).toBe(0);
		const foreignHead = setup.fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();

		const refused = setup.fixture.json(['sync', '--abort']);

		expect(refused.run.status).toBe(1);
		expect(refused.envelope.errors.map((error) => error.code)).toEqual(['CK-E-SYNC-IN-PROGRESS']);
		expect(refused.envelope.errors[0]?.message).toContain(foreignHead.slice(0, 8));
		expect(refused.envelope.errors[0]?.message).toContain('human: work above the stopped sync');
		// Nothing was touched: the commit stands, the record stays, the markers stay.
		expect(setup.fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()).toBe(foreignHead);
		expect(existsSync(transactionPath(setup.fixture))).toBe(true);
		expect(readFileSync(setup.fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain('<<<<<<< ours');
	});
});

// ---------------------------------------------------------------------------
// The crash matrix: every atom, then --continue and then --abort
// ---------------------------------------------------------------------------

describe('a crash at any atom: --continue and --abort each reach a defined state', () => {
	/** The two atoms of the stop itself fire in the first run; the three of the continuation fire in `sync --continue`. */
	const STOP_ATOMS = ['transaction-written', 'conflict-materialized'] as const;
	const CONTINUATION_ATOMS = ['state-committed', 'worktree-moved', 'mark-written'] as const;

	/** Crash at `stage`, wherever that stage lives, leaving the fixture in its crashed state. */
	function crashAt(label: string, stage: string): ConflictFixture {
		const setup = makeConflictState(label, true);
		if ((STOP_ATOMS as readonly string[]).includes(stage)) {
			const crashed = setup.fixture.run(['sync'], { [CODKIT_E2E_TEST_BUILD]: '1', [SYNC_TEST_CRASH_ENV]: stage });
			expect(crashed.status, crashed.stderr).toBe(SYNC_TEST_CRASH_EXIT_CODE);
			return setup;
		}
		expect(setup.fixture.json(['sync']).run.status).toBe(1);
		const target = setup.fixture.treePath(EXAMPLE_PART_PATH);
		writeFileSync(target, resolveConflict(readFileSync(target, 'utf8'), EXAMPLE_PART_PATH), 'utf8');
		const crashed = setup.fixture.run(['sync', '--continue'], {
			[CODKIT_E2E_TEST_BUILD]: '1',
			[SYNC_TEST_CRASH_ENV]: stage
		});
		expect(crashed.status, crashed.stderr).toBe(SYNC_TEST_CRASH_EXIT_CODE);
		return setup;
	}

	for (const stage of [...STOP_ATOMS, ...CONTINUATION_ATOMS]) {
		it(`crash at ${stage}: --continue reaches a defined state, or refuses saying why`, () => {
			const setup = crashAt(`sync-crash-continue-${stage}`, stage);
			const continued = setup.fixture.json(['sync', '--continue']);

			if (stage === 'transaction-written') {
				// The merge never reached the file: no human ever saw markers.
				expect(continued.run.status).toBe(1);
				expect(continued.envelope.errors.map((error) => error.code)).toEqual(['CK-E-BOTH-SIDES-EDITED']);
				expect(continued.envelope.errors[0]?.message).toContain('never reached');
				expect(continued.envelope.errors[0]?.message).toContain(EXAMPLE_PART_PATH);
				expect(existsSync(transactionPath(setup.fixture))).toBe(true);
				return;
			}
			if (stage === 'conflict-materialized') {
				// The markers are there, unresolved.
				expect(continued.run.status).toBe(1);
				expect(continued.envelope.errors.map((error) => error.code)).toEqual(['CK-E-BOTH-SIDES-EDITED']);
				expect(continued.envelope.errors[0]?.message).toContain('markers');
				expect(existsSync(transactionPath(setup.fixture))).toBe(true);
				return;
			}
			// A crashed continuation resumes and completes.
			expect(continued.run.status, continued.run.stderr).toBe(0);
			expect(continued.envelope.data['status']).toBe('synced');
			expect(existsSync(transactionPath(setup.fixture))).toBe(false);
			const artifact = readFileSync(setup.fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
			expect(artifact).toContain(TREE_LINE);
			expect(artifact).toContain(PATCHSET_LINE);
		});

		it(`crash at ${stage}: --abort returns the pre-run state, hashes shown`, () => {
			const setup = crashAt(`sync-crash-abort-${stage}`, stage);

			const aborted = setup.fixture.json(['sync', '--abort']);

			expect(aborted.run.status, aborted.run.stderr).toBe(0);
			const after = {
				treeFile: hashOf(setup.fixture.treePath(EXAMPLE_PART_PATH)),
				artifact: hashOf(setup.fixture.patchesPath(EXAMPLE_PATCH)),
				treeHead: setup.fixture.git(['rev-parse', 'HEAD']).stdout.trim(),
				branchTip: setup.fixture.git(['rev-parse', 'refs/heads/codkit/applied/t1']).stdout.trim(),
				patchsetHead: setup.fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()
			};
			process.stdout.write(
				`S27 crash-matrix abort proof (${stage}): ${JSON.stringify({
					before: {
						treeFile: setup.treeFileHash,
						artifact: setup.artifactHash,
						treeHead: setup.treeHeadBefore,
						branchTip: setup.branchTipBefore,
						patchsetHead: setup.patchHeadBefore
					},
					after
				})}\n`
			);
			expect(after.treeFile).toBe(setup.treeFileHash);
			expect(after.artifact).toBe(setup.artifactHash);
			expect(after.treeHead).toBe(setup.treeHeadBefore);
			expect(after.branchTip).toBe(setup.branchTipBefore);
			expect(after.patchsetHead).toBe(setup.patchHeadBefore);
			expect(existsSync(transactionPath(setup.fixture))).toBe(false);
		});
	}
});
