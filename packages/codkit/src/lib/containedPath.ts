/** @scope spec://codkit/modules/codkit/PROP-002#CONTAINED-FILE-IO */
// The containment primitives every contained file operation is built from:
// what a refusal looks like, how an administrative directory path is proven
// real, how a directory or file is recognised across a rename (dev/ino, never
// a pathname string), how a descriptor write is driven to completion, and how
// two effective Git paths compare on each platform.
//
// Nothing here opens a caller's file or decides policy. Splitting it out keeps
// `containedFile.ts` at the grain of one cell: the operations, not the ground
// they stand on.

import { lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { ErrorCode } from './messages.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem } from './pathSafety.ts';

/** O_NOFOLLOW where the platform has it; 0 (and lstat fallbacks) where not. */
export const NOFOLLOW: number = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/**
 * O_NONBLOCK where the platform has it; 0 where not.
 *
 * Opening a FIFO blocks until a peer appears, so a named pipe planted at a leaf
 * would hang the whole tool with no error and no timeout - the post-open
 * `isFile()` refusal never runs because the open never returns. Every contained
 * open therefore asks not to block. On a regular file - which is the only shape
 * these functions accept - the flag has no effect.
 */
export const NONBLOCK: number = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;

/**
 * Refuse an existing leaf that is not a regular file before it is opened.
 *
 * `O_NOFOLLOW` makes a symlink leaf fail at the open, but a FIFO, socket or
 * device node opens (or blocks) happily, so type is proven before the syscall
 * as well as after it. An absent leaf is not a problem here: the open reports
 * it, and callers turn that into `absent`.
 */
export function refuseNonRegularLeaf(path: string, options: ContainedFileOptions): void {
	const leaf = lstatIfPresent(path);
	if (leaf === null || leaf.isFile()) return;
	if (leaf.isSymbolicLink()) {
		refuse(options, 'must be a regular non-symlink file', 'replace the symlink with a real file; codkit never reads or writes through one');
	}
	refuse(options, 'must be a regular file', 'replace the entry with a real regular file; codkit never opens a pipe, socket or device');
}

export type ContainedFileRead = { readonly state: 'absent' } | { readonly state: 'ok'; readonly bytes: Uint8Array };

export type ContainedFileOptions = {
	/** Label naming the file in diagnostics, e.g. `codkit.json` or its full path. */
	readonly what: string;
	/** Error code refusals carry; CONFIG unless the caller needs another family. */
	readonly code?: ErrorCode;
	/** Fires after the leaf descriptor is open and before containment proof (test seam). */
	readonly afterOpen?: () => void;
	/**
	 * Fires between the pre-open shape check and the `open` itself (test seam).
	 * `O_NONBLOCK` is the only defense for a leaf that becomes a FIFO in exactly
	 * that window, and with no seam there nothing could pin it.
	 */
	readonly beforeOpen?: () => void;
};

export function refuse(options: ContainedFileOptions, detail: string, hint: string): never {
	throw ckError(options.code ?? 'CONFIG', `${options.what}: ${detail}`, hint);
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/**
 * Verify (and create, when missing) one directory path below an administrative
 * root, refusing any component that is a symlink or a non-directory. Returns
 * the path built from the canonical root, so an atomic write into it cannot be
 * redirected through a link. With `create: false` nothing is created: missing
 * components are accepted (the caller may only be planning a read), while every
 * component that does exist must still be a real directory.
 */
export function ensureAdminDirectory(
	root: string,
	segments: readonly string[],
	options: ContainedFileOptions & {
		readonly create?: boolean;
		/**
		 * Fires between the component's lstat and its `mkdir` (test seam). The
		 * peer-creation race lives in exactly that window and has no other way
		 * to be expressed deterministically.
		 */
		readonly beforeCreate?: () => void;
	}
): string {
	const create = options.create !== false;
	let current: string;
	try {
		current = realpathSync(root);
	} catch (error) {
		refuse(options, `cannot resolve the administrative root ${root}: ${messageOf(error)}`, 'check that the git directory exists');
	}
	for (const segment of segments) {
		if (repoRelativePathProblem(segment) !== null) {
			refuse(
				options,
				`unsafe administrative path component ${JSON.stringify(segment)}`,
				'this is a bug in codkit unless the git directory is damaged'
			);
		}
		current = join(current, segment);
		let stat: Stats | null;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (errnoOf(error) !== 'ENOENT') {
				refuse(options, `cannot inspect ${current}: ${messageOf(error)}`, 'check the git directory');
			}
			stat = null;
		}
		if (stat === null) {
			if (!create) {
				continue;
			}
			options.beforeCreate?.();
			try {
				mkdirSync(current);
			} catch (error) {
				// Two commands on one patch set race to create the same
				// administrative component on a fresh checkout. A peer that won is
				// not a failure - but the component it created still has to pass
				// the same shape proof, so fall through to it instead of trusting
				// the errno.
				if (errnoOf(error) !== 'EEXIST') {
					refuse(options, `cannot create ${current}: ${messageOf(error)}`, 'check the permissions of the git directory');
				}
				stat = lstatIfPresent(current);
				if (stat === null) {
					refuse(options, `cannot create ${current}: it disappeared while being created`, 'retry after inspecting the git directory');
				}
			}
			if (stat === null) continue;
		}
		if (stat.isSymbolicLink()) {
			refuse(options, `${current} is a symlink, not a real directory`, 'remove the link; codkit writes only inside real git directories');
		}
		if (!stat.isDirectory()) {
			refuse(options, `${current} is not a directory`, 'the administrative path must descend through directories only');
		}
	}
	return current;
}

export type AtomicWriteOptions = ContainedFileOptions & {
	readonly bytes: Uint8Array;
	/** Applied to the replaced file (e.g. 0o755 for hooks). */
	readonly mode?: number;
	/** Override one descriptor write for deterministic short-write tests. */
	readonly writeChunk?: (handle: number, bytes: Uint8Array, offset: number, length: number) => number;
	/**
	 * Fires after the atomic rename and before the post-write parent proof
	 * (test seam). `afterOpen` cannot reach that proof: a parent swapped there
	 * is caught by the pre-rename re-verification, so without this seam the
	 * post-write proof is deletable with every test still green.
	 */
	readonly afterReplace?: () => void;
	/**
	 * Override the mode application of an atomic replacement (test seam). The
	 * real `chmod` almost never fails on a file its own writer created, so
	 * without a seam the temporary's cleanup across that exit could not be
	 * held to a test - it was reasoned about, not tested.
	 */
	readonly applyMode?: (temporary: string, mode: number) => void;
	/** Override atomic rename and its Windows retry clock for deterministic tests. */
	readonly applyRename?: (temporary: string, absolutePath: string) => void;
	readonly renamePlatform?: NodeJS.Platform;
	readonly waitForRenameRetry?: (milliseconds: number) => void;
};

export function lstatIfPresent(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

export function statIfPresent(path: string): Stats | null {
	try {
		return statSync(path);
	} catch (error) {
		if (errnoOf(error) === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

export function realpathIfPresent(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** Platform-aware equality for effective Git paths (case-insensitive on Windows). */
export function sameEffectivePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === 'win32') {
		const normalize = (value: string): string => win32.normalize(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
		return normalize(left) === normalize(right);
	}
	return (realpathIfPresent(left) ?? resolve(left)) === (realpathIfPresent(right) ?? resolve(right));
}

export function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errnoOf(error) !== 'ENOENT') {
			throw error;
		}
	}
}

export function writeAll(handle: number, options: AtomicWriteOptions): void {
	const write =
		options.writeChunk ?? ((fd: number, bytes: Uint8Array, offset: number, length: number) => writeSync(fd, bytes, offset, length));
	let offset = 0;
	while (offset < options.bytes.length) {
		const written = write(handle, options.bytes, offset, options.bytes.length - offset);
		if (!Number.isInteger(written) || written <= 0 || written > options.bytes.length - offset) {
			throw new Error(`short write made no valid progress at byte ${offset}`);
		}
		offset += written;
	}
}

/** dev/ino identity; on filesystems without stable ino the pair still matches self. */
export function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}
