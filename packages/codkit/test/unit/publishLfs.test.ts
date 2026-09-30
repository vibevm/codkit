// `publish --no-lfs` (PROP-007 ##PUBLISH-NO-LFS, ##PUBLISH-NO-LFS-REWRITE,
// ##PUBLISH-NO-LFS-FAIL-CLOSED): the rewrite of one attribute file as a pure
// function, the pointer, and the transformation of a tree in a small
// repository whose own configuration tries to mislead it.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import {
	dropLfsContent,
	isLfsPointer,
	lfsContentOf,
	linesNamingLfsFilter,
	pointerObject,
	rewriteAttributes,
	setsLfsFilter
} from '../../src/lib/publishLfs.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** The 108 bytes of `extensions/copilot/.gitattributes` at the pin of VS Code 1.135.0. */
const VSCODE_COPILOT_ATTRIBUTES =
	'* text=auto eol=lf\n\n# Enable Git LFS for SQLite database files\n*.sqlite filter=lfs diff=lfs merge=lfs -text\n';

function rewrite(text: string): { readonly rules: number; readonly text: string | null } {
	const result = rewriteAttributes(new Uint8Array(Buffer.from(text, 'latin1')));
	return { rules: result.rules, text: result.bytes === null ? null : Buffer.from(result.bytes).toString('latin1') };
}

function pointer(content: string): string {
	const oid = createHash('sha256').update(content, 'utf8').digest('hex');
	return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${Buffer.byteLength(content, 'utf8')}\n`;
}

describe('the rewrite of one .gitattributes', () => {
	it('turns the real 108 bytes of VS Code into the real 19', () => {
		expect(Buffer.byteLength(VSCODE_COPILOT_ATTRIBUTES)).toBe(108);
		const result = rewrite(VSCODE_COPILOT_ATTRIBUTES);
		expect(result).toEqual({ rules: 1, text: '* text=auto eol=lf\n' });
		expect(Buffer.byteLength(result.text ?? '')).toBe(19);
	});

	it('removes a rule together with the comment directly above it', () => {
		expect(rewrite('*.txt text\n# LFS\n# for the fixtures\n*.bin filter=lfs -text\n')).toEqual({ rules: 1, text: '*.txt text\n' });
	});

	it('removes several rules of one file, each with its own comment', () => {
		const text =
			'* text=auto\n# first\n*.a filter=lfs diff=lfs merge=lfs -text\n# second\n*.b filter=lfs diff=lfs merge=lfs -text\n*.c text\n';
		expect(rewrite(text)).toEqual({ rules: 2, text: '* text=auto\n*.c text\n' });
	});

	it('removes a rule in the middle of a file and keeps what surrounds it', () => {
		expect(rewrite('*.txt text\n*.bin filter=lfs\n*.md text\n')).toEqual({ rules: 1, text: '*.txt text\n*.md text\n' });
	});

	it('keeps CRLF line endings, and blank lines that are not at the end', () => {
		expect(rewrite('* text=auto\r\n\r\n# lfs\r\n*.a filter=lfs\r\n*.c text\r\n')).toEqual({
			rules: 1,
			text: '* text=auto\r\n\r\n*.c text\r\n'
		});
		expect(rewrite('*.c text\r\n*.a filter=lfs\r\n\r\n')).toEqual({ rules: 1, text: '*.c text\r\n' });
	});

	it('leaves a line with another filter, and diff=lfs alone, untouched', () => {
		expect(rewrite('*.x filter=custom\n*.y diff=lfs merge=lfs\n*.z filter=lfs\n')).toEqual({
			rules: 1,
			text: '*.x filter=custom\n*.y diff=lfs merge=lfs\n'
		});
		expect(rewrite('*.x filter=lfs2\n*.y -filter\n')).toEqual({ rules: 0, text: '*.x filter=lfs2\n*.y -filter\n' });
	});

	it('leaves alone a comment that is not directly above the rule', () => {
		expect(rewrite('# a header\n\n*.a filter=lfs\n')).toEqual({ rules: 1, text: '# a header\n' });
		expect(rewrite('# about text\n*.txt text\n*.a filter=lfs\n')).toEqual({ rules: 1, text: '# about text\n*.txt text\n' });
	});

	it('removes a file that is left without a non-blank line', () => {
		expect(rewrite('# lfs\n*.a filter=lfs\n\n')).toEqual({ rules: 1, text: null });
		expect(rewrite('\n\n*.a filter=lfs\n')).toEqual({ rules: 1, text: null });
		expect(rewrite('# lfs only\n\n*.a filter=lfs\n')).toEqual({ rules: 1, text: '# lfs only\n' });
	});

	it('touches no byte of a file without such a rule', () => {
		const text = '* text=auto\r\n# filter=lfs in a comment\n[attr]lfsdata filter=lfs diff=lfs\n*.db lfsdata\n\n\n';
		const input = new Uint8Array(Buffer.from(text, 'latin1'));
		const result = rewriteAttributes(input);
		expect(result.rules).toBe(0);
		expect(result.bytes).toBe(input);
	});

	it('reads what makes a line a rule that sets filter=lfs', () => {
		expect(setsLfsFilter('  *.bin filter=lfs')).toBe(true);
		expect(setsLfsFilter('"with space.bin" filter=lfs -text')).toBe(true);
		expect(setsLfsFilter('"a filter=lfs b" -text')).toBe(false);
		expect(setsLfsFilter('# *.bin filter=lfs')).toBe(false);
		expect(setsLfsFilter('[attr]lfsdata filter=lfs')).toBe(false);
		expect(setsLfsFilter('filter=lfs')).toBe(false);
		expect(rewrite('*.a text\n*.b filter=lfs')).toEqual({ rules: 1, text: '*.a text\n' });
		expect(rewrite('*.b filter=lfs\n*.a text')).toEqual({ rules: 1, text: '*.a text' });
	});

	it('names every line outside a comment that still names filter=lfs', () => {
		const bytes = new Uint8Array(Buffer.from('# filter=lfs\n[attr]lfsdata filter=lfs diff=lfs\n*.db lfsdata\n', 'latin1'));
		expect(linesNamingLfsFilter('.gitattributes', bytes)).toEqual([
			{ file: '.gitattributes', line: 2, text: '[attr]lfsdata filter=lfs diff=lfs' }
		]);
	});
});

describe('the git-lfs pointer', () => {
	it('is at most 1024 bytes and opens with the line of its version', () => {
		const text = pointer('fixture content\n');
		expect(isLfsPointer(new Uint8Array(Buffer.from(text)))).toBe(true);
		expect(pointerObject(new Uint8Array(Buffer.from(text)))).toEqual({
			oid: createHash('sha256').update('fixture content\n').digest('hex'),
			size: 16
		});
		expect(isLfsPointer(new Uint8Array(Buffer.from(`${text}${'x'.repeat(1024)}`)))).toBe(false);
		expect(isLfsPointer(new Uint8Array(Buffer.from('SQLite format 3\0')))).toBe(false);
		expect(isLfsPointer(new Uint8Array(Buffer.from(text.replaceAll('\n', '\r\n'))))).toBe(false);
		const noOid = 'version https://git-lfs.github.com/spec/v1\nsize 12\n';
		expect(isLfsPointer(new Uint8Array(Buffer.from(noOid)))).toBe(true);
		expect(pointerObject(new Uint8Array(Buffer.from(noOid)))).toBeNull();
	});
});

describe('the transformation of a tree', () => {
	it('drops the pointers the tree gives to lfs, rewrites the rule, keeps what is not a pointer and hears no other source', () => {
		const repo = repository('lfs-tree', {
			'assets/.gitattributes': VSCODE_COPILOT_ATTRIBUTES,
			'assets/cache/a.sqlite': pointer('a sqlite database\n'),
			'assets/cache/b.sqlite': 'SQLite format 3\u0000 not a pointer\n',
			'assets/cache/notes.md': pointer('notes that are no lfs content\n'),
			'README.md': '# fixture\n'
		});
		// Neither $GIT_DIR/info/attributes nor a working-tree file of the
		// repository may give a path to lfs: only the tree speaks.
		mkdirSync(join(repo.dir, '.git', 'info'), { recursive: true });
		writeFileSync(join(repo.dir, '.git', 'info', 'attributes'), 'assets/cache/notes.md filter=lfs\n', 'utf8');
		writeFileSync(join(repo.dir, 'assets', '.gitattributes'), '*.md filter=lfs\n', 'utf8');

		expect(lfsContentOf({ treeDir: repo.dir, scratchDir: scratch('lfs-content'), tree: repo.tree })).toEqual([
			{ path: 'assets/cache/a.sqlite', pointer: { oid: sha256('a sqlite database\n'), size: 18 } }
		]);
		const outcome = dropLfsContent({ treeDir: repo.dir, scratchDir: scratch('lfs-drop'), tree: repo.tree });
		expect(outcome.report).toEqual({ dropped: ['assets/cache/a.sqlite'], attributes: ['assets/.gitattributes'] });
		expect(outcome.rewrites).toEqual([{ path: 'assets/.gitattributes', rules: 1, removed: false }]);
		expect(outcome.leftovers).toEqual([]);
		expect(files(repo.dir, outcome.tree)).toEqual(['README.md', 'assets/.gitattributes', 'assets/cache/b.sqlite', 'assets/cache/notes.md']);
		expect(show(repo.dir, `${outcome.tree}:assets/.gitattributes`)).toBe('* text=auto eol=lf\n');
		// Only the named paths differ.
		expect(show(repo.dir, `${outcome.tree}:assets/cache/b.sqlite`)).toBe(show(repo.dir, `${repo.tree}:assets/cache/b.sqlite`));
		// The same tree, the same result.
		expect(dropLfsContent({ treeDir: repo.dir, scratchDir: scratch('lfs-again'), tree: repo.tree }).tree).toBe(outcome.tree);
	});

	it('leaves a tree with no git-lfs content and no rule as it is', () => {
		const repo = repository('lfs-none', { '.gitattributes': '* text=auto\n*.png binary\n', 'a.txt': 'a\n' });
		const outcome = dropLfsContent({ treeDir: repo.dir, scratchDir: scratch('lfs-none'), tree: repo.tree });
		expect(outcome).toEqual({ tree: repo.tree, report: { dropped: [], attributes: [] }, rewrites: [], leftovers: [] });
	});

	it('removes a file the rewrite leaves empty from the tree', () => {
		const repo = repository('lfs-empty', {
			'data/.gitattributes': '# lfs\n*.bin filter=lfs -text\n',
			'data/x.bin': pointer('x\n'),
			'data/y.txt': 'y\n'
		});
		const outcome = dropLfsContent({ treeDir: repo.dir, scratchDir: scratch('lfs-empty'), tree: repo.tree });
		expect(outcome.rewrites).toEqual([{ path: 'data/.gitattributes', rules: 1, removed: true }]);
		expect(files(repo.dir, outcome.tree)).toEqual(['data/y.txt']);
	});

	it('fails closed on a macro: a path it still gives to lfs, and a rule no path is left to match', () => {
		const macro = '[attr]lfsdata filter=lfs diff=lfs merge=lfs -text\n*.db lfsdata\n';
		const kept = repository('lfs-macro-path', { '.gitattributes': macro, 'data/x.db': pointer('x\n'), 'data/y.db': 'not a pointer\n' });
		const outcome = dropLfsContent({ treeDir: kept.dir, scratchDir: scratch('lfs-macro-path'), tree: kept.tree });
		expect(outcome.report).toEqual({ dropped: ['data/x.db'], attributes: [] });
		expect(outcome.leftovers).toEqual([
			{ path: 'data/y.db', rules: [{ file: '.gitattributes', line: 1, text: '[attr]lfsdata filter=lfs diff=lfs merge=lfs -text' }] }
		]);

		const dormant = repository('lfs-macro-rule', { '.gitattributes': macro, 'data/x.db': pointer('x\n') });
		expect(dropLfsContent({ treeDir: dormant.dir, scratchDir: scratch('lfs-macro-rule'), tree: dormant.tree }).leftovers).toEqual([
			{ path: null, rules: [{ file: '.gitattributes', line: 1, text: '[attr]lfsdata filter=lfs diff=lfs merge=lfs -text' }] }
		]);
	});
});

function repository(label: string, content: Readonly<Record<string, string>>): { readonly dir: string; readonly tree: string } {
	const dir = makeTempRoot(`${label}-repo`);
	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);
	for (const [path, text] of Object.entries(content)) {
		const absolute = join(dir, ...path.split('/'));
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, text, 'utf8');
	}
	fixtureCommit(dir, 'fixture: a tree for --no-lfs', '2026-01-01T00:00:00Z');
	return { dir, tree: fixtureGit(dir, ['rev-parse', 'HEAD^{tree}']).stdout.trim() };
}

function scratch(label: string): string {
	return makeTempRoot(`${label}-scratch`);
}

function files(dir: string, tree: string): readonly string[] {
	const listed = runGit({ args: ['ls-tree', '-r', '--name-only', '-z', tree], cwd: dir });
	expect(listed.status, listed.stderr).toBe(0);
	return listed.stdout.split('\0').filter((path) => path !== '');
}

function show(dir: string, object: string): string {
	const shown = runGit({ args: ['cat-file', '-p', object], cwd: dir });
	expect(shown.status, shown.stderr).toBe(0);
	return shown.stdout;
}

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}
