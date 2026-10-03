/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The drift guard (PROP-008 ##DRIFT-GUARD-PREDICATE).
//
// Destructive commands (`load`, `cycle start`, `ci`, `publish`, `clone` over an
// existing tree, `restart`) refuse to run over work that was never extracted
// back into patchset. The predicate has three halves, and it needs all of them:
//
//   (a) `git status --porcelain` outside the own directory - edits to upstream
//       files, which git can see because those files are tracked;
//   (b) a byte comparison of the tree's owned directories against their delta
//       directories -
//       edits to own code, which git cannot see, because locally the own
//       directory is excluded (##OWN-EXCLUDED-LOCALLY: the managed block of
//       info/exclude in a single-worktree repository, the worktree-local
//       exclude file in a multi-worktree one);
//   (c) the foreign commits of ##TREE-COMMITS-ARE-WORK - commits of the tree's
//       first-parent line above the last generated tip, which both other halves
//       are blind to: git status reports a clean tree over a commit, and own
//       code says nothing about upstream files.
//
// Half (b) is not an optimization: without it every change to own code in the
// tree would be silently overwritten by the next load. Neither is half (c):
// without it the next load would rebuild the branch over a commit and leave the
// work reachable only through the reflog.
//
// One refinement of the literal predicate: an own file that exists in patchset and
// not in the tree is *not* dirt. It is own code that has not been materialized
// yet - the state of every tree before its first load - and nothing in the tree
// can be lost by writing it. Only the two classes that carry work (a file the
// tree has and patchset does not, and a file both sides have with different bytes)
// stop a destructive command.
//
// A second refinement (##OVERLAY-KNOWN-MATERIALIZATION): a *tracked* path the
// caller can certify as a state codkit itself wrote - today the strict overlay
// composition of `overlay apply` - is not unextracted work either, provided the
// calling run is the one that replaces it. The guard itself stays generic: it
// accepts a predicate and asks it about tracked paths only, so the classification
// lives with the layer that can actually prove it. `load --fresh` is the only
// caller (an ordinary `load` may answer the fast path "up to date" and leave the
// bytes in place, which is exactly what a silent exemption must not do); `ci`
// deliberately passes none (see the sync engine).
//
// A third refinement, the other way round (##OWN-EXTENSION-STRANDED): an
// *untracked* top-level directory of the materialization root that no manifest record
// declares and the pin does not ship is the materialization of an own extension
// somebody withdrew. A plain `load` neither writes into it nor removes it, so
// refusing over it guarded nothing and locked the daily command after a legal
// change of the patch set; `status` names the directory instead, with the
// `--fresh` pass that removes it. Again a predicate, again supplied by exactly
// one caller: every other guarded command keeps the rule about a new file in
// the upstream zone.

import { runGit } from './gitx.ts';
import { workspaceForkReceipt } from './workspaceReceipt.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { compareOwnExtensions, extensionsTreeDir, ownExtensionTreePrefixes } from './layers/ownExtensions.ts';
import type { Materializer } from './layers/ownExtensions.ts';
import type { OwnExtensionDivergence } from './layers/ownExtensions.ts';
import { loadOwnManifest } from './layers/ownManifest.ts';
import type { OwnExtension } from './layers/ownManifest.ts';
import { ckError } from './messages.ts';
import { compareAllOwn } from './ownCopy.ts';
import type { OwnDivergence } from './ownCopy.ts';
import { ownedTreePrefixes } from './ownedRoots.ts';
import type { OwnedRoot } from './ownedRoots.ts';
import { foreignCommits } from './treeCommits.ts';
import type { TreeCommit, TreeCommits } from './treeCommits.ts';

export type DriftResult = {
	readonly dirty: boolean;
	/**
	 * Paths to show the user. Upstream paths are plain; own-code divergences
	 * carry a note, because the two halves are fixed by different means.
	 */
	readonly files: readonly string[];
	/** Half (a) on its own. */
	readonly upstream: readonly string[];
	/** Half (b) on its own, classified; includes the harmless class. */
	readonly own: readonly OwnDivergence[];
	/**
	 * Half (b) for the own-extension layer (modules/vscode/PROP-002 ##OWN-EXTENSION-UNIT):
	 * an own-extension directory is materialized from the delta exactly like own code,
	 * so git says nothing about it either and only a byte comparison can.
	 */
	readonly extensions: readonly OwnExtensionDivergence[];
	/** Half (c) on its own: commits that are not in patchset yet. */
	readonly commits: readonly TreeCommit[];
	/** The full D2 state behind half (c); `treeHeadError` reads it (decision D8). */
	readonly treeCommits: TreeCommits;
};

/** Marker appended to own-code entries of the list. */
export const OWN_DIVERGENCE_NOTE = 'own code differs from';

export type DriftBaseOptions = {
	/** Exact untracked paths certified by the composition root's held capabilities. */
	readonly ownedUntrackedFiles?: readonly string[];
	readonly workspace?: WorkspaceRecord | undefined;
	/**
	 * The directory the own-extension materializations of this type sit in, from
	 * the tree root; empty when the type has no such layer. It is needed only to
	 * open a collapsed untracked listing, and it comes from the type
	 * (##TYPE-AREA-LAYERS).
	 */
	readonly materializationRoot?: string;
	/**
	 * Whether untracked paths count as dirt. They do by default: a new file in
	 * the upstream zone is unextracted work (##CK-E-NEW-FILE-IN-UPSTREAM-ZONE).
	 * `load --fresh` sets it to false, because it was told to remove exactly
	 * those paths, by the cleanup whitelist, in the same run.
	 */
	readonly untrackedIsDirt?: boolean;
	/**
	 * ##OVERLAY-KNOWN-MATERIALIZATION: a tracked path this predicate accepts is
	 * a state codkit itself wrote and the calling run is about to replace, so it
	 * is not unextracted work. Asked only about paths git reports as tracked and
	 * changed - never about untracked litter, which stays the business of
	 * `untrackedIsDirt` - and only about paths outside the own directory. A
	 * false answer leaves the path dirt, so an exemption can narrow the guard
	 * but never disable it; a throwing predicate is the caller's problem, and
	 * the one caller catches everything into a false answer.
	 */
	readonly isKnownMaterialization?: (path: string) => boolean;
	/**
	 * ##CMD-LOAD-DISCARD-WORKTREE: a tracked path the operator named as a loss in
	 * advance, so this run may throw the edit away instead of refusing over it.
	 * `load --fresh --discard` is the only caller, and the answer is not a
	 * verdict about the bytes but a decision about them - which is why it is a
	 * second hook rather than a second meaning of the one above: a known
	 * materialization is a state codkit wrote, this is a state somebody is
	 * giving up.
	 *
	 * Asked on the same terms: tracked, changed entries outside the own
	 * directory and outside the prefixes another layer supplies. A false answer
	 * leaves the path dirt, so the flag can only ever narrow the guard.
	 */
	readonly isDiscardable?: (entry: PorcelainEntry) => boolean;
	/**
	 * ##DRIFT-GUARD-PREDICATE, the stranded exception (PROP-005
	 * ##OWN-EXTENSION-STRANDED): an untracked top-level directory under
	 * the materialization root that no manifest record declares and the pin does not ship
	 * is not unextracted work for the one command that neither writes into it
	 * nor removes it - a plain `load`. Withdrawing a record is a legal change of
	 * the patch set, and the directory it leaves behind used to lock the daily
	 * command until a `--fresh` pass; `status` is what names the directory now.
	 *
	 * The mirror image of the two hooks above: asked about *untracked* entries
	 * only, and only about those outside the own directory and the prefixes
	 * another layer supplies. A false answer leaves the path dirt, so this can
	 * only ever narrow the guard, and a caller that passes nothing gets the
	 * predicate exactly as it was. `load --fresh`, `ci`, `publish`, `cycle` and
	 * the two-way `sync` pass nothing.
	 *
	 * Passing it also opens up a wholly untracked materialization root, which git
	 * reports as one entry that hides the directory names inside it.
	 */
	readonly isStrandedExtension?: (entry: PorcelainEntry) => boolean;
	/**
	 * Tree prefixes (with a trailing slash) that another layer supplies and git
	 * therefore may not judge - today the materialized own extensions
	 * (modules/vscode/PROP-002 ##OWN-EXTENSION-UNIT). They are filtered out for the same reason
	 * the own directory is: their bytes come from the delta.
	 */
	readonly ownedPrefixes?: readonly string[];
};

export type DriftOptions = DriftBaseOptions & {
	/**
	 * Half (c): the pin and the generated branch the tree's commits are walked
	 * against. Deliberately required - a caller that cannot name them has no
	 * business running a two-halves guard and staying silent about commits.
	 */
	readonly generated: { readonly pinSha: string; readonly branch: string };
};

export function driftDirty(
	materializer: Materializer | null,
	treeDir: string,
	roots: readonly OwnedRoot[],
	patchesDir: string,
	options: DriftOptions
): DriftResult {
	const declared = materializer === null ? [] : declaredExtensions(patchesDir);
	const prefixes = materializer === null ? [] : ownExtensionTreePrefixes(materializer, declared);
	const upstream = upstreamDirt(treeDir, roots, {
		materializationRoot: materializer === null ? '' : extensionsTreeDir(materializer),
		...options,
		ownedPrefixes: prefixes
	});
	const own = compareAllOwn(patchesDir, treeDir, roots);
	const extensions = materializer === null ? [] : compareOwnExtensions(materializer, patchesDir, treeDir, declared);
	const treeCommits = foreignCommits(treeDir, options.generated.pinSha, options.generated.branch);

	const files: string[] = [...upstream];
	for (const divergence of own) {
		if (divergence.kind === 'patchset-only') {
			continue;
		}
		const artifact = `${divergence.owned.deltaDir}/${divergence.relative}`;
		const note = divergence.kind === 'tree-only' ? `own code is not in ${artifact}` : `${OWN_DIVERGENCE_NOTE} ${artifact}`;
		files.push(`${divergence.owned.path}/${divergence.relative} (${note})`);
	}
	for (const divergence of extensions) {
		if (divergence.kind === 'patchset-only') {
			continue;
		}
		const note =
			divergence.kind === 'tree-only'
				? `own extension file is not in ${materializer?.deltaRoot ?? ''}/${divergence.relative}`
				: `${OWN_DIVERGENCE_NOTE} ${materializer?.deltaRoot ?? ''}/${divergence.relative}`;
		files.push(`${materializer === null ? '' : extensionsTreeDir(materializer)}/${divergence.relative} (${note})`);
	}
	for (const commit of treeCommits.commits) {
		files.push(`commit ${commit.sha.slice(0, 8)} "${commit.subject}" (not in patchset)`);
	}
	return { dirty: files.length > 0, files, upstream, own, extensions, commits: treeCommits.commits, treeCommits };
}

/**
 * The extensions the delta declares, or none when the manifest cannot be read.
 *
 * A manifest that does not parse is a failure of its own - `verify` names it,
 * and every writing command stops on it before it touches the tree - and the
 * guard has no verdict to add. What it must not do is throw here: the guard is
 * the step that decides whether work is at risk, and it has to reach that
 * decision even over a repository somebody left half-edited.
 */
function declaredExtensions(patchesDir: string): readonly OwnExtension[] {
	try {
		return loadOwnManifest(patchesDir).extensions;
	} catch {
		return [];
	}
}

/**
 * Half (a): what git sees, minus the owned directories it is not allowed to
 * judge, minus the tracked paths the caller certified as its own known
 * materialization, minus the tracked paths the caller was told by name to throw
 * away.
 */
export function upstreamDirt(treeDir: string, roots: readonly OwnedRoot[], options: DriftBaseOptions = {}): readonly string[] {
	const receipts = workspaceForkReceipt(treeDir, options.workspace);
	const ownedFiles = [...receipts, ...(options.ownedUntrackedFiles ?? [])];
	const status = runGit({ args: ['status', '--porcelain', ...(ownedFiles.length === 0 ? [] : ['--untracked-files=all'])], cwd: treeDir });
	if (status.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`git status failed in ${treeDir}: ${firstLine(status.stderr)}`,
			'check that the fork tree is a healthy git work tree'
		);
	}
	const untrackedIsDirt = options.untrackedIsDirt ?? true;
	const classify = options.isKnownMaterialization;
	const discardable = options.isDiscardable;
	const stranded = options.isStrandedExtension;
	const owned = [...ownedTreePrefixes(roots), ...(options.ownedPrefixes ?? [])];
	// The stranded question is asked per top-level directory of the
	// materialization root, and a wholly untracked one is a collapsed entry that hides
	// exactly those names - so the caller that can answer them gets the listing
	// opened up, the way a declared extension opens up its own prefix.
	const root = options.materializationRoot ?? '';
	const opened = [...(options.ownedPrefixes ?? []), ...(stranded === undefined || root === '' ? [] : [`${root}/`])];
	return (
		expandCollapsedUntracked(treeDir, porcelainEntries(status.stdout), opened)
			.filter((entry) => entry.status !== '??' || !ownedFiles.includes(entry.path))
			.filter((entry) => untrackedIsDirt || entry.status !== '??')
			// The known-state question is about tracked bytes only: an untracked
			// path carries no HEAD to differ from (and with `--fresh` it is the
			// whitelist, not an overlay, that speaks for it).
			.filter((entry) => classify === undefined || entry.status === '??' || !classify(entry.path))
			.filter((entry) => !owned.some((prefix) => entry.path.startsWith(prefix)))
			// The stranded question, over what the prefixes above left: a
			// declared extension is never asked about, and only an untracked
			// entry can be a materialization nobody owns any more.
			.filter((entry) => stranded === undefined || entry.status !== '??' || !stranded(entry))
			// The discard question comes last, and over what is left: a path the
			// own layer supplies is never the operator's to give up here, and an
			// untracked one has no tip version to be returned to.
			.filter((entry) => discardable === undefined || entry.status === '??' || !discardable(entry))
			.map((entry) => entry.path)
	);
}

/**
 * Untracked paths git collapsed to a directory, opened up where they hide a
 * path another layer owns.
 *
 * `git status --porcelain` reports one line for a wholly untracked directory -
 * the materialization root rather than each file inside it - and a prefix
 * filter cannot see through that: the materialized own extension would read as
 * unextracted work in the upstream zone (modules/vscode/PROP-002 ##OWN-EXTENSION-UNIT). Only
 * an entry that is an ancestor of an owned prefix is re-listed, so a tree with
 * no own extensions gets exactly the listing it got before, and litter beside
 * the owned path keeps its own name and stays dirt.
 */
export function expandCollapsedUntracked(
	treeDir: string,
	entries: readonly PorcelainEntry[],
	ownedPrefixes: readonly string[]
): readonly PorcelainEntry[] {
	if (ownedPrefixes.length === 0) {
		return entries;
	}
	const out: PorcelainEntry[] = [];
	for (const entry of entries) {
		if (entry.status !== '??' || !entry.path.endsWith('/') || !ownedPrefixes.some((prefix) => prefix.startsWith(entry.path))) {
			out.push(entry);
			continue;
		}
		const listed = runGit({ args: ['status', '--porcelain', '-z', '-uall', '--', entry.path], cwd: treeDir });
		if (listed.status !== 0) {
			out.push(entry);
			continue;
		}
		out.push(...porcelainZEntries(listed.stdout));
	}
	return out;
}

export type PorcelainEntry = {
	/** The two status characters, e.g. ` M`, `??`, `A `. */
	readonly status: string;
	readonly path: string;
};

/**
 * `git status --porcelain` v1. For a rename the new path is the one that
 * matters; `core.quotepath=false` (forced by gitx) keeps non-ASCII names
 * unquoted.
 */
export function porcelainEntries(stdout: string): readonly PorcelainEntry[] {
	const entries: PorcelainEntry[] = [];
	for (const line of stdout.split('\n')) {
		if (line.length < 4) {
			continue;
		}
		const rest = line.slice(3);
		const arrow = rest.indexOf(' -> ');
		entries.push({ status: line.slice(0, 2), path: unquote(arrow === -1 ? rest : rest.slice(arrow + 4)) });
	}
	return entries;
}

export function porcelainPaths(stdout: string): readonly string[] {
	return porcelainEntries(stdout).map((entry) => entry.path);
}

/**
 * `git status --porcelain -z`: records are NUL-terminated and never quoted, so
 * a path with a space, a quote or a newline in it survives the round trip. A
 * rename or copy is two records - the new path first, the old one right after -
 * and only the new path is a subject for `save`.
 *
 * This is the form the writing commands use; the plain parser above stays for
 * the guard, which only ever looks at names.
 */
export function porcelainZEntries(stdout: string): readonly PorcelainEntry[] {
	const fields = stdout.split('\0');
	const entries: PorcelainEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index];
		if (record === undefined || record.length < 4) {
			continue;
		}
		const status = record.slice(0, 2);
		entries.push({ status, path: record.slice(3) });
		if (status.startsWith('R') || status.startsWith('C')) {
			// The source path of the rename follows in its own field.
			index += 1;
		}
	}
	return entries;
}

function unquote(path: string): string {
	return path.length >= 2 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function firstLine(text: string): string {
	const trimmed = text.trim();
	if (trimmed === '') {
		return 'no output';
	}
	const [line] = trimmed.split('\n');
	return line ?? 'no output';
}
