/** @scope spec://codkit/modules/codkit/PROP-008#GENERATED-REF-WORKTREE-PREFLIGHT */
// Which worktrees share this tree's repository, and what each of them has
// checked out (PROP-008 ##GENERATED-REF-WORKTREE-PREFLIGHT).
//
// Git plumbing permits two worktrees to sit on one branch (`symbolic-ref` does
// not check), and a branch is one object shared by every worktree of the
// repository: moving `refs/heads/<generated>` from the second worktree leaves
// the first worktree's index and work tree dirty against a HEAD it never asked
// to move. Codkit therefore refuses to mutate a generated ref while another
// worktree has it checked out, and serializes the check-then-mutate pair with
// a lock in the common administrative directory, so two codkit processes
// cannot lose the race against each other. A foreign `git symbolic-ref` run in
// that exact window remains possible - there is no git-side interlock to close
// it - and the window is the microseconds between the preflight and the
// update-ref, all under the lock.

import { realpathSync } from 'node:fs';
import { ckError } from './messages.ts';
import { runGit } from './gitx.ts';
import { gitCommonDirOf } from './treeCache.ts';
import { ensureAdminDirectory } from './containedPath.ts';
import { acquirePathLock } from './lock.ts';
import type { LockHandle } from './lock.ts';

/** One worktree of the repository this tree belongs to. */
export type WorktreeListing = {
	/** Absolute path as `git worktree list` reports it. */
	readonly path: string;
	/** Ref HEAD points at, or null while detached / unreadable. */
	readonly headRef: string | null;
};

/**
 * Every worktree of the repository, from one porcelain listing. Null when git
 * cannot answer; a generated-ref mutation must treat that as a failed safety
 * proof, never as an empty list.
 */
export function listWorktrees(treeDir: string): readonly WorktreeListing[] | null {
	const result = runGit({ args: ['worktree', 'list', '--porcelain'], cwd: treeDir });
	if (result.status !== 0) {
		return null;
	}
	const listings: WorktreeListing[] = [];
	let path: string | null = null;
	let headRef: string | null = null;
	for (const line of result.stdout.split('\n')) {
		if (line.startsWith('worktree ')) {
			if (path !== null) {
				listings.push({ path, headRef });
			}
			path = line.slice('worktree '.length);
			headRef = null;
			continue;
		}
		if (line.startsWith('branch ') && path !== null) {
			headRef = line.slice('branch '.length);
		}
	}
	if (path !== null) {
		listings.push({ path, headRef });
	}
	return listings;
}

function realPathOf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Worktrees other than `selfDir` whose HEAD is `ref`: the trees a mutation of
 * `ref` would corrupt. A prunable entry whose path no longer exists on disk
 * carries no HEAD to corrupt and never matches a symbolic ref.
 */
export function otherWorktreesOnRef(listings: readonly WorktreeListing[], selfDir: string, ref: string): readonly WorktreeListing[] {
	const self = realPathOf(selfDir);
	return listings.filter((listing) => realPathOf(listing.path) !== self && listing.headRef === ref);
}

/**
 * The preflight of ##GENERATED-REF-WORKTREE-PREFLIGHT: refuse while another
 * worktree of this repository has `ref` checked out, naming both trees. Must
 * run immediately before the mutation, under the common-repository lock.
 */
export function assertGeneratedRefExclusive(treeDir: string, ref: string): void {
	const listings = listWorktrees(treeDir);
	if (listings === null) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot inspect linked worktrees before moving generated ref ${ref}`,
			'run git worktree list --porcelain in the fork repository, repair the reported error, and retry'
		);
	}
	const holders = otherWorktreesOnRef(listings, treeDir, ref);
	if (holders.length === 0) {
		return;
	}
	const other = holders[0];
	throw ckError(
		'WORKTREE-REF-SHARED',
		`generated ref ${ref} is checked out in another worktree of this repository (${other?.path}); ` +
			`this tree is ${treeDir}. The branch is shared by every worktree, so moving it here would leave that worktree's index and work tree dirty`,
		`let that worktree use its own branch (git -C ${other?.path} switch --detach), or remove it (git worktree remove ${other?.path}), then re-run; ` +
			'no ref, index or work-tree file was changed',
		other?.path
	);
}

/** Directory of the common-repository coordination lock, inside git admin. */
export function commonLockDirectory(treeDir: string): string {
	return ensureAdminDirectory(gitCommonDirOf(treeDir), ['codkit'], {
		what: 'codkit coordination directory of the repository',
		code: 'INTERNAL'
	});
}

/**
 * Take the common-repository lock every generated-ref mutation and shared
 * administrative write of this repository is serialized under. The protocol is
 * the hard-link lock of PROP-006 ##LOCK-MECHANISM, applied to a path inside
 * the repository's common git directory, so two codkit processes working two
 * worktrees of one repository - possibly from two different patch sets - still
 * exclude each other where git's shared state is at stake.
 */
export function acquireCommonRepositoryLock(treeDir: string, command: string): LockHandle {
	return acquirePathLock(`${commonLockDirectory(treeDir)}/refs.lock`, command);
}

export type GeneratedRefCheckpoints = {
	/** Fires after the lock is held and before the preflight (test seam). */
	readonly afterLock?: () => void;
	/** Override the safety preflight itself (test seam). */
	readonly assertExclusive?: (treeDir: string, ref: string) => void;
};

/**
 * The guarded generated-ref mutation (##GENERATED-REF-WORKTREE-PREFLIGHT):
 * hold the common-repository lock, run the exclusivity preflight against a
 * fresh worktree listing, and only then let `mutate` move the ref and HEAD.
 * Every refusal leaves the repository's refs, indexes and work trees exactly
 * as they were.
 */
export function mutateGeneratedRef(treeDir: string, ref: string, mutate: () => void, checkpoints?: GeneratedRefCheckpoints): void {
	const handle = acquireCommonRepositoryLock(treeDir, `generated ref ${ref}`);
	try {
		checkpoints?.afterLock?.();
		(checkpoints?.assertExclusive ?? assertGeneratedRefExclusive)(treeDir, ref);
		mutate();
	} finally {
		handle.release();
	}
}
