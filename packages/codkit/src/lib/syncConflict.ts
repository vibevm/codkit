/** @scope spec://codkit/modules/codkit/PROP-008#SYNC-CONFLICT-DIFF3 */
// The diff3 materialization of a both-sides conflict (PROP-008 sec. 5a
// ##SYNC-CONFLICT-DIFF3; campaign TREE-COMMITS-SAVE, decision D19, Phase 8b).
//
// Phase 8 answered a file both sides moved with a refusal and a choose-a-side
// recipe. This module is the third answer git taught: put the 3-way into the
// tree file as diff3 markers and let a human resolve it - base is the loaded
// state (`<base>:<target>`), ours is the working file, theirs is the pin plus
// the artifact as the patch set holds it now. The merge itself is
// `runMergeFile` - the one diff3 implementation codkit has (spike S0.8);
// `replayPatch` is the wrong function here because theirs is pin+artifact,
// not base+patch.
//
// The durable write follows the precedents rather than reinventing them
// (`atomicReplace` of reresolve.ts:240, `writeCycleConflicts` of
// cycleMaterializeMoveWorktree.ts): wx-temp, mode preserved, rename over the
// target. The marker check is the same four marker lines the human procedure
// greps for, so the machine and the documented hand procedure can never
// disagree about what "resolved" means.

import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUtf8Strict } from './bytes.ts';
import { applyUnified } from './applyUnified.ts';
import { runMergeFile } from './classifyEngine.ts';
import { loadConventions } from './conventionsFile.ts';
import { ckError } from './messages.ts';
import type { CkError } from './messages.ts';
import { parseCkpatch } from './patchFormat.ts';
import { resolveContainedPath } from './pathSafety.ts';
import { sha256 } from './renameFileState.ts';
import { pinBytesOf } from './syncMerge.ts';
import { bytesOf } from './treeState.ts';
import type { TreeState } from './treeState.ts';
import type { ProjectType } from '@codkit/type-api';

/** The three sides of one both-sides target, and where each comes from (D19). */
export type ConflictSidesInput = {
	readonly patchesDir: string;
	readonly type: ProjectType;
	readonly treeDir: string;
	readonly pinSha: string;
	/** The base of the selection: the file as the load left it, at the generated tip. */
	readonly base: string;
	/** HEAD of the tree as the run found it: D19's `ours` fallback (`HEAD:<target>`). */
	readonly treeHead: string;
	readonly target: string;
	/** Patchset-relative artifact path of the target. */
	readonly artifact: string;
};

export type ConflictMerge = {
	readonly target: string;
	/** The merge-file output: the file's next bytes, markers included. */
	readonly bytes: Uint8Array;
	/** Whether the merge left conflict markers for a human. */
	readonly hasConflicts: boolean;
};

/**
 * The 3-way of one both-sides target (D19). Nothing is written: the caller
 * computes every merge before it writes anything, so a side that cannot be
 * read or an artifact that does not apply refuses the run while it still has
 * written nothing.
 */
export function mergeConflictSides(input: ConflictSidesInput): ConflictMerge {
	const theirs = applyUnified(
		pinBytesOf(input.treeDir, input.pinSha, input.target) ?? new Uint8Array(0),
		parseCkpatch(
			readFileSync(join(input.patchesDir, ...input.artifact.split('/'))),
			loadConventions(input.type, input.patchesDir),
			input.artifact
		)
	);
	let ours: Uint8Array;
	try {
		ours = bytesOf(input.treeDir, { kind: 'worktree' }, input.target);
	} catch {
		ours = bytesOf(input.treeDir, { kind: 'commit', sha: input.treeHead }, input.target);
	}
	const base = stateBytesOrEmpty(input.treeDir, { kind: 'commit', sha: input.base }, input.target);
	const merged = runMergeFile({ treeDir: input.treeDir, targetPath: input.target, ours, base, theirs });
	return { target: input.target, bytes: merged.bytes, hasConflicts: merged.hasConflicts };
}

/** The target as one tree state carries it, or empty bytes when the state has no such file. */
function stateBytesOrEmpty(treeDir: string, state: TreeState, target: string): Uint8Array {
	try {
		return bytesOf(treeDir, state, target);
	} catch {
		return new Uint8Array(0);
	}
}

/**
 * The sha256 of the bytes a run materialized, as the transaction record names
 * them (D20/D21): the proof `sync --continue` uses to tell "the markers never
 * reached this file" (a crash before the write) from "a human resolved to
 * exactly the tree side" (a legitimate answer).
 */
export function conflictMaterializedSha(bytes: Uint8Array): string {
	return sha256(bytes);
}

/**
 * Write materialized bytes into one tree file, the durable way the codebase
 * writes single files: wx-temp, mode preserved, rename over the target.
 * Nothing else in the tree moves.
 */
export function materializeConflictBytes(treeDir: string, target: string, bytes: Uint8Array): void {
	const resolved = resolveContainedPath(treeDir, target, { allowMissing: true });
	if (!resolved.ok) {
		throw ckError(
			'INTERNAL',
			`cannot materialize the conflict of ${target}: ${resolved.reason}`,
			're-run with --verbose and attach the output to a bug report'
		);
	}
	let mode = 0o644;
	try {
		const before = lstatSync(resolved.absolute);
		if (!before.isFile() || before.isSymbolicLink()) {
			throw ckError(
				'INTERNAL',
				`cannot materialize the conflict of ${target}: the target is not a regular file`,
				'resolve the conflict by hand with codkit sync --abort, and attach the output to a bug report'
			);
		}
		mode = before.mode & 0o7777;
	} catch (error) {
		if (!isNoEntry(error)) {
			throw error;
		}
	}
	const temporary = `${resolved.absolute}.codkit-sync-conflict-${randomUUID()}`;
	try {
		writeFileSync(temporary, bytes, { flag: 'wx', mode });
		chmodSync(temporary, mode);
		renameSync(temporary, resolved.absolute);
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

/** The conflict-marker lines `git merge-file --diff3` writes - the same four the human procedure greps for. */
const CONFLICT_MARKER_LINE = /^(<{7}|={7}|>{7}|\|{7})/;

/**
 * Whether bytes still carry conflict markers - the per-file check
 * `sync --continue` makes over every file of the record's `conflicts[]` (D21).
 */
export function hasConflictMarkers(bytes: Uint8Array): boolean {
	const text = decodeUtf8Strict(bytes);
	if (text === null) {
		return false;
	}
	return text.split('\n').some((line) => CONFLICT_MARKER_LINE.test(line));
}

/** One target a run materialized, for the stop report. */
export type MaterializedConflictReport = { readonly target: string; readonly hasConflicts: boolean };

/**
 * The exit-1 stop of a run that materialized its conflicts (D19, Phase 8b):
 * the markers are in the tree files and the record carries the ours-snapshots,
 * and the two ways on are `codkit sync --continue` and `codkit sync --abort`.
 */
export function conflictMaterializedError(materialized: readonly MaterializedConflictReport[]): CkError {
	const list = materialized.map((one) => one.target).join(', ');
	const clean = materialized.filter((one) => !one.hasConflicts).map((one) => one.target);
	return ckError(
		'BOTH-SIDES-EDITED',
		`the fork tree and the patch set both changed ${materialized.length} target(s); the merge is in the tree file(s) as diff3 markers: ${list}` +
			(clean.length === 0 ? '' : ` (${clean.join(', ')} merged without markers)`),
		'resolve the markers inside the codkit blocks - keep both sides and the block ids - then codkit sync --continue; ' +
			'codkit sync --abort returns the tree and the patch set to the state before the sync (see the upgrade-cycle marker procedure)',
		materialized[0]?.target
	);
}

/** Whether an fs error says "not there" - the only absence a cleanup unlink may swallow. */
function isNoEntry(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
