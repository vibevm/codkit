/** @scope spec://codkit/modules/codkit/PROP-007#CMD-LOAD-DISCARD-WORKTREE */
// The working-tree half of `load --discard` (PROP-007 ##CMD-LOAD-DISCARD-WORKTREE).
//
// Building the tree rewrites a tracked upstream file with an artifact of the
// build, and those bytes are indistinguishable from a human edit: the drift
// guard sees unextracted work and refuses, and the only way back into dev mode
// used to be a `git checkout` typed by hand inside a managed tree. Together with
// `--fresh`, `--discard` is that way back, and it stays a sacrifice by name: the
// plan prints every path before the first write, and step 9 restores exactly the
// paths the plan named.
//
// What the flag may never throw away is what somebody could still extract:
//
//   * a file that carries a codkit marker block - the block may hold an
//     intervention nobody has run `save` over yet, and no amount of `--discard`
//     makes that a build artifact;
//   * own code and own extensions - their side of truth is `save`/`load`
//     (PROP-008), and git cannot even see them locally, so they never reach this
//     classifier at all;
//   * untracked paths - they have no tip to return to, and `--fresh` already
//     answers for them through the cleanup whitelist (PROP-011 sec. 4).
//
// The classifier therefore only ever narrows: an answer it cannot prove is a
// refusal, and the guard keeps the path as dirt.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PorcelainEntry } from './driftGuard.ts';
import { markerFormFor, markerKeyOf, parseMarkers } from './markers.ts';
import type { MarkerConventions } from './markers.ts';

/** The hint of the refusal over a path that carries a block (S59). */
export const MARKER_BLOCK_DISCARD_HINT = 'this file carries a marker block: run codkit save to extract it, or move the edit out';

/**
 * What one `--fresh --discard` run decided about the tracked dirt of the tree.
 * Both lists are filled in `git status` order, which is the order the plan is
 * printed in.
 */
export type WorktreeDiscardPlan = {
	/** Paths this run may return to the tip; one `discard <path>` plan line each. */
	readonly discard: string[];
	/** Paths that carry a codkit block: still dirt, and named by the refusal. */
	readonly markerCarrying: string[];
};

export function emptyWorktreeDiscardPlan(): WorktreeDiscardPlan {
	return { discard: [], markerCarrying: [] };
}

/**
 * The `isDiscardable` predicate of the drift guard, filling `into` as it goes.
 *
 * The guard asks it about tracked, non-own, changed paths only; this decides
 * which of them are edits the run was told to throw away. A true answer removes
 * the path from the dirt half (a) and puts it in the plan; a false answer leaves
 * it exactly as dirty as it was before the flag existed.
 */
export function worktreeDiscardClassifier(
	treeDir: string,
	conventions: MarkerConventions,
	into: WorktreeDiscardPlan
): (entry: PorcelainEntry) => boolean {
	return (entry) => {
		if (!hasTipVersion(entry.status)) {
			return false;
		}
		if (carriesMarkerBlock(treeDir, entry.path, conventions)) {
			into.markerCarrying.push(entry.path);
			return false;
		}
		into.discard.push(entry.path);
		return true;
	};
}

/** The refusal message over the paths that carry a block. */
export function markerBlockDirtMessage(paths: readonly string[]): string {
	return `${paths.length} path(s) in the fork tree carry a codkit marker block, so --discard leaves them alone: ${paths.join(', ')}`;
}

/**
 * Whether the status of a porcelain entry describes a path the tree's tip
 * carries, so that "return it to the pin plus the delta" means something.
 *
 * `git status --porcelain` v1 says it in two characters, and only the plain
 * ones qualify: space, `M` (modified), `D` (deleted) and `T` (type changed).
 * `A` is a path staged into the index that the tip does not have - there is no
 * version to return it to; `R`/`C` name a staged rename or copy, whose other
 * half is a second path the plan never mentioned; `U` is an unresolved merge,
 * a position to finish rather than a build artifact to drop; `?` is untracked
 * and never reaches this predicate.
 */
function hasTipVersion(status: string): boolean {
	return /^[ MDT]{2}$/.test(status);
}

/**
 * Whether the tree's copy of `relative` carries a codkit marker block.
 *
 * A deleted file has nothing to parse, and a file whose extension has no marker
 * form is a blind zone by construction (PROP-004 ##MR-BLIND-ZONES) - the same
 * two exemptions `codkit status` makes when it reports the marker verdict of a
 * changed upstream file. Everything else is parsed, and a marker line the parser
 * could not pair counts exactly like a block: an unclosed or malformed marker is
 * still somebody's intervention, and a discard would bury it. So is a file this
 * process cannot read: the classifier may only narrow the guard by proof.
 */
function carriesMarkerBlock(treeDir: string, relative: string, conventions: MarkerConventions): boolean {
	const absolute = join(treeDir, ...relative.split('/'));
	const extension = markerKeyOf(relative);
	if (!existsSync(absolute) || markerFormFor(extension, conventions) === null) {
		return false;
	}
	let parsed;
	try {
		parsed = parseMarkers(readFileSync(absolute), extension, conventions, relative);
	} catch {
		return true;
	}
	return parsed.blocks.length > 0 || parsed.errors.length > 0;
}
