// unit: the line endings a fork tree holds against its blobs (PROP-002
// ##GIT-ENV-EOL). A CRLF working copy over an LF blob that no eol=crlf
// attribute asks for is what a checkout under the machine's configuration
// leaves behind: git's stat cache calls it unchanged, and the cycle's proof of
// the moved bytes would refuse it after the long build. The listing reads the
// copies, so it finds them first; what the attributes ask for, and a blob that
// holds CRLF itself, are not its business.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isCkError } from '../../src/lib/messages.ts';
import { assertTreeLineEndings, crlfWorktreeFiles } from '../../src/lib/treeLineEndings.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

function write(root: string, relative: string, text: string): void {
	const absolute = join(root, ...relative.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, text);
}

function tree(): string {
	const root = makeTempRoot('eol-tree');
	fixtureGit(root, ['init', '--quiet', '--initial-branch=main', '.']);
	write(root, '.gitattributes', '* text=auto\n*.bat eol=crlf\n*.bin -text\n');
	write(root, 'plain.md', 'a\nb\n');
	write(root, 'mixed.md', 'a\nb\n');
	write(root, 'script.bat', 'echo a\r\necho b\r\n');
	write(root, 'data.bin', 'x\r\ny\r\n');
	fixtureCommit(root, 'fixture: lf blobs, crlf where asked for', '2026-08-31T00:00:00Z');
	return root;
}

describe('crlfWorktreeFiles (##GIT-ENV-EOL)', () => {
	it('finds nothing in a tree whose copies hold what the blobs and the attributes say', () => {
		expect(crlfWorktreeFiles(tree())).toEqual([]);
	});

	it('names a CRLF or mixed copy over an LF blob that no eol=crlf attribute asks for', () => {
		const root = tree();
		write(root, 'plain.md', 'a\r\nb\r\n');
		write(root, 'mixed.md', 'a\r\nb\n');
		write(root, 'data.bin', 'x\r\ny\r\n');

		expect(crlfWorktreeFiles(root).map((file) => [file.path, file.index, file.worktree, file.attributes])).toEqual([
			['mixed.md', 'lf', 'mixed', 'text=auto'],
			['plain.md', 'lf', 'crlf', 'text=auto']
		]);
	});
});

describe('assertTreeLineEndings (##GIT-ENV-EOL)', () => {
	it('passes a tree without such copies and reports nothing', () => {
		const lines: string[] = [];
		expect(() => assertTreeLineEndings(tree(), (text) => lines.push(text))).not.toThrow();
		expect(lines).toEqual([]);
	});

	it('refuses with the paths, the count and the recipe that rewrites the copies', () => {
		const root = tree();
		write(root, 'plain.md', 'a\r\nb\r\n');
		write(root, 'mixed.md', 'a\r\nb\n');
		const lines: string[] = [];
		let caught: unknown = null;
		try {
			assertTreeLineEndings(root, (text) => lines.push(text));
		} catch (error) {
			caught = error;
		}
		if (!isCkError(caught)) throw new Error('expected a CkError');
		expect(caught.code).toBe('CRLF');
		expect(caught.message).toContain('2 tracked file(s) of the fork tree hold CRLF line endings');
		expect(caught.message).toContain('mixed.md, plain.md');
		expect(caught.hint).toContain('core.autocrlf false');
		expect(caught.hint).toContain('core.eol lf');
		expect(caught.hint).toContain('checkout-index --force');
		expect(lines).toEqual([
			'  crlf: mixed.md (blob lf, working copy mixed, attr text=auto)',
			'  crlf: plain.md (blob lf, working copy crlf, attr text=auto)'
		]);
	});
});
