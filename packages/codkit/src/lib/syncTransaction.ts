/** @scope spec://codkit/modules/codkit/PROP-006#SYNC-TRANSACTION-FILE */
// The durable transaction of the two-way `codkit sync` (PROP-008 sec. 5a
// ##SYNC-TRANSACTION; campaign TREE-COMMITS-SAVE, decision D20).
//
// A sync mutates two repositories in one logical step: it extracts the tree's
// work into patchset artifacts and commits, then rebuilds the tree from a delta
// that patchset may have moved under it. A process loss in the middle leaves a
// tree that is half one thing and half another - exactly the state no other
// command may quietly operate on. The transaction file is how that state says
// its own name: written before the first mutation (exclusively, so a second
// sync cannot start over a live one), appended after every atom a recovery
// would need (each patchset commit, the consumed ref), retired only after the
// last. While it exists, the engines refuse with CK-E-SYNC-IN-PROGRESS
// (PROP-008 ##SYNC-TWO-PASS) instead of loading or saving over the halves.
//
// The record is a recovery plan, not a lock: the per-tree lock still does that
// job. What it carries is what no other file knows - the pre-run heads, the
// byte snapshots of everything the run intended to rewrite (`git hash-object
// -w`, so a snapshot is content-addressed and survives in the object database),
// and the shas of the patchset commits it made, each of which also carries the
// `Codkit-Sync-Transaction` trailer so a recovery can recognize this run's
// commits by content even where the record's list ends mid-crash.
//
// The file lives under `.codkit/` of the patchset root, beside the other
// runtime state that owns its own protocol (F24): hands and `gc` do not touch
// it, and its class of state is deliberate - `status` reports it, `load` and
// `save` refuse over it, and the `--abort`/`--continue` recovery of the
// conflict-materialization phase is its reader.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { encodeUtf8 } from './bytes.ts';
import { readContainedFile, removeContainedFile, writeContainedFileAtomic, writeContainedFileExclusive } from './containedFile.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import type { Output } from './jsonOut.ts';
import { revParse } from './treeCache.ts';
import type { TreeMark } from './treeCache.ts';

/** Where the record lives, relative to the patchset root. */
export const SYNC_TRANSACTION_RELATIVE_PATH = '.codkit/sync-transaction.json';

/** The trailer that names this run on every patchset commit it makes (D20). */
export const SYNC_TRANSACTION_TRAILER = 'Codkit-Sync-Transaction';

/** Schema version of the record; a different number is a foreign record. */
const SYNC_TRANSACTION_VERSION = 1;

/** One file the run intends to rewrite, with its pre-run bytes in the object database. */
export type SyncTransactionRewrite = {
	/** Which repository the path belongs to. */
	readonly repo: 'patchset' | 'tree';
	/** Repository-relative POSIX path. */
	readonly path: string;
	/** sha of the pre-run bytes (`hash-object -w`), or null when the file does not exist yet. */
	readonly blob: string | null;
};

export type SyncTransaction = {
	readonly codkitSyncTransaction: number;
	readonly id: string;
	readonly startedAt: string;
	readonly patchset: {
		readonly head: string;
		/** Whether delta paths were already modified when the run started. */
		readonly dirtyBefore: boolean;
	};
	readonly tree: {
		readonly head: string;
		readonly branchTip: string | null;
		/** The apply mark as the run found it; a recovery writes it back verbatim. */
		readonly markSnapshot: TreeMark | null;
	};
	readonly rewrite: readonly SyncTransactionRewrite[];
	/** Shas of the patchset commits this run made, oldest first. */
	readonly patchsetCommits: readonly string[];
	readonly consumedRef: string | null;
	/** Conflict tree files of the run (D19, Phase 8b), with the state of their materialization. */
	readonly conflicts: readonly SyncTransactionConflict[];
};

/**
 * One materialized conflict of the record (D21): the tree path the markers
 * went into, and - only once the bytes were actually written - the sha256 of
 * what was written. `materialized: null` means the run stopped before the
 * merge reached this file (a crash between the record and the write), which is
 * exactly the fact `sync --continue` refuses over: no human ever saw markers.
 */
export type SyncTransactionConflict = {
	readonly path: string;
	readonly materialized: string | null;
};

// The mark snapshot is stored as the parsed mark this run read (already
// validated by `readTreeMark`); this record is written and read by codkit
// alone, so the envelope is what needs proving strict, not the mark's fields.
const syncTransactionSchema = z.object({
	codkitSyncTransaction: z.literal(SYNC_TRANSACTION_VERSION),
	id: z.string().min(1),
	startedAt: z.string().min(1),
	patchset: z.object({ head: z.string().min(1), dirtyBefore: z.boolean() }),
	tree: z.object({
		head: z.string().min(1),
		branchTip: z.string().min(1).nullable(),
		markSnapshot: z.record(z.string(), z.unknown()).nullable()
	}),
	rewrite: z.array(z.object({ repo: z.enum(['patchset', 'tree']), path: z.string().min(1), blob: z.string().min(1).nullable() })),
	patchsetCommits: z.array(z.string().min(1)),
	consumedRef: z.string().min(1).nullable(),
	conflicts: z.array(z.object({ path: z.string().min(1), materialized: z.string().min(1).nullable() }))
});

/** What a caller needs to start a record; `id` and `startedAt` are made here. */
export type SyncTransactionInput = {
	readonly patchset: { readonly head: string; readonly dirtyBefore: boolean };
	readonly tree: { readonly head: string; readonly branchTip: string | null; readonly markSnapshot: TreeMark | null };
	readonly rewrite: readonly SyncTransactionRewrite[];
	/** Tree paths of the both-sides conflicts this run opens with (D19), unmaterialized. */
	readonly conflicts?: readonly SyncTransactionConflict[];
	readonly now?: () => Date;
};

/**
 * The record of a live sync, or null when none is. A present file that does not
 * parse is a diagnosis of its own: the write is atomic, so this is corruption,
 * and the caller refuses over it rather than guessing (fail closed).
 */
export function readSyncTransaction(patchesDir: string): SyncTransaction | null {
	const read = readContainedFile(patchesDir, SYNC_TRANSACTION_RELATIVE_PATH, {
		what: SYNC_TRANSACTION_RELATIVE_PATH,
		code: 'ARTIFACT-BROKEN'
	});
	if (read.state === 'absent') {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(read.bytes));
	} catch (error) {
		throw unreadable(error);
	}
	const record = syncTransactionSchema.safeParse(parsed);
	if (!record.success) {
		throw unreadable(record.error);
	}
	const value = record.data;
	return {
		codkitSyncTransaction: value.codkitSyncTransaction,
		id: value.id,
		startedAt: value.startedAt,
		patchset: value.patchset,
		tree: { ...value.tree, markSnapshot: (value.tree.markSnapshot ?? null) as TreeMark | null },
		rewrite: value.rewrite,
		patchsetCommits: value.patchsetCommits,
		consumedRef: value.consumedRef,
		conflicts: value.conflicts
	};
}

/**
 * The engines' step 0 (PROP-008 ##SYNC-TWO-PASS): while a transaction is live,
 * `load`, `save` and every rebuilding caller refuse with CK-E-SYNC-IN-PROGRESS
 * instead of operating on a tree that is half one thing and half another.
 * Returns true when the refusal was issued and the caller must stop with exit 1.
 */
export function refuseOverLiveSyncTransaction(patchesDir: string, command: string, out: Output): boolean {
	const record = readSyncTransaction(patchesDir);
	if (record === null) {
		return false;
	}
	out.addError(
		ckError(
			'SYNC-IN-PROGRESS',
			`a codkit sync (transaction ${record.id}) did not finish, and ${command} refuses to operate on its half-applied state`,
			'wait for the running sync, or resolve its record first: codkit sync --continue after resolving its conflict markers, ' +
				`or codkit sync --abort to return everything to the state before the run; the record is ${SYNC_TRANSACTION_RELATIVE_PATH}`,
			SYNC_TRANSACTION_RELATIVE_PATH
		).toPayload()
	);
	return true;
}

/**
 * Write the record before the first mutation (D20). The publication is
 * exclusive by construction, so a second sync starting over a live one loses
 * the link race and is refused - there is no window in which two transactions
 * believe they own the same run.
 */
export function createSyncTransaction(patchesDir: string, input: SyncTransactionInput): SyncTransaction {
	const record: SyncTransaction = {
		codkitSyncTransaction: SYNC_TRANSACTION_VERSION,
		id: transactionId(input.now ?? (() => new Date())),
		startedAt: (input.now ?? (() => new Date()))().toISOString(),
		patchset: input.patchset,
		tree: input.tree,
		rewrite: input.rewrite,
		patchsetCommits: [],
		consumedRef: null,
		conflicts: [...(input.conflicts ?? [])]
	};
	const published = writeContainedFileExclusive(patchesDir, SYNC_TRANSACTION_RELATIVE_PATH, {
		bytes: encodeUtf8(serialize(record)),
		what: SYNC_TRANSACTION_RELATIVE_PATH
	});
	if (!published) {
		const existing = readSyncTransaction(patchesDir);
		throw ckError(
			'SYNC-IN-PROGRESS',
			`cannot start a sync: ${SYNC_TRANSACTION_RELATIVE_PATH} already exists` + (existing === null ? '' : ` (transaction ${existing.id})`),
			'resolve the live record first: codkit sync --continue after resolving its conflict markers, or codkit sync --abort'
		);
	}
	return record;
}

/**
 * Append an atom and republish atomically. The record was created exclusively
 * and lives under the tree lock this run holds, so the replacement is an
 * ordinary atomic write of codkit's own file - never a second publication.
 */
export function saveSyncTransaction(patchesDir: string, record: SyncTransaction): SyncTransaction {
	writeContainedFileAtomic(patchesDir, SYNC_TRANSACTION_RELATIVE_PATH, {
		bytes: encodeUtf8(serialize(record)),
		what: SYNC_TRANSACTION_RELATIVE_PATH
	});
	return record;
}

/** Retire the record after the last atom (D20); absent is already retired. */
export function retireSyncTransaction(patchesDir: string): void {
	removeContainedFile(patchesDir, SYNC_TRANSACTION_RELATIVE_PATH, { what: SYNC_TRANSACTION_RELATIVE_PATH });
}

/** The paths one open record snapshots, by repository: everything the run intends to rewrite. */
export type OpenSyncTransactionInput = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly branch: string;
	readonly patchsetHead: string | null;
	readonly deltaDirtyBefore: boolean;
	readonly treeHead: string;
	readonly markSnapshot: TreeMark | null;
	/** Patchset-relative artifact paths of the tree's selection (the save half writes them). */
	readonly treeArtifacts: readonly string[];
	/** Tree paths the patch set moved (the rebuild rewrites them). */
	readonly patchsetTargets: readonly string[];
	/**
	 * Every own file diverging between the sides, as the pair of paths it lives
	 * at: the artifact inside the delta directory of its owned root, and its
	 * materialization in the tree (PROP-016 ##TYPE-AREA-LAYOUT).
	 */
	readonly ownPaths: readonly { readonly artifact: string; readonly target: string }[];
	/** Tree paths of the both-sides conflicts (D19): the run materializes markers into them. */
	readonly conflictTargets: readonly string[];
};

/**
 * The record before the first mutation, snapshots included (D20): both heads,
 * the mark as the run found it, and the byte snapshots of everything the run
 * intends to rewrite - the artifacts of the tree's selection, the targets the
 * patch set moved, every divergent own file on both its sides, and the files
 * the diff3 materialization is about to rewrite (Phase 8b).
 */
export function openSyncTransaction(input: OpenSyncTransactionInput): SyncTransaction {
	return createSyncTransaction(input.patchesDir, {
		patchset: { head: input.patchsetHead ?? '', dirtyBefore: input.deltaDirtyBefore },
		tree: { head: input.treeHead, branchTip: revParse(input.treeDir, `refs/heads/${input.branch}`), markSnapshot: input.markSnapshot },
		rewrite: [
			...snapshotForTransaction(input.patchesDir, 'patchset', input.treeArtifacts),
			...snapshotForTransaction(input.treeDir, 'tree', input.patchsetTargets),
			...snapshotForTransaction(
				input.patchesDir,
				'patchset',
				input.ownPaths.map((pair) => pair.artifact)
			),
			...snapshotForTransaction(
				input.treeDir,
				'tree',
				input.ownPaths.map((pair) => pair.target)
			),
			...snapshotForTransaction(input.treeDir, 'tree', input.conflictTargets)
		],
		conflicts: input.conflictTargets.map((path) => ({ path, materialized: null }))
	});
}

/**
 * What a refused or crashed run does with its own record: a run that wrote
 * nothing (the snapshots still match, neither HEAD moved) retires it - the
 * refusal was a diagnosis, and a live record would lock `load` and `save` out
 * of an unchanged world. A run that wrote anything keeps it: that is the
 * half-state the record exists to name, for the recovery of the next phase.
 */
export function resolveStoppedTransaction(
	patchesDir: string,
	treeDir: string,
	record: SyncTransaction,
	out: Output
): 'untouched' | 'written' {
	if (rewriteStillUntouched(patchesDir, treeDir, record)) {
		retireSyncTransaction(patchesDir);
		out.info('the sync refused before any write; its transaction record was removed');
		return 'untouched';
	}
	out.warn(
		`the sync stopped after writing; its record stays at ${SYNC_TRANSACTION_RELATIVE_PATH} and load/save refuse until it is resolved`
	);
	return 'written';
}

/**
 * Record that one conflict's markers actually landed in its file (D21): the
 * sha256 of the written bytes turns the record's entry from "never reached the
 * file" into "materialized", which is the difference `sync --continue` refuses
 * over. Appended only after the write, so a crash between the two leaves the
 * honest `null`.
 */
export function appendConflictMaterialized(
	patchesDir: string,
	record: SyncTransaction,
	path: string,
	materialized: string
): SyncTransaction {
	const conflicts = record.conflicts.map((conflict) => (conflict.path === path ? { path, materialized } : conflict));
	return saveSyncTransaction(patchesDir, { ...record, conflicts });
}

/** The snapshot entry of one path, by repository, as the record holds it. */
export function recordedRewriteOf(
	record: SyncTransaction,
	repo: SyncTransactionRewrite['repo'],
	path: string
): SyncTransactionRewrite | null {
	return record.rewrite.find((entry) => entry.repo === repo && entry.path === path) ?? null;
}

/**
 * The snapshots of D20: `git hash-object -w` of every named file into the
 * repository it belongs to, so the pre-run bytes are content-addressed in the
 * object database and a recovery can restore them byte for byte. A path that
 * does not exist is recorded as null - its "snapshot" is absence, which is
 * what a rollback would restore.
 */
export function snapshotForTransaction(
	repoDir: string,
	repo: SyncTransactionRewrite['repo'],
	paths: readonly string[]
): readonly SyncTransactionRewrite[] {
	return paths.map((path) => {
		if (!existsSync(join(repoDir, ...path.split('/')))) {
			return { repo, path, blob: null };
		}
		const hashed = runGit({ args: ['hash-object', '-w', '--', path], cwd: repoDir });
		if (hashed.status !== 0) {
			throw ckError(
				'INTERNAL',
				`cannot snapshot ${path} of the ${repo} repository for the sync transaction: ${hashed.stderr.trim()}`,
				're-run with --verbose and attach the output to a bug report'
			);
		}
		return { repo, path, blob: hashed.stdout.trim() };
	});
}

/**
 * Whether every snapshotted byte still matches its snapshot and neither HEAD
 * moved: the proof a refused run uses before retiring its own record. A run
 * that wrote nothing leaves exactly the state it photographed; a run that
 * wrote anything does not, and its record must stay for the recovery.
 */
export function rewriteStillUntouched(patchesDir: string, treeDir: string, record: SyncTransaction): boolean {
	const patchsetHead = runGit({ args: ['rev-parse', 'HEAD'], cwd: patchesDir });
	if (patchsetHead.status !== 0 || patchsetHead.stdout.trim() !== record.patchset.head) {
		return false;
	}
	const treeHead = runGit({ args: ['rev-parse', 'HEAD'], cwd: treeDir });
	if (treeHead.status !== 0 || treeHead.stdout.trim() !== record.tree.head) {
		return false;
	}
	for (const entry of record.rewrite) {
		const repoDir = entry.repo === 'patchset' ? patchesDir : treeDir;
		if (entry.blob === null) {
			if (existsSync(join(repoDir, ...entry.path.split('/')))) {
				return false;
			}
			continue;
		}
		const hashed = runGit({ args: ['hash-object', '--', entry.path], cwd: repoDir });
		if (hashed.status !== 0 || hashed.stdout.trim() !== entry.blob) {
			return false;
		}
	}
	return true;
}

function serialize(record: SyncTransaction): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

/** UTC-stamped, single-run unique: readable in `status`, sortable in a directory listing. */
function transactionId(now: () => Date): string {
	const stamp = now()
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function unreadable(cause: unknown): Error {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return ckError(
		'ARTIFACT-BROKEN',
		`${SYNC_TRANSACTION_RELATIVE_PATH} exists but cannot be parsed as a sync transaction record: ${detail}`,
		'codkit wrote that file atomically, so this is corruption or a foreign file; inspect it before removing it'
	);
}

// ---------------------------------------------------------------------------
// Test-only hard-process interruption through the real CLI (the shape of
// saveReplay.ts): the environment variable names a stage, the checkpoint
// hard-exits the first time the stage is reached, and both are refused outside
// the test runtime. The stages are the atoms of PROP-008 sec. 5a that the
// campaign proves: the record before the first mutation, each materialized
// conflict file (Phase 8b), each patchset commit, and the two post-checkout
// windows of the rebuild.
// ---------------------------------------------------------------------------

export const SYNC_TEST_CRASH_ENV = 'CODKIT_TEST_SYNC_CRASH_AT';
export const SYNC_TEST_CRASH_EXIT_CODE = 86;
export const SYNC_TEST_CRASH_STAGES = [
	'transaction-written',
	'conflict-materialized',
	'state-committed',
	'worktree-moved',
	'mark-written'
] as const;

export type SyncTestCrashStage = (typeof SYNC_TEST_CRASH_STAGES)[number];

export function syncCrashCheckpoint(
	crashAt: unknown,
	testBuild: boolean,
	terminate: (exitCode: number) => never = hardExit
): ((stage: SyncTestCrashStage) => void) | undefined {
	if (crashAt === undefined || crashAt === '') {
		return undefined;
	}
	if (!SYNC_TEST_CRASH_STAGES.includes(crashAt as SyncTestCrashStage)) {
		throw ckError('CONFIG', `${SYNC_TEST_CRASH_ENV} names an unknown sync stage`, `use one of: ${SYNC_TEST_CRASH_STAGES.join(', ')}`);
	}
	if (!testBuild) {
		throw ckError('CONFIG', `${SYNC_TEST_CRASH_ENV} is disabled outside the test runtime`, 'unset the test-only crash injection variable');
	}
	return (stage) => {
		if (stage === crashAt) {
			terminate(SYNC_TEST_CRASH_EXIT_CODE);
		}
	};
}

function hardExit(exitCode: number): never {
	// Deliberately bypasses catch/finally, matching an uncatchable process loss
	// at the exact boundary the stage names - record, lock and all.
	process.exit(exitCode);
}
