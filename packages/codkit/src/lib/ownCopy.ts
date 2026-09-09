/** @scope spec://codkit/modules/codkit/PROP-008#root */
// Copying own code between patchset and the fork tree (PROP-008 ##OWN-COPY-ALGORITHM).
//
// `delta/own/**` is the source of truth; `<tree>/<ownRoot>/**` is a
// materialization of it (PROP-005 ##OWN-SOURCE-OF-TRUTH). The copy is rsync-like
// and content-addressed on purpose:
//
//   * a file is written only when its bytes differ, so mtime of untouched files
//     never moves and the watch daemons do not restart a build for nothing
//     (##MTIME-DISCIPLINE);
//   * mtime is never a criterion for "changed" - a checkout rewrites mtimes
//     without changing content, and trusting it would copy the whole tree;
//   * files missing on the source side are deleted on the target side, and the
//     directories they emptied are removed.
//
// The same listing is used by the drift guard, which compares the two sides
// without writing: locally the own directory is excluded from git, so byte
// comparison is the only thing that can see a change in it.
//
// Every function here works on **one** owned directory, and the plural form of
// each - the one the commands call - loops over the list the type answered
// (PROP-016 ##TYPE-AREA-LAYOUT, `ownedRoots.ts`). Inside an owned directory the
// build outputs the type named are not own code at all: the listing never
// yields them, so they are never copied into the delta, never compared, never
// removed by a load, and never counted as work at risk. Only the fresh pass,
// which was told to remove build outputs, touches them.

import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { bytesEqual } from './bytes.ts';
import { LICENCE_NOTICE_NAME, OWN_MANIFEST_NAME } from './layers/ownManifest.ts';
import { ckError } from './messages.ts';
import { ownCodeFilter, OWN_SOURCE_DIR } from './ownedRoots.ts';
import type { OwnedRoot } from './ownedRoots.ts';
import type { OwnSideClass } from './ownSides.ts';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.ts';

// The delta directory of the own root is defined with the owned directories
// themselves and re-exported here, where every consumer of the own layer
// already imports from.
export { OWN_SOURCE_DIR };

/** Placeholder that only exists to keep an empty directory in git. */
export const GITKEEP_NAME = '.gitkeep';

/**
 * Whether a file under `delta/own/` is own code that the tree receives.
 *
 * Two kinds of file live there and are not delivered: the placeholders git
 * needs to carry an empty directory, and the unit manifest. The manifest is a
 * statement of patchset *about* own code, not a module of it (PROP-005 sec. 3), and
 * mirroring it would materialize it in the own root of the tree, from where the
 * transpiler of the tree carries it into `out/` as if it were product code.
 *
 * The same predicate governs the comparison of the two sides: a file that is
 * never copied must never be missed in the tree either, or the drift guard
 * would read its absence as unextracted work.
 */
export function isDeliveredOwnFile(relative: string): boolean {
	const name = relative.slice(relative.lastIndexOf('/') + 1);
	return name !== GITKEEP_NAME && name !== OWN_MANIFEST_NAME;
}

/**
 * The own snapshot of a release branch: everything delivered except the codkit
 * licence notice (PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION).
 *
 * Only `publish` builds a release; the `ci` branch, the cycle branch and the
 * developer tree after `load` carry the notice as usual, because those are
 * working trees and not something anybody ships.
 */
export function isReleasedOwnFile(relative: string): boolean {
	const name = relative.slice(relative.lastIndexOf('/') + 1);
	return isDeliveredOwnFile(relative) && name !== LICENCE_NOTICE_NAME;
}

export type OwnSyncReport = {
	/** Files written into the tree because their bytes differed or were absent. */
	readonly copied: number;
	/** Files removed from the tree because patchset no longer has them. */
	readonly removed: number;
	/** Files own code consists of after the load. */
	readonly total: number;
};

/**
 * The delta directory of one owned root, absolute. The default is the own root
 * of the patch set, `delta/own/` - the historical location, and still the only
 * one for the family that owns one directory (PROP-005 ##OWN-ROOTS-IN-THE-DELTA).
 */
export function ownSourceRoot(patchesDir: string, deltaDir: string = OWN_SOURCE_DIR): string {
	return join(patchesDir, ...deltaDir.split('/'));
}

/**
 * The materialized own directory of a fork tree, absolute. The own root is a
 * full path from the tree root and comes from `typeConfig.ownRoot`
 * (PROP-016 ##TYPE-OWN-ROOT); to this module it is an opaque directory.
 */
export function ownTargetRoot(treeDir: string, ownRoot: string): string {
	return join(treeDir, ...ownRoot.split('/'));
}

/**
 * Relative POSIX paths of every file under `root`, sorted.
 *
 * `refuseSymlinks` is set for the patchset side: a symlink in own code would make
 * the delta depend on something outside the repository, so it is refused rather
 * than followed. The listing is raw - everything that is there, including the
 * files `isDeliveredOwnFile` excludes - because `verify` and the inventory read
 * the manifest and the placeholders as content of patchset.
 */
export function listOwnFiles(
	root: string,
	options: { readonly refuseSymlinks: boolean; readonly keep?: ((relative: string) => boolean) | undefined }
): readonly string[] {
	const out: string[] = [];
	walk(root, '', out, options.refuseSymlinks, options.keep);
	out.sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
	return out;
}

/** Byte equality with a size fast path; mtime is deliberately not consulted. */
export function fileContentEqual(left: string, right: string): boolean {
	let leftSize: number;
	let rightSize: number;
	try {
		leftSize = statSync(left).size;
		rightSize = statSync(right).size;
	} catch {
		return false;
	}
	if (leftSize !== rightSize) {
		return false;
	}
	return bytesEqual(readFileSync(left), readFileSync(right));
}

/**
 * How the two sides of one own file disagree. The class matters: only two of
 * the three put work at risk, and the third is simply "not materialized yet".
 */
export type OwnDivergenceKind =
	/** In patchset and in the tree, different bytes: someone moved one of them. */
	| 'both'
	/** In the tree only: an own file that was never extracted into patchset. */
	| 'tree-only'
	/** In patchset only: nothing to lose, this is what a load is for. */
	| 'patchset-only';

export type OwnDivergence = {
	/** Path relative to the owned directory, POSIX. */
	readonly relative: string;
	readonly kind: OwnDivergenceKind;
	/** The owned directory the path belongs to. */
	readonly owned: OwnedRoot;
};

/** Paths (relative to the own root) that differ between patchset and the tree. */
export function compareOwn(patchesDir: string, treeDir: string, owned: OwnedRoot): readonly OwnDivergence[] {
	const source = ownSourceRoot(patchesDir, owned.deltaDir);
	const target = ownTargetRoot(treeDir, owned.path);
	assertOwnRootsSafe(patchesDir, treeDir, owned);
	const keep = ownCodeFilter(owned);
	const sourceFiles = listOwnFiles(source, { refuseSymlinks: true, keep }).filter(isDeliveredOwnFile);
	const targetFiles = listOwnFiles(target, { refuseSymlinks: true, keep }).filter(isDeliveredOwnFile);

	const diverged: OwnDivergence[] = [];
	const targetSet = new Set(targetFiles);
	for (const relative of sourceFiles) {
		if (!targetSet.has(relative)) {
			diverged.push({ relative, kind: 'patchset-only', owned });
			continue;
		}
		if (!fileContentEqual(join(source, relative), join(target, relative))) {
			diverged.push({ relative, kind: 'both', owned });
		}
	}
	const sourceSet = new Set(sourceFiles);
	for (const relative of targetFiles) {
		if (!sourceSet.has(relative)) {
			diverged.push({ relative, kind: 'tree-only', owned });
		}
	}
	diverged.sort((left, right) => Buffer.from(left.relative, 'utf8').compare(Buffer.from(right.relative, 'utf8')));
	return diverged;
}

/** Every owned directory compared, in the order the type answered. */
export function compareAllOwn(patchesDir: string, treeDir: string, roots: readonly OwnedRoot[]): readonly OwnDivergence[] {
	return roots.flatMap((owned) => compareOwn(patchesDir, treeDir, owned));
}

/**
 * patchset -> tree, the direction `load` uses.
 *
 * The target side is listed raw, so that a file the tree carries and patchset does
 * not is removed. That is also how a manifest an older load materialized leaves
 * the tree: it is no longer copied, so the next run finds it in the mirror
 * without a source and deletes it like any other leftover.
 */
export function syncOwnCode(patchesDir: string, treeDir: string, owned: OwnedRoot): OwnSyncReport {
	const source = ownSourceRoot(patchesDir, owned.deltaDir);
	const target = ownTargetRoot(treeDir, owned.path);
	// Validate both complete trees before the first copy/delete. In particular, a
	// symlink on the materialized side must not redirect a later write outside the
	// fork tree, and a symlink found after one copy must not leave a partial load.
	assertOwnRootsSafe(patchesDir, treeDir, owned);
	const keep = ownCodeFilter(owned);
	const sourceFiles = listOwnFiles(source, { refuseSymlinks: true, keep }).filter(isDeliveredOwnFile);
	// The target side is listed under the same filter: a build output the tree
	// carries is not a leftover of a withdrawn own file, and deleting it would
	// force a full rebuild on every load (##TYPE-AREA-LAYOUT).
	const targetFiles = listOwnFiles(target, { refuseSymlinks: true, keep });

	let copied = 0;
	for (const relative of sourceFiles) {
		const from = join(source, relative);
		const to = join(target, relative);
		if (fileContentEqual(from, to)) {
			continue;
		}
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, readFileSync(from));
		copied += 1;
	}

	let removed = 0;
	const delivered = new Set(sourceFiles);
	const emptied = new Set<string>();
	for (const relative of targetFiles) {
		if (delivered.has(relative)) {
			continue;
		}
		rmSync(join(target, relative), { force: true });
		removed += 1;
		collectAncestors(relative, emptied);
	}
	pruneEmptyDirectories(target, emptied);

	return { copied, removed, total: sourceFiles.length };
}

/** Every owned directory mirrored into the tree, as one report. */
export function syncAllOwnCode(patchesDir: string, treeDir: string, roots: readonly OwnedRoot[]): OwnSyncReport {
	let copied = 0;
	let removed = 0;
	let total = 0;
	for (const owned of roots) {
		const report = syncOwnCode(patchesDir, treeDir, owned);
		copied += report.copied;
		removed += report.removed;
		total += report.total;
	}
	return { copied, removed, total };
}

export type OwnMirrorReport = OwnSyncReport & {
	/** Files left as patchset has them, because only patchset moved. */
	readonly kept: number;
};

/**
 * tree -> patchset, the direction `save` uses (##OWN-COPY-ALGORITHM, reversed).
 *
 * Only the files the tree moved are mirrored: `save` extracts work out of the
 * tree, and a file that only patchset changed would otherwise be overwritten by a
 * tree that is simply out of date. A file both sides changed never reaches this
 * function - the caller stops at CK-E-BOTH-SIDES-EDITED before anything is
 * written.
 */
export function mirrorOwnBack(patchesDir: string, treeDir: string, owned: OwnedRoot, classes: readonly OwnSideClass[]): OwnMirrorReport {
	const source = ownTargetRoot(treeDir, owned.path);
	const target = ownSourceRoot(patchesDir, owned.deltaDir);
	let copied = 0;
	let removed = 0;
	let kept = 0;
	const emptied = new Set<string>();

	for (const entry of classes) {
		if (entry.kind === 'same') {
			continue;
		}
		if (entry.kind === 'patchset-edited') {
			kept += 1;
			continue;
		}
		// 'tree-edited', and 'unknown': without a map the tree is what `save` is
		// asked to extract, which is the behaviour codkit had before the map.
		if (entry.tree === null) {
			rmSync(join(target, entry.relative), { force: true });
			removed += 1;
			collectAncestors(entry.relative, emptied);
			continue;
		}
		const from = join(source, entry.relative);
		const to = join(target, entry.relative);
		mkdirSync(dirname(to), { recursive: true });
		writeFileSync(to, readFileSync(from));
		copied += 1;
	}
	// The own root of patchset is a directory of the repository; only the
	// directories a removal emptied are pruned, never the root itself.
	pruneEmptyDirectoriesBelow(target, emptied);

	const total = classes.filter((entry) => (entry.kind === 'patchset-edited' ? entry.patchset !== null : entry.tree !== null)).length;
	return { copied, removed, kept, total };
}

/** Every owned directory mirrored back, as one report. */
export function mirrorAllOwnBack(
	patchesDir: string,
	treeDir: string,
	roots: readonly OwnedRoot[],
	classes: readonly OwnSideClass[]
): OwnMirrorReport {
	let copied = 0;
	let removed = 0;
	let kept = 0;
	let total = 0;
	for (const owned of roots) {
		const mine = classes.filter((entry) => entry.owned.role === owned.role);
		const report = mirrorOwnBack(patchesDir, treeDir, owned, mine);
		copied += report.copied;
		removed += report.removed;
		kept += report.kept;
		total += report.total;
	}
	return { copied, removed, kept, total };
}

function walk(
	absoluteDir: string,
	relativeDir: string,
	into: string[],
	refuseSymlinks: boolean,
	keep?: ((relative: string) => boolean) | undefined
): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(absoluteDir, { withFileTypes: true });
	} catch {
		// An absent own directory on either side is a legal state: patchset may not
		// have own code yet, and the tree may never have been synced.
		return;
	}
	for (const entry of entries) {
		const absolute = join(absoluteDir, entry.name);
		const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
		// A directory the filter rejects is not descended into at all: that is
		// what keeps the listing away from what a build wrote, symlinks of an
		// install inside it included.
		if (keep !== undefined && !keep(entry.isDirectory() ? `${relative}/` : relative)) {
			continue;
		}
		if (entry.isSymbolicLink()) {
			if (refuseSymlinks) {
				throw ckError(
					'ARTIFACT-BROKEN',
					`symlinks are not allowed in own code: ${OWN_SOURCE_DIR}/${relative}`,
					'replace the symlink with the file itself; own code must be self-contained in patchset',
					`${OWN_SOURCE_DIR}/${relative}`
				);
			}
			if (isDirectory(absolute)) {
				walk(absolute, relative, into, refuseSymlinks, keep);
				continue;
			}
			into.push(relative);
			continue;
		}
		if (entry.isDirectory()) {
			walk(absolute, relative, into, refuseSymlinks, keep);
			continue;
		}
		into.push(relative);
	}
}

function isDirectory(absolute: string): boolean {
	try {
		return statSync(absolute).isDirectory();
	} catch {
		return false;
	}
}

function assertOwnRootsSafe(patchesDir: string, treeDir: string, owned: OwnedRoot): void {
	assertSafeOwnRoot(owned.path);
	assertContainedOwnRoot(patchesDir, owned.deltaDir, 'own source');
	assertContainedOwnRoot(treeDir, owned.path, 'materialized own target');
}

/**
 * The own root reaches here from the configuration, so it is checked as a path
 * before it is joined: the type states where the root may sit, the engine
 * states only that it stays inside the tree (##TYPE-OWN-ROOT).
 */
export function assertSafeOwnRoot(ownRoot: string): void {
	const problem = repoRelativePathProblem(ownRoot);
	if (problem !== null) {
		throw ckError(
			'CONFIG',
			`typeConfig.ownRoot "${ownRoot}" is unsafe: ${problem}`,
			'set typeConfig.ownRoot to a path from the tree root, without a leading slash or a dot-dot segment'
		);
	}
}

export function assertContainedOwnRoot(repositoryRoot: string, relative: string, label: string): void {
	const resolved = resolveContainedPath(repositoryRoot, relative, { allowMissing: true });
	if (!resolved.ok) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`${label} ${relative} is unsafe: ${resolved.reason}`,
			'remove symlinks from own code and keep it inside its repository root',
			relative
		);
	}
}

function collectAncestors(relative: string, into: Set<string>): void {
	let at = relative;
	for (;;) {
		const slash = at.lastIndexOf('/');
		if (slash === -1) {
			return;
		}
		at = at.slice(0, slash);
		into.add(at);
	}
}

/** Deepest first, so a directory tree that became empty disappears entirely. */
function pruneEmptyDirectories(root: string, candidates: ReadonlySet<string>): void {
	pruneEmptyDirectoriesBelow(root, candidates);
	removeIfEmpty(root);
}

function pruneEmptyDirectoriesBelow(root: string, candidates: ReadonlySet<string>): void {
	const ordered = [...candidates].sort((left, right) => right.split('/').length - left.split('/').length);
	for (const relative of ordered) {
		removeIfEmpty(join(root, relative));
	}
}

function removeIfEmpty(absolute: string): void {
	try {
		if (lstatSync(absolute).isDirectory() && readdirSync(absolute).length === 0) {
			rmdirSync(absolute);
		}
	} catch {
		// Already gone, or not ours to remove: nothing to report.
	}
}
