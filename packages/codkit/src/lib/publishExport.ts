/** @scope spec://codkit/modules/codkit/PROP-007#PUBLISH-EXPORT */
// `publish --export-bare <dir>` and `--export-repo <dir>` (PROP-007
// ##PUBLISH-EXPORT): the release written into a new local repository the
// command creates, instead of pushed into `publishRemoteUrl`.
//
// The repository starts from an empty template, so no hook and no file of a
// template of the machine goes in; its objects are one pack that
// `pack-objects --revs` writes from the disposable fork straight into its
// object directory - exactly what the tip reaches, with no alternates and no
// remote; its refs are written without a reflog, so no identity of the machine
// goes in either. Nothing here reaches the network: no git call below is one
// `gitx` counts as a network call.

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { messageOf } from './configFile.ts';
import { gitOk } from './gitx.ts';
import type { GitEnv } from './gitx.ts';
import type { Output } from './jsonOut.ts';
import { ckError } from './messages.ts';
import type { CkError } from './messages.ts';

export type ExportKind = 'bare' | 'repository';

/** Where an export goes: `--export-bare <dir>` or `--export-repo <dir>`, the path absolute. */
export type ExportRequest = { readonly kind: ExportKind; readonly path: string };

/** `data.export`: the repository an export created. */
export type PublishExport = { readonly kind: ExportKind; readonly path: string; readonly lfsObjects: number };

export type ExportOptions = {
	readonly request: ExportRequest;
	/** The disposable fork the tip was written into. */
	readonly forkDir: string;
	/** A directory of the run's scratch. */
	readonly scratchDir: string;
	readonly branchRef: string;
	readonly tagRef: string | null;
	readonly tip: string;
	readonly out: Output;
	/** Called once the repository exists and before anything goes into it. */
	readonly created?: () => void;
};

/** The configuration a working tree of an export needs to be the bytes of the release on any machine. */
const WORKING_TREE_CONFIG: readonly (readonly [string, string])[] = [
	['core.autocrlf', 'false'],
	['core.eol', 'lf']
];
/** The machine's attribute files stay out of the checkout of an export. */
const CHECKOUT_CONFIG: readonly string[] = ['-c', 'core.attributesFile=/dev/null'];
const CHECKOUT_ENV: GitEnv = { GIT_ATTR_NOSYSTEM: '1' };
const NO_REFLOG: readonly string[] = ['-c', 'core.logAllRefUpdates=false'];
const REMOVE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

/** ##PUBLISH-EXPORT: `--export-bare` and `--export-repo` exclude each other; both is refused before any gate. */
export function exportFlagsRefusal(): CkError {
	return ckError(
		'CONFIG',
		'--export-bare and --export-repo exclude each other',
		'give one: --export-bare <dir> for a bare repository, --export-repo <dir> for a repository with a working tree'
	);
}

/** `--export-bare <dir>` or `--export-repo <dir>` as given: absolute, or relative to the current directory. */
export function exportRequestOf(kind: ExportKind, given: string, cwd: string): ExportRequest {
	return { kind, path: resolve(cwd, given) };
}

/**
 * ##PUBLISH-EXPORT: the directory does not exist or is empty, its parent
 * exists, and it is neither the patch-set directory nor the fork tree nor
 * inside either of them - on their real paths, ignoring case on Windows.
 */
export function assertExportTarget(request: ExportRequest, patchesDir: string, forkTree: string): void {
	const parent = dirname(request.path);
	if (!isDirectory(parent)) {
		throw ckError(
			'CONFIG',
			`the parent of the export directory does not exist: ${parent}`,
			'create it, or name a directory whose parent exists'
		);
	}
	if (existsSync(request.path)) {
		if (!isDirectory(request.path)) {
			throw ckError('CONFIG', `the export path is not a directory: ${request.path}`, 'name a new directory, or an empty one');
		}
		if (readdirSync(request.path).length > 0) {
			throw ckError(
				'CONFIG',
				`the export directory is not empty: ${request.path}`,
				'an export creates a new repository: name a new or an empty directory; a second export into the same one is refused'
			);
		}
	}
	const target = existsSync(request.path) ? realpathSync(request.path) : join(realpathSync(parent), basename(request.path));
	for (const [owner, root] of [
		['patch-set directory', patchesDir],
		['fork tree', forkTree]
	] as const) {
		if (contains(realOrResolved(root), target)) {
			throw ckError(
				'CONFIG',
				`the export directory ${request.path} is inside the ${owner} ${root}`,
				'name a directory outside the patch set and the fork tree'
			);
		}
	}
}

/**
 * The new repository of an export, created and filled; a failure removes what
 * this run created and leaves a directory that existed empty as it was.
 */
export function writeExport(options: ExportOptions): PublishExport {
	const { request } = options;
	if (existsSync(request.path) && readdirSync(request.path).length > 0) {
		throw ckError(
			'CONFIG',
			`the export directory is not empty any more: ${request.path}`,
			'name a new or an empty directory and run again'
		);
	}
	const existed = existsSync(request.path);
	try {
		const gitDir = createRepository(options);
		options.created?.();
		git(
			options.forkDir,
			['pack-objects', '--revs', '--delta-base-offset', '-q', join(gitDir, 'objects', 'pack', 'pack')],
			'cannot write the objects of the release into the export',
			`${options.tip}\n`
		);
		const refs = [options.branchRef, ...(options.tagRef === null ? [] : [options.tagRef])];
		git(
			request.path,
			[...NO_REFLOG, 'update-ref', '--stdin'],
			'cannot write the refs of the export',
			refs.map((ref) => `create ${ref} ${options.tip}\n`).join('')
		);
		if (request.kind === 'repository') {
			gitOk(
				{ args: [...CHECKOUT_CONFIG, 'read-tree', '-m', '-u', 'HEAD'], cwd: request.path, env: CHECKOUT_ENV },
				{ code: 'CONFIG', message: `cannot check out the release in ${request.path}` }
			);
		}
		return { kind: request.kind, path: request.path, lfsObjects: 0 };
	} catch (error) {
		removeCreated(request.path, existed, options.out);
		throw error;
	}
}

/** `git init` from an empty template, in the object format of the fork, the release branch as HEAD. */
function createRepository(options: ExportOptions): string {
	const { request } = options;
	const template = join(options.scratchDir, 'export-template');
	mkdirSync(template, { recursive: true });
	const format = git(options.forkDir, ['rev-parse', '--show-object-format'], 'cannot read the object format of the disposable fork');
	const branch = options.branchRef.slice('refs/heads/'.length);
	git(
		dirname(request.path),
		[
			'init',
			'--quiet',
			...(request.kind === 'bare' ? ['--bare'] : []),
			`--template=${template}`,
			`--object-format=${format}`,
			`--initial-branch=${branch}`,
			request.path
		],
		`cannot create the export repository ${request.path}`
	);
	const config: readonly (readonly [string, string])[] = [
		['core.longpaths', 'true'],
		...(request.kind === 'repository' ? WORKING_TREE_CONFIG : [])
	];
	for (const [key, value] of config) git(request.path, ['config', key, value], `cannot configure the export repository ${request.path}`);
	return request.kind === 'bare' ? request.path : join(request.path, '.git');
}

function removeCreated(path: string, existed: boolean, out: Output): void {
	try {
		if (!existed) rmSync(path, REMOVE);
		else for (const entry of readdirSync(path)) rmSync(join(path, entry), REMOVE);
	} catch (error) {
		out.warn(`the export ${path} of the failed run could not be removed: ${messageOf(error)}`);
	}
}

function contains(root: string, path: string): boolean {
	const fold = (text: string): string => (process.platform === 'win32' ? text.toLowerCase() : text);
	const base = fold(root.endsWith(sep) ? root.slice(0, -1) : root);
	const candidate = fold(path);
	return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function realOrResolved(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function git(cwd: string, args: readonly string[], message: string, input?: string): string {
	return gitOk(input === undefined ? { args, cwd } : { args, cwd, input }, { code: 'CONFIG', message }).stdout.trim();
}
