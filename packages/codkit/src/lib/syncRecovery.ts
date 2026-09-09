/** @scope spec://codkit/modules/codkit/PROP-008#SYNC-CONTINUE */
// The recovery entry of a stopped two-way sync (PROP-008 sec. 5a
// ##SYNC-CONTINUE; campaign TREE-COMMITS-SAVE, decisions D19-D21).
//
// A file both sides moved stops the run with the 3-way materialized as diff3
// markers in the tree file, under a live transaction record (the primitives
// live in lib/syncConflict.ts). `codkit sync --continue` finishes that
// interrupted run - after checking every recorded conflict is actually
// resolved: no markers left, and the merge really reached the file (a crash
// between the record and the write must not pass silently for a human's
// "keep the tree side"). `codkit sync --abort` is the other way out and lives
// in lib/syncAbort.ts; this module dispatches to both.
//
// The module also owns the write pass a fresh run and a resume share (the
// save half under the transaction, then the load half when only the patch set
// moved) and the conflict stop itself, so the resume is the same code that
// started the run, not a copy of it. The command file (`commands/sync.ts`)
// keeps the read pass and the flag dispatch.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CodkitConfig } from './configFile.ts';
import { runGit } from './gitx.ts';
import type { Output } from './jsonOut.ts';
import { ckError, isCkError } from './messages.ts';
import type { CkError } from './messages.ts';
import { classifyAllOwn, ownMarkFilesOf } from './ownSides.ts';
import { ownedRootsOf } from './ownedRoots.ts';
import { decodePatchName, encodePatchName } from './patchFormat.ts';
import type { ForkDirResolution } from './paths.ts';
import { runSave } from './saveEngine.ts';
import type { SaveResult } from './saveEngine.ts';
import { abortStoppedSync } from './syncAbort.ts';
import {
	conflictMaterializedError,
	conflictMaterializedSha,
	hasConflictMarkers,
	materializeConflictBytes,
	mergeConflictSides
} from './syncConflict.ts';
import type { MaterializedConflictReport } from './syncConflict.ts';
import { PATCHES_DIR, generatedBranchName, runSync } from './syncEngine.ts';
import type { SyncResult } from './syncEngine.ts';
import { checkLineage, classifyTargets, loadedFrom, patchsetMovedError } from './syncMerge.ts';
import type { TargetClasses } from './syncMerge.ts';
import {
	appendConflictMaterialized,
	readSyncTransaction,
	recordedRewriteOf,
	resolveStoppedTransaction,
	retireSyncTransaction,
	saveSyncTransaction,
	snapshotForTransaction
} from './syncTransaction.ts';
import type { SyncTestCrashStage, SyncTransaction } from './syncTransaction.ts';
import { readTreeMark, revParse } from './treeCache.ts';
import type { TreeMark } from './treeCache.ts';
import { foreignCommits, treeHeadError } from './treeCommits.ts';
import type { TreeCommits } from './treeCommits.ts';
import { changesSince } from './treeState.ts';
import { checkTree } from './treeIdentity.ts';
import type { ProjectType } from '@codkit/type-api';
import { assertGeneratedRefExclusive } from './worktrees.ts';

// ---------------------------------------------------------------------------
// The run's result shape (shared with the command file)
// ---------------------------------------------------------------------------

export type TwoWayStatus = 'synced' | 'up-to-date' | 'dry-run' | 'blocked' | 'unfit' | 'aborted';

export type TwoWayResult = {
	readonly exitCode: number;
	readonly status: TwoWayStatus;
	readonly classes: TargetClasses;
	readonly treeCommitCount: number;
	readonly transactionId: string | null;
	readonly patchsetCommits: readonly string[];
	readonly consumedRef: string | null;
};

export const NO_CLASSES: TargetClasses = { treeOnly: [], patchsetOnly: [], both: [], unknown: true, fingerprintMatches: false };

/** The optional parts of a `ok()` result: one builder, many exits. */
type OkParts = { readonly transaction?: string | null; readonly patchsetCommits?: readonly string[]; readonly consumedRef?: string | null };

export function ok(status: TwoWayStatus, classes: TargetClasses, treeCommitCount: number, parts: OkParts = {}): TwoWayResult {
	return {
		exitCode: 0,
		status,
		classes,
		treeCommitCount,
		transactionId: parts.transaction ?? null,
		patchsetCommits: [...(parts.patchsetCommits ?? [])],
		consumedRef: parts.consumedRef ?? null
	};
}

export function unfit(): TwoWayResult {
	return { ...ok('unfit', NO_CLASSES, 0), exitCode: 2 };
}

/** A stopped result: exit 1, and the transaction it stopped under when there is one. */
export function blocked(classes: TargetClasses, treeCommitCount: number, parts: OkParts = {}): TwoWayResult {
	return { ...ok('blocked', classes, treeCommitCount, parts), exitCode: 1 };
}

/** Everything both the fresh run and the recovery need to act on one tree. */
export type TwoWayInput = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	/** The project type of the patch set; the engines below ask it, not a constant. */
	readonly type: ProjectType;
	readonly out: Output;
	readonly flags: {
		readonly squash: boolean;
		readonly commit: boolean;
		readonly message: string | null;
		readonly discard: boolean;
		readonly fresh: boolean;
		readonly dryRun: boolean;
	};
	readonly verbose: boolean;
	readonly crash: (stage: SyncTestCrashStage) => void;
};

// ---------------------------------------------------------------------------
// The write pass a fresh run and a resume share (steps 10-11 of PROP-008 5a)
// ---------------------------------------------------------------------------

/**
 * The merge under the transaction (D20): the save half when the tree has work
 * - its rebuild is the load half over the delta as it stands now - or the load
 * half alone when only the patch set moved. Identical for a fresh run and a
 * `sync --continue`: the resume is this same code reading the same record.
 */
export function runWritePass(
	input: TwoWayInput,
	record: SyncTransaction,
	classes: TargetClasses,
	treeState: TreeCommits,
	hasTreeWork: boolean,
	resumed: boolean
): TwoWayResult {
	const { patchesDir, resolution, config, out, flags, crash } = input;
	let live = record;

	// The tree has work: the save half extracts it, and its rebuild is the load
	// half over the delta as it stands now - patchset's shift included, its
	// rewrites explained (D16).
	if (hasTreeWork) {
		let saved: SaveResult;
		try {
			saved = runSave({
				patchesDir,
				resolution,
				config,
				type: input.type,
				out,
				paths: [],
				allowNewFile: [],
				commit: flags.commit,
				message: flags.message,
				squash: flags.squash,
				verbose: input.verbose,
				fresh: flags.fresh,
				skipPatchsetMovedCheck: true,
				skipSyncInProgressCheck: true,
				explainedRewrites: classes.patchsetOnly.map(artifactTarget),
				syncTransactionId: live.id,
				replayCheckpoint: (stage, sha) => {
					live = saveSyncTransaction(patchesDir, { ...live, patchsetCommits: [...live.patchsetCommits, sha] });
					crash(stage);
				},
				syncCheckpoint: (stage) => {
					crash(stage);
				}
			});
		} catch (error) {
			return stoppedMidway(input, live, classes, treeState, { error });
		}
		if (saved.exitCode !== 0) {
			return stoppedMidway(input, live, classes, treeState, { engine: saved });
		}
		live = appendOutcome(patchesDir, live, saved);
		retireSyncTransaction(patchesDir);
		out.info(
			`sync ${resumed ? 'continued and complete' : 'complete'}: ${live.patchsetCommits.length} patchset commit(s), both sides settled; ` +
				`transaction ${live.id} retired`
		);
		return ok('synced', classes, treeState.commits.length, {
			transaction: live.id,
			patchsetCommits: live.patchsetCommits,
			consumedRef: saved.consumedRef
		});
	}

	// Only patchset moved: the load half alone, still under the transaction -
	// the rebuild rewrites tree files, and a crash between them must leave the
	// record that says so.
	let applied: SyncResult;
	try {
		applied = runSync({
			patchesDir,
			resolution,
			config,
			type: input.type,
			out,
			fresh: flags.fresh,
			dryRun: false,
			verbose: input.verbose,
			skipSyncInProgressCheck: true
		});
	} catch (error) {
		return stoppedMidway(input, live, classes, treeState, { error });
	}
	if (applied.exitCode !== 0) {
		return stoppedMidway(input, live, classes, treeState, { engine: applied });
	}
	retireSyncTransaction(patchesDir);
	out.info(
		`sync ${resumed ? 'continued and complete' : 'complete'}: the patchset side was applied to the tree; transaction ${live.id} retired`
	);
	return ok('synced', classes, 0, { transaction: live.id, consumedRef: applied.discardedRef });
}

/** The final atoms of a successful save half: the consumed ref and the closing commit. */
export function appendOutcome(patchesDir: string, record: SyncTransaction, saved: SaveResult): SyncTransaction {
	const commits =
		saved.commit !== null && !record.patchsetCommits.includes(saved.commit)
			? [...record.patchsetCommits, saved.commit]
			: record.patchsetCommits;
	return saveSyncTransaction(patchesDir, { ...record, patchsetCommits: commits, consumedRef: saved.consumedRef });
}

/** What stopped a run mid-way: an escaped error, or an engine's own refusal result. */
export type Failure = { readonly error: unknown } | { readonly engine: SaveResult | SyncResult };

/**
 * A run that refused or crashed mid-way. The engine's refusal (or the escaped
 * error) is already on the envelope; what this decides is the record's fate -
 * `resolveStoppedTransaction` retires it when nothing was written and keeps it
 * when something was, and the answer decides the exit path.
 */
export function stoppedMidway(
	input: TwoWayInput,
	record: SyncTransaction,
	classes: TargetClasses,
	treeState: TreeCommits,
	failure: Failure
): TwoWayResult {
	const { patchesDir, resolution, out } = input;
	let exitCode = 1;
	if ('error' in failure) {
		if (!isCkError(failure.error)) {
			throw failure.error;
		}
		out.addError(failure.error.toPayload());
		exitCode = failure.error.code === 'CONFIG' ? 2 : 1;
	} else if (failure.engine.status === 'unfit') {
		exitCode = 2;
	}
	const settled = resolveStoppedTransaction(patchesDir, resolution.path, record, out);
	return {
		exitCode: settled === 'untouched' ? exitCode : 1,
		status: settled === 'untouched' && exitCode === 2 ? 'unfit' : 'blocked',
		classes,
		treeCommitCount: treeState.commits.length,
		transactionId: settled === 'untouched' ? null : record.id,
		patchsetCommits: [...record.patchsetCommits],
		consumedRef: null
	};
}

// ---------------------------------------------------------------------------
// The conflict stop (D19): markers into the tree, ours into the record
// ---------------------------------------------------------------------------

/**
 * Materialize the given both-side targets under the record (D19, Phase 8b):
 * every merge is computed before anything is written, each result is written
 * durably into its tree file and recorded as it lands, and the run stops with
 * exit 1 naming the files. The record keeps the ours-snapshots, so `--abort`
 * can undo all of it byte for byte.
 */
export function materializeConflicts(
	input: TwoWayInput,
	record: SyncTransaction,
	classes: TargetClasses,
	treeState: TreeCommits,
	targets: readonly string[]
): TwoWayResult {
	const { patchesDir, resolution, config, out, crash } = input;
	const tree = resolution.path;
	// First pass, pure computation (the two-pass rule of ##SYNC-TWO-PASS): an
	// artifact that does not apply, or a side that cannot be read, refuses the
	// run while it still has written nothing.
	const merges = targets.map((target) =>
		mergeConflictSides({
			patchesDir,
			treeDir: tree,
			pinSha: config.pin.sha,
			type: input.type,
			base: treeState.base,
			treeHead: treeState.head,
			target,
			artifact: `${PATCHES_DIR}/${encodePatchName(target)}`
		})
	);
	// The ours-snapshots of every conflict target belong to the record before
	// the first write; a resumed run appends the ones it did not have.
	let live = ensureConflictSnapshots(patchesDir, tree, record, targets);
	for (const merge of merges) {
		materializeConflictBytes(tree, merge.target, merge.bytes);
		live = appendConflictMaterialized(patchesDir, live, merge.target, conflictMaterializedSha(merge.bytes));
		crash('conflict-materialized');
	}
	const reports: readonly MaterializedConflictReport[] = merges.map((merge) => ({
		target: merge.target,
		hasConflicts: merge.hasConflicts
	}));
	out.addError(conflictMaterializedError(reports).toPayload());
	return blocked(classes, treeState.commits.length, { transaction: live.id, patchsetCommits: [...live.patchsetCommits] });
}

/** Every conflict target snapshotted as ours and listed in the record; appends what a resumed run lacks. */
function ensureConflictSnapshots(
	patchesDir: string,
	treeDir: string,
	record: SyncTransaction,
	targets: readonly string[]
): SyncTransaction {
	const listed = new Set(record.conflicts.map((conflict) => conflict.path));
	const fresh = targets.filter((target) => !listed.has(target));
	if (fresh.length === 0) {
		return record;
	}
	return saveSyncTransaction(patchesDir, {
		...record,
		conflicts: [...record.conflicts, ...fresh.map((path) => ({ path, materialized: null }))],
		rewrite: [
			...record.rewrite,
			...snapshotForTransaction(
				treeDir,
				'tree',
				fresh.filter((path) => recordedRewriteOf(record, 'tree', path) === null)
			)
		]
	});
}

// ---------------------------------------------------------------------------
// sync --continue (D21)
// ---------------------------------------------------------------------------

/**
 * `codkit sync --continue`: finish the run the record names. The completeness
 * check comes first - every recorded conflict resolved, by markers gone *and*
 * the merge having actually reached the file - then the same write pass a
 * fresh run performs, under the same record. New both-side targets the stop
 * did not name get the same answer the fresh run gives them: markers, exit 1,
 * the record extended.
 */
function continueStoppedSync(input: TwoWayInput, record: SyncTransaction): TwoWayResult {
	const { patchesDir, resolution, config, out } = input;
	const tree = resolution.path;
	const branch = generatedBranchName(config);

	const identity = checkTree(resolution, config, { mode: 'write', type: input.type });
	if (identity.fatal !== null) {
		out.addError(identity.fatal.toPayload());
		return unfit();
	}
	try {
		assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
	} catch (error) {
		if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
			out.addError(error.toPayload());
			return unfit();
		}
		throw error;
	}

	// D21's completeness check, per file of conflicts[].
	const unresolved = unresolvedConflictAudit(tree, record);
	if (unresolved !== null) {
		out.addError(unresolved.toPayload());
		return blocked(NO_CLASSES, 0, { transaction: record.id, patchsetCommits: [...record.patchsetCommits] });
	}

	// The read pass again - the world may have moved since the stop. The
	// refusals are the fresh run's, with one difference: the record's own
	// conflicts are exempt from the both-sides refusal, because their
	// resolution in the tree file IS the answer.
	const treeState = foreignCommits(tree, config.pin.sha, branch);
	const head = treeHeadError(treeState, branch);
	if (head !== null) {
		out.addError(head.toPayload());
		return blocked(NO_CLASSES, treeState.commits.length, { transaction: record.id });
	}
	const mark = readTreeMark(tree, (text) => {
		out.warn(text);
	});
	const loaded = loadedFrom({ treeDir: tree, base: treeState.base, pinSha: config.pin.sha, mark });
	if (loaded.kind === 'sha' && !checkLineage(patchesDir, loaded.sha).ok) {
		out.addError(
			patchsetMovedError({
				loaded,
				lineageHead: revParse(patchesDir, 'HEAD'),
				moved: []
			}).toPayload()
		);
		return blocked(NO_CLASSES, treeState.commits.length, { transaction: record.id });
	}
	const classified = classifySides(input, mark, treeState);
	if (classified.error !== null) {
		out.addError(classified.error.toPayload());
		return blocked(classified.classes, treeState.commits.length, { transaction: record.id });
	}
	const classes = classified.classes;
	const ownClasses = classifyAllOwn(patchesDir, tree, ownedRootsOf(input.type, config.typeConfig), (owned) =>
		ownMarkFilesOf(mark, owned)
	).filter((entry) => entry.kind !== 'same');
	if (ownClasses.some((entry) => entry.kind === 'both-edited')) {
		out.addError(
			ckError(
				'BOTH-SIDES-EDITED',
				'the fork tree and the patch set both changed an own file since the stop; own code has no marker blocks to materialize a merge into',
				'choose a side by hand (revert one side), then codkit sync --continue again, or codkit sync --abort'
			).toPayload()
		);
		return blocked(classes, treeState.commits.length, { transaction: record.id });
	}

	// Both-side targets the stop did not name (work that appeared after it)
	// get the same answer the fresh run gives: markers, exit 1, record kept.
	const resolvedTargets = new Set(record.conflicts.map((conflict) => conflict.path));
	const newBoth = classes.both.map(artifactTarget).filter((target) => !resolvedTargets.has(target));
	if (newBoth.length > 0) {
		return materializeConflicts(input, record, classes, treeState, newBoth);
	}

	// Snapshots the fresh run did not take (files that changed or appeared
	// after the stop): the save half is about to rewrite their artifacts, and
	// an abort after a crash in the continuation must cover them too.
	const live = extendRecordSnapshots(input, record, treeState);

	const changes = changesSince(tree, treeState.base, { kind: 'worktree' }, ownedRootsOf(input.type, config.typeConfig));
	const hasTreeWork =
		treeState.commits.length > 0 ||
		changes.length > 0 ||
		ownClasses.some((entry) => entry.kind === 'tree-edited' || entry.kind === 'unknown');
	return runWritePass(input, live, classes, treeState, hasTreeWork, true);
}

/** The D21 completeness audit: null when every recorded conflict is resolved, the refusal otherwise. */
function unresolvedConflictAudit(treeDir: string, record: SyncTransaction): CkError | null {
	const withMarkers: string[] = [];
	const missing: string[] = [];
	const neverMaterialized: string[] = [];
	for (const conflict of record.conflicts) {
		let bytes: Uint8Array;
		try {
			bytes = readFileSync(join(treeDir, ...conflict.path.split('/')));
		} catch {
			missing.push(conflict.path);
			continue;
		}
		if (hasConflictMarkers(bytes)) {
			withMarkers.push(conflict.path);
			continue;
		}
		if (conflict.materialized === null && !differsFromSnapshot(treeDir, conflict.path, record)) {
			// The file is byte-identical to the pre-run ours and the run never
			// wrote its merge into it: no human ever saw markers here. A human
			// who resolves to exactly the tree side *after* materialization
			// produces these bytes too - but there the record carries the
			// materialized sha, and that is the difference.
			neverMaterialized.push(conflict.path);
		}
	}
	if (withMarkers.length > 0 || missing.length > 0) {
		const parts: string[] = [];
		if (withMarkers.length > 0) {
			parts.push(`still carry conflict markers: ${withMarkers.join(', ')}`);
		}
		if (missing.length > 0) {
			parts.push(`no longer exist: ${missing.join(', ')}`);
		}
		return ckError(
			'BOTH-SIDES-EDITED',
			`the stopped sync's conflict is not resolved - ${parts.join('; ')}`,
			'resolve the markers inside the codkit blocks (keep both sides and the block ids), then codkit sync --continue; ' +
				'codkit sync --abort returns the tree and the patch set to the state before the run',
			withMarkers[0] ?? missing[0]
		);
	}
	if (neverMaterialized.length > 0) {
		return ckError(
			'BOTH-SIDES-EDITED',
			`the merge never reached ${neverMaterialized.length} conflict file(s): ${neverMaterialized.join(', ')} - ` +
				'the run crashed before its markers were written, and the file still carries only the tree side',
			'codkit sync --abort returns everything to the state before the run, or merge the patch set side into the file by hand and codkit sync --continue',
			neverMaterialized[0]
		);
	}
	return null;
}

/** Whether the file on disk differs from its ours-snapshot in the record (absent snapshot counts as differing). */
function differsFromSnapshot(treeDir: string, path: string, record: SyncTransaction): boolean {
	const entry = recordedRewriteOf(record, 'tree', path);
	if (entry === null || entry.blob === null) {
		return true;
	}
	const hashed = runGit({ args: ['hash-object', '--', path], cwd: treeDir });
	return hashed.status !== 0 || hashed.stdout.trim() !== entry.blob;
}

/** Snapshots the artifacts of every changed tree file the record does not carry yet. */
function extendRecordSnapshots(input: TwoWayInput, record: SyncTransaction, treeState: TreeCommits): SyncTransaction {
	const { patchesDir, resolution, config } = input;
	const changes = changesSince(resolution.path, treeState.base, { kind: 'worktree' }, ownedRootsOf(input.type, config.typeConfig));
	const artifacts = changes.map((change) => `${PATCHES_DIR}/${encodePatchName(change.path)}`);
	const fresh = artifacts.filter((artifact) => recordedRewriteOf(record, 'patchset', artifact) === null);
	if (fresh.length === 0) {
		return record;
	}
	return saveSyncTransaction(patchesDir, {
		...record,
		rewrite: [...record.rewrite, ...snapshotForTransaction(patchesDir, 'patchset', fresh)]
	});
}

// ---------------------------------------------------------------------------
// Dispatch and small readers
// ---------------------------------------------------------------------------

/**
 * The recovery entry (`codkit sync --abort` / `codkit sync --continue`): reads
 * the record and hands it to the right half. No record is an honest exit 2,
 * not a guess; an unreadable one fails closed inside `readSyncTransaction`.
 */
export function runSyncRecovery(input: TwoWayInput, mode: 'abort' | 'continue'): TwoWayResult {
	const record = readSyncTransaction(input.patchesDir);
	if (record === null) {
		input.out.addError(
			ckError(
				'CONFIG',
				`codkit sync --${mode} recovers a stopped sync, and there is no stopped sync: no transaction record exists`,
				'a record is left only when a sync stops after writing something; run codkit sync to start a run'
			).toPayload()
		);
		return unfit();
	}
	if (mode === 'abort') {
		const verdict = abortStoppedSync(input, record);
		return verdict.outcome === 'ok'
			? ok('aborted', NO_CLASSES, 0, { transaction: record.id })
			: verdict.outcome === 'unfit'
				? unfit()
				: blocked(NO_CLASSES, 0, { transaction: record.id, patchsetCommits: [...record.patchsetCommits] });
	}
	return continueStoppedSync(input, record);
}

/** The classification of the resumed run, or its refusal (a mark without the map, R13). */
function classifySides(
	input: TwoWayInput,
	mark: TreeMark | null,
	treeState: TreeCommits
): { readonly classes: TargetClasses; readonly error: CkError | null } {
	const classes = classifyTargets({
		patchesDir: input.patchesDir,
		treeDir: input.resolution.path,
		pinSha: input.config.pin.sha,
		type: input.type,
		base: treeState.base,
		mark,
		roots: ownedRootsOf(input.type, input.config.typeConfig),
		commits: treeState.commits
	});
	if (classes.unknown) {
		return {
			classes,
			error: ckError(
				'PATCHSET-MOVED',
				'the apply mark carries no delta artifact map, so the continued sync cannot tell which side moved which artifact',
				'codkit sync --abort returns everything to the state before the run'
			)
		};
	}
	return { classes, error: null };
}

/** The tree path a delta/patches artifact name encodes (PROP-004 sec. 4). */
export function artifactTarget(artifact: string): string {
	return decodePatchName(artifact.split('/').pop() ?? '');
}
