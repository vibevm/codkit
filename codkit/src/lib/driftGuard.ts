/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The drift guard (PROP-008 ##DRIFT-GUARD-PREDICATE).
//
// Destructive commands (`sync`, `cycle start`, `ci`, `publish`, `clone` over an
// existing tree, `restart`) refuse to run over work that was never extracted
// back into patchset. The predicate has two halves, and it needs both:
//
//   (a) `git status --porcelain` outside the own directory - edits to upstream
//       files, which git can see because those files are tracked;
//   (b) a byte comparison of the tree's own directory against `delta/own/` -
//       edits to own code, which git cannot see, because locally the own
//       directory is excluded through .git/info/exclude (##OWN-EXCLUDED-LOCALLY).
//
// Half (b) is not an optimization: without it every change to own code in the
// tree would be silently overwritten by the next sync.
//
// One refinement of the literal predicate: an own file that exists in patchset and
// not in the tree is *not* dirt. It is own code that has not been materialized
// yet - the state of every tree before its first sync - and nothing in the tree
// can be lost by writing it. Only the two classes that carry work (a file the
// tree has and patchset does not, and a file both sides have with different bytes)
// stop a destructive command.

import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { OWN_SOURCE_DIR, compareOwn, ownTargetRelativeDir } from './ownCopy.ts';
import type { OwnDivergence } from './ownCopy.ts';

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
};

/** Marker appended to own-code entries of the list. */
export const OWN_DIVERGENCE_NOTE = 'own code differs from';

export type DriftOptions = {
	/**
	 * Whether untracked paths count as dirt. They do by default: a new file in
	 * the upstream zone is unextracted work (##CK-E-NEW-FILE-IN-UPSTREAM-ZONE).
	 * `sync --fresh` sets it to false, because it was told to remove exactly
	 * those paths, by the cleanup whitelist, in the same run.
	 */
	readonly untrackedIsDirt?: boolean;
};

export function driftDirty(treeDir: string, ownDirName: string, patchesDir: string, options: DriftOptions = {}): DriftResult {
	const upstream = upstreamDirt(treeDir, ownDirName, options);
	const own = compareOwn(patchesDir, treeDir, ownDirName);
	const ownPrefix = ownTargetRelativeDir(ownDirName);

	const files: string[] = [...upstream];
	for (const divergence of own) {
		if (divergence.kind === 'patchset-only') {
			continue;
		}
		const note =
			divergence.kind === 'tree-only'
				? `own code is not in ${OWN_SOURCE_DIR}/${divergence.relative}`
				: `${OWN_DIVERGENCE_NOTE} ${OWN_SOURCE_DIR}/${divergence.relative}`;
		files.push(`${ownPrefix}/${divergence.relative} (${note})`);
	}
	return { dirty: files.length > 0, files, upstream, own };
}

/** Half (a): what git sees, minus the own directory it is not allowed to judge. */
export function upstreamDirt(treeDir: string, ownDirName: string, options: DriftOptions = {}): readonly string[] {
	const status = runGit({ args: ['status', '--porcelain'], cwd: treeDir });
	if (status.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`git status failed in ${treeDir}: ${firstLine(status.stderr)}`,
			'check that the fork tree is a healthy git work tree'
		);
	}
	const untrackedIsDirt = options.untrackedIsDirt ?? true;
	const ownPrefix = `${ownTargetRelativeDir(ownDirName)}/`;
	return porcelainEntries(status.stdout)
		.filter((entry) => untrackedIsDirt || entry.status !== '??')
		.map((entry) => entry.path)
		.filter((path) => !path.startsWith(ownPrefix));
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
