/** @scope spec://codkit/modules/codkit/PROP-008#PATCHSET-SIDE-EDIT-RULE */
// Which side of an own file moved (PROP-008 ##PATCHSET-SIDE-EDIT-RULE), and the
// per-file evidence the tree mark carries to answer it (PROP-006 ##TREE-MARK).
//
// The copy itself is `ownCopy.ts`; this is the half that decides. The two sides
// of an owned directory are identical by construction right after a load, so
// the map recorded then is what lets a later run say, file by file, whether the
// delta moved, the tree moved, or both - which is the difference between a
// silent overwrite and an extraction. Every owned directory of the patch set
// keeps its own map (PROP-016 ##TYPE-AREA-LAYOUT).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	assertContainedOwnRoot,
	assertSafeOwnRoot,
	isDeliveredOwnFile,
	listOwnFiles,
	OWN_SOURCE_DIR,
	ownSourceRoot,
	ownTargetRoot
} from './ownCopy.ts';
import { ownCodeFilter } from './ownedRoots.ts';
import type { OwnedRoot } from './ownedRoots.ts';

// Own state: the per-file map the mark carries, and what it lets save decide
// ---------------------------------------------------------------------------

/** sha256 of every own file at one moment, keyed by its path under the own root. */
export type OwnFileMap = Readonly<Record<string, string>>;

export type OwnState = {
	readonly files: OwnFileMap;
	/** hex sha256 of the canonical string over `files`; the mark's ownFingerprint. */
	readonly fingerprint: string;
};

/** Version of the canonical string of ownFingerprint; part of the hashed input. */
const OWN_FINGERPRINT_SCHEMA_VERSION = 1;

/**
 * The own state as patchset holds it. Recorded in the tree mark by every load and
 * save (PROP-006 ##TREE-MARK) so that the next run can tell, file by file, which
 * side moved: a file equal to the mark did not change on that side.
 *
 * It is taken from `delta/own/` and not from the tree, because immediately after
 * the copy the two sides are identical by construction and patchset is the source
 * of truth (PROP-005 ##OWN-SOURCE-OF-TRUTH).
 */
export function ownStateOfPatchSet(patchesDir: string, owned?: OwnedRoot): OwnState {
	const deltaDir = owned?.deltaDir ?? OWN_SOURCE_DIR;
	assertContainedOwnRoot(patchesDir, deltaDir, 'own source');
	return ownStateOf(ownSourceRoot(patchesDir, deltaDir), owned === undefined ? undefined : ownCodeFilter(owned));
}

export function ownStateOfTree(treeDir: string, owned: OwnedRoot): OwnState {
	assertSafeOwnRoot(owned.path);
	assertContainedOwnRoot(treeDir, owned.path, 'materialized own target');
	return ownStateOf(ownTargetRoot(treeDir, owned.path), ownCodeFilter(owned));
}

/**
 * The state of one side. Both sides are read through the same filter: a file
 * that is not delivered is not part of the comparison on either side, so it can
 * never be classified as "one of the sides moved it".
 */
function ownStateOf(root: string, keep?: ((relative: string) => boolean) | undefined): OwnState {
	const relatives = listOwnFiles(root, { refuseSymlinks: true, keep }).filter(isDeliveredOwnFile);
	const files: Record<string, string> = {};
	const hash = createHash('sha256');
	for (const relative of relatives) {
		const sha = sha256File(join(root, relative));
		files[relative] = sha;
		hash.update(`${relative}\n${sha}\n`, 'utf8');
	}
	hash.update(`schema ${OWN_FINGERPRINT_SCHEMA_VERSION}\n`, 'utf8');
	return { files, fingerprint: hash.digest('hex') };
}

function sha256File(absolute: string): string {
	return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

/**
 * The maps the tree mark keeps for the owned directories, from the delta side
 * (PROP-006 ##TREE-MARK). The own root keeps the historical two fields, so a
 * mark of a patch set that owns one directory is byte for byte what it always
 * was; every other owned directory is one entry of `ownRootFiles`, keyed by its
 * role.
 */
export function ownMarkState(
	patchesDir: string,
	roots: readonly OwnedRoot[]
): {
	readonly ownFingerprint: string;
	readonly ownFiles: OwnFileMap;
	readonly ownRootFiles: Readonly<Record<string, OwnFileMap>> | undefined;
} {
	const first = roots[0];
	const own = first === undefined ? ownStateOfPatchSet(patchesDir) : ownStateOfPatchSet(patchesDir, first);
	const others: Record<string, OwnFileMap> = {};
	for (const owned of roots.slice(1)) {
		others[owned.role] = ownStateOfPatchSet(patchesDir, owned).files;
	}
	return {
		ownFingerprint: own.fingerprint,
		ownFiles: own.files,
		ownRootFiles: Object.keys(others).length === 0 ? undefined : others
	};
}

/**
 * The map the mark kept for one owned directory, or null when it kept none.
 * `null` is the honest answer of a mark written before this directory was
 * owned, and the classifier turns it into `unknown` rather than a guess.
 */
export function ownMarkFilesOf(
	mark: { readonly ownFiles?: OwnFileMap | undefined; readonly ownRootFiles?: Readonly<Record<string, OwnFileMap>> | undefined } | null,
	owned: OwnedRoot
): OwnFileMap | null {
	if (mark === null) {
		return null;
	}
	return (owned.role === 'own' ? mark.ownFiles : mark.ownRootFiles?.[owned.role]) ?? null;
}

/**
 * Which side of one own file moved since the tree was last synced
 * (PROP-008 ##PATCHSET-SIDE-EDIT-RULE).
 */
export type OwnSideKind =
	/** Both sides carry the same bytes: nothing to decide. */
	| 'same'
	/** The tree still matches the mark, patchset does not: patchset was edited. */
	| 'patchset-edited'
	/** patchset still matches the mark, the tree does not: the tree was edited. */
	| 'tree-edited'
	/** Both sides moved away from the mark, and away from each other. */
	| 'both-edited'
	/**
	 * The two sides differ and there is no map to judge by: a mark written
	 * before the map existed, or no mark at all. Callers stay conservative.
	 */
	| 'unknown';

export type OwnSideClass = {
	/** Path relative to the owned directory, POSIX. */
	readonly relative: string;
	readonly kind: OwnSideKind;
	/** The owned directory the path belongs to. */
	readonly owned: OwnedRoot;
	/** sha256 in patchset, or null when the file is not there. */
	readonly patchset: string | null;
	/** sha256 in the tree, or null when the file is not there. */
	readonly tree: string | null;
};

/**
 * Classify every own file by which side moved. `markFiles` is the map the tree
 * mark recorded at the last load; null means "the map is unknown" - migration
 * from a mark written before the map existed - and every difference then falls
 * into `unknown` rather than being guessed at.
 */
export function classifyOwn(patchesDir: string, treeDir: string, owned: OwnedRoot, markFiles: OwnFileMap | null): readonly OwnSideClass[] {
	const patchset = ownStateOfPatchSet(patchesDir, owned).files;
	const tree = ownStateOfTree(treeDir, owned).files;
	const paths = [...new Set([...Object.keys(patchset), ...Object.keys(tree)])].sort((left, right) =>
		Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
	);

	const out: OwnSideClass[] = [];
	for (const relative of paths) {
		const inPatchSet = patchset[relative] ?? null;
		const inTree = tree[relative] ?? null;
		out.push({ relative, kind: classifyOne(inPatchSet, inTree, markFiles, relative), patchset: inPatchSet, tree: inTree, owned });
	}
	return out;
}

/**
 * Every owned directory classified, each against the map the mark kept for it
 * (PROP-006 ##TREE-MARK). A directory the mark says nothing about is classified
 * with a null map, which is the conservative "unknown" answer and not a guess.
 */
export function classifyAllOwn(
	patchesDir: string,
	treeDir: string,
	roots: readonly OwnedRoot[],
	markFiles: (owned: OwnedRoot) => OwnFileMap | null
): readonly OwnSideClass[] {
	return roots.flatMap((owned) => classifyOwn(patchesDir, treeDir, owned, markFiles(owned)));
}

function classifyOne(inPatchSet: string | null, inTree: string | null, markFiles: OwnFileMap | null, relative: string): OwnSideKind {
	if (inPatchSet === inTree) {
		return 'same';
	}
	if (markFiles === null) {
		return 'unknown';
	}
	const marked = markFiles[relative] ?? null;
	const patchsetMoved = inPatchSet !== marked;
	const treeMoved = inTree !== marked;
	if (patchsetMoved && treeMoved) {
		return 'both-edited';
	}
	return patchsetMoved ? 'patchset-edited' : 'tree-edited';
}
