// git-lfs content of the pseudo-upstream (PROP-007 ##PUBLISH-NO-LFS,
// ##PUBLISH-EXPORT-LFS), shaped like the one VS Code carries: a nested
// .gitattributes whose one rule gives *.sqlite to git-lfs, and pointer files
// under it. `makeUpstream` adds it only when a fixture asks for it, so every
// other fixture keeps its shas.
//
//   anchor  assets/cache/sample.sqlite -> object 1   an older object: history only
//   t1      assets/cache/sample.sqlite -> object 2   the objects of the tip
//           assets/cache/extra.sqlite  -> object 3
//
// The `macro` kind gives *.db to git-lfs through a macro of the top-level
// .gitattributes instead - a form the rewrite of --no-lfs does not remove.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitOk, runGit } from '../../src/lib/gitx.ts';

export type LfsKind = 'rule' | 'macro';

/** One object of the git-lfs storage and the pointer that names it. */
export type LfsObject = { readonly oid: string; readonly size: number; readonly content: Uint8Array; readonly pointer: string };

export const LFS_ATTRIBUTES_PATH = 'assets/.gitattributes';
/** The form of `extensions/copilot/.gitattributes` of VS Code 1.135.0. */
export const LFS_ATTRIBUTES =
	'* text=auto eol=lf\n\n# Enable Git LFS for SQLite database files\n*.sqlite filter=lfs diff=lfs merge=lfs -text\n';
/** What `--no-lfs` makes of it. */
export const LFS_ATTRIBUTES_WITHOUT_RULE = '* text=auto eol=lf\n';
export const LFS_SAMPLE_PATH = 'assets/cache/sample.sqlite';
export const LFS_EXTRA_PATH = 'assets/cache/extra.sqlite';
export const LFS_MACRO_ATTRIBUTES = '[attr]lfsdata filter=lfs diff=lfs merge=lfs -text\n*.db lfsdata\n';
export const LFS_MACRO_PATH = 'assets/store.db';

const OLD_SAMPLE = lfsObject('SQLite format 3\u0000 fixture sample, the version of the anchor\n');
export const LFS_SAMPLE = lfsObject('SQLite format 3\u0000 fixture sample, the version of the pin\n'.repeat(20));
export const LFS_EXTRA = lfsObject('SQLite format 3\u0000 fixture extra database\n'.repeat(50));
const MACRO_STORE = lfsObject('SQLite format 3\u0000 fixture store behind a macro\n');

/** The git-lfs content the anchor commit adds. */
export function lfsFilesAtAnchor(kind: LfsKind): ReadonlyMap<string, string> {
	return kind === 'rule'
		? new Map([
				[LFS_ATTRIBUTES_PATH, LFS_ATTRIBUTES],
				[LFS_SAMPLE_PATH, OLD_SAMPLE.pointer]
			])
		: new Map([['.gitattributes', LFS_MACRO_ATTRIBUTES]]);
}

/** The git-lfs content the commit of the pin adds or changes. */
export function lfsFilesAtPin(kind: LfsKind): ReadonlyMap<string, string> {
	return kind === 'rule'
		? new Map([
				[LFS_SAMPLE_PATH, LFS_SAMPLE.pointer],
				[LFS_EXTRA_PATH, LFS_EXTRA.pointer]
			])
		: new Map([[LFS_MACRO_PATH, MACRO_STORE.pointer]]);
}

/** Every object the history of the fixture names: what the git-lfs storage of a fork tree holds. */
export function lfsObjectsOf(kind: LfsKind): readonly LfsObject[] {
	return kind === 'rule' ? [OLD_SAMPLE, LFS_SAMPLE, LFS_EXTRA] : [MACRO_STORE];
}

/** Where git-lfs keeps an object below an lfs storage. */
export function lfsObjectPath(storage: string, oid: string): string {
	return join(storage, 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

/**
 * The git-lfs content of a fork tree, as a clone with git-lfs has it before its
 * checkout: every object in the lfs storage of its common git directory, and -
 * where git-lfs is installed - the lfs filters in its own config, since
 * codkit's git reads no global or system config.
 */
export function provideLfsContent(treeDir: string, objects: readonly LfsObject[]): string {
	const common = gitOk(
		{ args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: treeDir },
		fixtureFailure(treeDir)
	).stdout.trim();
	const storage = join(common, 'lfs');
	for (const object of objects) {
		const path = lfsObjectPath(storage, object.oid);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, object.content);
	}
	if (runGit({ args: ['lfs', 'version'], cwd: treeDir }).status !== 0) return storage;
	for (const [key, value] of [
		['filter.lfs.clean', 'git-lfs clean -- %f'],
		['filter.lfs.smudge', 'git-lfs smudge -- %f'],
		['filter.lfs.process', 'git-lfs filter-process'],
		['filter.lfs.required', 'true']
	] as const) {
		gitOk({ args: ['config', key, value], cwd: treeDir }, fixtureFailure(treeDir));
	}
	return storage;
}

function lfsObject(text: string): LfsObject {
	const content = new Uint8Array(Buffer.from(text, 'utf8'));
	const oid = createHash('sha256').update(content).digest('hex');
	return {
		oid,
		size: content.length,
		content,
		pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`
	};
}

function fixtureFailure(dir: string): { readonly code: 'INTERNAL'; readonly message: string; readonly hint: string } {
	return {
		code: 'INTERNAL',
		message: `fixture git failed in ${dir}`,
		hint: 'this is a bug in the codkit test fixtures, not in the tree under test'
	};
}
