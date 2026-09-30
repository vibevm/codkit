/** @scope spec://codkit/modules/codkit/PROP-007#PUBLISH-NO-LFS */
// `publish --no-lfs` (PROP-007 ##PUBLISH-NO-LFS, ##PUBLISH-NO-LFS-REWRITE,
// ##PUBLISH-NO-LFS-FAIL-CLOSED): the release tree without the content git-lfs
// tracks and without the rules that make it track anything.
//
// The attributes of a tree are resolved from the .gitattributes files of that
// tree and of nothing else. `git check-attr --source=<tree>` reads them from the
// tree itself, and it runs in an attribute oracle: a bare repository of the
// run's scratch, made from an empty template, that borrows the objects of the
// disposable fork through objects/info/alternates and so has no
// info/attributes, with the attribute files of the machine switched off. The
// oracle answers `unspecified` for a tree it cannot read instead of failing, so
// the tree and its attribute files are read there before it is asked.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOk, runGit } from './gitx.ts';
import type { GitEnv } from './gitx.ts';
import { ckError } from './messages.ts';
import { readBlobs } from './publishRelease.ts';
import { COMMIT_AUTHOR_EMAIL, COMMIT_AUTHOR_NAME } from './treeCommits.ts';

/** The first line of a git-lfs pointer, with its line feed. */
export const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1\n';
/** A pointer is at most this many bytes. */
export const LFS_POINTER_LIMIT = 1024;

/** The object a pointer names. */
export type LfsPointer = { readonly oid: string; readonly size: number };

/** What `--no-lfs` did to a tree: the paths it left out and the attribute files it changed. */
export type LfsReport = { readonly dropped: readonly string[]; readonly attributes: readonly string[] };

/** A line of an attribute file that names `filter=lfs`: `<file>:<line>`, and its text. */
export type LfsRuleLine = { readonly file: string; readonly line: number; readonly text: string };

/** What the fail-closed check found: a path that still resolves to lfs, or a line no such path names. */
export type LfsLeftover = { readonly path: string | null; readonly rules: readonly LfsRuleLine[] };

export type LfsOutcome = {
	readonly tree: string;
	readonly report: LfsReport;
	/** The rules removed from each changed attribute file, and whether the file is left out. */
	readonly rewrites: readonly { readonly path: string; readonly rules: number; readonly removed: boolean }[];
	readonly leftovers: readonly LfsLeftover[];
};

/** A path of a tree that is git-lfs content, with the object its pointer names; null when it names none. */
export type LfsContent = { readonly path: string; readonly pointer: LfsPointer | null };

export type AttributesRewrite = { readonly rules: number; readonly bytes: Uint8Array | null };

type Line = { readonly text: string; readonly ending: string };
type TreeEntry = { readonly mode: string; readonly object: string; readonly size: number; readonly path: string };
type AttributeFile = { readonly path: string; readonly mode: string; readonly bytes: Uint8Array };
type Classified = {
	readonly regular: readonly TreeEntry[];
	readonly lfs: ReadonlySet<string>;
	readonly attributes: readonly AttributeFile[];
};

const ATTRIBUTES = '.gitattributes';
const PATHS_PER_CALL = 50;
/** The machine's attribute files stay out of every question the oracle answers. */
const ORACLE_CONFIG: readonly string[] = ['-c', 'core.attributesFile=/dev/null', '-c', 'core.ignorecase=false'];
const ORACLE_ENV: GitEnv = { GIT_ATTR_NOSYSTEM: '1' };

/** A git-lfs pointer: at most 1024 bytes, opening with the line of the pointer's version. */
export function isLfsPointer(bytes: Uint8Array): boolean {
	if (bytes.length > LFS_POINTER_LIMIT || bytes.length < LFS_POINTER_HEADER.length) return false;
	return Buffer.from(bytes.subarray(0, LFS_POINTER_HEADER.length)).toString('latin1') === LFS_POINTER_HEADER;
}

/** The object a pointer names - its `oid sha256:` and `size` lines - or null when it names none. */
export function pointerObject(bytes: Uint8Array): LfsPointer | null {
	if (!isLfsPointer(bytes)) return null;
	const text = Buffer.from(bytes).toString('latin1');
	const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
	const size = /^size (0|[1-9][0-9]{0,15})$/m.exec(text)?.[1];
	return oid === undefined || size === undefined ? null : { oid, size: Number(size) };
}

/**
 * ##PUBLISH-NO-LFS-REWRITE: a rule - not blank, not a comment, not a macro
 * definition - one of whose attributes after its pattern is exactly
 * `filter=lfs`. A quoted pattern is read up to its closing quote.
 */
export function setsLfsFilter(line: string): boolean {
	const rule = line.replace(/^[ \t]+/, '');
	if (rule === '' || rule.startsWith('#') || rule.startsWith('[attr]')) return false;
	return attributesOf(rule).includes('filter=lfs');
}

/**
 * ##PUBLISH-NO-LFS-REWRITE over the bytes of one attribute file: every rule that
 * sets `filter=lfs` goes, with the comment lines directly above it, then the
 * blank lines at the end of the file; every other byte stays. `rules` is 0 and
 * the bytes are the input when nothing sets it; `bytes` is null when the file
 * is left without a non-blank line.
 */
export function rewriteAttributes(bytes: Uint8Array): AttributesRewrite {
	const lines = linesOf(Buffer.from(bytes).toString('latin1'));
	const removed = new Set<number>();
	let rules = 0;
	lines.forEach((line, index) => {
		if (!setsLfsFilter(line.text)) return;
		rules += 1;
		removed.add(index);
		for (let above = index - 1; above >= 0 && (lines[above]?.text.startsWith('#') ?? false); above -= 1) removed.add(above);
	});
	if (rules === 0) return { rules, bytes };
	const kept = lines.filter((_, index) => !removed.has(index));
	while (kept.length > 0 && isBlank(kept[kept.length - 1]?.text ?? '')) kept.pop();
	if (kept.length === 0) return { rules, bytes: null };
	return { rules, bytes: new Uint8Array(Buffer.from(kept.map((line) => line.text + line.ending).join(''), 'latin1')) };
}

/** ##PUBLISH-NO-LFS-FAIL-CLOSED: every line that names `filter=lfs` outside a comment, numbered from 1. */
export function linesNamingLfsFilter(file: string, bytes: Uint8Array): readonly LfsRuleLine[] {
	return linesOf(Buffer.from(bytes).toString('latin1')).flatMap((line, index) => {
		const rule = line.text.replace(/^[ \t]+/, '');
		if (rule.startsWith('#') || !rule.split(/[ \t\r]+/).includes('filter=lfs')) return [];
		return [{ file, line: index + 1, text: line.text.trim() }];
	});
}

/**
 * ##PUBLISH-NO-LFS: the tree without its git-lfs content and without the rules
 * that name `filter=lfs`, written into `treeDir`, and what the fail-closed check
 * found in it. A tree the transformation leaves as it is comes back as it is -
 * and is checked all the same.
 */
export function dropLfsContent(options: { readonly treeDir: string; readonly scratchDir: string; readonly tree: string }): LfsOutcome {
	const oracle = attributeOracle(options.treeDir, options.scratchDir);
	const before = classify(oracle, options.tree);
	const content = lfsContent(oracle, before);
	const rewrites = before.attributes
		.map((file) => ({ file, rewrite: rewriteAttributes(file.bytes) }))
		.filter((entry) => entry.rewrite.rules > 0);
	const dropped = content.map((entry) => entry.path);
	const changed = dropped.length > 0 || rewrites.length > 0;
	const tree = changed ? writeReleaseTree(options, dropped, rewrites) : options.tree;
	return {
		tree,
		report: { dropped, attributes: rewrites.map((entry) => entry.file.path) },
		rewrites: rewrites.map((entry) => ({ path: entry.file.path, rules: entry.rewrite.rules, removed: entry.rewrite.bytes === null })),
		leftovers: leftoversOf(classify(oracle, tree))
	};
}

/** The git-lfs content of a tree (##PUBLISH-NO-LFS), sorted by path: what an export that keeps git-lfs carries. */
export function lfsContentOf(options: {
	readonly treeDir: string;
	readonly scratchDir: string;
	readonly tree: string;
}): readonly LfsContent[] {
	const oracle = attributeOracle(options.treeDir, options.scratchDir);
	return lfsContent(oracle, classify(oracle, options.tree));
}

/**
 * The generated commit that ends the history under `--no-lfs` without
 * `--squash`: the identity and date of every generated commit, the canonical
 * trailers and no `Codkit-Artifact`.
 */
export function lfsCommit(options: {
	readonly treeDir: string;
	readonly parent: string;
	readonly tree: string;
	readonly patchSetCommit: string;
	readonly pinTag: string;
	readonly pinSha: string;
	readonly date: string;
}): string {
	const message = [
		'codkit: leave out git-lfs content',
		'',
		`Codkit-Patchset-Commit: ${options.patchSetCommit}`,
		`Codkit-Upstream-Pin: ${options.pinTag}@${options.pinSha}`
	].join('\n');
	const env: GitEnv = {
		GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
		GIT_AUTHOR_DATE: options.date,
		GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
		GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
		GIT_COMMITTER_DATE: options.date
	};
	return gitOk(
		{ args: ['commit-tree', options.tree, '-p', options.parent, '-m', message], cwd: options.treeDir, env },
		{ code: 'CONFIG', message: 'cannot write the commit that leaves out the git-lfs content' }
	).stdout.trim();
}

/** The oracle of the attributes: a bare repository of the scratch that reads the objects of `treeDir`. */
function attributeOracle(treeDir: string, scratchDir: string): string {
	const template = join(scratchDir, 'template');
	const oracle = join(scratchDir, 'attributes.git');
	mkdirSync(template, { recursive: true });
	const format = git(treeDir, ['rev-parse', '--show-object-format'], 'cannot read the object format of the disposable fork');
	git(
		scratchDir,
		['init', '--quiet', '--bare', `--template=${template}`, `--object-format=${format}`, oracle],
		'cannot create the attribute oracle'
	);
	const objects = git(
		treeDir,
		['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
		'cannot locate the objects of the disposable fork'
	);
	mkdirSync(join(oracle, 'objects', 'info'), { recursive: true });
	writeFileSync(join(oracle, 'objects', 'info', 'alternates'), `${objects}\n`, 'utf8');
	return oracle;
}

/** The regular files of a tree, the ones whose filter is lfs, and its attribute files with their bytes. */
function classify(oracle: string, tree: string): Classified {
	if (git(oracle, ['cat-file', '-t', tree], `cannot read the tree ${tree}`) !== 'tree') {
		throw ckError('CONFIG', `--no-lfs was given ${tree}, which is not a tree`);
	}
	const regular = treeEntries(oracle, tree).filter((entry) => entry.mode === '100644' || entry.mode === '100755');
	const files = regular.filter((entry) => entry.path === ATTRIBUTES || entry.path.endsWith(`/${ATTRIBUTES}`));
	const blobs = readBlobs(
		oracle,
		files.map((entry) => entry.object)
	);
	const attributes = files.map((entry) => ({ path: entry.path, mode: entry.mode, bytes: blobs.get(entry.object) ?? new Uint8Array() }));
	return { regular, lfs: lfsFiltered(oracle, tree, regular), attributes };
}

/** The paths whose filter is lfs and whose blob is a pointer, with the objects their pointers name. */
function lfsContent(oracle: string, classified: Classified): readonly LfsContent[] {
	const candidates = classified.regular.filter((entry) => classified.lfs.has(entry.path) && entry.size <= LFS_POINTER_LIMIT);
	const blobs = readBlobs(
		oracle,
		candidates.map((entry) => entry.object)
	);
	return candidates
		.filter((entry) => isLfsPointer(blobs.get(entry.object) ?? new Uint8Array()))
		.map((entry) => ({ path: entry.path, pointer: pointerObject(blobs.get(entry.object) ?? new Uint8Array()) }));
}

/** `git check-attr --source` in the oracle: the paths whose `filter` attribute is `lfs`. */
function lfsFiltered(oracle: string, tree: string, entries: readonly TreeEntry[]): ReadonlySet<string> {
	const lfs = new Set<string>();
	if (entries.length === 0) return lfs;
	const result = runGit({
		args: [...ORACLE_CONFIG, 'check-attr', `--source=${tree}`, '-z', '--stdin', 'filter'],
		cwd: oracle,
		env: ORACLE_ENV,
		input: entries.map((entry) => `${entry.path}\0`).join('')
	});
	if (result.status !== 0 || /^(error|fatal):/m.test(result.stderr)) {
		throw ckError('CONFIG', `cannot resolve the attributes of the release tree: ${firstLine(result.stderr)}`);
	}
	const fields = result.stdout.split('\0');
	for (let index = 0; index + 2 < fields.length; index += 3) {
		if (fields[index + 1] === 'filter' && fields[index + 2] === 'lfs') lfs.add(fields[index] ?? '');
	}
	return lfs;
}

/** ##PUBLISH-NO-LFS-FAIL-CLOSED over the new tree: every path still given to lfs, then every line no such path names. */
function leftoversOf(classified: Classified): readonly LfsLeftover[] {
	const naming = new Map(classified.attributes.map((file) => [file.path, linesNamingLfsFilter(file.path, file.bytes)]));
	const named = new Set<string>();
	const leftovers: LfsLeftover[] = [];
	for (const path of [...classified.lfs].sort()) {
		const rules = attributeFilesAbove(path).flatMap((file) => naming.get(file) ?? []);
		for (const rule of rules) named.add(`${rule.file}:${rule.line}`);
		leftovers.push({ path, rules });
	}
	for (const rules of naming.values()) {
		for (const rule of rules) if (!named.has(`${rule.file}:${rule.line}`)) leftovers.push({ path: null, rules: [rule] });
	}
	return leftovers;
}

/** The attribute files that can speak about a path: the one of its directory and of every directory above. */
function attributeFilesAbove(path: string): readonly string[] {
	const segments = path.split('/').slice(0, -1);
	return segments
		.map((_, index) => `${segments.slice(0, index + 1).join('/')}/${ATTRIBUTES}`)
		.reverse()
		.concat(ATTRIBUTES)
		.reverse();
}

/** The tree with the paths removed and the attribute files rewritten, in a temporary index of `treeDir`. */
function writeReleaseTree(
	options: { readonly treeDir: string; readonly scratchDir: string; readonly tree: string },
	dropped: readonly string[],
	rewrites: readonly { readonly file: AttributeFile; readonly rewrite: AttributesRewrite }[]
): string {
	const env: GitEnv = { GIT_INDEX_FILE: join(options.scratchDir, 'lfs.index') };
	gitOk(
		{ args: ['read-tree', options.tree], cwd: options.treeDir, env },
		{ code: 'CONFIG', message: 'cannot read the release tree for --no-lfs' }
	);
	const removed = [...dropped, ...rewrites.filter((entry) => entry.rewrite.bytes === null).map((entry) => entry.file.path)];
	for (let index = 0; index < removed.length; index += PATHS_PER_CALL) {
		gitOk(
			{ args: ['update-index', '--force-remove', '--', ...removed.slice(index, index + PATHS_PER_CALL)], cwd: options.treeDir, env },
			{ code: 'CONFIG', message: 'cannot leave the git-lfs content out of the release tree' }
		);
	}
	const kept = rewrites.filter((entry) => entry.rewrite.bytes !== null);
	if (kept.length > 0) {
		const scratch = kept.map((entry, index) => {
			const path = join(options.scratchDir, `attributes-${index}`);
			writeFileSync(path, entry.rewrite.bytes ?? new Uint8Array());
			return path;
		});
		const stored = gitOk(
			{
				args: ['hash-object', '-w', '--no-filters', '--stdin-paths'],
				cwd: options.treeDir,
				env,
				input: scratch.map((path) => `${path}\n`).join('')
			},
			{ code: 'CONFIG', message: 'cannot store the rewritten attribute files of the release' }
		).stdout.split('\n');
		const entries = kept.map((entry, index) => `${entry.file.mode} ${stored[index] ?? ''}\t${entry.file.path}\0`).join('');
		gitOk(
			{ args: ['update-index', '-z', '--index-info'], cwd: options.treeDir, env, input: entries },
			{ code: 'CONFIG', message: 'cannot stage the rewritten attribute files of the release' }
		);
	}
	return gitOk(
		{ args: ['write-tree'], cwd: options.treeDir, env },
		{ code: 'CONFIG', message: 'cannot write the release tree without git-lfs content' }
	).stdout.trim();
}

/** `ls-tree -r -l` of a tree: every entry with its mode, object, size and path; a commit entry has no size. */
function treeEntries(oracle: string, tree: string): readonly TreeEntry[] {
	const listed = gitOk(
		{ args: ['ls-tree', '-r', '-l', '-z', '--full-tree', tree], cwd: oracle },
		{ code: 'CONFIG', message: `cannot list the release tree ${tree}` }
	).stdout;
	const entries: TreeEntry[] = [];
	for (const record of listed.split('\0')) {
		if (record === '') continue;
		const tab = record.indexOf('\t');
		const [mode = '', , object = '', size = ''] = record.slice(0, tab).split(/ +/);
		entries.push({ mode, object, size: /^\d+$/.test(size) ? Number(size) : Number.POSITIVE_INFINITY, path: record.slice(tab + 1) });
	}
	return entries;
}

/** Lines with their own line endings; the last one may have none. */
function linesOf(text: string): readonly Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start < text.length) {
		const newline = text.indexOf('\n', start);
		if (newline === -1) {
			lines.push({ text: text.slice(start), ending: '' });
			break;
		}
		const crlf = newline > start && text[newline - 1] === '\r';
		lines.push({ text: text.slice(start, crlf ? newline - 1 : newline), ending: crlf ? '\r\n' : '\n' });
		start = newline + 1;
	}
	return lines;
}

/** The attributes of a rule: the words after its pattern. */
function attributesOf(rule: string): readonly string[] {
	let rest: string;
	if (rule.startsWith('"')) {
		let at = 1;
		while (at < rule.length && rule[at] !== '"') at += rule[at] === '\\' ? 2 : 1;
		rest = rule.slice(at + 1);
	} else {
		const end = rule.search(/[ \t\r]/);
		rest = end === -1 ? '' : rule.slice(end);
	}
	return rest.split(/[ \t\r]+/).filter((word) => word !== '');
}

function isBlank(text: string): boolean {
	return /^[ \t\r\f\v]*$/.test(text);
}

function git(cwd: string, args: readonly string[], message: string): string {
	return gitOk({ args, cwd }, { code: 'CONFIG', message }).stdout.trim();
}

function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}
