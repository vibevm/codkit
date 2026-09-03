/** @scope spec://codkit/modules/codkit/PROP-007#cmd-reresolve */
// Source selection and safe materialization for `codkit reresolve`.
// Git is used only for object reads: this module never checks out, stages, or
// updates a ref. The sole durable write is one atomic replacement of the target.

import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { bytesEqual, decodeUtf8Strict } from './bytes.ts';
import type { Conventions } from './conventionsFile.ts';
import { runGit, runGitBytes } from './gitx.ts';
import type { GitBytesResult, GitResult, RunGitOptions } from './gitx.ts';
import { ckError, isCkError } from './messages.ts';
import type { ErrorCode } from './messages.ts';
import { encodePatchName, parseCkpatch } from './patchFormat.ts';
import type { ParsedPatch } from './patchFormat.ts';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.ts';
import { replayPatch } from './replayPatch.ts';
import type { ReplayPatchResult } from './replayPatch.ts';

const PATCHES_DIR = 'delta/patches';
const EMPTY = new Uint8Array(0);

export type ReresolveSourceKind = 'explicit' | 'orig' | 'merge-head' | 'merge-parent';

export type SelectedPatchSource = {
	readonly kind: ReresolveSourceKind;
	/** Stable user-facing identity, e.g. `HEAD:delta/patches/a.ckpatch`. */
	readonly source: string;
	readonly bytes: Uint8Array;
	/** Sources considered up to and including the selected source. */
	readonly checkedSources: readonly string[];
};

export type ReresolveResult = {
	readonly target: string;
	readonly patchArtifact: string;
	readonly patchSource: string;
	readonly checkedSources: readonly string[];
	readonly outcome: ReplayPatchResult['outcome'];
	readonly conflictCount: number;
	readonly nextAction: string;
};

export type ReresolveDependencies = {
	readonly runGit?: (options: RunGitOptions) => GitResult;
	readonly runGitBytes?: (options: RunGitOptions) => GitBytesResult;
	readonly replay?: typeof replayPatch;
	/** Test seam immediately before the atomic rename; production leaves it absent. */
	readonly beforeRename?: (temporary: string, target: string) => void;
};

export type ReresolveOptions = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly target: string;
	readonly explicitPatch: string | null;
	readonly conventions: Conventions;
	readonly dependencies?: ReresolveDependencies;
};

type CurrentFile = {
	readonly absolute: string;
	readonly bytes: Uint8Array;
	readonly exists: boolean;
	readonly identity: Stats | null;
	readonly mode: number;
};

type Dependencies = {
	readonly textGit: (options: RunGitOptions) => GitResult;
	readonly bytesGit: (options: RunGitOptions) => GitBytesResult;
	readonly replay: typeof replayPatch;
	readonly beforeRename?: (temporary: string, target: string) => void;
};

/** Resolve the old patch, replay it, and atomically materialize its exact bytes. */
export function runReresolve(options: ReresolveOptions): ReresolveResult {
	const dependencies = resolvedDependencies(options.dependencies);
	const target = containedArgument(options.treeDir, options.target, 'target');
	const patchArtifact = `${PATCHES_DIR}/${encodePatchName(target)}`;
	const current = readCurrentFile(options.treeDir, target);
	const selected = selectPatchSource(options.patchesDir, patchArtifact, options.explicitPatch, dependencies);
	const patch = parseSelectedPatch(selected, options.conventions);
	if (patch.targetPath !== target) {
		throw checkedError(
			'MARKER-ARTIFACT-MISMATCH',
			`${selected.source}: patch target ${patch.targetPath} does not exactly match requested target ${target}`,
			`pass the target carried by the patch, or select the correct old patch with --patch; checked sources: ${selected.checkedSources.join(' -> ')}`,
			patchArtifact
		);
	}

	const base = readBase(options.treeDir, patch, patchArtifact, dependencies);
	const replayed = dependencies.replay({
		treeDir: options.treeDir,
		targetPath: target,
		base: base.bytes,
		baseExists: base.exists,
		ours: current.bytes,
		oursExists: current.exists,
		patch
	});
	const conflicts = replayed.bytes === null ? 0 : countConflicts(replayed.bytes);
	if (replayed.bytes !== null) {
		atomicReplace(options.treeDir, target, replayed.bytes, current, dependencies);
	}

	return {
		target,
		patchArtifact,
		patchSource: selected.source,
		checkedSources: selected.checkedSources,
		outcome: replayed.outcome,
		conflictCount: conflicts,
		nextAction: nextAction(replayed.outcome, target, patchArtifact)
	};
}

/** PROP-007 sec. 9: explicit, .orig, in-progress HEAD, completed HEAD^1. */
export function selectPatchSource(
	patchesDir: string,
	patchArtifact: string,
	explicitPatch: string | null,
	dependencies: ReresolveDependencies = {}
): SelectedPatchSource {
	const resolved = resolvedDependencies(dependencies);
	const checked: string[] = [];

	if (explicitPatch !== null) {
		const explicit = containedArgument(patchesDir, explicitPatch, '--patch');
		const source = `--patch ${explicit}`;
		checked.push(source);
		const bytes = readRegularIfPresent(patchesDir, explicit, '--patch');
		if (bytes !== null) return { kind: 'explicit', source, bytes, checkedSources: checked };
	}

	const orig = `${patchArtifact}.orig`;
	checked.push(orig);
	const origBytes = readRegularIfPresent(patchesDir, orig, '.orig source');
	if (origBytes !== null) return { kind: 'orig', source: orig, bytes: origBytes, checkedSources: checked };

	assertPatchSetRepository(patchesDir, resolved);
	const inProgress = resolved.textGit({ args: ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], cwd: patchesDir }).status === 0;
	const headSource = `HEAD:${patchArtifact}`;
	checked.push(inProgress ? headSource : `${headSource} (merge not in progress)`);
	if (inProgress) {
		const bytes = blobIfPresent(patchesDir, headSource, resolved);
		if (bytes !== null) return { kind: 'merge-head', source: headSource, bytes, checkedSources: checked };
	}

	const parents = inProgress ? 0 : headParents(patchesDir, resolved);
	const parentSource = `HEAD^1:${patchArtifact}`;
	checked.push(
		parents === 2 ? parentSource : `${parentSource} (${inProgress ? 'merge is still in progress' : 'HEAD is not a two-parent merge'})`
	);
	if (parents === 2) {
		const bytes = blobIfPresent(patchesDir, parentSource, resolved);
		if (bytes !== null) return { kind: 'merge-parent', source: parentSource, bytes, checkedSources: checked };
	}

	throw checkedError(
		'ARTIFACT-BROKEN',
		`no old patch source exists for ${patchArtifact}`,
		`checked sources in order: ${checked.join(' -> ')}; preserve the old patch as ${orig}, or pass --patch <contained-file>`,
		patchArtifact
	);
}

function parseSelectedPatch(source: SelectedPatchSource, conventions: Conventions): ParsedPatch {
	try {
		return parseCkpatch(source.bytes, conventions, source.source);
	} catch (error) {
		if (!isCkError(error)) throw error;
		throw checkedError(
			error.code,
			`${source.source}: malformed old patch: ${error.message}`,
			`${error.hint ?? 'repair the old patch'}; checked sources: ${source.checkedSources.join(' -> ')}`,
			source.source,
			error.line
		);
	}
}

function readBase(
	treeDir: string,
	patch: ParsedPatch,
	artifact: string,
	dependencies: Dependencies
): { bytes: Uint8Array; exists: boolean } {
	const separator = patch.header.pin.lastIndexOf('@');
	const commit = patch.header.pin.slice(separator + 1);
	const commitCheck = dependencies.textGit({ args: ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], cwd: treeDir });
	if (commitCheck.status !== 0) {
		throw ckError(
			'PIN-UNREACHABLE',
			`${artifact}: patch base commit ${commit} is not reachable in the fork tree`,
			`fetch the commit outside codkit, then re-run reresolve: git -C ${treeDir} fetch <remote> ${commit}`,
			artifact
		);
	}
	const object = blobIfPresent(treeDir, `${commit}:${patch.targetPath}`, dependencies);
	if (object === null) {
		if (patch.isAddFile) return { bytes: EMPTY, exists: false };
		throw checkedError(
			'ARTIFACT-BROKEN',
			`${artifact}: target ${patch.targetPath} does not exist at patch base ${patch.header.pin}`,
			'the old patch must name a pin commit at which its target exists',
			artifact
		);
	}
	if (patch.isAddFile) {
		throw checkedError(
			'ARTIFACT-BROKEN',
			`${artifact}: add-file target ${patch.targetPath} already exists at patch base ${patch.header.pin}`,
			'an add-file patch requires an absent base target',
			artifact
		);
	}
	return { bytes: object, exists: true };
}

function readCurrentFile(treeDir: string, target: string): CurrentFile {
	const resolved = resolveContainedPath(treeDir, target, { allowMissing: true });
	if (!resolved.ok) throw unsafe('target', target, resolved.reason);
	try {
		const before = lstatSync(resolved.absolute);
		if (!before.isFile()) throw unsafe('target', target, 'is not a regular file');
		const bytes = readFileSync(resolved.absolute);
		const after = lstatSync(resolved.absolute);
		if (!sameIdentity(before, after)) throw unsafe('target', target, 'changed identity while it was read');
		return { absolute: resolved.absolute, bytes, exists: true, identity: after, mode: after.mode & 0o7777 };
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return { absolute: resolved.absolute, bytes: EMPTY, exists: false, identity: null, mode: 0o644 };
		throw error;
	}
}

function atomicReplace(treeDir: string, target: string, bytes: Uint8Array, current: CurrentFile, dependencies: Dependencies): void {
	const verified = resolveContainedPath(treeDir, target, { allowMissing: true });
	if (!verified.ok || verified.absolute !== current.absolute)
		throw unsafe('target', target, verified.ok ? 'resolved path changed' : verified.reason);
	assertCurrentIdentity(treeDir, current, target);
	const temporary = `${verified.absolute}.codkit-reresolve-${randomUUID()}`;
	try {
		writeFileSync(temporary, bytes, { flag: 'wx', mode: current.mode });
		chmodSync(temporary, current.mode);
		dependencies.beforeRename?.(temporary, verified.absolute);
		assertCurrentIdentity(treeDir, current, target);
		renameSync(temporary, verified.absolute);
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (errorCode(error) !== 'ENOENT') throw error;
		}
	}
}

function assertCurrentIdentity(treeDir: string, current: CurrentFile, target: string): void {
	const contained = resolveContainedPath(treeDir, target, { allowMissing: true });
	if (!contained.ok || contained.absolute !== current.absolute) {
		throw unsafe('target', target, contained.ok ? 'resolved path changed' : contained.reason);
	}
	try {
		const before = lstatSync(current.absolute);
		if (current.identity === null || !before.isFile() || !sameIdentity(current.identity, before)) {
			throw unsafe('target', target, 'changed before the atomic replacement');
		}
		const bytes = readFileSync(current.absolute);
		const after = lstatSync(current.absolute);
		if (!after.isFile() || !sameIdentity(before, after) || !sameIdentity(current.identity, after) || !bytesEqual(current.bytes, bytes)) {
			throw unsafe('target', target, 'bytes or identity changed before the atomic replacement');
		}
	} catch (error) {
		if (errorCode(error) === 'ENOENT' && current.identity === null) return;
		throw error;
	}
}

function readRegularIfPresent(root: string, path: string, label: string): Uint8Array | null {
	const resolved = resolveContainedPath(root, path, { allowMissing: true });
	if (!resolved.ok) throw unsafe(label, path, resolved.reason);
	try {
		const before = lstatSync(resolved.absolute);
		if (!before.isFile()) throw unsafe(label, path, 'is not a regular file');
		const bytes = readFileSync(resolved.absolute);
		const after = lstatSync(resolved.absolute);
		if (!sameIdentity(before, after)) throw unsafe(label, path, 'changed identity while it was read');
		return bytes;
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return null;
		throw error;
	}
}

function containedArgument(root: string, given: string, label: string): string {
	if (given === '') throw unsafe(label, given, 'must not be empty');
	const rootAbsolute = resolve(root);
	const absolute = isAbsolute(given) ? resolve(given) : resolve(rootAbsolute, given);
	const inside = relative(rootAbsolute, absolute);
	if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
		throw unsafe(label, given, `is outside ${rootAbsolute}`);
	}
	const portable = inside.split(sep).join('/');
	const problem = repoRelativePathProblem(portable);
	if (problem !== null) throw unsafe(label, given, problem);
	return portable;
}

function assertPatchSetRepository(patchesDir: string, dependencies: Dependencies): void {
	if (dependencies.textGit({ args: ['rev-parse', '--git-dir'], cwd: patchesDir }).status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`${patchesDir} is not a git repository, so merge patch sources cannot be read`,
			'run reresolve from a patchset checkout'
		);
	}
}

function headParents(patchesDir: string, dependencies: Dependencies): number {
	const result = dependencies.textGit({ args: ['rev-list', '--parents', '-n', '1', 'HEAD'], cwd: patchesDir });
	if (result.status !== 0) return 0;
	const fields = result.stdout
		.trim()
		.split(/\s+/)
		.filter((field) => field !== '');
	return Math.max(0, fields.length - 1);
}

function blobIfPresent(root: string, object: string, dependencies: Dependencies): Uint8Array | null {
	const result = dependencies.bytesGit({ args: ['show', object], cwd: root });
	return result.status === 0 ? result.stdout : null;
}

function countConflicts(bytes: Uint8Array): number {
	const text = decodeUtf8Strict(bytes);
	if (text === null) throw ckError('ENCODING', 'merge result is not valid UTF-8');
	return text.split('\n').filter((line) => line === '<<<<<<< ours').length;
}

function nextAction(outcome: ReplayPatchResult['outcome'], target: string, artifact: string): string {
	if (outcome === 'conflict') return `edit the diff3 conflicts in ${target}, then run codkit save ${target}`;
	if (outcome === 'target-deleted') return `decide whether to remove or retarget ${artifact}; no file was written`;
	return `resolved, run codkit save ${target}`;
}

function resolvedDependencies(input: ReresolveDependencies | undefined): Dependencies {
	const dependencies: Dependencies = {
		textGit: input?.runGit ?? runGit,
		bytesGit: input?.runGitBytes ?? runGitBytes,
		replay: input?.replay ?? replayPatch
	};
	if (input?.beforeRename !== undefined) return { ...dependencies, beforeRename: input.beforeRename };
	return dependencies;
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size;
}

function unsafe(label: string, path: string, reason: string): Error {
	return ckError(
		'CONFIG',
		`${label} ${JSON.stringify(path)} is unsafe: ${reason}`,
		'use a contained regular file without symlink components',
		path
	);
}

function checkedError(code: ErrorCode, message: string, hint: string, file?: string, line?: number): Error {
	return ckError(code, message, hint, file, line);
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}
