/** @scope spec://codkit/modules/codkit/PROP-008#SAVE-CONSUMES-TREE-COMMITS */
// The state a `save` selects work from (PROP-008 sec. 4, campaign decision D4).
//
// Selection used to be `git status --porcelain`, which is blind to everything a
// commit already holds: committed work was invisible ("nothing to save") or,
// with uncommitted work alongside, was buried by the internal rebuild. The
// selector here reads the tree as a diff against the last applied tip - the
// `base` of ##TREE-COMMITS-ARE-WORK - so committed and uncommitted edits are
// the same kind of fact: the tree's final state differs from what patchset
// last produced. Untracked paths are the one thing a diff cannot see and stay
// a union with `git status`, exactly as before.
//
// The same selector answers "what does commit S hold relative to base" for the
// replay of Phase 4: a commit state is read through `git cat-file`, never
// through a checkout of the tree it belongs to.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandCollapsedUntracked, porcelainZEntries } from './driftGuard.ts';
import { runGit, runGitBytes } from './gitx.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import { toPosix } from './syncEngine.ts';

/** Which state of the tree a selection or a byte read is about. */
export type TreeState = { readonly kind: 'worktree' } | { readonly kind: 'commit'; readonly sha: string };

/** One selected path: the diff letter (`A`/`D`/`M`), `??` for untracked, ` M` when forced. */
export type StateChange = { readonly status: string; readonly path: string };

/**
 * The paths in which `state` differs from `base` (D4): the worktree's final
 * state - staged, unstaged and committed together - or one commit's state.
 * The own directory is not an upstream file in any mode and is filtered out;
 * `forcedPaths` are internal addressed targets that must be regenerated even
 * when the tree already carries their bytes, appended as modified when absent.
 */
export function changesSince(
	treeDir: string,
	base: string,
	state: TreeState,
	ownRoot: string,
	forcedPaths: readonly string[] = [],
	ownedPrefixes: readonly string[] = []
): readonly StateChange[] {
	const ownPrefix = `${ownRoot}/`;
	// ##OWN-EXTENSION-UNIT: `extensions/<name>/` of a declared own extension is
	// supplied by the delta too, so it is no more an upstream file than the own
	// directory is - and without this a materialized extension would be selected
	// as a new file in the upstream zone.
	const owned = [ownPrefix, ...ownedPrefixes];
	const isOwned = (path: string): boolean => owned.some((prefix) => path.startsWith(prefix));
	const changes: StateChange[] = diffEntries(treeDir, base, state).filter((entry) => !isOwned(entry.path));
	if (state.kind === 'worktree') {
		// A diff cannot see a path no commit carries yet; `??` is the only
		// addition the porcelain union makes (S0.3).
		const status = runGit({ args: ['status', '--porcelain', '-z'], cwd: treeDir });
		if (status.status !== 0) {
			throw ckError(
				'NOT-A-REPO',
				`git status failed in ${treeDir}: ${status.stderr.trim()}`,
				'check that the fork tree is a healthy git work tree'
			);
		}
		for (const entry of expandCollapsedUntracked(treeDir, porcelainZEntries(status.stdout), ownedPrefixes)) {
			if (entry.status === '??' && !isOwned(entry.path)) {
				changes.push({ status: entry.status, path: entry.path });
			}
		}
	}
	const present = new Set(changes.map((entry) => entry.path));
	for (const path of forcedPaths) {
		if (repoRelativePathProblem(path) !== null || isOwned(path)) {
			throw ckError('CONFIG', `invalid forced save path ${JSON.stringify(path)}`);
		}
		if (!present.has(path)) {
			changes.push({ status: ' M', path });
		}
	}
	return changes.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

/**
 * The bytes of one path in `state` (D4): the working file, or the blob the
 * named commit holds. `bytesAtPin` keeps its single pin duty and is not
 * extended - the pin is a different question from the selection state.
 */
export function bytesOf(treeDir: string, state: TreeState, path: string): Uint8Array {
	if (state.kind === 'worktree') {
		return readFileSync(join(treeDir, ...path.split('/')));
	}
	const shown = runGitBytes({ args: ['cat-file', 'blob', `${state.sha}:${toPosix(path)}`], cwd: treeDir });
	if (shown.status !== 0) {
		throw ckError(
			'INTERNAL',
			`cannot read ${path} at commit ${state.sha.slice(0, 8)} in ${treeDir}`,
			're-run with --verbose and attach the output to a bug report'
		);
	}
	return shown.stdout;
}

/**
 * `git diff --name-status -z --no-renames` between `base` and `state`: records
 * are `status NUL path NUL` pairs. `--no-renames` turns a rename into the
 * deletion plus the new file it already was for the patch layer (D4) - a patch
 * never removes an upstream file, so the deletion half is refused downstream
 * exactly like a plain `git rm`.
 */
function diffEntries(treeDir: string, base: string, state: TreeState): readonly StateChange[] {
	const against = state.kind === 'worktree' ? [base] : [base, state.sha];
	const diff = runGit({ args: ['diff', '--name-status', '-z', '--no-renames', ...against], cwd: treeDir });
	if (diff.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`git diff failed in ${treeDir}: ${diff.stderr.trim()}`,
			'check that the fork tree is a healthy git work tree'
		);
	}
	const fields = diff.stdout.split('\0');
	const entries: StateChange[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const status = fields[index];
		const path = fields[index + 1];
		if (status !== undefined && path !== undefined && status !== '') {
			entries.push({ status, path });
		}
	}
	return entries;
}
