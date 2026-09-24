/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The bytes of the files the delta writes (PROP-008 ##WORKTREE-DELTA-BYTES).
//
// codkit stores what the patch set holds in the branch as it is, and a checkout
// hands those bytes through git's working-copy conversion on their way out:
// CRLF for a `text=auto` file wherever the platform's line ending is CRLF
// (PROP-002 ##GIT-ENV-EOL), and on every OS whatever an upstream `eol`, `ident`
// or filter of that path asks for. A package is built from the working copy,
// so it would ship the conversion instead of the patch set. After `load` has
// moved the tree, and on its fast path, every file the delta writes is compared
// with its blob at the tip, and a file that differs from it only by such a
// conversion gets the blob's bytes back.
//
// "Only by such a conversion" is git's own answer: its hash of the working file
// under the tree's attributes is the blob. A file with a real difference is left
// alone - the drift guard and the move of the tree own it - and a file that
// already holds the bytes is never written, so its mtime stays
// (##MTIME-DISCIPLINE). The same comparison is what heals a tree an older
// checkout wrote.

import { lstatSync, writeFileSync } from 'node:fs';
import { runGit, runGitBytes } from './gitx.ts';
import type { GitResult } from './gitx.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';

/** Paths per git invocation: an argv is bounded, and tightly on Windows. */
const PATH_BATCH = 100;

/** A regular file of the tip that the tree carries as a regular file too. */
type TipFile = { readonly path: string; readonly blob: string; readonly absolute: string };

/**
 * Give the tip's bytes back to every one of `targets` whose working file
 * differs from its blob at HEAD only by git's working-copy conversion. Returns
 * the rewritten paths in path order; no other file is written.
 */
export function restoreDeltaBytes(treeDir: string, targets: readonly string[]): readonly string[] {
	const files = regularFilesAtHead(treeDir, [...new Set(targets)].sort());
	const raw = hashFiles(treeDir, files, true);
	const differing = files.filter((file, index) => raw[index] !== file.blob);
	if (differing.length === 0) {
		return [];
	}
	const stored = hashFiles(treeDir, differing, false);
	const restored: string[] = [];
	differing.forEach((file, index) => {
		// A real difference is no conversion, and not this step's to touch.
		if (stored[index] !== file.blob) {
			return;
		}
		writeFileSync(file.absolute, blobBytes(treeDir, file));
		restored.push(file.path);
	});
	// The index still holds the size of the converted file, and git trusts a
	// changed size without reading the file: `status` - and the drift guard with
	// it - would call the restored file modified. Adding it again stores the
	// same blob, which is what made it eligible, with the new size and mtime.
	// `safecrlf` would only warn, or refuse, that a checkout converts it back.
	for (const batch of batches(restored)) {
		mustGit(treeDir, ['-c', 'core.safecrlf=false', 'update-index', '--', ...batch], 'record the restored files in the index');
	}
	return restored;
}

/** The targets that are regular files at HEAD and in the tree, with their blobs. */
function regularFilesAtHead(treeDir: string, targets: readonly string[]): readonly TipFile[] {
	const wanted = new Set(targets);
	const files: TipFile[] = [];
	for (const batch of batches(targets)) {
		const listed = mustGit(
			treeDir,
			['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', ...batch],
			'list the files of the delta at HEAD'
		);
		for (const record of listed.stdout.split('\0')) {
			const match = /^(?:100644|100755) blob ([0-9a-f]+)\t(.+)$/su.exec(record);
			const blob = match?.[1];
			const path = match?.[2];
			if (blob === undefined || path === undefined || !wanted.has(path)) {
				continue;
			}
			const resolved = resolveContainedPath(treeDir, path);
			if (!resolved.ok || !lstatSync(resolved.absolute).isFile()) {
				continue;
			}
			files.push({ path, blob, absolute: resolved.absolute });
		}
	}
	return files;
}

/**
 * The object ids of the working files, in order: raw (`--no-filters`), or the
 * one git itself would store for the file at its path, under the tree's
 * attributes.
 */
function hashFiles(treeDir: string, files: readonly TipFile[], raw: boolean): readonly string[] {
	const ids: string[] = [];
	for (const batch of batches(files.map((file) => file.path))) {
		const hashed = mustGit(treeDir, ['hash-object', ...(raw ? ['--no-filters'] : []), '--', ...batch], 'hash the files of the delta');
		ids.push(...hashed.stdout.split('\n').filter((line) => line !== ''));
	}
	if (ids.length !== files.length) {
		throw ckError('INTERNAL', `git hashed ${ids.length} file(s) of the delta, ${files.length} were asked for`);
	}
	return ids;
}

function blobBytes(treeDir: string, file: TipFile): Uint8Array {
	const blob = runGitBytes({ args: ['cat-file', 'blob', file.blob], cwd: treeDir });
	if (blob.status !== 0) {
		throw ckError('ARTIFACT-BROKEN', `cannot read the blob of ${file.path} at HEAD: ${blob.stderr.trim()}`, 're-run with --verbose');
	}
	return blob.stdout;
}

function mustGit(treeDir: string, args: readonly string[], what: string): GitResult {
	const result = runGit({ args, cwd: treeDir });
	if (result.status !== 0) {
		throw ckError('ARTIFACT-BROKEN', `cannot ${what}: ${result.stderr.trim().split('\n')[0] ?? ''}`, 're-run with --verbose');
	}
	return result;
}

function* batches(paths: readonly string[]): Generator<readonly string[]> {
	for (let index = 0; index < paths.length; index += PATH_BATCH) {
		yield paths.slice(index, index + PATH_BATCH);
	}
}
