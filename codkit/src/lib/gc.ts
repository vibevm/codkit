/** @scope spec://codkit/modules/codkit/PROP-006#GC-CLASSES */
// codkit gc - one command for the state earlier phases deliberately kept
// (PROP-006 sec. 1 ##GC-CLASSES; campaign TREE-COMMITS-SAVE, decision D22).
//
// Everything this command may delete was kept for a reason that expires:
// consumed refs hold lines patchset already replayed, tmp scratch is cleaned
// in a `finally` a crash never runs, a tree cache describes a checkout that
// can be deleted by hand. Everything it must never delete is the opposite -
// state whose whole point is to outlive the run that wrote it: transaction
// records and receipts (a stopped sync is recovered from its file, not from
// memory), pending draft headers, daemon records, and every lock held by a
// live process. The command therefore classifies first and acts second, and
// the plan it prints names the kept classes as kept, so the operator sees
// the line between spent and live before anything goes (R14: a --dry-run is
// compared with the real removal one to one).
//
// Deleting is the dangerous direction, so the classes are closed (D22) and
// every removal is of one entry the classifier itself named - never a glob
// over a directory, and never a recursive removal of a directory the command
// did not classify entry by entry.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitOk } from './gitx.ts';
import { acquirePathLock, isAlive, lockPath, readLock } from './lock.ts';
import type { LockInfo } from './lock.ts';
import { ckError, isCkError } from './messages.ts';
import { PENDING_DIR } from './pendingHeader.ts';
import { readTreeCache, TREES_DIR } from './treeCache.ts';
import { CONSUMED_REF_PREFIX } from './treeCommits.ts';
import { acquireCommonRepositoryLock } from './worktrees.ts';

/** What a plan line says will happen to its entry. */
export type GcAction = 'remove' | 'keep';

/** The closed set of classes D22 names; anything else is not gc's business. */
export type GcClass =
	'consumed-ref' | 'tmp' | 'lock' | 'tree-cache' | 'out' | 'transaction' | 'receipt' | 'pending' | 'build' | 'daemon-lock';

export type GcEntry = {
	readonly action: GcAction;
	readonly klass: GcClass;
	/** Ref name or patchset-relative path, as the operator would type it. */
	readonly path: string;
	readonly reason: string;
};

export type GcPlan = {
	readonly entries: readonly GcEntry[];
	/** The stale own-tree lock this run's acquisition took over (##LOCK-MECHANISM), named as a removal. */
	readonly takeover: readonly GcEntry[];
};

export type GcOptions = {
	readonly patchesDir: string;
	readonly treeDir: string;
	/** The 16-hex tree key of `treeDir`, so gc does not list its own live lock. */
	readonly ownTreeKey: string;
	/** Keep the newest N consumed refs regardless of age (default 5, D22). */
	readonly keepConsumed: number;
	/** Beyond the kept window, remove refs at least this many days old (default 30). */
	readonly olderThanDays: number;
	readonly now?: () => Date;
	/** Owner-liveness oracle; injectable so a test never has to kill a pid. */
	readonly ownerAlive?: (pid: number) => boolean;
	/**
	 * What the lock acquisition reported taking over: the per-tree lock of THIS
	 * tree is not gc's to classify (gc holds it), but a takeover is a real
	 * removal the plan must name - the lock protocol performs it on every
	 * acquisition, gc's included, in both --dry-run and a real run.
	 */
	readonly ownLockTakeover?: { readonly holder: LockInfo } | null;
};

export type GcOutcome = {
	readonly removed: readonly GcEntry[];
	readonly kept: readonly GcEntry[];
};

const LOCKS_DIR = '.codkit/locks';
const TMP_DIR = '.codkit/tmp';
const OUT_DIR = '.codkit/out';
const BUILD_DIR = '.codkit/build';
const RENAME_TRANSACTION = '.codkit/rename-transaction.json';
const RENAME_COMPLETIONS = '.codkit/rename-completions';
const REBASE_RECEIPTS = '.codkit/rebase-onto-pin';
const SYNC_TRANSACTION = '.codkit/sync-transaction.json';

/** A per-tree lock or its private generation: `<16 hex>.lock[.<uuid>.owner]`. */
const TREE_LOCK_NAME = /^([0-9a-f]{16})\.lock(?:\.[0-9a-f-]{36}\.owner)?$/;
/** buildBranch scratch, keyed by the tree it builds (`<16 hex>.index|.blob`). */
const TREE_SCRATCH_NAME = /^([0-9a-f]{16})\.(index|blob)$/;
/** The stamp `recordConsumedRef` puts in every ref name. */
const CONSUMED_STAMP = /^(\d{8}T\d{6}Z)-[0-9a-f]{7,40}$/;

const DAY_MS = 86_400_000;

/**
 * The whole classification, before anything is removed. Read-only: the plan a
 * `--dry-run` prints is the very list the real run would act on.
 */
export function planGc(options: GcOptions): GcPlan {
	const entries: GcEntry[] = [
		...consumedRefEntries(options),
		...tmpEntries(options),
		...lockEntries(options),
		...treeCacheEntries(options),
		...outEntries(options),
		...keptStateEntries(options)
	];
	const order: Record<GcClass, number> = {
		'consumed-ref': 0,
		tmp: 1,
		lock: 2,
		'tree-cache': 3,
		out: 4,
		transaction: 5,
		receipt: 6,
		pending: 7,
		build: 8,
		'daemon-lock': 9
	};
	entries.sort((left, right) => order[left.klass] - order[right.klass] || left.path.localeCompare(right.path));
	const takeover =
		options.ownLockTakeover === undefined || options.ownLockTakeover === null
			? []
			: [
					{
						action: 'remove' as const,
						klass: 'lock' as const,
						path: `${LOCKS_DIR}/${options.ownTreeKey}.lock`,
						reason:
							`left by pid ${options.ownLockTakeover.holder.pid} ("${options.ownLockTakeover.holder.command}"); ` +
							'the lock protocol removes a stale lock on acquisition, and this run acquired the tree lock'
					}
				];
	return { entries, takeover };
}

/**
 * Remove exactly the entries the plan marked, one classified entry at a time.
 * A lock that became live between the plan and the removal is kept and the
 * outcome says so - losing that race to a live process is the safe direction.
 */
export function executeGc(plan: GcPlan, options: GcOptions): GcOutcome {
	const removed: GcEntry[] = [];
	const kept: GcEntry[] = [...plan.entries.filter((entry) => entry.action === 'keep')];
	for (const entry of plan.entries) {
		if (entry.action === 'keep') {
			continue;
		}
		if (entry.klass === 'consumed-ref') {
			removeConsumedRef(options, entry.path);
			removed.push(entry);
			continue;
		}
		if (entry.klass === 'lock' && entry.path.endsWith('.owner')) {
			// A private generation link whose public name is already gone: no
			// election is possible (there is nothing to succeed it), and the pid
			// inside was proven gone, so the debris is simply taken away.
			rmSync(join(options.patchesDir, ...entry.path.split('/')), { force: true });
			removed.push(entry);
			continue;
		}
		if (entry.klass === 'lock') {
			// Through the acquisition protocol, never a bare unlink: the election
			// it performs is what keeps a late release from unlinking a successor.
			try {
				acquirePathLock(join(options.patchesDir, ...entry.path.split('/')), 'gc').release();
			} catch (error) {
				if (!isCkError(error) || error.code !== 'LOCKED') {
					throw error;
				}
				kept.push({ ...entry, action: 'keep', reason: 'became live between the plan and the removal' });
				continue;
			}
			removed.push(entry);
			continue;
		}
		rmSync(join(options.patchesDir, ...entry.path.split('/')), { recursive: true, force: true });
		removed.push(entry);
	}
	return { removed: [...removed, ...plan.takeover], kept };
}

// ---------------------------------------------------------------------------
// Consumed refs (D6 keeps them, D22 spends them)
// ---------------------------------------------------------------------------

function consumedRefEntries(options: GcOptions): readonly GcEntry[] {
	const listing = gitOk(
		{ args: ['for-each-ref', '--format=%(refname)', CONSUMED_REF_PREFIX], cwd: options.treeDir },
		{ code: 'INTERNAL', message: 'cannot list consumed refs', hint: 'check that the fork repository is readable' }
	);
	const now = (options.now ?? (() => new Date()))().getTime();
	const stamped = listing.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.flatMap((ref): { readonly ref: string; readonly stamp: string }[] => {
			const match = CONSUMED_STAMP.exec(ref.slice(CONSUMED_REF_PREFIX.length));
			// A name without the stamp is not a ref codkit wrote; a human used
			// that namespace, and gc does not spend what it cannot recognize.
			return match === null ? [] : [{ ref, stamp: match[1] ?? '' }];
		})
		.sort((left, right) => right.stamp.localeCompare(left.stamp));
	return stamped.map((item, rank) => {
		const ageDays = (now - Date.parse(`${item.stamp.slice(0, 8)}T${item.stamp.slice(8)}`)) / DAY_MS;
		if (rank < options.keepConsumed) {
			return {
				action: 'keep' as const,
				klass: 'consumed-ref' as const,
				path: item.ref,
				reason: `within the kept window (rank ${rank + 1} of ${stamped.length}, newest first; --keep-consumed ${options.keepConsumed})`
			};
		}
		if (ageDays < options.olderThanDays) {
			return {
				action: 'keep' as const,
				klass: 'consumed-ref' as const,
				path: item.ref,
				reason: `${Math.max(0, Math.floor(ageDays))} day(s) old, younger than --older-than ${options.olderThanDays}`
			};
		}
		return {
			action: 'remove' as const,
			klass: 'consumed-ref' as const,
			path: item.ref,
			reason: `consumed ${Math.floor(ageDays)} day(s) ago, beyond the newest ${options.keepConsumed}`
		};
	});
}

/** Refs are shared by every worktree of the repository, so the deletions serialize under the common lock (F26). */
function removeConsumedRef(options: GcOptions, ref: string): void {
	const coordination = acquireCommonRepositoryLock(options.treeDir, `gc ${ref}`);
	try {
		gitOk(
			{ args: ['update-ref', '-d', ref], cwd: options.treeDir },
			{ code: 'INTERNAL', message: `cannot remove consumed ref ${ref}`, hint: 'check that the fork repository is writable' }
		);
	} finally {
		coordination.release();
	}
}

// ---------------------------------------------------------------------------
// .codkit/tmp: scratch a crashed run never cleaned (F24)
// ---------------------------------------------------------------------------

function tmpEntries(options: GcOptions): readonly GcEntry[] {
	return listedEntries(options.patchesDir, TMP_DIR).map((name) => {
		const path = `${TMP_DIR}/${name}`;
		const scratch = TREE_SCRATCH_NAME.exec(name);
		if (scratch === null) {
			return {
				action: 'remove' as const,
				klass: 'tmp' as const,
				path,
				reason: 'scratch under .codkit/tmp; the runs that make it clean up in a finally, so what is still here is crash residue'
			};
		}
		const owner = scratch[1] ?? '';
		const holder = liveLockHolder(options, owner);
		if (holder !== null) {
			return {
				action: 'keep' as const,
				klass: 'tmp' as const,
				path,
				reason: `a live run (${holder.command}, pid ${holder.pid}) of the tree ${owner} is using it`
			};
		}
		return {
			action: 'remove' as const,
			klass: 'tmp' as const,
			path,
			reason: `branch-build scratch of the tree ${owner}; its run is gone`
		};
	});
}

/** The holder of a tree's lock when it is a live process other than this one. */
function liveLockHolder(options: GcOptions, treeKey: string): LockInfo | null {
	const holder = readLock(lockPath(options.patchesDir, treeKey));
	if (holder === null || holder.pid === process.pid) {
		return null;
	}
	return (options.ownerAlive ?? isAlive)(holder.pid) ? holder : null;
}

// ---------------------------------------------------------------------------
// Locks: a gone owner is debris, a live owner is the opposite of garbage
// ---------------------------------------------------------------------------

function lockEntries(options: GcOptions): readonly GcEntry[] {
	const entries: GcEntry[] = [];
	for (const name of listedEntries(options.patchesDir, LOCKS_DIR)) {
		const path = `${LOCKS_DIR}/${name}`;
		// This run holds its own tree's lock; listing it would describe gc itself.
		if (name === `${options.ownTreeKey}.lock` || name.startsWith(`${options.ownTreeKey}.lock.`)) {
			continue;
		}
		if (name.startsWith('daemon-')) {
			entries.push({
				action: 'keep',
				klass: 'daemon-lock',
				path,
				reason: 'daemon channel lock; its own protocol proves the owner and retires it'
			});
			continue;
		}
		const lock = TREE_LOCK_NAME.exec(name);
		if (lock === null) {
			entries.push({
				action: 'keep',
				klass: 'lock',
				path,
				reason: 'not a per-tree lock codkit recognizes; left for the lock protocol'
			});
			continue;
		}
		const holder = readLock(join(options.patchesDir, ...path.split('/')));
		const ownerAlive = holder !== null && (options.ownerAlive ?? isAlive)(holder.pid);
		// The private generation link without its public lock is the crash window
		// between the two unlinks of a release; the pid inside says whose it was.
		if (lock[2] !== undefined) {
			const hasPublic = existsSync(join(options.patchesDir, ...`${LOCKS_DIR}/${lock[1]}.lock`.split('/')));
			entries.push(
				hasPublic
					? { action: 'keep', klass: 'lock', path, reason: 'private generation of a lock that still has its public name' }
					: ownerAlive
						? { action: 'keep', klass: 'lock', path, reason: 'an owner may still be between the two unlinks of its release' }
						: {
								action: 'remove',
								klass: 'lock',
								path,
								reason:
									`private generation of pid ${holder?.pid ?? 'an unknown'}` + '; its public lock is gone and the owner is not running'
							}
			);
			continue;
		}
		entries.push(
			ownerAlive
				? {
						action: 'keep',
						klass: 'lock',
						path,
						reason: `pid ${holder?.pid} ("${holder?.command}", since ${holder?.startedAt}) is still running`
					}
				: {
						action: 'remove',
						klass: 'lock',
						path,
						reason: holder === null ? 'names no live owner (unreadable lock)' : `pid ${holder.pid} ("${holder.command}") is gone`
					}
		);
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Tree caches and generated outputs
// ---------------------------------------------------------------------------

function treeCacheEntries(options: GcOptions): readonly GcEntry[] {
	return listedEntries(options.patchesDir, TREES_DIR)
		.filter((name) => name.endsWith('.json'))
		.map((name) => {
			const path = `${TREES_DIR}/${name}`;
			// A broken cache is kept, not guessed about: it names a tree the file
			// cannot identify, and deleting it is not this class (D22).
			const cache = readTreeCache(options.patchesDir, name.slice(0, -'.json'.length));
			if (cache === null) {
				return { action: 'keep' as const, klass: 'tree-cache' as const, path, reason: 'unreadable; the next load of its tree rewrites it' };
			}
			return existsSync(cache.treePath)
				? { action: 'keep' as const, klass: 'tree-cache' as const, path, reason: `the apply cache of the existing tree ${cache.treePath}` }
				: {
						action: 'remove' as const,
						klass: 'tree-cache' as const,
						path,
						reason: `its tree ${cache.treePath} no longer exists; the cache describes nothing`
					};
		});
}

function outEntries(options: GcOptions): readonly GcEntry[] {
	return listedEntries(options.patchesDir, OUT_DIR).map((name) => ({
		action: 'remove' as const,
		klass: 'out' as const,
		path: `${OUT_DIR}/${name}`,
		reason: 'generated output; the next inventory or verify run regenerates it'
	}));
}

// ---------------------------------------------------------------------------
// The kept classes, named as kept (D22: transactions and pending are never spent)
// ---------------------------------------------------------------------------

function keptStateEntries(options: GcOptions): readonly GcEntry[] {
	const entries: GcEntry[] = [];
	const keep = (klass: GcClass, path: string, reason: string): void => {
		entries.push({ action: 'keep', klass, path, reason });
	};
	if (patchsetHas(options, SYNC_TRANSACTION)) {
		keep('transaction', SYNC_TRANSACTION, 'a stopped two-way sync; codkit sync --continue or codkit sync --abort resolves it, never gc');
	}
	if (patchsetHas(options, RENAME_TRANSACTION)) {
		keep('receipt', RENAME_TRANSACTION, 'a live rename transaction; its own recovery resumes it');
	}
	for (const dir of [RENAME_COMPLETIONS, REBASE_RECEIPTS]) {
		if (patchsetHas(options, dir)) {
			keep('receipt', dir, 'recovery receipts; the protocol that wrote them consumes them');
		}
	}
	for (const name of listedEntries(options.patchesDir, PENDING_DIR)) {
		keep('pending', `${PENDING_DIR}/${name}`, 'a draft patch header of an unfinished marker new; codkit save consumes it');
	}
	if (patchsetHas(options, BUILD_DIR)) {
		keep('build', BUILD_DIR, 'daemon records and logs; the daemon protocol owns their lifetime');
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

function patchsetHas(options: GcOptions, relative: string): boolean {
	return existsSync(join(options.patchesDir, ...relative.split('/')));
}

/** Entry names of one patchset-relative directory, sorted by UTF-8 bytes; empty when absent. */
function listedEntries(patchesDir: string, relative: string): readonly string[] {
	let names: readonly string[];
	try {
		names = readdirSync(join(patchesDir, ...relative.split('/')));
	} catch {
		return [];
	}
	return [...names].sort((left, right) => Buffer.from(left, 'utf-8').compare(Buffer.from(right, 'utf-8')));
}

/** Parse and validate the two numeric gc flags; a garbage value is a usage problem before any lock is taken. */
export function gcCountFlag(flags: ReadonlyMap<string, string | true | readonly string[]>, name: string, fallback: number): number {
	const raw = flags.get(name);
	if (raw === undefined) {
		return fallback;
	}
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
		throw ckError('CONFIG', `gc ${name} needs a non-negative integer`, `usage: codkit gc ${name} <n>`);
	}
	const value = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(value)) {
		throw ckError('CONFIG', `gc ${name} is out of range: ${raw}`, 'pass a smaller non-negative integer');
	}
	return value;
}
