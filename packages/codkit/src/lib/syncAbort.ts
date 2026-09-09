/** @scope spec://codkit/modules/codkit/PROP-008#SYNC-ABORT */
// `codkit sync --abort` (PROP-008 sec. 5a ##SYNC-ABORT; campaign
// TREE-COMMITS-SAVE, decision D21): put everything back where the run found
// it. The abort is the load-bearing half of the conflict-materialization
// phase - materializing markers is easy; the promise that the operator can
// always get back to where they were is what makes the markers safe to offer.
//
// The audits run before the first mutation and refuse - naming the commits -
// rather than discard anybody's work: this run's patchset commits are
// recognizable by the `Codkit-Sync-Transaction` trailer, a rebuild's tree
// commits by the generated identity (F13), and everything else on top is
// somebody else's. The mutations are ordered so an abort interrupted by a
// crash is restartable: each step idempotent, the record retired last.

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesEqual } from './bytes.ts';
import { runGit, runGitBytes } from './gitx.ts';
import { ckError, isCkError } from './messages.ts';
import type { CkError } from './messages.ts';
import { generatedBranchName } from './syncEngine.ts';
import type { TwoWayInput } from './syncRecovery.ts';
import { SYNC_TRANSACTION_TRAILER, retireSyncTransaction } from './syncTransaction.ts';
import type { SyncTransaction, SyncTransactionRewrite } from './syncTransaction.ts';
import { removeTreeMark, revParse, writeTreeMark } from './treeCache.ts';
import { checkTree } from './treeIdentity.ts';
import { assertGeneratedRefExclusive } from './worktrees.ts';

// ---------------------------------------------------------------------------
// The abort verdict: the errors are already on the envelope; this is the shape
// the dispatch of lib/syncRecovery.ts maps onto the run's result.
// ---------------------------------------------------------------------------

export type AbortOutcome = { readonly outcome: 'ok' } | { readonly outcome: 'blocked' } | { readonly outcome: 'unfit' };

// ---------------------------------------------------------------------------
// The restore primitive and the audits (moved verbatim from the transaction
// module; the record stays there, what an abort does with it lives here)
// ---------------------------------------------------------------------------

/** What `sync --abort` puts back, by repository, and what it removes (D21). */
export type RestoredSnapshots = {
	readonly restored: readonly { readonly repo: SyncTransactionRewrite['repo']; readonly path: string }[];
	readonly removed: readonly { readonly repo: SyncTransactionRewrite['repo']; readonly path: string }[];
};

/**
 * Restore every snapshotted byte of the record, in both repositories (D21):
 * present-before files get their pre-run bytes back (wx-temp + rename, mode
 * preserved - the `atomicReplace` precedent), absent-before files are removed.
 * The blobs are content-addressed in the object database, so the restore is
 * byte for byte. Idempotent by construction, which is what makes an abort
 * interrupted by a crash restartable: re-running it repeats no-ops where it
 * already landed and finishes the rest.
 */
export function restoreTransactionSnapshots(patchesDir: string, treeDir: string, record: SyncTransaction): RestoredSnapshots {
	const restored: { repo: SyncTransactionRewrite['repo']; path: string }[] = [];
	const removed: { repo: SyncTransactionRewrite['repo']; path: string }[] = [];
	for (const entry of record.rewrite) {
		const repoDir = entry.repo === 'patchset' ? patchesDir : treeDir;
		const absolute = join(repoDir, ...entry.path.split('/'));
		if (entry.blob === null) {
			if (existsSync(absolute)) {
				rmSync(absolute, { force: true });
				removed.push({ repo: entry.repo, path: entry.path });
			}
			continue;
		}
		const blob = runGitBytes({ args: ['cat-file', 'blob', entry.blob], cwd: repoDir });
		if (blob.status !== 0) {
			throw ckError(
				'INTERNAL',
				`cannot restore ${entry.path} of the ${entry.repo} repository: snapshot blob ${entry.blob} is not in the object database: ${blob.stderr.trim()}`,
				're-run with --verbose and attach the output to a bug report'
			);
		}
		if (existsSync(absolute) && blobEqualsFile(blob.stdout, absolute)) {
			continue;
		}
		writeSnapshotBytes(repoDir, entry.path, blob.stdout);
		restored.push({ repo: entry.repo, path: entry.path });
	}
	return { restored, removed };
}

/** One commit above a recorded head, named for the refusal that protects it. */
export type CommitAboveRecord = { readonly sha: string; readonly subject: string };

/** The audit `sync --abort` runs before touching anything (D21). */
export type AboveRecordAudit =
	{ readonly moved: false } | { readonly moved: true; readonly foreign: readonly CommitAboveRecord[]; readonly offLine: boolean };

/**
 * The patchset half of the abort audit (D21): commits above the recorded HEAD
 * are removable only when every one of them belongs to this run - it made each
 * with the `Codkit-Sync-Transaction` trailer - and the current HEAD still sits
 * on the recorded line. A foreign commit, or a HEAD that left the line
 * (rebase, switch, reset), refuses the abort instead of discarding it.
 */
export function auditPatchsetAboveRecord(patchesDir: string, record: SyncTransaction): AboveRecordAudit {
	const head = revParse(patchesDir, 'HEAD');
	if (head === null || head === record.patchset.head) {
		return { moved: false };
	}
	const onLine = runGit({ args: ['merge-base', '--is-ancestor', record.patchset.head, 'HEAD'], cwd: patchesDir });
	const listed = runGit({ args: ['rev-list', '--format=%H%x00%s', `${record.patchset.head}..HEAD`], cwd: patchesDir });
	const foreign: CommitAboveRecord[] = [];
	if (listed.status === 0) {
		for (const row of listed.stdout.trim().split('\n')) {
			if (!row.startsWith('commit ')) {
				continue;
			}
			const sha = row.slice('commit '.length).trim();
			const subject = subjectOf(patchesDir, sha);
			const trailer = runGit({
				args: ['log', '-1', `--format=%(trailers:key=${SYNC_TRANSACTION_TRAILER},valueonly)`, sha],
				cwd: patchesDir
			});
			if (trailer.status !== 0 || trailer.stdout.trim() !== record.id) {
				foreign.push({ sha, subject });
			}
		}
	}
	return { moved: true, foreign, offLine: listed.status !== 0 || onLine.status !== 0 };
}

/**
 * The tree half of the abort audit (D21): commits above the recorded tree HEAD
 * are removable only when every one of them is a generated commit of a rebuild
 * (the codkit author plus the `Codkit-Upstream-Pin` trailer, F13) - a commit a
 * human made on top is theirs, and aborting must not orphan it silently. No
 * descent check here, unlike the patch set: the rebuild legitimately moves the
 * tree onto a line that does not contain the recorded HEAD (that is how a
 * consumed foreign commit stops being reachable, D6), so "not a descendant" is
 * the normal shape of a crashed rebuild, not foreign surgery.
 */
export type TreeAboveRecordAudit =
	{ readonly moved: false } | { readonly moved: true; readonly foreign: readonly CommitAboveRecord[]; readonly readable: boolean };

export function auditTreeAboveRecord(treeDir: string, record: SyncTransaction): TreeAboveRecordAudit {
	const head = revParse(treeDir, 'HEAD');
	if (head === null || head === record.tree.head) {
		return { moved: false };
	}
	const listed = runGit({ args: ['rev-list', '--format=%H%x00%s', `${record.tree.head}..HEAD`], cwd: treeDir });
	const foreign: CommitAboveRecord[] = [];
	if (listed.status === 0) {
		for (const row of listed.stdout.trim().split('\n')) {
			if (!row.startsWith('commit ')) {
				continue;
			}
			const sha = row.slice('commit '.length).trim();
			const subject = subjectOf(treeDir, sha);
			if (!isGeneratedTreeCommit(treeDir, sha)) {
				foreign.push({ sha, subject });
			}
		}
	}
	return { moved: true, foreign, readable: listed.status === 0 };
}

/** The generated-commit predicate of D2/F13: codkit author and the pin trailer, both. */
function isGeneratedTreeCommit(treeDir: string, sha: string): boolean {
	const identity = runGit({ args: ['log', '-1', '--format=%ae%x00%(trailers:key=Codkit-Upstream-Pin,valueonly)', sha], cwd: treeDir });
	if (identity.status !== 0) {
		return false;
	}
	const [email = '', trailer = ''] = identity.stdout.trim().split('\0');
	return email === 'codkit@patchset.invalid' && trailer.trim() !== '';
}

function subjectOf(repoDir: string, sha: string): string {
	const subject = runGit({ args: ['log', '-1', '--format=%s', sha], cwd: repoDir });
	return subject.status === 0 ? subject.stdout.trim() : '(subject unavailable)';
}

/** Whether a snapshot blob and a file on disk hold the same bytes. */
function blobEqualsFile(blob: Uint8Array, absolute: string): boolean {
	try {
		return bytesEqual(blob, readFileSync(absolute));
	} catch {
		return false;
	}
}

/**
 * Write restored snapshot bytes into one repository file, the durable way the
 * codebase writes single files (`atomicReplace` of reresolve.ts:240): wx-temp,
 * mode preserved, rename over the target.
 */
function writeSnapshotBytes(repoDir: string, path: string, bytes: Uint8Array): void {
	const absolute = join(repoDir, ...path.split('/'));
	let mode = 0o644;
	try {
		const before = lstatSync(absolute);
		if (before.isFile() && !before.isSymbolicLink()) {
			mode = before.mode & 0o7777;
		}
	} catch {
		// The file is new since the snapshot (the run created it); the default
		// mode is what a fresh regular file gets.
	}
	const temporary = `${absolute}.codkit-sync-restore-${randomUUID()}`;
	try {
		writeFileSync(temporary, bytes, { flag: 'wx', mode });
		chmodSync(temporary, mode);
		renameSync(temporary, absolute);
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (!isNoEntry(error)) {
				throw error;
			}
		}
	}
}

/** Whether an fs error says "not there" - the only absence a cleanup unlink may swallow. */
function isNoEntry(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

// ---------------------------------------------------------------------------
// The abort itself
// ---------------------------------------------------------------------------

/**
 * `codkit sync --abort`: put everything back where the run found it. The
 * audits run first and refuse - naming the commits - rather than discard
 * anybody's work; the mutations are ordered so an abort interrupted by a crash
 * is restartable (each step idempotent, the record retired last).
 */
export function abortStoppedSync(input: TwoWayInput, record: SyncTransaction): AbortOutcome {
	const { patchesDir, resolution, config, out } = input;
	const tree = resolution.path;
	const branch = generatedBranchName(config);

	// The abort writes into the tree by the record's say-so; an unfit tree is
	// not one to write into.
	const identity = checkTree(resolution, config, { mode: 'write', type: input.type });
	if (identity.fatal !== null) {
		out.addError(identity.fatal.toPayload());
		return { outcome: 'unfit' };
	}

	// Audits: everything that would make the abort destroy somebody else's
	// work, checked before the first mutation (D21).
	const patchsetAudit = auditPatchsetAboveRecord(patchesDir, record);
	if (patchsetAudit.moved && (patchsetAudit.offLine || patchsetAudit.foreign.length > 0)) {
		out.addError(abortRefusal('the patch set', patchsetAudit, record).toPayload());
		return { outcome: 'blocked' };
	}
	const treeAudit = auditTreeAboveRecord(tree, record);
	if (treeAudit.moved && (!treeAudit.readable || treeAudit.foreign.length > 0)) {
		out.addError(abortRefusal('the fork tree', { foreign: treeAudit.foreign, offLine: !treeAudit.readable }, record).toPayload());
		return { outcome: 'blocked' };
	}
	const symbolic = runGit({ args: ['symbolic-ref', '--quiet', 'HEAD'], cwd: tree });
	if (symbolic.status === 0 && symbolic.stdout.trim() !== `refs/heads/${branch}`) {
		out.addError(
			ckError(
				'SYNC-IN-PROGRESS',
				`cannot abort transaction ${record.id}: HEAD of the fork tree is on ${symbolic.stdout.trim()}, not the generated branch ${branch}`,
				'return HEAD to the generated branch by hand (git switch), then codkit sync --abort again'
			).toPayload()
		);
		return { outcome: 'blocked' };
	}
	try {
		assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
	} catch (error) {
		if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
			out.addError(error.toPayload());
			return { outcome: 'unfit' };
		}
		throw error;
	}

	// The patch set first: this run's commits above the recorded head come off
	// (each carries the transaction trailer - the audit proved it), the index
	// resyncs with the moved HEAD (--mixed: the retired commits' content must
	// not survive as staged changes), and the snapshotted artifacts return.
	let removedCommits = 0;
	if (patchsetAudit.moved) {
		const counted = runGit({ args: ['rev-list', '--count', `${record.patchset.head}..HEAD`], cwd: patchesDir });
		removedCommits = counted.status === 0 ? Number(counted.stdout.trim()) : 0;
		const reset = runGit({ args: ['reset', '--mixed', '--quiet', record.patchset.head], cwd: patchesDir });
		if (reset.status !== 0) {
			throw ckError(
				'INTERNAL',
				`cannot return the patchset HEAD of transaction ${record.id} to ${record.patchset.head}: ${reset.stderr.trim()}`,
				're-run with --verbose and attach the output to a bug report'
			);
		}
	}
	// The tree: files back from the snapshots, then the branch and HEAD, then
	// the mark as the run found it.
	const treeHeadMoved = (revParse(tree, 'HEAD') ?? '') !== record.tree.head;
	const restored = restoreTransactionSnapshots(patchesDir, tree, record);
	returnTreeHeads(tree, branch, record);
	if (treeHeadMoved) {
		// A rebuild that moved HEAD also rewrote the index; moving the ref back
		// must resync it, or the retired rebuild survives as staged changes.
		runGit({ args: ['reset', '--mixed', '--quiet'], cwd: tree });
	}
	if (record.tree.markSnapshot === null) {
		removeTreeMark(tree);
	} else {
		writeTreeMark(tree, record.tree.markSnapshot, (text) => {
			out.warn(text);
		});
	}
	retireSyncTransaction(patchesDir);
	const inTree = countRepo(restored, 'tree');
	const inPatchset = countRepo(restored, 'patchset');
	if (removedCommits > 0) {
		out.info(
			`patchset HEAD returned to ${record.patchset.head.slice(0, 8)}; the ${removedCommits} commit(s) the run made are off the branch`
		);
	}
	out.info(`restored ${inTree} fork-tree file(s) and ${inPatchset} patchset file(s) from the transaction snapshots`);
	out.info(`sync aborted: transaction ${record.id} retired; the tree and the patch set are where the run found them`);
	return { outcome: 'ok' };
}

/** How many files one repository's half of a restore touched. */
function countRepo(restored: RestoredSnapshots, repo: 'patchset' | 'tree'): number {
	return restored.restored.filter((entry) => entry.repo === repo).length + restored.removed.filter((entry) => entry.repo === repo).length;
}

/** The refusal that protects foreign work from an abort (D21). */
function abortRefusal(
	side: string,
	audit: { readonly foreign: readonly { sha: string; subject: string }[]; readonly offLine: boolean },
	record: SyncTransaction
): CkError {
	if (audit.offLine) {
		return ckError(
			'SYNC-IN-PROGRESS',
			`cannot abort transaction ${record.id}: HEAD of ${side} left the line the record knows (a rebase, switch or reset happened after the run)`,
			'return HEAD to the recorded line by hand, then codkit sync --abort again; the record stays at .codkit/sync-transaction.json'
		);
	}
	const list = audit.foreign.map((commit) => `${commit.sha.slice(0, 8)} "${commit.subject}"`).join(', ');
	return ckError(
		'SYNC-IN-PROGRESS',
		`cannot abort transaction ${record.id}: ${audit.foreign.length} commit(s) above the recorded HEAD of ${side} were made outside this sync and aborting would discard them: ${list}`,
		'move or remove the named commit(s) by hand (git rebase, git reset), then codkit sync --abort again; the record stays at .codkit/sync-transaction.json',
		audit.foreign[0]?.sha
	);
}

/** Branch and HEAD of the tree back to the recorded state (D21), the branch move guarded by its current tip. */
function returnTreeHeads(tree: string, branch: string, record: SyncTransaction): void {
	const currentTip = revParse(tree, `refs/heads/${branch}`);
	if (record.tree.branchTip === null) {
		// The run found no branch; if it created one, the abort removes it.
		if (currentTip !== null) {
			const removed = runGit({ args: ['update-ref', '-d', `refs/heads/${branch}`, currentTip], cwd: tree });
			if (removed.status !== 0) {
				throw ckError(
					'INTERNAL',
					`cannot remove the generated branch ${branch} of the aborted sync: ${removed.stderr.trim()}`,
					're-run with --verbose and attach the output to a bug report'
				);
			}
		}
	} else if (currentTip !== record.tree.head) {
		const moved =
			currentTip === null
				? runGit({ args: ['update-ref', `refs/heads/${branch}`, record.tree.head], cwd: tree })
				: runGit({ args: ['update-ref', `refs/heads/${branch}`, record.tree.head, currentTip], cwd: tree });
		if (moved.status !== 0) {
			throw ckError(
				'INTERNAL',
				`cannot return the generated branch ${branch} to ${record.tree.head}: ${moved.stderr.trim()}`,
				're-run with --verbose and attach the output to a bug report'
			);
		}
	}
	const head = revParse(tree, 'HEAD');
	if (head !== record.tree.head) {
		const detached = runGit({ args: ['symbolic-ref', '--quiet', 'HEAD'], cwd: tree });
		const args = detached.status === 0 ? ['update-ref', 'HEAD', record.tree.head] : ['update-ref', '--no-deref', 'HEAD', record.tree.head];
		const moved = runGit({ args, cwd: tree });
		if (moved.status !== 0) {
			throw ckError(
				'INTERNAL',
				`cannot return the fork-tree HEAD to ${record.tree.head}: ${moved.stderr.trim()}`,
				're-run with --verbose and attach the output to a bug report'
			);
		}
	}
}
