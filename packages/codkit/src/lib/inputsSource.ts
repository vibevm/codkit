/** @scope spec://codkit/modules/codkit/PROP-007#INPUTS-SOURCE */
// Where an input comes from (PROP-007 ##INPUTS-SOURCE): the working tree of its
// repository, uncommitted edits included, or the pinned commit; the content
// stamp that says whether the last build of the same content can be reused; and
// the disposable copy the build runs in. The repository is read and never
// written: the copy is made out of it, and nothing is made in it.

import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InputConfig } from './configFile.ts';
import { runGit } from './gitx.ts';
import type { GitEnv } from './gitx.ts';
import type { Output } from './jsonOut.ts';
import { ckError } from './messages.ts';

export type InputMode = 'working' | 'pinned';

/** What one input is made from in this run, known before any byte is copied. */
export type InputSource = {
	readonly mode: InputMode;
	/** The top of the repository's working tree; its git directory when it has none. */
	readonly root: string;
	/** The absolute git directory of the repository. */
	readonly gitDir: string;
	/** Whether the repository has a working tree the dependency roots are carried from. */
	readonly hasWorkingTree: boolean;
	/** The pinned commit; null for the working tree. */
	readonly commit: string | null;
	/** The files of the working tree the copy takes, relative to `root`; empty for a commit. */
	readonly files: readonly string[];
	/** The declaration and the content of the source, as one digest. */
	readonly stamp: string;
};

const STAMP_VERSION = '1';
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The source of one input: the repository is checked and read, the stamp is
 * computed, and nothing is copied yet. A refusal names the input and what to do.
 */
export function inspectSource(input: InputConfig, mode: InputMode): InputSource {
	if (!existsSync(input.repository)) {
		throw ckError(
			'CONFIG',
			`input ${input.name}: the repository ${input.repository} does not exist`,
			'clone it there, name its location on this machine in codkit.local.json, or run codkit load --no-inputs'
		);
	}
	const gitDir = gitLine(input, input.repository, ['rev-parse', '--absolute-git-dir'], 'is not a git repository');
	const inside = runGit({ args: ['rev-parse', '--is-inside-work-tree'], cwd: input.repository });
	const hasWorkingTree = inside.status === 0 && inside.stdout.trim() === 'true';
	const root = hasWorkingTree ? gitLine(input, input.repository, ['rev-parse', '--show-toplevel'], 'has no readable working tree') : gitDir;
	if (hasWorkingTree && realpathSync.native(root) !== realpathSync.native(input.repository)) {
		throw ckError(
			'CONFIG',
			`input ${input.name}: ${input.repository} is inside the repository ${root}, not its top`,
			'name the top of the repository in inputs.repository'
		);
	}
	const declaration = declarationDigest(input);
	if (mode === 'pinned') {
		const commit = runGit({ args: ['rev-parse', '--verify', '--quiet', `${input.ref}^{commit}`], cwd: root });
		if (commit.status !== 0 || commit.stdout.trim() !== input.ref) {
			throw ckError(
				'CONFIG',
				`input ${input.name}: ${input.ref} is not a commit of ${input.repository}`,
				`fetch the commit into that repository, or pin the input to one it has: codkit inputs pin ${input.name}`
			);
		}
		const tree = gitLine(input, root, ['rev-parse', `${input.ref}^{tree}`], 'cannot read the tree of its pinned commit');
		return { mode, root, gitDir, hasWorkingTree, commit: input.ref, files: [], stamp: stampOf([declaration, 'pinned', input.ref, tree]) };
	}
	if (!hasWorkingTree) {
		throw ckError(
			'CONFIG',
			`input ${input.name}: ${input.repository} has no working tree to take the input from`,
			'name a repository with a working tree, or run codkit load --inputs pinned'
		);
	}
	const files = workingFiles(input, root);
	const blobs = hashFiles(input, root, files);
	const content = files.map((path, index) => `${path}\0${blobs[index] ?? ''}`).join('\n');
	return { mode, root, gitDir, hasWorkingTree, commit: null, files, stamp: stampOf([declaration, 'working', content]) };
}

/**
 * What the build of an input depends on besides its source: the commands, the
 * roots carried in, the variables and the directory taken. The location is not
 * part of it - it is this machine's - and neither is `to`, which says where the
 * output lands, not what it is.
 */
function declarationDigest(input: InputConfig): string {
	const env = Object.entries(input.env).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return JSON.stringify({ build: input.build, dependencyRoots: input.dependencyRoots, env, from: input.from });
}

function stampOf(parts: readonly string[]): string {
	return createHash('sha256')
		.update(`codkit-input-stamp\0${STAMP_VERSION}\0${parts.join('\0')}`, 'utf8')
		.digest('hex');
}

/**
 * The files of the working tree that the copy takes: every tracked file that is
 * there and every untracked file that is not ignored, in byte order. Each must
 * be a regular file: a link would make the copy depend on something outside
 * the repository, and a directory in this list is a nested repository.
 */
function workingFiles(input: InputConfig, root: string): readonly string[] {
	const listed = new Set(gitList(input, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
	for (const deleted of gitList(input, root, ['ls-files', '-z', '--deleted'])) listed.delete(deleted);
	const files = [...listed].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
	for (const path of files) {
		if (CONTROL.test(path) || path.includes('\\')) {
			throw ckError('CONFIG', `input ${input.name}: the working tree carries a file name the copy cannot take: ${JSON.stringify(path)}`);
		}
		const stat = lstatSync(join(root, ...path.split('/')), { throwIfNoEntry: false });
		if (stat === undefined || !stat.isFile()) {
			const what = stat?.isSymbolicLink() === true ? 'a link' : stat?.isDirectory() === true ? 'a nested repository' : 'no regular file';
			throw ckError(
				'CONFIG',
				`input ${input.name}: ${path} of ${input.repository} is ${what}; an input copies regular files only`,
				'replace it with a regular file in that repository, or ignore it there'
			);
		}
	}
	return files;
}

/** The blob each file would be, read without filters: the bytes the copy takes. */
function hashFiles(input: InputConfig, root: string, files: readonly string[]): readonly string[] {
	if (files.length === 0) return [];
	const hashed = runGit({ args: ['hash-object', '--no-filters', '--stdin-paths'], cwd: root, input: `${files.join('\n')}\n` });
	if (hashed.status !== 0) {
		throw ckError('CONFIG', `input ${input.name}: cannot read the working tree of ${input.repository}: ${firstLine(hashed.stderr)}`);
	}
	return hashed.stdout.split('\n').filter((line) => line !== '');
}

/**
 * The disposable copy: the listed files of the working tree, byte for byte, or
 * the files of the pinned commit as git stores them - line endings as the
 * commit has them, and no git-lfs smudge, so no network is reached - plus the
 * dependency roots of the declaration, carried from the working tree.
 */
export function copySource(input: InputConfig, source: InputSource, scratch: string, checkout: string, out: Output): void {
	mkdirSync(checkout, { recursive: true });
	if (source.mode === 'working') {
		for (const path of source.files) {
			const target = join(checkout, ...path.split('/'));
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(join(source.root, ...path.split('/')), target);
		}
	} else {
		const env: GitEnv = {
			GIT_DIR: source.gitDir,
			GIT_WORK_TREE: checkout,
			GIT_INDEX_FILE: join(scratch, 'input.index'),
			GIT_LFS_SKIP_SMUDGE: '1'
		};
		for (const args of [
			['read-tree', source.commit ?? ''],
			['checkout-index', '--all']
		]) {
			const result = runGit({ args, cwd: checkout, env });
			if (result.status !== 0) {
				throw ckError(
					'CONFIG',
					`input ${input.name}: cannot copy ${source.commit ?? ''} of ${input.repository}: ${firstLine(result.stderr)}`
				);
			}
		}
	}
	carryDependencyRoots(input, source, checkout, out);
}

/**
 * ##INPUTS-DEPENDENCY-ROOTS: each root is copied from the working tree of the
 * repository as it is, so a build that needs installed tools finds them without
 * the network. A copy, not a link: the build may write into the root, and the
 * repository stays untouched. Links inside the root stay links where the
 * platform lets anyone create them and are copied as their files on Windows.
 */
function carryDependencyRoots(input: InputConfig, source: InputSource, checkout: string, out: Output): void {
	for (const root of input.dependencyRoots) {
		const from = join(source.root, ...root.split('/'));
		if (!source.hasWorkingTree || !existsSync(from)) {
			out.warn(`input ${input.name}: dependency root ${root} is not in the working tree of ${input.repository}; the build runs without it`);
			continue;
		}
		const to = join(checkout, ...root.split('/'));
		if (existsSync(to)) {
			throw ckError(
				'CONFIG',
				`input ${input.name}: dependency root ${root} is part of the copy itself`,
				'name only directories the repository does not carry as its content'
			);
		}
		mkdirSync(dirname(to), { recursive: true });
		const windows = process.platform === 'win32';
		cpSync(from, to, { recursive: true, dereference: windows, verbatimSymlinks: !windows, preserveTimestamps: true, errorOnExist: true });
	}
}

function gitLine(input: InputConfig, cwd: string, args: readonly string[], problem: string): string {
	const result = runGit({ args, cwd });
	const line = result.stdout.trim();
	if (result.status !== 0 || line === '') {
		throw ckError('CONFIG', `input ${input.name}: ${input.repository} ${problem}: ${firstLine(result.stderr)}`);
	}
	return line;
}

function gitList(input: InputConfig, cwd: string, args: readonly string[]): readonly string[] {
	const result = runGit({ args, cwd });
	if (result.status !== 0) {
		throw ckError('CONFIG', `input ${input.name}: cannot list the working tree of ${input.repository}: ${firstLine(result.stderr)}`);
	}
	return result.stdout.split('\0').filter((path) => path !== '');
}

export function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}
