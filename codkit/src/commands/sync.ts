/** @scope spec://codkit/modules/codkit/PROP-007#CMD-SYNC-TWO-WAY */
// codkit sync - the two-way command: one run that extracts what the fork tree
// has and delivers what the patch set has (PROP-007 sec. 5a ##CMD-SYNC-TWO-WAY;
// algorithm: PROP-008 sec. 5a; campaign TREE-COMMITS-SAVE, decisions D15-D21).
// The name was reserved for it since the one-way `sync` became `load` (D14).
//
// Two properties are the phase, not details: a file both sides moved is a
// refusal, never a merge - the classification runs before the first write, so
// CK-E-BOTH-SIDES-EDITED leaves no record, no moved ref and no changed byte
// behind (D16/D19); and a crash never leaves an unreadable half-state - the
// transaction record is written before the first mutation and retired after
// the last, and while it exists the engines refuse with CK-E-SYNC-IN-PROGRESS
// (D20).
//
// The halves are the one-way engines: the save half (`runSave`, with the
// patchset-shift refusal replaced by the per-target rule) and the load half
// (`runSync`, whose rebuild applies what patchset moved - explained by D16's
// extension of the rebuild invariant).

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { commandFlagGiven, commandFlagValue, forkResolution } from '../lib/command.ts';
import { isCycleTestBuild } from '../lib/cycleTestCrash.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import { runGit } from '../lib/gitx.ts';
import type { Output } from '../lib/jsonOut.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { withLock } from '../lib/lock.ts';
import { ckError, isCkError } from '../lib/messages.ts';
import { classifyOwn, ownTargetRelativeDir } from '../lib/ownCopy.ts';
import type { OwnSideClass } from '../lib/ownCopy.ts';
import { decodePatchName, encodePatchName } from '../lib/patchFormat.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import type { ForkDirResolution } from '../lib/paths.ts';
import { runSave } from '../lib/saveEngine.ts';
import type { SaveResult } from '../lib/saveEngine.ts';
import { PATCHES_DIR, generatedBranchName, runSync } from '../lib/syncEngine.ts';
import type { SyncResult } from '../lib/syncEngine.ts';
import { bothSidesConflictError, checkLineage, classifyTargets, loadedFrom, patchsetMovedError, reportSyncPlan } from '../lib/syncMerge.ts';
import type { BothSideTarget, TargetClasses } from '../lib/syncMerge.ts';
import {
	SYNC_TEST_CRASH_ENV,
	SYNC_TRANSACTION_RELATIVE_PATH,
	openSyncTransaction,
	refuseOverLiveSyncTransaction,
	resolveStoppedTransaction,
	retireSyncTransaction,
	saveSyncTransaction,
	syncCrashCheckpoint
} from '../lib/syncTransaction.ts';
import type { SyncTestCrashStage, SyncTransaction } from '../lib/syncTransaction.ts';
import { readTreeMark, revParse } from '../lib/treeCache.ts';
import type { TreeMark } from '../lib/treeCache.ts';
import { foreignCommits, treeHeadError } from '../lib/treeCommits.ts';
import type { TreeCommits } from '../lib/treeCommits.ts';
import { changesSince } from '../lib/treeState.ts';
import type { StateChange } from '../lib/treeState.ts';
import { checkTree } from '../lib/treeIdentity.ts';
import { assertGeneratedRefExclusive } from '../lib/worktrees.ts';

const SQUASH = '--squash';
const COMMIT = '--commit';
const MESSAGE = '--message';
const DISCARD = '--discard';
const FRESH = '--fresh';
const DRY_RUN = '--dry-run';
const ABORT = '--abort';
const CONTINUE = '--continue';

type SyncFlags = {
	readonly squash: boolean;
	readonly commit: boolean;
	readonly message: string | null;
	readonly discard: boolean;
	readonly fresh: boolean;
	readonly dryRun: boolean;
};

type TwoWayStatus = 'synced' | 'up-to-date' | 'dry-run' | 'blocked' | 'unfit';

type TwoWayResult = {
	readonly exitCode: number;
	readonly status: TwoWayStatus;
	readonly classes: TargetClasses;
	readonly treeCommitCount: number;
	readonly transactionId: string | null;
	readonly patchsetCommits: readonly string[];
	readonly consumedRef: string | null;
};

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}
	const config = requireConfig(ctx.config);

	// Recovery of a live record belongs to the conflict-materialization phase
	// (D21, Phase 8b): the flags are part of the command's contract (D15) and
	// answer honestly until that phase lands, rather than pretending.
	if (commandFlagGiven(ctx.commandFlags, ABORT) || commandFlagGiven(ctx.commandFlags, CONTINUE)) {
		throw ckError(
			'CONFIG',
			'codkit sync --abort/--continue recover a stopped sync and arrive with the conflict-materialization phase',
			`until then, resolve the record by hand: its snapshots and commit shas are in ${SYNC_TRANSACTION_RELATIVE_PATH}`
		);
	}
	// A non-interactive run must never decide on its own to drop somebody's
	// work (D11): the flag names a loss, and naming a loss is interactive.
	const discard = commandFlagGiven(ctx.commandFlags, DISCARD);
	if (discard && ctx.flags.ci) {
		throw ckError(
			'CONFIG',
			'sync --discard drops fork-tree commits on purpose, and a --ci run must not make that decision',
			'run codkit sync to keep the commits, or codkit sync --discard interactively'
		);
	}
	// Test-only crash injection, validated at this boundary exactly like the
	// save replay one: an unknown stage or a non-test runtime is a config
	// error before any lock is taken.
	const crashAt = syncCrashCheckpoint(ctx.env[SYNC_TEST_CRASH_ENV], isCycleTestBuild(process.execArgv));
	const crash = (stage: SyncTestCrashStage): void => {
		crashAt?.(stage);
	};

	const flags: SyncFlags = {
		squash: commandFlagGiven(ctx.commandFlags, SQUASH),
		commit: commandFlagGiven(ctx.commandFlags, COMMIT),
		message: commandFlagValue(ctx.commandFlags, MESSAGE),
		discard,
		fresh: commandFlagGiven(ctx.commandFlags, FRESH),
		dryRun: commandFlagGiven(ctx.commandFlags, DRY_RUN)
	};

	return withLock(
		ctx.patchesDir,
		treeId(resolution.path),
		'sync',
		() => {
			const result = runTwoWay({ patchesDir: ctx.patchesDir, resolution, config, out: ctx.out, flags, verbose: ctx.flags.verbose, crash });
			ctx.out.setData(buildData(result));
			return result.exitCode;
		},
		(text) => {
			ctx.out.warn(text);
		}
	);
}

type TwoWayInput = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	readonly out: Output;
	readonly flags: SyncFlags;
	readonly verbose: boolean;
	readonly crash: (stage: SyncTestCrashStage) => void;
};

const NO_CLASSES: TargetClasses = { treeOnly: [], patchsetOnly: [], both: [], unknown: true, fingerprintMatches: false };

/** The optional parts of a `ok()` result: one builder, many exits. */
type OkParts = { readonly transaction?: string | null; readonly patchsetCommits?: readonly string[]; readonly consumedRef?: string | null };

function ok(status: TwoWayStatus, classes: TargetClasses, treeCommitCount: number, parts: OkParts = {}): TwoWayResult {
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

function unfit(): TwoWayResult {
	return { ...ok('unfit', NO_CLASSES, 0), exitCode: 2 };
}

function blocked(classes: TargetClasses, treeCommitCount: number): TwoWayResult {
	return { ...ok('blocked', classes, treeCommitCount), exitCode: 1 };
}

function runTwoWay(input: TwoWayInput): TwoWayResult {
	const { patchesDir, resolution, config, out, flags, crash } = input;
	const tree = resolution.path;
	const branch = generatedBranchName(config);

	// 0. A live transaction: nothing may operate over its half-applied state.
	if (refuseOverLiveSyncTransaction(patchesDir, 'sync', out)) {
		return blocked(NO_CLASSES, 0);
	}

	// 1. Is this the tree we think it is, and may we write to it? A dry run
	// only reads, so it takes the read mode and skips the exclusive preflight,
	// exactly like `load --dry-run`.
	const identity = checkTree(resolution, config, { mode: flags.dryRun ? 'read' : 'write' });
	if (identity.fatal !== null) {
		out.addError(identity.fatal.toPayload());
		return unfit();
	}
	if (!flags.dryRun) {
		try {
			assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
		} catch (error) {
			if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
				out.addError(error.toPayload());
				return unfit();
			}
			throw error;
		}
	}

	// 2. Commits made in the tree are work, and the wrong line is a position
	// to correct, not a fact to extract from (D8).
	const treeState = foreignCommits(tree, config.pin.sha, branch);
	const head = treeHeadError(treeState, branch);
	if (head !== null) {
		out.addError(head.toPayload());
		return blocked(NO_CLASSES, treeState.commits.length);
	}

	// 3. The lineage question (D17): a loaded-from sha that stopped being an
	// ancestor of patchset HEAD names a state this checkout no longer carries,
	// and merging across that line is a human decision however the bytes look.
	const mark = readTreeMark(tree, (text) => {
		out.warn(text);
	});
	const loaded = loadedFrom({ treeDir: tree, base: treeState.base, pinSha: config.pin.sha, mark });
	const patchsetHead = revParse(patchesDir, 'HEAD') ?? 'HEAD';
	const restoreRef = loaded.kind === 'sha' ? loaded.sha : patchsetHead;
	if (loaded.kind === 'sha') {
		const lineage = checkLineage(patchesDir, loaded.sha);
		if (!lineage.ok) {
			out.addError(patchsetMovedError({ loaded, lineageHead: lineage.head, moved: [] }).toPayload());
			return blocked(NO_CLASSES, treeState.commits.length);
		}
	} else if (loaded.kind === 'dirty' || loaded.kind === 'none') {
		out.warn(
			loaded.kind === 'dirty'
				? 'the tree was loaded from an uncommitted patchset state (dirty); sync cannot verify the patchset lineage and proceeds'
				: 'the tree was loaded from a patchset without a HEAD (none); sync cannot verify the patchset lineage and proceeds'
		);
	}

	// 4. The per-target rule (D16). A mark without the artifact map cannot
	// answer the byte question, and a two-way merge may not guess (R13): one
	// load records the map, and the refusal says so.
	const classes = classifyTargets({
		patchesDir,
		treeDir: tree,
		pinSha: config.pin.sha,
		base: treeState.base,
		mark,
		ownDirName: config.ownDirName,
		commits: treeState.commits
	});
	if (classes.unknown) {
		out.addError(
			ckError(
				'PATCHSET-MOVED',
				'the apply mark carries no delta artifact map, so sync cannot tell which side moved which artifact',
				'run codkit load once to record the loaded state (every load writes the map), then codkit sync'
			).toPayload()
		);
		return blocked(classes, treeState.commits.length);
	}
	const patchsetOnlyTargets = classes.patchsetOnly.map(artifactTarget);

	// 5. Own code, file by file (##PATCHSET-SIDE-EDIT-RULE): a both-sided own
	// file is the same refusal as a both-sided patch target.
	const ownClasses = classifyOwn(patchesDir, tree, config.ownDirName, mark?.ownFiles ?? null).filter((entry) => entry.kind !== 'same');
	const ownBoth = ownClasses.filter((entry) => entry.kind === 'both-edited');
	if (ownBoth.length > 0) {
		const prefix = ownTargetRelativeDir(config.ownDirName);
		const sides = ownBoth.map((entry) => ({ artifact: `delta/own/${entry.relative}`, target: `${prefix}/${entry.relative}` }));
		out.addError(bothSidesConflictError(sides, restoreRef).toPayload());
		return blocked(classes, treeState.commits.length);
	}

	// 6. The patch layer: both sides moved the same target (D19). Under
	// `--discard` the commits' half of the tree side is dropped on purpose, so
	// only targets the *uncommitted* state still carries refuse (D11: the flag
	// speaks about commits, never about edits).
	const bothSides: readonly BothSideTarget[] = classes.both.map((artifact) => ({ artifact, target: artifactTarget(artifact) }));
	const refusingBoth =
		flags.discard && treeState.commits.length > 0
			? bothSides.filter((side) => uncommittedChanges(tree, treeState, config.ownDirName).some((change) => change.path === side.target))
			: bothSides;
	if (refusingBoth.length > 0) {
		out.addError(bothSidesConflictError(refusingBoth, restoreRef).toPayload());
		return blocked(classes, treeState.commits.length);
	}

	// 7. --dry-run: the classification is the answer; nothing is written.
	if (flags.dryRun) {
		const paths = changesSince(tree, treeState.base, { kind: 'worktree' }, config.ownDirName).map((change) => change.path);
		reportSyncPlan(out, classes, treeState.commits.length, paths);
		return ok('dry-run', classes, treeState.commits.length);
	}

	// 8. --discard: drop the tree commits deliberately (D11). The discard's
	// rebuild is a full load - it applies whatever patchset holds - and its
	// guard keeps protecting everything the flag did not name.
	if (flags.discard && treeState.commits.length > 0) {
		return discardBranch(input, classes, treeState, mark, crash);
	}
	if (flags.discard) {
		out.info('discard: no fork-tree commits above the generated tip; nothing to drop');
	}

	// 9. Is there anything to merge at all? With both sides still, the load
	// engine alone answers - usually from its fast path - and no transaction is
	// written, because nothing is about to mutate.
	const changes = changesSince(tree, treeState.base, { kind: 'worktree' }, config.ownDirName);
	const hasTreeWork =
		treeState.commits.length > 0 ||
		changes.length > 0 ||
		ownClasses.some((entry) => entry.kind === 'tree-edited' || entry.kind === 'unknown');
	const hasPatchsetWork = classes.patchsetOnly.length > 0 || ownClasses.some((entry) => entry.kind === 'patchset-edited');
	if (!hasTreeWork && !hasPatchsetWork) {
		const settled = runSync({ patchesDir, resolution, config, out, fresh: flags.fresh, dryRun: false, verbose: input.verbose });
		return {
			...ok(settled.status === 'up-to-date' ? 'up-to-date' : 'synced', classes, 0, { consumedRef: settled.discardedRef }),
			exitCode: settled.exitCode
		};
	}

	// 10. The merge, under the transaction: the record exists before the first
	// mutation and is retired after the last (D20).
	let record = openRecord(input, treeState, mark, changes, ownClasses, classes.patchsetOnly);
	crash('transaction-written');

	// 11a. The tree has work: the save half extracts it, and its rebuild is
	// the load half over the delta as it stands now - patchset's shift
	// included, its rewrites explained (D16).
	if (hasTreeWork) {
		let saved: SaveResult;
		try {
			saved = runSave({
				patchesDir,
				resolution,
				config,
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
				explainedRewrites: patchsetOnlyTargets,
				syncTransactionId: record.id,
				replayCheckpoint: (stage, sha) => {
					record = saveSyncTransaction(patchesDir, { ...record, patchsetCommits: [...record.patchsetCommits, sha] });
					crash(stage);
				},
				syncCheckpoint: (stage) => {
					crash(stage);
				}
			});
		} catch (error) {
			return stoppedMidway(input, record, classes, treeState, { error });
		}
		if (saved.exitCode !== 0) {
			return stoppedMidway(input, record, classes, treeState, { engine: saved });
		}
		record = appendOutcome(patchesDir, record, saved);
		retireSyncTransaction(patchesDir);
		out.info(`sync complete: ${record.patchsetCommits.length} patchset commit(s), both sides settled; transaction ${record.id} retired`);
		return ok('synced', classes, treeState.commits.length, {
			transaction: record.id,
			patchsetCommits: record.patchsetCommits,
			consumedRef: saved.consumedRef
		});
	}

	// 11b. Only patchset moved: the load half alone, still under the
	// transaction - the rebuild rewrites tree files, and a crash between them
	// must leave the record that says so.
	let applied: SyncResult;
	try {
		applied = runSync({
			patchesDir,
			resolution,
			config,
			out,
			fresh: flags.fresh,
			dryRun: false,
			verbose: input.verbose,
			skipSyncInProgressCheck: true
		});
	} catch (error) {
		return stoppedMidway(input, record, classes, treeState, { error });
	}
	if (applied.exitCode !== 0) {
		return stoppedMidway(input, record, classes, treeState, { engine: applied });
	}
	retireSyncTransaction(patchesDir);
	out.info(`sync complete: the patchset side was applied to the tree; transaction ${record.id} retired`);
	return ok('synced', classes, 0, { transaction: record.id, consumedRef: applied.discardedRef });
}

// ---------------------------------------------------------------------------
// The discard branch
// ---------------------------------------------------------------------------

/**
 * `sync --discard` over tree commits (D11/D15): the operator named the loss,
 * so the commits are dropped by the load engine's own discard path - consumed
 * ref first, rebuild second - under this run's transaction; the file halves of
 * the guard stay armed inside that engine.
 */
function discardBranch(
	input: TwoWayInput,
	classes: TargetClasses,
	treeState: TreeCommits,
	mark: TreeMark | null,
	crash: (stage: SyncTestCrashStage) => void
): TwoWayResult {
	const { patchesDir, resolution, config, out, flags } = input;
	let record = openRecord(input, treeState, mark, [], [], classes.patchsetOnly);
	crash('transaction-written');
	let discarded: SyncResult;
	try {
		discarded = runSync({
			patchesDir,
			resolution,
			config,
			out,
			fresh: flags.fresh,
			dryRun: false,
			verbose: input.verbose,
			discardTreeCommits: true,
			skipSyncInProgressCheck: true,
			checkpoint: (stage) => {
				crash(stage);
			}
		});
	} catch (error) {
		return stoppedMidway(input, record, classes, treeState, { error });
	}
	if (discarded.exitCode !== 0) {
		return stoppedMidway(input, record, classes, treeState, { engine: discarded });
	}
	if (discarded.discardedRef !== null) {
		record = saveSyncTransaction(patchesDir, { ...record, consumedRef: discarded.discardedRef });
	}
	retireSyncTransaction(patchesDir);
	out.info(`sync complete: the tree commits were dropped and the patchset side applied; transaction ${record.id} retired`);
	return ok('synced', classes, treeState.commits.length, { transaction: record.id, consumedRef: discarded.discardedRef });
}

// ---------------------------------------------------------------------------
// The transaction of this run
// ---------------------------------------------------------------------------

/**
 * The record of this run before its first mutation (D20), by way of
 * `openSyncTransaction`: heads, mark, and snapshots of everything the run
 * intends to rewrite.
 */
function openRecord(
	input: TwoWayInput,
	treeState: TreeCommits,
	mark: TreeMark | null,
	changes: readonly StateChange[],
	ownClasses: readonly OwnSideClass[],
	patchsetOnly: readonly string[]
): SyncTransaction {
	const { patchesDir, resolution, config } = input;
	return openSyncTransaction({
		patchesDir,
		treeDir: resolution.path,
		branch: generatedBranchName(config),
		patchsetHead: revParse(patchesDir, 'HEAD'),
		deltaDirtyBefore: deltaDirty(patchesDir),
		treeHead: treeState.head,
		markSnapshot: mark,
		treeArtifacts: changes.map((change) => `${PATCHES_DIR}/${encodePatchName(change.path)}`),
		patchsetTargets: patchsetOnly.map(artifactTarget),
		ownRelatives: ownClasses.map((entry) => entry.relative),
		ownTargetPrefix: ownTargetRelativeDir(config.ownDirName)
	});
}

/** The final atoms of a successful save half: the consumed ref and the closing commit. */
function appendOutcome(patchesDir: string, record: SyncTransaction, saved: SaveResult): SyncTransaction {
	const commits =
		saved.commit !== null && !record.patchsetCommits.includes(saved.commit)
			? [...record.patchsetCommits, saved.commit]
			: record.patchsetCommits;
	return saveSyncTransaction(patchesDir, { ...record, patchsetCommits: commits, consumedRef: saved.consumedRef });
}

/** What stopped a run mid-way: an escaped error, or an engine's own refusal result. */
type Failure = { readonly error: unknown } | { readonly engine: SaveResult | SyncResult };

/**
 * A run that refused or crashed mid-way. The engine's refusal (or the escaped
 * error) is already on the envelope; what this decides is the record's fate -
 * `resolveStoppedTransaction` retires it when nothing was written and keeps it
 * when something was, and the answer decides the exit path.
 */
function stoppedMidway(
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
// Reports
// ---------------------------------------------------------------------------

function buildData(result: TwoWayResult): JsonValue {
	return {
		status: result.status,
		classes: {
			treeOnly: [...result.classes.treeOnly],
			patchsetOnly: [...result.classes.patchsetOnly],
			both: [...result.classes.both]
		},
		treeCommits: result.treeCommitCount,
		transaction: result.transactionId,
		patchsetCommits: [...result.patchsetCommits],
		consumedRef: result.consumedRef
	};
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

/** The tree path a delta/patches artifact name encodes (PROP-004 sec. 4). */
function artifactTarget(artifact: string): string {
	return decodePatchName(artifact.split('/').pop() ?? '');
}

/** Changes the working tree carries on top of its own HEAD: the part `--discard` may not drop. */
function uncommittedChanges(tree: string, treeState: TreeCommits, ownDirName: string): readonly StateChange[] {
	return changesSince(tree, treeState.head, { kind: 'worktree' }, ownDirName);
}

/** Whether delta paths of the patchset carry uncommitted modifications right now. */
function deltaDirty(patchesDir: string): boolean {
	const status = runGit({ args: ['status', '--porcelain', '-z', '--', 'delta'], cwd: patchesDir });
	return status.status === 0 && status.stdout.trim() !== '';
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: sync needs the pin, the delta and the fork tree of this repository',
			'run sync from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

export const syncCommand: CommandDefinition = {
	name: 'sync',
	summary: 'extract the fork tree work and apply the patch set shifts, one run per side',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [SQUASH, COMMIT, MESSAGE, DISCARD, FRESH, DRY_RUN, ABORT, CONTINUE],
	run
};
