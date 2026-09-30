/** @scope spec://codkit/modules/codkit/PROP-007#PUBLISH-EXPORT-LFS */
// git-lfs in an export (PROP-007 ##PUBLISH-EXPORT-LFS): an export that keeps
// the git-lfs content carries the objects the tip's pointers name - of the
// tip's tree, not of the history - copied from the lfs storage of the fork
// tree into its own and checked against the pointers. Every object is found
// and checked in the fork tree before the export exists; codkit never fetches
// one.

import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitOk, runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { lfsContentOf } from './publishLfs.ts';
import type { LfsPointer } from './publishLfs.ts';
import { LFS_FILTER_CONFIG } from './publishWorkspace.ts';

/** One object of the tip: what its pointer names, the paths that name it, where the fork tree keeps it. */
export type ExportLfsObject = LfsPointer & { readonly paths: readonly string[]; readonly source: string };

const READ_CHUNK = 1024 * 1024;

/**
 * The git-lfs objects of the tip, each found in the lfs storage of the fork
 * tree and checked against its pointer; a missing or mismatched object, or a
 * pointer that names none, is exit 2 `CK-E-LFS` naming every path and id.
 */
export function tipLfsObjects(options: {
	readonly forkDir: string;
	readonly scratchDir: string;
	readonly tip: string;
	readonly forkTree: string;
	readonly pinSha: string;
}): readonly ExportLfsObject[] {
	const tree = gitOk(
		{ args: ['rev-parse', '--verify', `${options.tip}^{tree}`], cwd: options.forkDir },
		{ code: 'CONFIG', message: `cannot read the tree of ${options.tip}` }
	).stdout.trim();
	const content = lfsContentOf({ treeDir: options.forkDir, scratchDir: options.scratchDir, tree });
	if (content.length === 0) return [];
	const storage = join(
		gitOk(
			{ args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: options.forkTree },
			{ code: 'LFS', message: `cannot locate the git-lfs storage of the fork tree ${options.forkTree}` }
		).stdout.trim(),
		'lfs'
	);
	const objects = new Map<string, { pointer: LfsPointer; paths: string[] }>();
	const problems: string[] = [];
	for (const entry of content) {
		if (entry.pointer === null) {
			problems.push(`${entry.path}: its pointer names no sha256 object`);
			continue;
		}
		const known = objects.get(entry.pointer.oid);
		if (known === undefined) objects.set(entry.pointer.oid, { pointer: entry.pointer, paths: [entry.path] });
		else known.paths.push(entry.path);
	}
	const found: ExportLfsObject[] = [];
	for (const { pointer, paths } of objects.values()) {
		const source = objectPath(storage, pointer.oid);
		const problem = mismatch(source, pointer);
		if (problem === null) found.push({ ...pointer, paths, source });
		else if (problem === 'missing')
			problems.push(`${paths.join(', ')}: sha256 ${pointer.oid} is not in the git-lfs storage of the fork tree`);
		else
			problems.push(
				`${paths.join(', ')}: sha256 ${pointer.oid} in the git-lfs storage of the fork tree does not match its pointer: it ${problem}`
			);
	}
	if (problems.length > 0) {
		throw ckError(
			'LFS',
			`the fork tree does not have every git-lfs object the published tip needs (${problems.length}): ${problems.join('; ')}`,
			`fetch them into the fork tree, for example: git -C ${options.forkTree} lfs fetch origin ${options.pinSha}; codkit does not reach the network for them, and nothing was created`
		);
	}
	return found;
}

/** Every object into the lfs storage of the export, each copy checked against its pointer. */
export function copyLfsObjects(objects: readonly ExportLfsObject[], gitDir: string): string {
	const storage = join(gitDir, 'lfs');
	for (const object of objects) {
		const target = objectPath(storage, object.oid);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(object.source, target);
		const problem = mismatch(target, object);
		if (problem !== null)
			throw ckError('LFS', `the copy of the git-lfs object ${object.oid} in ${storage} does not match its pointer: it ${problem}`);
	}
	return join(storage, 'objects');
}

/**
 * The lfs filters in the export's own configuration, so that its checkout
 * smudges from its own storage; false - and nothing written - where git-lfs is
 * not installed.
 */
export function configureLfsFilters(repository: string): boolean {
	if (runGit({ args: ['lfs', 'version'], cwd: repository }).status !== 0) return false;
	for (const [key, value] of LFS_FILTER_CONFIG) {
		gitOk(
			{ args: ['config', key, value], cwd: repository },
			{ code: 'CONFIG', message: `cannot configure git-lfs in the export ${repository}` }
		);
	}
	return true;
}

function objectPath(storage: string, oid: string): string {
	return join(storage, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

/** Why a file is not the object a pointer names - `missing`, or what differs - or null when it is. */
function mismatch(path: string, pointer: LfsPointer): string | null {
	let size: number;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return 'missing';
		size = stats.size;
	} catch {
		return 'missing';
	}
	if (size !== pointer.size) return `has ${size} bytes where the pointer names ${pointer.size}`;
	const digest = sha256Of(path);
	return digest === pointer.oid ? null : `has the sha256 ${digest}`;
}

function sha256Of(path: string): string {
	const hash = createHash('sha256');
	const buffer = Buffer.alloc(READ_CHUNK);
	const handle = openSync(path, 'r');
	try {
		for (let read = readSync(handle, buffer, 0, READ_CHUNK, null); read > 0; read = readSync(handle, buffer, 0, READ_CHUNK, null)) {
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(handle);
	}
	return hash.digest('hex');
}
