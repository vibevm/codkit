/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Durable ref/HEAD/index/work-tree transaction for provisional cycle apply.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { porcelainZEntries } from './driftGuard.ts';
import { gitOk, runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { mutateGeneratedRef } from './worktrees.ts';
import {
	cycleMoveCheckpointSchema,
	cycleMoveRecordSchema,
	cycleRecordError,
	readCycleMoveRecord,
	removeCycleMoveRecord,
	writeCycleMoveRecord,
	type CycleMoveCheckpoint,
	type CycleMoveRecord,
	type CycleMoveStoredRecord
} from './cycleMaterializeMoveReceipt.ts';
import {
	assertCycleEntryKnown,
	assertCycleFinalState,
	assertCyclePathsSafe,
	cycleOwnedConflictTemps,
	deriveCycleMoveEntries,
	materializeCycleEntries,
	writeCycleConflicts,
	type CycleConflictWrite
} from './cycleMaterializeMoveWorktree.ts';

export { CYCLE_MATERIALIZE_RECORD_PATH } from './cycleMaterializeMoveReceipt.ts';

const ZERO_SHA = '0'.repeat(40);

export type CycleMaterializeMoveCheckpoint =
	| CycleMoveCheckpoint
	| `path-deleted:${string}`
	| `checkout-batch:${number}`
	| `conflict-temp-written:${string}`
	| `conflict-renamed:${string}`
	| 'record-removed';

export type ConflictWrite = CycleConflictWrite;
export type ProvisionalMoveOptions = {
	readonly patchesDir: string;
	readonly tree: string;
	readonly branch: string;
	readonly targetPin: string;
	readonly tip: string;
	readonly changedPaths: readonly string[];
	/** Bare scratch repository that carries the prospective tip before import. */
	readonly prospectiveGitDir: string;
	readonly conflicts: readonly ConflictWrite[];
	readonly allowedOwnPaths: readonly string[];
	readonly checkpoint?: (checkpoint: CycleMaterializeMoveCheckpoint) => void;
};
export type ProvisionalMoveResult = { readonly changedPaths: readonly string[]; readonly sourceHead: string };
export type ProvisionalMovePreflight = {
	readonly prior: CycleMoveRecord | null;
	readonly record: CycleMoveRecord;
	readonly migrateLegacy: boolean;
};

/** Source commit used to compute the prospective tip diff, including resume. */
export function provisionalMoveSource(patchesDir: string, tree: string): string {
	return readCycleMoveRecord(patchesDir)?.sourceHead ?? mustHead(tree);
}

/** Entire read-only move/hazard/CAS preflight; no record, object or ref is written. */
export function prepareProvisionalMove(options: ProvisionalMoveOptions): ProvisionalMovePreflight {
	const stored = readCycleMoveRecord(options.patchesDir);
	const sourceHead = stored === null ? mustHead(options.tree) : stored.sourceHead;
	const sourceBranch = stored === null ? branchName(options.tree) : stored.sourceBranch;
	const originalRef = stored === null ? refTip(options.tree, options.branch) : stored.originalRef;
	const expected = makeRecord(options, sourceHead, sourceBranch, originalRef, stored?.checkpoint ?? 'prepared');
	if (stored !== null) assertSameTransaction(stored, expected);
	assertRefOwnership(options.tree, options.branch, options.tip, originalRef);
	assertWorktreeAvailable(options.tree, options.branch);
	assertPartialState(options, expected, stored !== null);
	return {
		prior: stored === null ? null : expected,
		record: expected,
		migrateLegacy: stored?.codkitCycleMaterialize === 1
	};
}

/** Import has completed; persist the record and execute/resume every machine step. */
export function executeProvisionalMove(options: ProvisionalMoveOptions, preflight: ProvisionalMovePreflight): ProvisionalMoveResult {
	let record = preflight.record;
	if (preflight.prior === null || preflight.migrateLegacy) {
		writeCycleMoveRecord(options.patchesDir, record);
		if (preflight.prior === null) notify(options, 'prepared');
	}
	// The same generated-ref guard as sync (PROP-008
	// ##GENERATED-REF-WORKTREE-PREFLIGHT): both moving the shared ref and
	// selecting it as this worktree's HEAD happen under one common-repository
	// lock and one fresh preflight. Guarding only update-ref would leave the
	// resume case (ref already at tip, HEAD not selected yet) able to race a
	// sibling worktree onto the same generated branch.
	mutateGeneratedRef(options.tree, `refs/heads/${options.branch}`, () => {
		if (refTip(options.tree, options.branch) !== options.tip) {
			mustGit(
				options.tree,
				['update-ref', `refs/heads/${options.branch}`, options.tip, record.originalRef ?? ZERO_SHA],
				`claim ${options.branch}`
			);
		}
		if (branchName(options.tree) !== options.branch || mustHead(options.tree) !== options.tip) {
			mustGit(options.tree, ['symbolic-ref', 'HEAD', `refs/heads/${options.branch}`], `select ${options.branch}`);
		}
	});
	record = advance(options, record, 'ref-updated');
	record = advance(options, record, 'head-selected');

	// After this durable point the live index can be changed by external tools.
	// Worktree bytes always come from the exact-tip isolated index instead.
	if (checkpointIndex(record.checkpoint) < checkpointIndex('index-reset')) {
		mustGit(options.tree, ['read-tree', '--reset', options.tip], 'reset the provisional index');
	}
	record = advance(options, record, 'index-reset');
	const touched = materializeCycleEntries({
		tree: options.tree,
		prospectiveGitDir: options.prospectiveGitDir,
		tip: record.tip,
		entries: record.entries,
		conflicts: options.conflicts,
		notify: (checkpoint) => notify(options, checkpoint as CycleMaterializeMoveCheckpoint)
	});
	record = advance(options, record, 'checkout-complete');
	const conflictTouched = writeCycleConflicts(options.tree, record.tip, record.entries, options.conflicts, (checkpoint) =>
		notify(options, checkpoint as CycleMaterializeMoveCheckpoint)
	);
	record = advance(options, record, 'conflicts-written');
	assertCycleFinalState(options.tree, record.entries, options.conflicts);
	record = advance(options, record, 'verified');
	removeCycleMoveRecord(options.patchesDir);
	notify(options, 'record-removed');
	return { changedPaths: byteSorted([...touched, ...conflictTouched]), sourceHead: record.sourceHead };
}

function makeRecord(
	options: ProvisionalMoveOptions,
	sourceHead: string,
	sourceBranch: string | null,
	originalRef: string | null,
	checkpoint: CycleMoveCheckpoint
): CycleMoveRecord {
	const changedPaths = byteSorted(options.changedPaths);
	const managedPaths = byteSorted([...changedPaths, ...options.conflicts.map((entry) => entry.path)]);
	const entries = deriveCycleMoveEntries(options.prospectiveGitDir, options.tree, sourceHead, options.tip, managedPaths);
	return cycleMoveRecordSchema.parse({
		codkitCycleMaterialize: 2,
		branch: options.branch,
		targetPin: options.targetPin,
		tip: options.tip,
		sourceHead,
		sourceBranch,
		originalRef,
		changedPaths,
		entries,
		conflicts: byteSorted(options.conflicts.map((entry) => entry.path)).map((path) => {
			const found = options.conflicts.find((entry) => entry.path === path);
			if (found === undefined) throw ckError('INTERNAL', `missing conflict bytes for ${path}`);
			return { path, sha256: hash(found.bytes) };
		}),
		checkpoint
	});
}

function assertSameTransaction(stored: CycleMoveStoredRecord, expected: CycleMoveRecord): void {
	const common = (record: CycleMoveStoredRecord | CycleMoveRecord): string =>
		JSON.stringify({
			branch: record.branch,
			targetPin: record.targetPin,
			tip: record.tip,
			sourceHead: record.sourceHead,
			sourceBranch: record.sourceBranch,
			originalRef: record.originalRef,
			changedPaths: record.changedPaths,
			conflicts: record.conflicts
		});
	if (common(stored) !== common(expected)) throw cycleRecordError('does not match this target pin, tip, paths, or conflict bytes');
	if (stored.codkitCycleMaterialize === 2) {
		const normalize = (record: CycleMoveRecord): string => JSON.stringify({ ...record, checkpoint: 'prepared' });
		if (normalize(stored) !== normalize(expected)) throw cycleRecordError('physical endpoint identity changed');
	}
}

function assertPartialState(options: ProvisionalMoveOptions, record: CycleMoveRecord, resuming: boolean): void {
	const head = mustHead(options.tree);
	const branch = branchName(options.tree);
	if (head !== record.sourceHead && head !== record.tip) throw cycleRecordError(`fork HEAD is unexpected ${head}`);
	if (branch !== record.sourceBranch && branch !== record.branch)
		throw cycleRecordError(`fork branch is unexpected ${branch ?? 'detached'}`);
	assertCyclePathsSafe(options.tree, record.entries);
	const ownedTemps = cycleOwnedConflictTemps(options.tree, record.tip, record.entries, options.conflicts);
	const allowed = new Set([...record.changedPaths, ...options.conflicts.map((entry) => entry.path), ...ownedTemps.keys()]);
	for (const entry of statusWithIgnored(options.tree)) {
		if (expectedOwnStatus(entry.path, options.allowedOwnPaths)) continue;
		const temp = ownedTemps.get(entry.path);
		if (temp !== undefined) {
			if ((entry.status !== '??' && entry.status !== '!!') || !Buffer.from(readFileSync(temp.absolute)).equals(Buffer.from(temp.bytes)))
				throw dirt(`invalid transaction temp ${entry.path}`);
			continue;
		}
		if (entry.status === '!!') {
			if (overlapsAny(entry.path, record.changedPaths)) throw dirt(`ignored path blocks checkout: ${entry.path}`);
			continue;
		}
		if (!allowed.has(entry.path)) throw dirt(`unknown ${entry.status} ${entry.path}`);
		if ((entry.status === '??' || entry.status[0] !== ' ') && !resuming) throw dirt(`untracked or staged ${entry.status} ${entry.path}`);
	}
	for (const entry of record.entries) {
		assertCycleEntryKnown(
			options.tree,
			entry,
			options.conflicts.find((candidate) => candidate.path === entry.path),
			record.entries
		);
	}
}

function statusWithIgnored(tree: string): readonly { readonly status: string; readonly path: string }[] {
	const result = gitOk(
		{
			args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'],
			cwd: tree,
			env: { GIT_OPTIONAL_LOCKS: '0' }
		},
		{ code: 'NOT-A-REPO', message: 'cannot inspect provisional tree dirt' }
	);
	return porcelainZEntries(result.stdout);
}

function assertRefOwnership(tree: string, branch: string, tip: string, originalRef: string | null): void {
	const current = refTip(tree, branch);
	if (current !== originalRef && current !== tip)
		throw ckError(
			'CONFIG',
			`provisional ref ${branch} moved to ${current ?? 'absent'}`,
			'inspect the ref; codkit will not overwrite another owner'
		);
	if (originalRef !== null && originalRef !== tip && current === originalRef)
		throw ckError(
			'CONFIG',
			`provisional ref ${branch} already points at unrelated ${originalRef}`,
			'remove or rename that ref after inspection'
		);
}

function assertWorktreeAvailable(tree: string, branch: string): void {
	const result = gitOk(
		{ args: ['worktree', 'list', '--porcelain'], cwd: tree, env: { GIT_OPTIONAL_LOCKS: '0' } },
		{ code: 'ARTIFACT-BROKEN', message: 'cannot inspect linked worktrees before provisional ref movement' }
	).stdout;
	let worktree = '';
	for (const line of result.split('\n')) {
		if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
		if (line === `branch refs/heads/${branch}` && worktree !== tree)
			throw ckError('CONFIG', `provisional branch ${branch} is checked out in ${worktree}`, 'finish that worktree before continuing here');
	}
}

function advance(options: ProvisionalMoveOptions, record: CycleMoveRecord, checkpoint: CycleMoveCheckpoint): CycleMoveRecord {
	if (checkpointIndex(record.checkpoint) >= checkpointIndex(checkpoint)) return record;
	const next = { ...record, checkpoint };
	writeCycleMoveRecord(options.patchesDir, next);
	notify(options, checkpoint);
	return next;
}

function checkpointIndex(checkpoint: CycleMoveCheckpoint): number {
	return cycleMoveCheckpointSchema.options.indexOf(checkpoint);
}

function mustHead(tree: string): string {
	return readGit(tree, ['rev-parse', '--verify', 'HEAD'], 'resolve fork HEAD').stdout.trim();
}

function branchName(tree: string): string | null {
	const result = runGit({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: tree, env: { GIT_OPTIONAL_LOCKS: '0' } });
	return result.status === 0 ? result.stdout.trim() : null;
}

function refTip(tree: string, branch: string): string | null {
	const result = runGit({
		args: ['show-ref', '--verify', '--hash', `refs/heads/${branch}`],
		cwd: tree,
		env: { GIT_OPTIONAL_LOCKS: '0' }
	});
	return result.status === 0 && /^[0-9a-f]{40}$/.test(result.stdout.trim()) ? result.stdout.trim() : null;
}

function readGit(tree: string, args: readonly string[], action: string) {
	return gitOk(
		{ args, cwd: tree, env: { GIT_OPTIONAL_LOCKS: '0' } },
		{ code: 'ARTIFACT-BROKEN', message: `cannot ${action} during provisional movement`, hint: 'repair the fork repository and retry' }
	);
}

function mustGit(tree: string, args: readonly string[], action: string) {
	return gitOk(
		{ args, cwd: tree },
		{ code: 'ARTIFACT-BROKEN', message: `cannot ${action} during provisional movement`, hint: 'repair the fork repository and retry' }
	);
}

function expectedOwnStatus(path: string, allowed: readonly string[]): boolean {
	if (allowed.includes(path)) return true;
	return path.endsWith('/') && allowed.some((candidate) => candidate.startsWith(path));
}

function overlapsAny(path: string, changed: readonly string[]): boolean {
	const clean = path.endsWith('/') ? path.slice(0, -1) : path;
	return changed.some((candidate) => candidate === clean || candidate.startsWith(`${clean}/`) || clean.startsWith(`${candidate}/`));
}

function notify(options: ProvisionalMoveOptions, checkpoint: CycleMaterializeMoveCheckpoint): void {
	options.checkpoint?.(checkpoint);
}

function byteSorted(paths: readonly string[]): readonly string[] {
	return [...new Set(paths)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function hash(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function dirt(detail: string): Error {
	return ckError('DIRTY-TREE', `cycle materialization found ${detail}`, 'save or restore this work before continuing');
}
