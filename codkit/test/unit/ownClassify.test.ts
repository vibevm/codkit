// Which side of an own file moved (PROP-008 ##PATCHSET-SIDE-EDIT-RULE), and what
// `save` mirrors back because of it (##OWN-COPY-ALGORITHM, reversed).
//
// The classifier is what makes the two directions of truth co-exist: `sync`
// applies patchset over the tree, `save` extracts the tree into patchset, and the map
// the mark recorded at the last sync is the only evidence of which side of a
// difference actually moved.

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyOwn, mirrorOwnBack, ownStateOfTree, ownStateOfPatchSet, syncOwnCode } from '../../src/lib/ownCopy.ts';
import type { OwnFileMap } from '../../src/lib/ownCopy.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const OWN_DIR = 'patchset';

afterAll(() => {
	cleanupTempRoots();
});

type Sides = { readonly patchesDir: string; readonly treeDir: string };

/** Two own directories on unrelated paths, filled from the two maps. */
function makeSides(label: string, patchset: Record<string, string>, tree: Record<string, string>): Sides {
	const patchesDir = makeTempRoot(`own-${label}-patchset`);
	const treeDir = makeTempRoot(`own-${label}-tree`);
	for (const [relative, content] of Object.entries(patchset)) {
		write(join(patchesDir, 'delta', 'own', relative), content);
	}
	for (const [relative, content] of Object.entries(tree)) {
		write(join(treeDir, 'src', 'vs', OWN_DIR, relative), content);
	}
	return { patchesDir, treeDir };
}

function write(absolute: string, content: string): void {
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
}

function kinds(sides: Sides, mark: OwnFileMap | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of classifyOwn(sides.patchesDir, sides.treeDir, OWN_DIR, mark)) {
		out[entry.relative] = entry.kind;
	}
	return out;
}

describe('classifyOwn', () => {
	it('tells the four classes apart against the map of the mark', () => {
		const sides = makeSides(
			'four',
			{ 'same.ts': 'a\n', 'patchset.ts': 'edited in patchset\n', 'tree.ts': 'as of the mark\n', 'both.ts': 'the patchset version\n' },
			{ 'same.ts': 'a\n', 'patchset.ts': 'as of the mark\n', 'tree.ts': 'edited in the tree\n', 'both.ts': 'the tree version\n' }
		);
		// The mark records the state both sides had after the last sync.
		const mark = ownStateOfTree(sides.treeDir, OWN_DIR).files;
		const asOfMark: OwnFileMap = {
			'same.ts': mark['same.ts'] ?? '',
			'patchset.ts': mark['patchset.ts'] ?? '',
			'tree.ts': ownStateOfPatchSet(sides.patchesDir).files['tree.ts'] ?? '',
			'both.ts': 'a-sha-neither-side-has-any-more'
		};

		expect(kinds(sides, asOfMark)).toEqual({
			'same.ts': 'same',
			'patchset.ts': 'patchset-edited',
			'tree.ts': 'tree-edited',
			'both.ts': 'both-edited'
		});
	});

	it('reads a file only one side has as an edit of that side', () => {
		const sides = makeSides('presence', { 'new-in-patchset.ts': 'x\n', 'deleted-in-tree.ts': 'y\n' }, { 'new-in-tree.ts': 'z\n' });
		const patchset = ownStateOfPatchSet(sides.patchesDir).files;
		const mark: OwnFileMap = { 'deleted-in-tree.ts': patchset['deleted-in-tree.ts'] ?? '' };

		expect(kinds(sides, mark)).toEqual({
			'new-in-patchset.ts': 'patchset-edited',
			'deleted-in-tree.ts': 'tree-edited',
			'new-in-tree.ts': 'tree-edited'
		});
	});

	it('answers "unknown" when there is no map to judge by', () => {
		const sides = makeSides('nomap', { 'a.ts': 'one\n' }, { 'a.ts': 'another\n' });
		expect(kinds(sides, null)).toEqual({ 'a.ts': 'unknown' });
	});

	it('ignores the .gitkeep of an empty directory on the patchset side', () => {
		const sides = makeSides('gitkeep', { 'dir/.gitkeep': '', 'a.ts': 'x\n' }, { 'a.ts': 'x\n' });
		expect(kinds(sides, {})).toEqual({ 'a.ts': 'same' });
	});

	it('gives the same fingerprint to the same content and a different one otherwise', () => {
		const sides = makeSides('fingerprint', { 'a.ts': 'x\n' }, { 'a.ts': 'x\n' });
		expect(ownStateOfPatchSet(sides.patchesDir).fingerprint).toBe(ownStateOfTree(sides.treeDir, OWN_DIR).fingerprint);
		write(join(sides.treeDir, 'src', 'vs', OWN_DIR, 'a.ts'), 'y\n');
		expect(ownStateOfPatchSet(sides.patchesDir).fingerprint).not.toBe(ownStateOfTree(sides.treeDir, OWN_DIR).fingerprint);
	});
});

describe('mirrorOwnBack', () => {
	it('extracts what the tree moved and keeps what only patchset moved', () => {
		const sides = makeSides(
			'mirror',
			{ 'tree.ts': 'as of the mark\n', 'patchset.ts': 'edited in patchset\n', 'gone.ts': 'still in patchset\n' },
			{ 'tree.ts': 'edited in the tree\n', 'patchset.ts': 'as of the mark\n' }
		);
		const patchset = ownStateOfPatchSet(sides.patchesDir).files;
		const tree = ownStateOfTree(sides.treeDir, OWN_DIR).files;
		const mark: OwnFileMap = {
			'tree.ts': patchset['tree.ts'] ?? '',
			'patchset.ts': tree['patchset.ts'] ?? '',
			'gone.ts': patchset['gone.ts'] ?? ''
		};

		const report = mirrorOwnBack(sides.patchesDir, sides.treeDir, OWN_DIR, classifyOwn(sides.patchesDir, sides.treeDir, OWN_DIR, mark));

		expect(report.copied).toBe(1);
		expect(report.kept).toBe(1);
		expect(report.removed).toBe(1);
		expect(readFileSync(join(sides.patchesDir, 'delta', 'own', 'tree.ts'), 'utf8')).toBe('edited in the tree\n');
		expect(readFileSync(join(sides.patchesDir, 'delta', 'own', 'patchset.ts'), 'utf8')).toBe('edited in patchset\n');
		// The tree no longer has it and the mark says it had: the deletion is
		// work of the tree like any other.
		expect(existsSync(join(sides.patchesDir, 'delta', 'own', 'gone.ts'))).toBe(false);
	});

	it('does not delete a patchset file the tree never had', () => {
		const sides = makeSides('mirror-new', { 'fresh.ts': 'written in patchset\n' }, {});
		const report = mirrorOwnBack(sides.patchesDir, sides.treeDir, OWN_DIR, classifyOwn(sides.patchesDir, sides.treeDir, OWN_DIR, {}));

		expect(report.removed).toBe(0);
		expect(report.kept).toBe(1);
		expect(readFileSync(join(sides.patchesDir, 'delta', 'own', 'fresh.ts'), 'utf8')).toBe('written in patchset\n');
	});

	it('takes the tree side when there is no map, as codkit did before the map', () => {
		const sides = makeSides('mirror-unknown', { 'a.ts': 'the patchset version\n' }, { 'a.ts': 'the tree version\n' });
		mirrorOwnBack(sides.patchesDir, sides.treeDir, OWN_DIR, classifyOwn(sides.patchesDir, sides.treeDir, OWN_DIR, null));
		expect(readFileSync(join(sides.patchesDir, 'delta', 'own', 'a.ts'), 'utf8')).toBe('the tree version\n');
	});

	it('leaves the own root of patchset in place when everything under it goes', () => {
		const sides = makeSides('mirror-empty', { 'a.ts': 'x\n' }, {});
		const mark: OwnFileMap = { 'a.ts': ownStateOfPatchSet(sides.patchesDir).files['a.ts'] ?? '' };
		mirrorOwnBack(sides.patchesDir, sides.treeDir, OWN_DIR, classifyOwn(sides.patchesDir, sides.treeDir, OWN_DIR, mark));

		expect(existsSync(join(sides.patchesDir, 'delta', 'own', 'a.ts'))).toBe(false);
		expect(existsSync(join(sides.patchesDir, 'delta', 'own'))).toBe(true);
	});
});

describe('ownStateOfPatchSet', () => {
	it('is empty and stable when there is no own code at all', () => {
		const root = makeTempRoot('own-absent');
		const first = ownStateOfPatchSet(root);
		expect(first.files).toEqual({});
		expect(ownStateOfPatchSet(root).fingerprint).toBe(first.fingerprint);
		rmSync(root, { recursive: true, force: true });
	});
});

describe('syncOwnCode path safety', () => {
	it('refuses a symlink on the tree side before overwriting its external target', () => {
		const sides = makeSides('target-symlink', { 'linked.ts': 'from patchset\n', 'other.ts': 'also from patchset\n' }, {});
		const outside = makeTempRoot('own-target-symlink-outside');
		const victim = join(outside, 'victim.ts');
		writeFileSync(victim, 'outside bytes\n', 'utf8');
		const link = join(sides.treeDir, 'src', 'vs', OWN_DIR, 'linked.ts');
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(victim, link);

		expect(() => syncOwnCode(sides.patchesDir, sides.treeDir, OWN_DIR)).toThrow(/symlink/i);
		expect(readFileSync(victim, 'utf8')).toBe('outside bytes\n');
		expect(existsSync(join(sides.treeDir, 'src', 'vs', OWN_DIR, 'other.ts'))).toBe(false);
	});
});
