/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Filter-aware endpoint proof and D/F-safe writes for cycle movement.

import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { bytesEqual } from './bytes.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.ts';
import {
	createRebaseCheckoutContext,
	readRebaseWorktreeSemantics,
	rebaseCheckoutIndex,
	rebaseTreeEntry,
	releaseRebaseCheckoutContext,
	type RebaseWorktreeDigest,
	type RebaseWorktreeSemantics
} from './rebaseOntoPinCheckout.ts';
import { cycleRecordError, type CycleMoveRecord, type CycleMoveRecordEntry } from './cycleMaterializeMoveReceipt.ts';

const CHECKOUT_BATCH_MAX_PATHS = 128;
const CHECKOUT_BATCH_MAX_BYTES = 64 * 1024;

export type CycleConflictWrite = { readonly path: string; readonly bytes: Uint8Array };
export type CycleMoveNotify = (checkpoint: string) => void;

export function deriveCycleMoveEntries(
	prospectiveGitDir: string,
	worktree: string,
	beforeTree: string,
	afterTree: string,
	paths: readonly string[]
): CycleMoveRecord['entries'] {
	for (const path of paths) assertLexical(path);
	const checkout = createRebaseCheckoutContext(prospectiveGitDir, worktree);
	try {
		return paths.map((path) => {
			const before = rebaseTreeEntry(checkout, beforeTree, path);
			const after = rebaseTreeEntry(checkout, afterTree, path);
			return {
				path,
				before: before?.digest ?? null,
				after: after?.digest ?? null,
				beforeObject: before?.object ?? null,
				afterObject: after?.object ?? null
			};
		});
	} finally {
		releaseRebaseCheckoutContext(checkout);
	}
}

export function assertCyclePathsSafe(tree: string, entries: readonly CycleMoveRecordEntry[]): void {
	const managed = managedPaths(entries);
	for (const entry of entries) entryAbsolute(tree, entry.path, managed);
}

export function assertCycleEntryKnown(
	tree: string,
	entry: CycleMoveRecordEntry,
	conflict: CycleConflictWrite | undefined,
	entries: readonly CycleMoveRecordEntry[]
): void {
	const actual = worktreeState(tree, entry.path, readRebaseWorktreeSemantics(tree), managedPaths(entries));
	const accepted: Array<RebaseWorktreeDigest | null> = [entry.before, entry.after];
	if (conflict !== undefined && entry.after !== null) accepted.push(conflictState(conflict, entry.after));
	if (!accepted.some((candidate) => sameState(candidate, actual)))
		throw cycleRecordError(`${entry.path} is neither source, target, nor exact conflict bytes`);
}

export function materializeCycleEntries(options: {
	readonly tree: string;
	readonly prospectiveGitDir: string;
	readonly tip: string;
	readonly entries: readonly CycleMoveRecordEntry[];
	readonly conflicts: readonly CycleConflictWrite[];
	readonly notify: CycleMoveNotify;
}): readonly string[] {
	const semantics = readRebaseWorktreeSemantics(options.tree);
	const removable = managedPaths(options.entries);
	const touched = options.entries.filter((entry) => {
		const actual = worktreeState(options.tree, entry.path, semantics, removable);
		if (sameState(actual, entry.after)) return false;
		const conflict = options.conflicts.find((candidate) => candidate.path === entry.path);
		return conflict === undefined || entry.after === null || !sameState(actual, conflictState(conflict, entry.after));
	});
	const deletions = touched
		.filter((entry) => entry.after === null)
		.sort((left, right) => depth(right.path) - depth(left.path) || compareText(right.path, left.path));
	for (const entry of deletions) {
		if (worktreeState(options.tree, entry.path, semantics, removable) === null) continue;
		unlinkSync(entryAbsolute(options.tree, entry.path, new Set()));
		options.notify(`path-deleted:${entry.path}`);
	}
	for (const entry of deletions) removeEmptyParents(options.tree, dirname(entry.path));

	const present = touched.filter((entry) => entry.after !== null);
	if (present.length > 0) checkoutPresent(options, present);
	for (const entry of options.entries) {
		const conflict = options.conflicts.find((candidate) => candidate.path === entry.path);
		if (conflict !== undefined && entry.after !== null) continue;
		if (!sameState(worktreeState(options.tree, entry.path, semantics, removable), entry.after))
			throw cycleRecordError(`${entry.path}: isolated checkout did not produce the recorded target`);
	}
	return touched.map((entry) => entry.path);
}

export function writeCycleConflicts(
	tree: string,
	tip: string,
	entries: readonly CycleMoveRecordEntry[],
	conflicts: readonly CycleConflictWrite[],
	notify: CycleMoveNotify
): readonly string[] {
	const touched: string[] = [];
	for (const conflict of [...conflicts].sort((left, right) => compareText(left.path, right.path))) {
		const entry = entries.find((candidate) => candidate.path === conflict.path);
		if (entry?.after === null || entry === undefined) throw cycleRecordError(`${conflict.path}: conflict target is absent`);
		const target = entryAbsolute(tree, conflict.path, new Set());
		const targetStat = lstatSync(target);
		if (!targetStat.isFile() || targetStat.isSymbolicLink())
			throw cycleRecordError(`${conflict.path}: conflict target is not a regular file`);
		if (bytesEqual(readFileSync(target), conflict.bytes)) continue;
		const temp = conflictTemp(tree, tip, conflict, managedPaths(entries));
		if (!temp.exists) {
			writeFileSync(temp.absolute, conflict.bytes, { flag: 'wx' });
			chmodSync(temp.absolute, targetStat.mode & 0o777);
			notify(`conflict-temp-written:${conflict.path}`);
		}
		renameSync(temp.absolute, target);
		notify(`conflict-renamed:${conflict.path}`);
		touched.push(conflict.path);
	}
	return touched;
}

export function assertCycleFinalState(
	tree: string,
	entries: readonly CycleMoveRecordEntry[],
	conflicts: readonly CycleConflictWrite[]
): void {
	const semantics = readRebaseWorktreeSemantics(tree);
	const managed = managedPaths(entries);
	for (const entry of entries) {
		const conflict = conflicts.find((candidate) => candidate.path === entry.path);
		const expected = conflict !== undefined && entry.after !== null ? conflictState(conflict, entry.after) : entry.after;
		if (!sameState(worktreeState(tree, entry.path, semantics, managed), expected))
			throw cycleRecordError(`${entry.path}: final worktree proof differs from the durable target`);
	}
}

export function cycleOwnedConflictTemps(
	tree: string,
	tip: string,
	entries: readonly CycleMoveRecordEntry[],
	conflicts: readonly CycleConflictWrite[]
): ReadonlyMap<string, { readonly absolute: string; readonly bytes: Uint8Array }> {
	const found = new Map<string, { readonly absolute: string; readonly bytes: Uint8Array }>();
	for (const conflict of conflicts) {
		const temp = conflictTemp(tree, tip, conflict, managedPaths(entries));
		if (!temp.exists) continue;
		let bytes: Uint8Array;
		try {
			if (!lstatSync(temp.absolute).isFile()) throw new Error('not a regular file');
			bytes = readFileSync(temp.absolute);
		} catch (error) {
			throw dirt(`invalid transaction temp ${temp.relative}: ${messageOf(error)}`);
		}
		if (!bytesEqual(bytes, conflict.bytes)) throw dirt(`transaction temp ${temp.relative} has unexpected bytes`);
		found.set(temp.relative, { absolute: temp.absolute, bytes: conflict.bytes });
	}
	return found;
}

function checkoutPresent(
	options: {
		readonly tree: string;
		readonly prospectiveGitDir: string;
		readonly tip: string;
		readonly notify: CycleMoveNotify;
	},
	present: readonly CycleMoveRecordEntry[]
): void {
	const checkout = createRebaseCheckoutContext(options.prospectiveGitDir, options.tree);
	try {
		const isolated = rebaseCheckoutIndex(checkout, options.tip);
		let number = 0;
		for (const batch of checkoutBatches(present.map((entry) => entry.path))) {
			for (const path of batch) mkdirSync(dirname(entryAbsolute(options.tree, path, new Set())), { recursive: true });
			const result = runGit({
				args: [...isolated.args, 'checkout-index', '--force', `--prefix=${resolve(options.tree)}${sep}`, '--', ...batch],
				cwd: isolated.cwd,
				env: isolated.env,
				maxBuffer: 1024 * 1024 * 1024
			});
			if (result.status !== 0)
				throw ckError('ARTIFACT-BROKEN', `cannot restore provisional paths from the isolated index: ${result.stderr.trim()}`);
			number += 1;
			options.notify(`checkout-batch:${number}`);
		}
	} finally {
		releaseRebaseCheckoutContext(checkout);
	}
}

function checkoutBatches(paths: readonly string[]): readonly (readonly string[])[] {
	const batches: string[][] = [];
	let batch: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		const size = Buffer.byteLength(path, 'utf8') + 1;
		if (batch.length > 0 && (batch.length >= CHECKOUT_BATCH_MAX_PATHS || bytes + size > CHECKOUT_BATCH_MAX_BYTES)) {
			batches.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(path);
		bytes += size;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

function worktreeState(
	root: string,
	path: string,
	semantics: RebaseWorktreeSemantics,
	removable: ReadonlySet<string>
): RebaseWorktreeDigest | null {
	const location = entryLocation(root, path, removable);
	if (location.blocked) return null;
	try {
		const stat = lstatSync(location.absolute);
		if (stat.isSymbolicLink()) return { sha256: hash(readlinkSync(location.absolute, { encoding: 'buffer' })), mode: '120000' };
		if (stat.isDirectory()) return null;
		if (!stat.isFile()) throw cycleRecordError(`${path}: worktree entry is not a file or symbolic link`);
		return {
			sha256: hash(readFileSync(location.absolute)),
			mode: semantics.fileMode && (stat.mode & 0o111) !== 0 ? '100755' : '100644'
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return null;
		throw error;
	}
}

function entryAbsolute(root: string, path: string, removable: ReadonlySet<string>): string {
	return entryLocation(root, path, removable).absolute;
}

function entryLocation(
	root: string,
	path: string,
	removable: ReadonlySet<string>
): { readonly absolute: string; readonly blocked: boolean } {
	assertLexical(path);
	const segments = path.split('/');
	const absolute = resolve(root, ...segments);
	for (let index = 1; index < segments.length; index += 1) {
		const parent = segments.slice(0, index).join('/');
		try {
			const stat = lstatSync(resolve(root, ...segments.slice(0, index)));
			if (!stat.isDirectory()) {
				if (removable.has(parent)) return { absolute, blocked: true };
				throw cycleRecordError(`${path}: non-directory parent ${parent} is outside the managed D/F transition`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { absolute, blocked: false };
			throw error;
		}
		const checked = resolveContainedPath(root, parent);
		if (!checked.ok) throw cycleRecordError(`${path}: unsafe parent ${parent}: ${checked.reason}`);
	}
	return { absolute, blocked: false };
}

function conflictTemp(
	root: string,
	tip: string,
	conflict: CycleConflictWrite,
	removable: ReadonlySet<string>
): { readonly relative: string; readonly absolute: string; readonly exists: boolean } {
	const parent = dirname(conflict.path);
	const name = `.codkit-cycle-${hash(Buffer.from(`${tip}\0${conflict.path}`, 'utf8')).slice(0, 24)}.tmp`;
	const relative = parent === '.' ? name : `${parent}/${name}`;
	const location = entryLocation(root, relative, removable);
	const absolute = location.absolute;
	if (location.blocked) return { relative, absolute, exists: false };
	let exists = true;
	try {
		lstatSync(absolute);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') exists = false;
		else throw dirt(`cannot inspect transaction temp ${relative}: ${messageOf(error)}`);
	}
	return { relative, absolute, exists };
}

function removeEmptyParents(root: string, parent: string): void {
	let current = parent;
	while (current !== '.') {
		const checked = resolveContainedPath(root, current);
		if (!checked.ok) return;
		try {
			rmdirSync(checked.absolute);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				current = dirname(current);
				continue;
			}
			if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
			throw error;
		}
		current = dirname(current);
	}
}

function managedPaths(entries: readonly CycleMoveRecordEntry[]): ReadonlySet<string> {
	return new Set(entries.map((entry) => entry.path));
}

function conflictState(conflict: CycleConflictWrite, target: RebaseWorktreeDigest): RebaseWorktreeDigest {
	return { sha256: hash(conflict.bytes), mode: target.mode };
}

function sameState(left: RebaseWorktreeDigest | null, right: RebaseWorktreeDigest | null): boolean {
	return left === null ? right === null : right !== null && left.sha256 === right.sha256 && left.mode === right.mode;
}

function assertLexical(path: string): void {
	const problem = repoRelativePathProblem(path);
	if (problem !== null) throw cycleRecordError(`${path}: unsafe path: ${problem}`);
}

function compareText(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

function depth(path: string): number {
	return path.split('/').length;
}

function hash(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function dirt(detail: string): Error {
	return ckError('DIRTY-TREE', `cycle materialization found ${detail}`, 'save or restore this work before continuing');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
