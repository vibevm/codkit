/** @scope spec://codkit/modules/codkit/PROP-018#COMPONENT-RELEASE-ARTIFACTS */
// Observe actual output bytes; directory hashes also bind layout and modes.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { decodeUtf8Strict } from './bytes.ts';
import { hashContainedFile } from './containedFile.ts';
import { componentReleaseBodySchema } from './componentRelease.ts';
import type { ComponentRelease, ComponentReleaseResult } from './componentRelease.ts';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.ts';

type Artifact = ComponentRelease['artifacts'][number];
type Row = {
	readonly path: string;
	readonly kind: 'file' | 'directory' | 'symlink';
	readonly mode: number;
	readonly sha256?: string;
	readonly bytes?: number;
};
export type ReleaseArtifactEntry = Row;
type Probe = { readonly absolute: string; readonly parent: string; readonly parentShape: Stats; readonly shape: Stats };

/** The same contained tree walk used for artifact receipts, with paths relative to root. */
export function captureReleaseEntries(root: string, outputs: readonly string[]): ComponentReleaseResult<readonly ReleaseArtifactEntry[]> {
	try {
		const physical = realpathSync(root);
		const shape = lstatSync(physical);
		const entries = new Map<string, Row>();
		for (const output of [...new Set(outputs)].sort(compare)) {
			const path = output.endsWith('/') ? output.slice(0, -1) : output;
			const rows: Row[] = [];
			walk(physical, path, path, rows);
			for (const row of rows) {
				const existing = entries.get(row.path);
				if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(row))
					throw new Error('overlapping artifact entries changed during capture');
				entries.set(row.path, row);
			}
		}
		if (!same(shape, lstatSync(physical))) throw new Error('artifact root identity changed during entry capture');
		return { ok: true, value: [...entries.values()].sort((left, right) => compare(left.path, right.path)) };
	} catch (error) {
		return { ok: false, problem: { kind: 'storage', message: error instanceof Error ? error.message : 'artifact entry capture failed' } };
	}
}

/**
 * Paths come from declared outputs after the packager finished, under its tree lock.
 * Links are hashed as link text, never followed; an escaping target refuses.
 */
export function captureReleaseArtifacts(root: string, outputs: readonly string[]): ComponentReleaseResult<readonly Artifact[]> {
	try {
		const physicalRoot = realpathSync(root);
		const rootShape = lstatSync(physicalRoot);
		if (!rootShape.isDirectory() || rootShape.isSymbolicLink()) throw new Error('release artifact root is not a real directory');
		const paths = [...new Set(outputs.map((path) => (path.endsWith('/') ? path.slice(0, -1) : path)))].sort(compare);
		const result: Artifact[] = [];
		for (const path of paths) {
			if (repoRelativePathProblem(path) !== null) throw new Error('release artifact path is not contained');
			const initial = probe(physicalRoot, path);
			if (initial.shape.isDirectory() && !initial.shape.isSymbolicLink()) {
				const rows: Row[] = [];
				walk(physicalRoot, path, '', rows);
				rows.sort((left, right) => compare(left.path, right.path));
				const stream = JSON.stringify({ codkitArtifactTree: 1, entries: rows });
				result.push(
					componentReleaseBodySchema.shape.artifacts.element.parse({
						kind: 'directory',
						path,
						sha256: hash(stream),
						bytes: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)
					})
				);
			} else {
				const row = leaf(physicalRoot, path, initial, '');
				result.push(
					componentReleaseBodySchema.shape.artifacts.element.parse({ kind: row.kind, path, sha256: row.sha256, bytes: row.bytes })
				);
			}
		}
		if (!same(rootShape, lstatSync(physicalRoot))) throw new Error('release artifact root identity changed during capture');
		return { ok: true, value: result };
	} catch (error) {
		return { ok: false, problem: { kind: 'storage', message: error instanceof Error ? error.message : 'release artifact capture failed' } };
	}
}

function walk(root: string, path: string, shown: string, rows: Row[]): void {
	const current = probe(root, path);
	if (!current.shape.isDirectory() || current.shape.isSymbolicLink()) {
		rows.push(leaf(root, path, current, shown));
		return;
	}
	rows.push({ path: shown, kind: 'directory', mode: current.shape.mode & 0o7777 });
	const names = readdirSync(current.absolute).sort(compare);
	confirm(root, path, current);
	for (const name of names) walk(root, `${path}/${name}`, shown === '' ? name : `${shown}/${name}`, rows);
	confirm(root, path, current);
}

function leaf(root: string, path: string, current: Probe, shown: string): Row {
	if (current.shape.isSymbolicLink()) {
		const targetBytes = readlinkSync(current.absolute, { encoding: 'buffer' });
		if (decodeUtf8Strict(targetBytes) === null) throw new Error('release link target is not valid UTF-8');
		const target = targetBytes.toString('utf8');
		const targetPath = resolve(dirname(current.absolute), target);
		const fromRoot = relative(root, targetPath);
		if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot))
			throw new Error('release artifact link target escapes the output tree');
		confirm(root, path, current);
		return { path: shown, kind: 'symlink', mode: current.shape.mode & 0o7777, sha256: hash(targetBytes), bytes: targetBytes.byteLength };
	}
	if (!current.shape.isFile()) throw new Error('release artifacts must contain only directories, regular files and contained links');
	const read = hashContainedFile(root, path, { what: 'release artifact' });
	if (read.state === 'absent') throw new Error('release artifact disappeared during capture');
	confirm(root, path, current);
	return { path: shown, kind: 'file', mode: current.shape.mode & 0o7777, sha256: read.sha256, bytes: read.bytes };
}

function probe(root: string, path: string): Probe {
	if (repoRelativePathProblem(path) !== null) throw new Error('release artifact path is not contained');
	const segments = path.split('/');
	const parentPath = segments.slice(0, -1).join('/');
	const checked = parentPath === '' ? { ok: true, absolute: root } : resolveContainedPath(root, parentPath);
	if (!checked.ok) throw new Error('release artifact parent is not a contained real directory');
	const parent = checked.absolute;
	const parentShape = lstatSync(parent);
	if (!parentShape.isDirectory() || parentShape.isSymbolicLink()) throw new Error('release artifact parent is not a real directory');
	const absolute = join(parent, segments[segments.length - 1] ?? '');
	return { absolute, parent, parentShape, shape: lstatSync(absolute) };
}

function confirm(root: string, path: string, before: Probe): void {
	const after = probe(root, path);
	if (
		!same(before.parentShape, after.parentShape) ||
		!same(before.shape, after.shape) ||
		before.shape.mtimeMs !== after.shape.mtimeMs ||
		before.shape.ctimeMs !== after.shape.ctimeMs
	)
		throw new Error('release artifact identity or metadata changed during capture');
}
function same(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function compare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}
function hash(bytes: string | Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}
