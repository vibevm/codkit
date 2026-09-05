/** @scope spec://codkit/modules/codkit/PROP-006#root */
// Per-tree lock (PROP-006 sec. 2, ##LOCK-MECHANISM).
//
// Every writing command holds it; the read-only commands (`status`, `where`,
// `inventory`) never take it. The public file is installed with an exclusive
// hard link, so the race is decided by the filesystem, not a check-then-write
// window.
//
// A lock whose owner is gone is not an obstacle: a killed sync must not require
// a human to delete a file before the next one can run. The pid in the file is
// probed, and a dead one is cleared with a warning.

import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ckError } from './messages.ts';
import { resolveContainedPath, safeBasenameProblem } from './pathSafety.ts';

/** Directory of lock files, relative to the patchset root. */
export const LOCKS_DIR = '.codkit/locks';

export type LockInfo = {
	readonly pid: number;
	readonly startedAt: string;
	readonly command: string;
	/** Generation identity. Absent only on lock files written by older codkit versions. */
	readonly nonce?: string;
};

export type LockHandle = {
	readonly path: string;
	readonly info: LockInfo;
	/** Idempotent: releasing twice is not an error. */
	release: () => void;
};

export type WarnSink = (text: string) => void;

const lockSchema = z.object({
	pid: z.number().int().positive(),
	startedAt: z.string().min(1),
	command: z.string().min(1),
	nonce: z
		.string()
		.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
		.optional()
});

/** In-process capability registry: structurally copied lock data is not ownership. */
const activeHandles = new WeakSet<LockHandle>();

type OwnedLockInfo = LockInfo & { readonly nonce: string };

export function lockPath(patchesDir: string, treeId: string): string {
	const problem = safeBasenameProblem(treeId);
	if (problem !== null) throw ckError('CONFIG', `unsafe lock id ${JSON.stringify(treeId)}: ${problem}`);
	const relative = `${LOCKS_DIR}/${treeId}.lock`;
	const resolved = resolveContainedPath(patchesDir, relative, { allowMissing: true });
	if (!resolved.ok) throw ckError('CONFIG', `unsafe lock path ${relative}: ${resolved.reason}`);
	return resolved.absolute;
}

/**
 * Take the lock for one tree. Throws CK-E-LOCKED (exit 2) when another live
 * process holds it.
 */
export function acquireLock(patchesDir: string, treeId: string, command: string, onWarn?: WarnSink): LockHandle {
	let path: string;
	try {
		path = lockPath(patchesDir, treeId);
		mkdirSync(dirname(path), { recursive: true });
		path = lockPath(patchesDir, treeId);
	} catch (error) {
		throw lockWriteFailure(error, patchesDir);
	}
	try {
		return acquirePathLock(path, command, onWarn);
	} catch (error) {
		// The per-tree lock lives under the patchset root: a mount failure
		// there is the public TREE-READONLY condition, not an internal error.
		throw lockWriteFailure(error, patchesDir);
	}
}

/**
 * The same hard-link lock protocol on an explicit path: the per-tree lock of
 * PROP-006 ##LOCK-MECHANISM is one instance of it, and the common-repository
 * lock (PROP-008 ##GENERATED-REF-WORKTREE-PREFLIGHT) is another - same
 * acquisition race, different coordination scope.
 */
export function acquirePathLock(path: string, command: string, onWarn?: WarnSink): LockHandle {
	mkdirSync(dirname(path), { recursive: true });

	const info: OwnedLockInfo = { pid: process.pid, startedAt: new Date().toISOString(), command, nonce: randomUUID() };
	if (tryCreate(path, info)) {
		return makeHandle(path, info);
	}

	const holder = readLock(path);
	if (holder !== null && isAlive(holder.pid)) {
		throw ckError(
			'LOCKED',
			`another codkit command is already working on this fork tree: pid ${holder.pid} running "${holder.command}" since ${holder.startedAt}`,
			`wait for pid ${holder.pid} to finish; if that process is gone, delete ${path}`
		);
	}

	// Stale: the owner died (or the file is unreadable, which is the same thing
	// for a lock - it names nobody).
	if (onWarn !== undefined) {
		const owner = holder === null ? 'an unreadable owner' : `pid ${holder.pid} ("${holder.command}")`;
		onWarn(`removing a stale lock left by ${owner}: ${path}`);
	}
	removeGeneration(path, holder);

	if (!tryCreate(path, info)) {
		// Somebody won the race between the removal and the retry.
		const winner = readLock(path);
		throw ckError(
			'LOCKED',
			winner === null
				? 'another codkit command took the lock on this fork tree'
				: `another codkit command took the lock on this fork tree: pid ${winner.pid} running "${winner.command}"`,
			`re-run once it finishes; the lock file is ${path}`
		);
	}
	return makeHandle(path, info);
}

/** Map a known mount/ownership failure to the public environment diagnostic. */
export function lockWriteFailure(error: unknown, patchesDir: string): unknown {
	const code = codeOf(error);
	if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') {
		return error;
	}
	return ckError(
		'TREE-READONLY',
		`cannot write Codkit runtime locks under ${patchesDir}/.codkit: ${code}`,
		`mount ${patchesDir}/.codkit read-write (the patchset source may remain read-only), then retry`
	);
}

/** Run `body` under the lock, releasing it whatever happens inside. */
export function withLock<T>(patchesDir: string, treeId: string, command: string, body: () => T, onWarn?: WarnSink): T {
	const handle = acquireLock(patchesDir, treeId, command, onWarn);
	try {
		return body();
	} finally {
		handle.release();
	}
}

/** The lock's content, or null when it is absent or unreadable. */
export function readLock(path: string): LockInfo | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
	const parsed = lockSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const { pid, startedAt, command, nonce } = parsed.data;
	return nonce === undefined ? { pid, startedAt, command } : { pid, startedAt, command, nonce };
}

/**
 * Signal 0 asks the kernel about the process without touching it: EPERM means
 * it exists and belongs to someone else, ESRCH means nobody is there.
 */
export function isAlive(pid: number): boolean {
	if (pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * A new lock has two hard links to one inode: the public lock path and an
 * owner path named by its nonce. Linking the owner path to the public path is
 * the atomic O_EXCL acquisition step. The private link is also the right to
 * remove that exact generation later.
 */
function tryCreate(path: string, info: OwnedLockInfo): boolean {
	const owner = generationPath(path, info.nonce);
	const handle = openSync(owner, 'wx');
	try {
		try {
			writeSync(handle, `${JSON.stringify(info, null, 2)}\n`);
		} finally {
			closeSync(handle);
		}
	} catch (error) {
		unlinkIfPresent(owner);
		throw error;
	}

	try {
		linkSync(owner, path);
	} catch (error) {
		unlinkIfPresent(owner);
		if (codeOf(error) === 'EEXIST') {
			return false;
		}
		throw error;
	}
	return true;
}

function makeHandle(path: string, info: OwnedLockInfo): LockHandle {
	let released = false;
	const handle: LockHandle = {
		path,
		info,
		release: () => {
			if (released) {
				return;
			}
			released = true;
			activeHandles.delete(handle);
			removeOwnedGeneration(path, info);
		}
	};
	activeHandles.add(handle);
	return handle;
}

/** True only for a live LockHandle issued by this process and not released. */
export function isOwnedLockHandle(handle: LockHandle): boolean {
	return activeHandles.has(handle);
}

/** Refuse a forged, copied, foreign-process or already released lock capability. */
export function assertOwnedLockHandle(handle: LockHandle, purpose = 'operation'): void {
	if (!activeHandles.has(handle)) {
		throw ckError('LOCKED', `${purpose} requires a live lock handle owned by this process`, 'acquire the required lock and retry');
	}
}

function generationPath(path: string, nonce: string): string {
	return `${path}.${nonce}.owner`;
}

/**
 * Remove the generation that was observed as stale, if it is still current.
 * A nonce-bearing generation elects one remover by unlinking its private hard
 * link. Older files use an inode-named claim link for the same election.
 */
function removeGeneration(path: string, observed: LockInfo | null): boolean {
	if (observed?.nonce !== undefined) {
		const result = removeOwnedGeneration(path, { ...observed, nonce: observed.nonce });
		if (result !== 'owner-missing') {
			return result === 'removed';
		}
	}
	return removeLegacyGeneration(path, observed);
}

/**
 * Atomically consume one generation's ownership link, then unlink the public
 * name only while it still denotes that same inode. A losing remover never
 * touches the public name, and a late release cannot unlink a successor.
 */
function removeOwnedGeneration(path: string, info: OwnedLockInfo): 'removed' | 'lost' | 'owner-missing' {
	const owner = generationPath(path, info.nonce);
	const identity = statIfPresent(owner);
	if (identity === null) {
		return 'owner-missing';
	}

	try {
		unlinkSync(owner);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return 'lost';
		}
		throw error;
	}

	const current = statIfPresent(path);
	if (current === null || !sameInode(identity, current)) {
		return 'lost';
	}
	try {
		unlinkSync(path);
		return 'removed';
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return 'lost';
		}
		throw error;
	}
}

/** Compatibility takeover for pre-nonce and malformed lock files. */
function removeLegacyGeneration(path: string, observed: LockInfo | null): boolean {
	const identity = statIfPresent(path);
	if (identity === null) {
		return false;
	}
	const claim = `${path}.legacy-${identity.dev.toString(16)}-${identity.ino.toString(16)}.owner`;
	try {
		linkSync(path, claim);
	} catch (error) {
		if (codeOf(error) === 'EEXIST' || codeOf(error) === 'ENOENT') {
			return false;
		}
		throw error;
	}

	try {
		const claimed = statIfPresent(claim);
		if (claimed === null || !sameInode(identity, claimed) || !sameGeneration(readLock(claim), observed)) {
			return false;
		}
		const current = statIfPresent(path);
		if (current === null || !sameInode(claimed, current)) {
			return false;
		}
		try {
			unlinkSync(path);
			return true;
		} catch (error) {
			if (codeOf(error) === 'ENOENT') {
				return false;
			}
			throw error;
		}
	} finally {
		unlinkIfPresent(claim);
	}
}

function sameGeneration(actual: LockInfo | null, observed: LockInfo | null): boolean {
	if (observed === null) {
		return actual === null;
	}
	if (observed.nonce !== undefined) {
		return actual?.nonce === observed.nonce;
	}
	return (
		actual !== null &&
		actual.nonce === undefined &&
		actual.pid === observed.pid &&
		actual.startedAt === observed.startedAt &&
		actual.command === observed.command
	);
}

type FileIdentity = { readonly dev: number | bigint; readonly ino: number | bigint };

function sameInode(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function statIfPresent(path: string): Stats | null {
	try {
		return statSync(path);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') {
			throw error;
		}
	}
}

function codeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}
