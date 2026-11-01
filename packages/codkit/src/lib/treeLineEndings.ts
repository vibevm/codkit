/** @scope spec://codkit/modules/codkit/PROP-002#GIT-ENV-EOL */
// The line endings a fork tree holds against the blobs its index stores
// (PROP-002 ##GIT-ENV-EOL). A tracked text file whose blob is LF and whose
// working copy is CRLF without an `eol=crlf` attribute was written by a
// checkout under the machine's configuration - `core.autocrlf=true`, or
// `core.eol` left at `native` on Windows - never by codkit, whose checkouts
// write the blob's line endings. git's stat cache calls such a file unchanged,
// so `git status` is clean over it; the byte-for-byte proof the upgrade cycle
// makes of every file it moves is not, and it comes after the long build of
// the prospective tree. The cycle therefore asks the question first, with
// `git ls-files --eol`, which reads the working copies instead of the cache.

import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';

export type CrlfWorktreeFile = {
	readonly path: string;
	/** The line endings of the blob, as `git ls-files --eol` names them (`lf`). */
	readonly index: string;
	/** The line endings of the working copy (`crlf` or `mixed`). */
	readonly worktree: string;
	/** The eol attributes of the path, as the listing prints them; may be empty. */
	readonly attributes: string;
};

/** How many paths the refusal names before counting the rest. */
const LIST_LIMIT = 10;

/**
 * The tracked files whose working copy carries CRLF where the blob is LF and no
 * `eol=crlf` attribute asks for it: exactly the files a checkout by codkit
 * writes differently. The listing reads every working copy, so a stat cache
 * that calls the file unchanged does not hide it.
 */
export function crlfWorktreeFiles(treeDir: string): readonly CrlfWorktreeFile[] {
	const listed = runGit({ args: ['ls-files', '--eol', '-z'], cwd: treeDir });
	if (listed.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`cannot read the line endings of the files in ${treeDir}: ${listed.stderr.trim().split('\n')[0] ?? ''}`,
			'check that the fork tree is a healthy git work tree'
		);
	}
	const files: CrlfWorktreeFile[] = [];
	for (const record of listed.stdout.split('\0')) {
		if (record === '') continue;
		const tab = record.indexOf('\t');
		const info = tab === -1 ? null : /^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*)$/.exec(record.slice(0, tab));
		if (info === null) throw ckError('INTERNAL', `git ls-files --eol printed a record codkit cannot read: ${JSON.stringify(record)}`);
		const index = info[1] ?? '';
		const worktree = info[2] ?? '';
		const attributes = (info[3] ?? '').trim();
		if (index !== 'lf' || (worktree !== 'crlf' && worktree !== 'mixed')) continue;
		if (/(^|\s)eol=crlf(\s|$)/.test(attributes)) continue;
		files.push({ path: record.slice(tab + 1), index, worktree, attributes });
	}
	return files;
}

/**
 * The refusal of a tree in that state, before anything expensive: the paths go
 * to `report` one per line, the refusal counts them and names the recipe that
 * rewrites the working copies from the index without touching anything else.
 */
export function assertTreeLineEndings(treeDir: string, report: (text: string) => void): void {
	const files = crlfWorktreeFiles(treeDir);
	if (files.length === 0) return;
	for (const file of files.slice(0, LIST_LIMIT)) {
		const attributes = file.attributes === '' ? '' : `, attr ${file.attributes}`;
		report(`  crlf: ${file.path} (blob ${file.index}, working copy ${file.worktree}${attributes})`);
	}
	if (files.length > LIST_LIMIT) report(`  ... and ${files.length - LIST_LIMIT} more`);
	const named = files
		.slice(0, 3)
		.map((file) => file.path)
		.join(', ');
	throw ckError(
		'CRLF',
		`${files.length} tracked file(s) of the fork tree hold CRLF line endings where the blob holds LF and no eol=crlf attribute asks for it (${named}${files.length > 3 ? ', ...' : ''}): ` +
			'a checkout under core.autocrlf=true or core.eol=native wrote them, git status does not show them, and the byte-for-byte proof of the files the cycle moves would refuse them after the build of the prospective tree',
		`in the fork tree set core.autocrlf=false and core.eol=lf (git -C ${treeDir} config core.autocrlf false; git -C ${treeDir} config core.eol lf), ` +
			`rewrite the listed working copies from the index (git -C ${treeDir} checkout-index --force -- <path>...), then run the command again`
	);
}
