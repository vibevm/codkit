// e2e: the two-way `codkit sync` (PROP-007 sec. 5a ##CMD-SYNC-TWO-WAY,
// PROP-008 sec. 5a ##SYNC-TWO-PASS/##SYNC-TRANSACTION; campaign
// TREE-COMMITS-SAVE Phase 8 + 8b, decisions D15-D21).
//
// S24: one run extracts the tree's committed and uncommitted work and applies
// what the patch set moved, per target, under a transaction that retires at
// the end. S25 (as of Phase 8b): a file both sides changed stops the run with
// the 3-way materialized as diff3 markers in the tree file under a live
// transaction - the deep proof of the stop and its recovery (resolve +
// `sync --continue`, `sync --abort`) lives in syncConflict.test.ts.
//
// The crash atoms prove the second property of the phase at every checkpoint
// seam: a process loss at any recorded atom leaves the transaction file with
// the atoms done so far, and `load`/`save` answer CK-E-SYNC-IN-PROGRESS over
// the half-applied state instead of operating on it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitLocal } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import {
	SYNC_TEST_CRASH_ENV,
	SYNC_TEST_CRASH_EXIT_CODE,
	SYNC_TEST_CRASH_STAGES,
	SYNC_TRANSACTION_RELATIVE_PATH
} from '../../src/lib/syncTransaction.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { CODKIT_E2E_TEST_BUILD, makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture, Envelope, Run } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

/** F: the file whose patch artifact the patchset side moves. */
const EXAMPLE_PATCH = 'delta/patches/src__vs__workbench__browser__parts__example__examplePart.ts.ckpatch';
/** G: the file the tree commits a change to. */
const UTIL_PATH = 'src/vs/base/common/util.ts';
/** H: the file the tree leaves an uncommitted change in. */
const LIFECYCLE_PATH = 'src/vs/base/common/lifecycle.ts';
const LIFECYCLE_PATCH = 'delta/patches/src__vs__base__common__lifecycle.ts.ckpatch';

const G_BLOCK_ID = 'CK-base-905';
const H_BLOCK_ID = 'CK-base-906';

const PATCHSET_LINE = '// the patchset side of F';
const G_COMMITTED_LINE = '// the committed side of G';
const H_UNCOMMITTED_LINE = '// the uncommitted side of H';

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
		'two-way sync fixture'
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

function transactionPath(fixture: CliFixture): string {
	return join(fixture.patchesDir, ...SYNC_TRANSACTION_RELATIVE_PATH.split('/'));
}

/** The transaction record of a crashed run, as the recovery of Phase 8b reads it. */
function readTransaction(fixture: CliFixture): {
	id: string;
	startedAt: string;
	patchsetCommits: string[];
	consumedRef: string | null;
	conflicts: { path: string; materialized: string | null }[];
	rewrite: { repo: string; path: string; blob: string | null }[];
} {
	expect(existsSync(transactionPath(fixture)), 'the sync transaction file should exist').toBe(true);
	return JSON.parse(readFileSync(transactionPath(fixture), 'utf8')) as {
		id: string;
		startedAt: string;
		patchsetCommits: string[];
		consumedRef: string | null;
		conflicts: { path: string; materialized: string | null }[];
		rewrite: { repo: string; path: string; blob: string | null }[];
	};
}

/** Patchset commits since `since`, oldest first, with their replay trailers. */
function patchsetCommitsSince(
	fixture: CliFixture,
	since: string
): readonly { sha: string; subject: string; treeTrailers: string[]; syncTrailers: string[] }[] {
	const rows = fixture.patchGit(['log', '--reverse', '--format=%H%x00%s', `${since}..HEAD`]).stdout.trim();
	return (rows === '' ? [] : rows.split('\n')).map((row) => {
		const [sha = '', subject = ''] = row.split('\0');
		const trailers = (name: string): string[] =>
			fixture
				.patchGit(['log', '-1', `--format=%(trailers:key=${name},valueonly)`, sha])
				.stdout.trim()
				.split('\n')
				.filter((line) => line !== '');
		return { sha, subject, treeTrailers: trailers('Codkit-Tree-Commit'), syncTrailers: trailers('Codkit-Sync-Transaction') };
	});
}

/** The consumed refs `save`/`--discard` leave behind, as `ref -> sha` rows. */
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

/** The S24 state: F shifted in patchset, G committed in the tree, H uncommitted. */
function makeS24State(label: string): { fixture: CliFixture; committed: string; patchHeadBefore: string } {
	const fixture = makeCliFixture(label);
	expect(fixture.run(['load']).status).toBe(0);
	const patchHeadBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
	shiftPatchsetArtifact(fixture, EXAMPLE_PATCH, `\t\t${PATCHSET_LINE}`);
	const committed = commitInTree(fixture, UTIL_PATH, G_BLOCK_ID, G_COMMITTED_LINE, 'work: G commits the util change');
	dirtyBlock(fixture, LIFECYCLE_PATH, H_BLOCK_ID, H_UNCOMMITTED_LINE);
	return { fixture, committed, patchHeadBefore };
}

/**
 * The --discard state: F shifted in patchset, G committed in the tree, and no
 * uncommitted edit - the flag speaks about commits only, and mixed dirt is the
 * refusal D11 keeps on purpose (covered for the engine in treeCommits tests).
 */
function makeDiscardState(label: string): { fixture: CliFixture; committed: string; patchHeadBefore: string } {
	const fixture = makeCliFixture(label);
	expect(fixture.run(['load']).status).toBe(0);
	const patchHeadBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
	shiftPatchsetArtifact(fixture, EXAMPLE_PATCH, `\t\t${PATCHSET_LINE}`);
	const committed = commitInTree(fixture, UTIL_PATH, G_BLOCK_ID, G_COMMITTED_LINE, 'work: G commits the util change');
	return { fixture, committed, patchHeadBefore };
}

describe('S24: sync merges non-overlapping work of both sides in one run', () => {
	let setup: ReturnType<typeof makeS24State>;
	let outcome: { run: Run; envelope: Envelope };

	beforeAll(() => {
		setup = makeS24State('sync-s24');
		outcome = setup.fixture.json(['sync']);
	});

	it('exits 0 and reports the settled merge', () => {
		expect(outcome.run.status, outcome.run.stderr).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		expect(outcome.envelope.data['status']).toBe('synced');
		expect(typeof outcome.envelope.data['transaction']).toBe('string');
	});

	it('delivers F from the patch set and keeps G and H from the tree', () => {
		const example = readFileSync(setup.fixture.treePath(EXAMPLE_PART_PATH), 'utf8');
		expect(example).toContain(PATCHSET_LINE);
		expect(readFileSync(setup.fixture.treePath(UTIL_PATH), 'utf8')).toContain(G_COMMITTED_LINE);
		expect(readFileSync(setup.fixture.treePath(LIFECYCLE_PATH), 'utf8')).toContain(H_UNCOMMITTED_LINE);
		// The tree's own sides of F were never there - only the patchset side is.
		expect(example).not.toContain(G_COMMITTED_LINE);
		expect(example).not.toContain(H_UNCOMMITTED_LINE);
	});

	it('leaves the tree clean and the patchset holding all three', () => {
		expect(setup.fixture.git(['status', '--porcelain']).stdout).toBe('');
		// G: one replayed patchset commit, named for its tree commit and for the
		// transaction that made it (D20's trailer).
		const commits = patchsetCommitsSince(setup.fixture, setup.patchHeadBefore);
		expect(commits.map((commit) => commit.subject)).toEqual(['work: G commits the util change']);
		expect(commits[0]?.treeTrailers).toEqual([setup.committed]);
		expect(commits[0]?.syncTrailers.length).toBe(1);
		// H: the uncommitted half reaches its artifact and stays uncommitted,
		// exactly as an uncommitted edit would under `save`. F's shift is the
		// patchset's own uncommitted edit and stays that way too - sync delivers
		// it to the tree, committing patchset work is not its job. (No leading
		// trim here: the porcelain XY columns start with a space.)
		expect(readFileSync(setup.fixture.patchesPath(LIFECYCLE_PATCH), 'utf8')).toContain(H_UNCOMMITTED_LINE);
		expect(
			setup.fixture
				.patchGit(['status', '--porcelain', '--', 'delta/'])
				.stdout.split('\n')
				.filter((line) => line !== '')
				.sort()
		).toEqual([`?? ${LIFECYCLE_PATCH}`, ` M ${EXAMPLE_PATCH}`].sort());
		// The consumed line of G stays reachable.
		expect(consumedRefs(setup.fixture).map((row) => row.sha)).toEqual([setup.committed]);
	});

	it('retires the transaction and a following load is up to date', () => {
		expect(existsSync(transactionPath(setup.fixture))).toBe(false);
		const load = setup.fixture.run(['load']);
		expect(load.status).toBe(0);
		expect(load.stdout).toContain('up to date');
	});
});

describe('S25: both sides changed F - the stop is the materialized merge (Phase 8b)', () => {
	let fixture: CliFixture;
	let patchHeadBefore: string;
	let treeFileBefore: string;
	let artifactBefore: string;
	let outcome: { run: Run; envelope: Envelope };

	beforeAll(() => {
		fixture = makeCliFixture('sync-s25');
		expect(fixture.run(['load']).status).toBe(0);
		patchHeadBefore = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		shiftPatchsetArtifact(fixture, EXAMPLE_PATCH, `\t\t${PATCHSET_LINE}`);
		// The tree edits F too: the same file, inside the marker block the
		// fixture patch already carries, on the other side of the two
		// repositories.
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), 'CK-workbench-901', '\t\t// the tree side of F'), 'utf8');
		treeFileBefore = readFileSync(target, 'utf8');
		artifactBefore = readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8');
		outcome = fixture.json(['sync']);
	});

	it('exits 1 with CK-E-BOTH-SIDES-EDITED, the diff3 markers in the tree file, the transaction live', () => {
		expect(outcome.run.status).toBe(1);
		const [error] = outcome.envelope.errors;
		expect(error?.code).toBe('CK-E-BOTH-SIDES-EDITED');
		expect(error?.message).toContain(EXAMPLE_PART_PATH);
		expect(error?.message).toContain('diff3 markers');
		expect(error?.hint).toContain('codkit sync --continue');
		expect(error?.hint).toContain('codkit sync --abort');
		const treeFile = readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8');
		expect(treeFile).toContain('<<<<<<< ours');
		expect(treeFile).toContain('||||||| base');
		expect(treeFile).toContain('>>>>>>> theirs');
		expect(treeFile).toContain('// the tree side of F');
		expect(treeFile).toContain(PATCHSET_LINE);
		expect(typeof outcome.envelope.data['transaction']).toBe('string');
	});

	it('writes only the markers and the record: the record carries the ours-snapshot and the sha', () => {
		// The record is the recovery plan: the conflict file listed with its
		// materialized sha, and its pre-run bytes snapshotted (D20/D21).
		const record = readTransaction(fixture);
		expect(record.conflicts).toEqual([{ path: EXAMPLE_PART_PATH, materialized: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
		const ours = record.rewrite.find((entry) => entry.repo === 'tree' && entry.path === EXAMPLE_PART_PATH);
		expect(ours?.blob).toMatch(/^[0-9a-f]{40}$/);
		// Nothing else moved: no patchset ref, no touched artifact, no consumed
		// line (the markers and the record are the run's only writes).
		expect(fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()).toBe(patchHeadBefore);
		expect(readFileSync(fixture.patchesPath(EXAMPLE_PATCH), 'utf8')).toBe(artifactBefore);
		expect(consumedRefs(fixture).length).toBe(0);
	});

	it('sync --abort returns the file byte for byte and retires the record', () => {
		const abort = fixture.json(['sync', '--abort']);
		expect(abort.run.status, abort.run.stderr).toBe(0);
		expect(abort.envelope.data['status']).toBe('aborted');
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toBe(treeFileBefore);
		expect(existsSync(transactionPath(fixture))).toBe(false);
		// The world is the pre-run world: the unextracted tree edit is back, so
		// `load` answers with the ordinary guard - not with the transaction's
		// refusal. The record is gone; the engine no longer sees it.
		const load = fixture.json(['load']);
		expect(load.run.status).toBe(1);
		expect(load.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
	});
});

describe('--dry-run prints the classification and writes nothing', () => {
	let setup: ReturnType<typeof makeS24State>;
	let outcome: { run: Run; envelope: Envelope };
	let treeFileBefore: string;

	beforeAll(() => {
		setup = makeS24State('sync-dry-run');
		treeFileBefore = readFileSync(setup.fixture.treePath(EXAMPLE_PART_PATH), 'utf8');
		outcome = setup.fixture.json(['sync', '--dry-run']);
	});

	it('exits 0 with the plan of both sides', () => {
		expect(outcome.run.status, outcome.run.stderr).toBe(0);
		expect(outcome.envelope.data['status']).toBe('dry-run');
		const texts = outcome.envelope.messages.map((message) => message.text);
		expect(
			texts.some((text) =>
				text.startsWith(
					'sync plan: 1 tree commit(s) to replay, 2 changed file(s) to extract, 1 patchset-side artifact(s) to apply, 0 on both sides'
				)
			)
		).toBe(true);
		expect(texts.some((text) => text.startsWith('  apply from the patch set:') && text.includes(EXAMPLE_PATCH))).toBe(true);
	});

	it('writes nothing: no transaction, no commit, no tree byte', () => {
		expect(existsSync(transactionPath(setup.fixture))).toBe(false);
		expect(setup.fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()).toBe(setup.patchHeadBefore);
		expect(readFileSync(setup.fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toBe(treeFileBefore);
		expect(setup.fixture.git(['status', '--porcelain']).stdout).not.toBe('');
	});
});

describe('--discard drops the tree commits and takes the patchset side (D11/D15)', () => {
	let setup: ReturnType<typeof makeDiscardState>;
	let outcome: { run: Run; envelope: Envelope };

	beforeAll(() => {
		setup = makeDiscardState('sync-discard');
		outcome = setup.fixture.json(['sync', '--discard']);
	});

	it('exits 0 with the commits dropped and kept by a consumed ref', () => {
		expect(outcome.run.status, outcome.run.stderr).toBe(0);
		// Dropped: the commit is no longer reachable from HEAD.
		expect(setup.fixture.git(['merge-base', '--is-ancestor', setup.committed, 'HEAD']).status).not.toBe(0);
		// Kept: the consumed ref still reaches the whole discarded line.
		const refs = consumedRefs(setup.fixture);
		expect(refs.map((row) => row.sha)).toEqual([setup.committed]);
		expect(setup.fixture.git(['merge-base', '--is-ancestor', setup.committed, refs[0]?.ref ?? '']).status).toBe(0);
		expect(outcome.envelope.data['consumedRef']).toBe(refs[0]?.ref);
	});

	it('applies the patchset side of F and leaves the tree clean', () => {
		expect(readFileSync(setup.fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain(PATCHSET_LINE);
		expect(readFileSync(setup.fixture.treePath(UTIL_PATH), 'utf8')).not.toContain(G_COMMITTED_LINE);
		expect(setup.fixture.git(['status', '--porcelain']).stdout).toBe('');
		// Nothing was replayed: the drop is the whole story on the tree side.
		expect(patchsetCommitsSince(setup.fixture, setup.patchHeadBefore)).toEqual([]);
		expect(existsSync(transactionPath(setup.fixture))).toBe(false);
	});

	it('is refused under --ci, like the loss it names', () => {
		const fresh = makeDiscardState('sync-discard-ci');
		const refused = fresh.fixture.json(['sync', '--discard', '--ci']);
		expect(refused.run.status).toBe(2);
		expect(refused.envelope.errors.map((error) => error.code)).toEqual(['CK-E-CONFIG']);
	});

	it('refuses over mixed dirt: the flag speaks about commits, never about edits', () => {
		const fresh = makeS24State('sync-discard-mixed');
		const refused = fresh.fixture.json(['sync', '--discard']);
		expect(refused.run.status).toBe(1);
		expect(refused.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(existsSync(transactionPath(fresh.fixture))).toBe(false);
	});
});

describe('a crash at any recorded atom leaves the transaction and refuses load/save', () => {
	// The conflict atom ('conflict-materialized') fires only in a conflict run;
	// syncConflict.test.ts proves it together with its recovery.
	const stageCases = SYNC_TEST_CRASH_STAGES.filter((stage) => stage !== 'conflict-materialized').map((stage) => ({
		stage,
		/** Atoms recorded in the file when the crash lands: the replay commit exists from 'state-committed' on. */
		commitsRecorded: stage === 'transaction-written' ? 0 : 1
	}));

	for (const { stage, commitsRecorded } of stageCases) {
		it(`crash at ${stage}: the file holds ${commitsRecorded} commit(s) and both engines refuse`, () => {
			const setup = makeS24State(`sync-crash-${stage.replace('-', '-')}`);
			const crashed = setup.fixture.run(['sync'], {
				[CODKIT_E2E_TEST_BUILD]: '1',
				[SYNC_TEST_CRASH_ENV]: stage
			});
			expect(crashed.status).toBe(SYNC_TEST_CRASH_EXIT_CODE);

			// The record exists and carries the atoms done so far.
			const record = readTransaction(setup.fixture);
			expect(record.id).toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/);
			expect(record.patchsetCommits.length).toBe(commitsRecorded);

			// Both one-way commands refuse over the half-applied state.
			const load = setup.fixture.json(['load']);
			expect(load.run.status).toBe(1);
			expect(load.envelope.errors.map((error) => error.code)).toEqual(['CK-E-SYNC-IN-PROGRESS']);
			const save = setup.fixture.json(['save']);
			expect(save.run.status).toBe(1);
			expect(save.envelope.errors.map((error) => error.code)).toEqual(['CK-E-SYNC-IN-PROGRESS']);

			// status names the live transaction (D20's line, D10's data).
			const status = setup.fixture.json(['status']);
			expect(status.envelope.messages.some((message) => message.text === `sync in progress: ${record.id}, conflicts: 0`)).toBe(true);
			expect(status.envelope.data['syncInProgress']).toEqual({ id: record.id, conflicts: 0, startedAt: record.startedAt });

			// A second sync refuses over the live record too, naming it.
			const again = setup.fixture.json(['sync']);
			expect(again.run.status).toBe(1);
			expect(again.envelope.errors.map((error) => error.code)).toEqual(['CK-E-SYNC-IN-PROGRESS']);
		});
	}
});

describe('nothing moved on either side: the load engine answers up to date', () => {
	it('exits 0 printing up to date and writes no transaction', () => {
		const fixture = makeCliFixture('sync-settled');
		expect(fixture.run(['load']).status).toBe(0);

		const outcome = fixture.run(['sync']);

		expect(outcome.status, outcome.stderr).toBe(0);
		expect(outcome.stdout).toContain('up to date');
		expect(existsSync(transactionPath(fixture))).toBe(false);
	});
});

describe('the name sync is the two-way command now (S21 successor)', () => {
	it('runs as a real command with an envelope, not a usage error', () => {
		const fixture = makeCliFixture('sync-real-name');
		expect(fixture.run(['load']).status).toBe(0);

		const outcome = fixture.json(['sync']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data['status']).toBe('up-to-date');
		expect(outcome.run.stderr).not.toContain('renamed');
	});

	it('--abort and --continue without a stopped sync answer honestly', () => {
		const fixture = makeCliFixture('sync-abort-honest');
		expect(fixture.run(['load']).status).toBe(0);

		const outcome = fixture.json(['sync', '--abort']);

		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-CONFIG']);
		expect(outcome.envelope.errors[0]?.message).toContain('no stopped sync');
		expect(existsSync(transactionPath(fixture))).toBe(false);
	});
});
