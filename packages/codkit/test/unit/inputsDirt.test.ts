// unit: an exact delivery of an input is a runtime copy of another repository,
// not dirt of the tree (PROP-008 ##INPUTS-LOAD). The guards that judge the tree
// - check-tree --require-clean, the materialization, resolve and stabilize of
// the upgrade cycle - read a delivered input through one list, so the list is
// what is proved here: an exact file is in it, an edited one, an added one and
// a file of an input the tree never received are not.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { InputConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { writeInputStore } from '../../src/lib/inputsStore.ts';
import { deliveredInputTargets, withoutDeliveredInputDirt } from '../../src/lib/inputsTree.ts';
import { fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const DELIVERED = 'delivered\n';
const ORIGINAL = 'original\n';
const EDITED = 'edited in the tree\n';
const DOCS = { name: 'docs', to: 'documentation' } as InputConfig;
const NOTES = { name: 'notes', to: 'notes' } as InputConfig;

let tree: string;
const warnings: string[] = [];

beforeEach(() => {
	warnings.length = 0;
	tree = makeTempRoot('input-dirt-tree');
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	write(tree, 'documentation/doc.md', DELIVERED);
	write(tree, 'documentation/edited.md', EDITED);
	write(tree, 'documentation/added.md', 'added by hand\n');
	write(tree, 'notes/never.md', 'never delivered\n');
	writeInputStore(tree, [
		{
			name: 'docs',
			to: 'documentation',
			mode: 'working',
			commit: null,
			stamp: '0'.repeat(64),
			files: { 'doc.md': blobOf(DELIVERED), 'edited.md': blobOf(ORIGINAL) }
		}
	]);
});

afterAll(cleanupTempRoots);

function write(root: string, relative: string, text: string): void {
	const absolute = join(root, ...relative.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, text, 'utf8');
}

function blobOf(text: string): string {
	return runGit({ args: ['hash-object', '--stdin'], cwd: tree, input: text }).stdout.trim();
}

const warn = (text: string): void => {
	warnings.push(text);
};

describe('deliveredInputTargets (##INPUTS-LOAD)', () => {
	it('names every recorded file whose tree copy holds what codkit delivered', () => {
		expect(deliveredInputTargets(tree, [DOCS, NOTES], warn)).toEqual(['documentation/doc.md']);
		expect(warnings).toEqual([]);
	});

	it('names nothing for an input the tree never received', () => {
		expect(deliveredInputTargets(tree, [NOTES], warn)).toEqual([]);
	});
});

describe('withoutDeliveredInputDirt (##INPUTS-LOAD)', () => {
	it('drops only the untracked entries of exact deliveries', () => {
		const entries = [
			{ status: '??', path: 'documentation/doc.md' },
			{ status: '??', path: 'documentation/edited.md' },
			{ status: '??', path: 'documentation/added.md' },
			{ status: ' M', path: 'documentation/doc.md' },
			{ status: '??', path: 'notes/never.md' },
			{ status: '??', path: 'stray.txt' }
		];

		expect(withoutDeliveredInputDirt(entries, tree, [DOCS, NOTES], warn)).toEqual([
			{ status: '??', path: 'documentation/edited.md' },
			{ status: '??', path: 'documentation/added.md' },
			{ status: ' M', path: 'documentation/doc.md' },
			{ status: '??', path: 'notes/never.md' },
			{ status: '??', path: 'stray.txt' }
		]);
	});

	it('leaves every entry alone when no input is declared', () => {
		const entries = [{ status: '??', path: 'documentation/doc.md' }];
		expect(withoutDeliveredInputDirt(entries, tree, [], warn)).toBe(entries);
	});
});
