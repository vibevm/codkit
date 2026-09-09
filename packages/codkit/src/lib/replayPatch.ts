/** @scope spec://codkit/modules/codkit/PROP-008#classify */
// Pure replay of one parsed patch over caller-supplied three-way file states.
// Repository objects, refs, the index, and work-tree paths are deliberately
// outside the model; treeDir is only the cwd of the isolated merge-file runner.

import { applyUnified } from './applyUnified.ts';
import { bytesEqual, containsByte, decodeUtf8Strict, NUL_BYTE } from './bytes.ts';
import { runMergeFile } from './classifyEngine.ts';
import type { MergeFileRunner, PatchClassificationMaterials } from './classifyEngine.ts';
import { ckError, isCkError } from './messages.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import type { ParsedPatch } from './patchFormat.ts';

export const REPLAY_PATCH_OUTCOMES = ['clean', 'shifted', 'merged', 'conflict', 'target-deleted'] as const;

export type ReplayPatchOutcome = (typeof REPLAY_PATCH_OUTCOMES)[number];

export type ReplayPatchOptions = {
	/** Cwd used only if the default isolated `git merge-file` runner is needed. */
	readonly treeDir: string;
	/** Current repository-relative identity of the replay target. */
	readonly targetPath: string;
	/** Bytes to which `patch` originally applied. */
	readonly base: Uint8Array;
	/** File existence is explicit because an absent file and an empty file differ. */
	readonly baseExists: boolean;
	/** Current target bytes, or empty bytes when `oursExists` is false. */
	readonly ours: Uint8Array;
	readonly oursExists: boolean;
	/** Parsed patch from the old base. */
	readonly patch: ParsedPatch;
	readonly mergeFile?: MergeFileRunner;
};

export type AppliedReplayPatch = {
	readonly outcome: Exclude<ReplayPatchOutcome, 'target-deleted'>;
	/** Exact bytes to materialize; conflicts retain diff3 markers. */
	readonly bytes: Uint8Array;
	readonly materials: PatchClassificationMaterials;
};

export type DeletedReplayPatch = {
	readonly outcome: 'target-deleted';
	readonly bytes: null;
	/** Retained so re-resolve/rebase can explain the delete/modify state. */
	readonly materials: PatchClassificationMaterials;
};

export type ReplayPatchResult = AppliedReplayPatch | DeletedReplayPatch;

/**
 * Replay a parsed old patch against an explicit current file state.
 *
 * The function is pure apart from private scratch files owned by the default
 * merge runner. It never reads or writes repository objects, refs, the index,
 * or a work-tree target.
 */
export function replayPatch(options: ReplayPatchOptions): ReplayPatchResult {
	assertOptions(options);
	assertText(options.base, 'base', options.targetPath);

	const theirs = applyUnified(options.base, options.patch);
	assertText(theirs, 'patched result', options.targetPath);
	const materials: PatchClassificationMaterials = {
		base: options.base,
		baseExists: options.baseExists,
		ours: options.ours,
		oursExists: options.oursExists,
		theirs
	};

	if (!options.patch.isAddFile && !options.oursExists) {
		return { outcome: 'target-deleted', bytes: null, materials };
	}

	assertText(options.ours, 'current target', options.targetPath);
	if (sameFileState(options.base, options.baseExists, options.ours, options.oursExists)) {
		return { outcome: 'clean', bytes: theirs, materials };
	}

	const merged = (options.mergeFile ?? runMergeFile)({
		treeDir: options.treeDir,
		targetPath: options.targetPath,
		ours: options.ours,
		base: options.base,
		theirs
	});
	assertMergeResult(merged, options.targetPath);
	assertText(merged.bytes, 'merge result', options.targetPath);
	if (merged.hasConflicts) {
		return { outcome: 'conflict', bytes: merged.bytes, materials };
	}

	// An add-file patch cannot apply to an existing path, including an existing
	// empty file. Existence therefore participates in the shifted probe too.
	const shifted =
		(!options.patch.isAddFile || !options.oursExists) && appliesExactly(options.ours, patchAtTarget(options.patch, options.targetPath));
	return { outcome: shifted ? 'shifted' : 'merged', bytes: merged.bytes, materials };
}

function assertOptions(options: ReplayPatchOptions): void {
	const pathProblem = repoRelativePathProblem(options.targetPath);
	if (pathProblem !== null) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot replay patch for ${JSON.stringify(options.targetPath)}: target path ${pathProblem}`,
			'the replay target must be a canonical repository-relative POSIX file path',
			options.targetPath
		);
	}
	if (options.patch.isAddFile === options.baseExists) {
		const mismatch = options.patch.isAddFile ? 'already exists' : 'is absent';
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot replay patch for ${options.targetPath}: its base ${mismatch}`,
			options.patch.isAddFile ? 'an add-file patch requires an absent base' : 'an edit patch requires an existing base',
			options.targetPath
		);
	}
	assertAbsentHasNoBytes(options.base, options.baseExists, 'base', options.targetPath);
	assertAbsentHasNoBytes(options.ours, options.oursExists, 'current target', options.targetPath);
}

function assertAbsentHasNoBytes(bytes: Uint8Array, exists: boolean, label: string, targetPath: string): void {
	if (!exists && bytes.length !== 0) {
		throw ckError(
			'INTERNAL',
			`cannot replay patch for ${targetPath}: absent ${label} carries ${bytes.length} byte(s)`,
			'callers must represent an absent file with an empty Uint8Array',
			targetPath
		);
	}
}

function assertText(bytes: Uint8Array, label: string, targetPath: string): void {
	if (containsByte(bytes, NUL_BYTE) || decodeUtf8Strict(bytes) === null) {
		throw ckError(
			'ENCODING',
			`cannot replay patch for ${targetPath}: ${label} is binary or is not valid UTF-8`,
			'a binary target belongs to the resource-file layer, not to a patch',
			targetPath
		);
	}
}

function assertMergeResult(result: { readonly bytes: Uint8Array; readonly hasConflicts: boolean }, targetPath: string): void {
	if (!(result.bytes instanceof Uint8Array) || typeof result.hasConflicts !== 'boolean') {
		throw ckError(
			'INTERNAL',
			`merge-file returned a malformed result for ${targetPath}`,
			'the merge runner must return Uint8Array bytes and a boolean conflict flag',
			targetPath
		);
	}
}

function sameFileState(left: Uint8Array, leftExists: boolean, right: Uint8Array, rightExists: boolean): boolean {
	return leftExists === rightExists && bytesEqual(left, right);
}

function appliesExactly(bytes: Uint8Array, patch: ParsedPatch): boolean {
	try {
		applyUnified(bytes, patch);
		return true;
	} catch (error) {
		if (isCkError(error) && error.code === 'ARTIFACT-BROKEN') {
			return false;
		}
		throw error;
	}
}

function patchAtTarget(patch: ParsedPatch, targetPath: string): ParsedPatch {
	return patch.targetPath === targetPath ? patch : { ...patch, targetPath };
}
