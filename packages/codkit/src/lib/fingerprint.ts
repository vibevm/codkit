/** @scope spec://codkit/modules/codkit/PROP-006#root */
// Delta fingerprint and fork-tree identity (PROP-006 sec. 1).
//
// Two derived identities live here, and neither of them is state:
//
//   * deltaFingerprint - what patchset currently asks the tree to look like. It is
//     a hash over every file under delta/ plus the pin, so any edit to any
//     artifact (own code included, since own lives under delta/own/) changes it.
//     It is the value the fast path of `load` compares against (##FAST-PATH-RULE):
//     when it moved, the applied state is stale by definition.
//   * treeId - which tree we are talking about. It keys the per-tree cache and
//     the lock file, so several fork trees can be driven from one patchset
//     checkout (##MULTI-TREE-SUPPORT) without ever seeing each other's state.
//
// The canonical string is fixed by the spec and must not drift: paths are POSIX
// and relative to the patchset root, sorted by their UTF-8 bytes (not by locale),
// and the terminating lines carry the pin and the schema version.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { OWN_ROOTS_DIR, OWN_SOURCE_DIR } from './ownedRoots.ts';

/** Directory holding every delta artifact, relative to the patchset root. */
export const DELTA_DIR_NAME = 'delta';

/** Version of the canonical string; part of the hashed input. */
export const FINGERPRINT_SCHEMA_VERSION = 1;

/** Hex characters of a tree id (##TREE-ID). */
const TREE_ID_LENGTH = 16;

export type DeltaFile = {
	/** POSIX path relative to the patchset root, e.g. `delta/own/hello.ts`. */
	readonly path: string;
	/** sha256 of the file content, hex. */
	readonly sha256: string;
};

/** The delta as one traversal sees it: its fingerprint and its per-file map. */
export type DeltaFiles = {
	/** hex sha256 of the canonical string of PROP-006 ##DELTA-FINGERPRINT. */
	readonly fingerprint: string;
	/** sha256 of every file under delta/, by its patchset-relative POSIX path. */
	readonly files: Readonly<Record<string, string>>;
};

/**
 * The delta in one traversal (PROP-006 ##DELTA-FINGERPRINT): the fingerprint
 * and the per-file map read the same walk, so a caller that needs both - every
 * mark `load` writes now does (##TREE-MARK) - does not pay for the delta tree
 * twice.
 *
 * A missing delta/ directory is not an error: it hashes the pin alone, which is
 * exactly the fingerprint of "no delta at all".
 */
export function deltaFiles(patchesDir: string, pinSha: string): DeltaFiles {
	const hash = createHash('sha256');
	const files: Record<string, string> = {};
	for (const file of listDeltaFiles(patchesDir)) {
		hash.update(`${file.path}\n${file.sha256}\n`, 'utf8');
		files[file.path] = file.sha256;
	}
	hash.update(`pin ${pinSha}\nschema ${FINGERPRINT_SCHEMA_VERSION}\n`, 'utf8');
	return { fingerprint: hash.digest('hex'), files };
}

export function deltaFingerprint(patchesDir: string, pinSha: string): string {
	return deltaFiles(patchesDir, pinSha).fingerprint;
}

/**
 * The mark's artifact map (PROP-006 ##TREE-MARK): `files` minus the owned
 * subtrees - every owned directory keeps its own per-file map in the mark
 * (`ownFiles`, `ownRootFiles`), so the two never double-cover a path. This
 * filter is the single definition of "artifact" for the moved-check; the writer
 * of the mark and its reader both go through it (PROP-008 ##PATCHSET-MOVED-RULE).
 */
export function deltaArtifactMap(files: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	const ownedPrefixes = [`${OWN_SOURCE_DIR}/`, `${OWN_ROOTS_DIR}/`];
	const artifacts: Record<string, string> = {};
	for (const [path, sha256] of Object.entries(files)) {
		if (!ownedPrefixes.some((prefix) => path.startsWith(prefix))) {
			artifacts[path] = sha256;
		}
	}
	return artifacts;
}

/**
 * Every file under delta/, recursively, sorted by the UTF-8 bytes of its path.
 * Exposed because `--verbose` diagnostics and the tests want to see the input
 * of the fingerprint, not only its digest.
 */
export function listDeltaFiles(patchesDir: string): readonly DeltaFile[] {
	const collected: { key: Buffer; file: DeltaFile }[] = [];
	walk(join(patchesDir, DELTA_DIR_NAME), DELTA_DIR_NAME, collected);
	collected.sort((left, right) => left.key.compare(right.key));
	return collected.map((entry) => entry.file);
}

/** sha256 of the tree's realpath, first 16 hex characters (##TREE-ID). */
export function treeId(resolvedTreePath: string): string {
	return createHash('sha256').update(canonicalPath(resolvedTreePath), 'utf8').digest('hex').slice(0, TREE_ID_LENGTH);
}

/**
 * The path treeId hashes: the realpath when the tree exists, the given path
 * otherwise. The resolver already hands out a realpath; this keeps the identity
 * stable for callers that build a path themselves.
 */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function walk(absoluteDir: string, relativeDir: string, into: { key: Buffer; file: DeltaFile }[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(absoluteDir, { withFileTypes: true });
	} catch {
		// No delta/ at all, or a directory that vanished mid-walk: both mean
		// "nothing to hash here", never a crash in the middle of a load.
		return;
	}
	for (const entry of entries) {
		const absolute = join(absoluteDir, entry.name);
		// POSIX separators in the canonical string on every platform.
		const relative = `${relativeDir}/${entry.name}`;
		if (isDirectory(entry, absolute)) {
			walk(absolute, relative, into);
			continue;
		}
		const content = readFileSync(absolute);
		into.push({
			key: Buffer.from(relative, 'utf8'),
			file: { path: relative, sha256: createHash('sha256').update(content).digest('hex') }
		});
	}
}

type DirentLike = { isDirectory: () => boolean; isSymbolicLink: () => boolean };

/** A symlink is followed, so a link to a directory is walked, not read as a file. */
function isDirectory(entry: DirentLike, absolute: string): boolean {
	if (entry.isDirectory()) {
		return true;
	}
	if (!entry.isSymbolicLink()) {
		return false;
	}
	try {
		return statSync(absolute).isDirectory();
	} catch {
		return false;
	}
}
