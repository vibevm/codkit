// unit: the two pieces of `ci` that are decidable without a container - the
// dependency fast path (PROP-011 sec. 4) and the safe.directory file
// (PROP-011 sec. 5).
//
// What is deliberately NOT here: the dubious-ownership branch itself. Provoking
// it needs a tree owned by another uid, which needs chown, which needs a root
// this suite does not have. What the branch does once it has decided - write the
// file, point the run at it - is what these tests and the gitx ones cover.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CI_GITCONFIG_PATH, DEPS_HASH_PATH, checkDeps, depsHash, depsReceiptsOf, writeCiGitConfig } from '../../src/lib/ciEngine.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** A family with two dependency roots: enough to tell "one of them" from "none". */
const ROOTS: readonly string[] = ['node_modules', 'build/node_modules'];
const RECEIPTS = depsReceiptsOf(ROOTS);

describe('the dependency fast path', () => {
	it('refuses a tree without node_modules, whatever the manifests say', () => {
		const patchesDir = makeTempRoot('deps-patchset');
		const tree = makeTempRoot('deps-tree');
		writeFileSync(join(tree, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');

		expect(checkDeps(patchesDir, tree, ROOTS).kind).toBe('missing');
		// Nothing was recorded: there is nothing to remember about a tree whose
		// dependencies never arrived.
		expect(existsSync(join(patchesDir, ...DEPS_HASH_PATH.split('/')))).toBe(false);
	});

	it('names the receipt that is missing, not the root the tree already has', () => {
		const patchesDir = makeTempRoot('deps-patchset-partial');
		const tree = makeTempRoot('deps-tree-partial');
		const first = RECEIPTS[0] as string;
		mkdirSync(join(tree, ...first.split('/'), '..'), { recursive: true });
		writeFileSync(join(tree, ...first.split('/')), '{"lockfileVersion":3}\n', 'utf8');

		// The tree has node_modules; only the second install root never arrived,
		// and that is what the report has to say.
		expect(checkDeps(patchesDir, tree, ROOTS)).toEqual({ kind: 'missing', hash: '', missing: [RECEIPTS[1]] });
	});

	it('asks a type with one dependency root for one receipt only', () => {
		const patchesDir = makeTempRoot('deps-patchset-single');
		const tree = makeTempRoot('deps-tree-single');
		mkdirSync(join(tree, 'node_modules'), { recursive: true });
		writeFileSync(join(tree, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');

		expect(checkDeps(patchesDir, tree, ['node_modules']).kind).toBe('recorded');
	});

	it('records the lock state once, then keeps answering "unchanged"', () => {
		const patchesDir = makeTempRoot('deps-patchset-2');
		const tree = makeTempRoot('deps-tree-2');
		provideDependencies(tree);
		writeFileSync(join(tree, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
		writeFileSync(join(tree, '.nvmrc'), '24.18.0\n', 'utf8');

		const first = checkDeps(patchesDir, tree, ROOTS);
		expect(first.kind).toBe('recorded');
		expect(checkDeps(patchesDir, tree, ROOTS)).toEqual({ kind: 'fresh', hash: first.hash, missing: [] });

		const record = JSON.parse(readFileSync(join(patchesDir, ...DEPS_HASH_PATH.split('/')), 'utf8')) as {
			codkitDepsHash: number;
			hash: string;
			treePath: string;
		};
		expect(record.codkitDepsHash).toBe(1);
		expect(record.hash).toBe(first.hash);
		expect(record.treePath).toBe(tree);
	});

	it('changes its verdict when the lock changes, and only then', () => {
		const patchesDir = makeTempRoot('deps-patchset-3');
		const tree = makeTempRoot('deps-tree-3');
		provideDependencies(tree);
		const lock = join(tree, 'package-lock.json');
		writeFileSync(lock, '{"lockfileVersion": 3}\n', 'utf8');

		const before = checkDeps(patchesDir, tree, ROOTS).hash;
		expect(checkDeps(patchesDir, tree, ROOTS).kind).toBe('fresh');

		writeFileSync(lock, '{"lockfileVersion": 3, "packages": {"": {"name": "x"}}}\n', 'utf8');
		expect(depsHash(tree)).not.toBe(before);
		expect(checkDeps(patchesDir, tree, ROOTS).kind).toBe('changed');
		// The record moved with it, so the warning is raised once per change.
		expect(checkDeps(patchesDir, tree, ROOTS).kind).toBe('fresh');

		// The node version is part of the same verdict: a toolchain change is a
		// dependency change (PROP-011 sec. 3, the cache key).
		writeFileSync(join(tree, '.nvmrc'), '26.0.0\n', 'utf8');
		expect(checkDeps(patchesDir, tree, ROOTS).kind).toBe('changed');
	});

	it('keeps the verdicts of two trees apart', () => {
		const patchesDir = makeTempRoot('deps-patchset-4');
		const one = makeTempRoot('deps-tree-4a');
		const two = makeTempRoot('deps-tree-4b');
		for (const tree of [one, two]) {
			provideDependencies(tree);
			writeFileSync(join(tree, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
		}

		expect(checkDeps(patchesDir, one, ROOTS).kind).toBe('recorded');
		// The record names one tree; the other one has never been seen, whatever
		// its manifests hash to.
		expect(checkDeps(patchesDir, two, ROOTS).kind).toBe('recorded');
		expect(checkDeps(patchesDir, one, ROOTS).kind).toBe('recorded');
	});

	it('rejects empty mountpoints even when the cached lock hash is fresh', () => {
		const patchesDir = makeTempRoot('deps-patchset-empty-mount');
		const tree = makeTempRoot('deps-tree-empty-mount');
		provideDependencies(tree);
		writeFileSync(join(tree, 'package-lock.json'), '{"lockfileVersion": 3}\n', 'utf8');
		expect(checkDeps(patchesDir, tree, ROOTS).kind).toBe('recorded');

		for (const relative of RECEIPTS) {
			unlinkSync(join(tree, ...relative.split('/')));
		}
		expect(checkDeps(patchesDir, tree, ROOTS)).toEqual({ kind: 'missing', hash: '', missing: RECEIPTS });
	});
});

function provideDependencies(tree: string): void {
	for (const relative of RECEIPTS) {
		const path = join(tree, ...relative.split('/'));
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, '{"lockfileVersion":3}\n', 'utf8');
	}
}

describe('the safe.directory file of the container', () => {
	it('creates it with both paths of the run', () => {
		const patchesDir = makeTempRoot('safe-patchset');
		const tree = makeTempRoot('safe-tree');

		const path = writeCiGitConfig(patchesDir, tree);
		const text = readFileSync(path, 'utf8');

		expect(path).toBe(join(patchesDir, ...CI_GITCONFIG_PATH.split('/')));
		expect(text).toContain('[safe]');
		expect(text).toContain(`\tdirectory = ${tree}`);
		expect(text).toContain(`\tdirectory = ${patchesDir}`);
		expect(text.endsWith('\n')).toBe(true);
	});

	it('extends an existing file instead of replacing what it lists', () => {
		const patchesDir = makeTempRoot('safe-patchset-2');
		const first = makeTempRoot('safe-tree-2a');
		const second = makeTempRoot('safe-tree-2b');

		writeCiGitConfig(patchesDir, first);
		const text = readFileSync(writeCiGitConfig(patchesDir, second), 'utf8');

		expect(text).toContain(`\tdirectory = ${first}`);
		expect(text).toContain(`\tdirectory = ${second}`);
		// One entry per path, however often the run repeats.
		expect(text.split('\n').filter((line) => line.includes(patchesDir)).length).toBe(1);
	});
});

describe('the channel calls of the build pass carry a warning channel', () => {
	it('wires onWarn into both the start and the teardown of every channel', () => {
		// The two acquisition points of the CI build pass are not injectable, so
		// their wiring is held the way the stabilization teardown holds its tree
		// binding: by the exact call shape in the source. A channel whose lock
		// cannot retire its own generation is reported on the run's own output,
		// not silent - the same contract `commands/build.ts` already carries.
		const source = readFileSync(join(import.meta.dirname, '../../src/lib/ciEngine.ts'), 'utf8');
		expect(source).toContain(
			'const result = upChannel({ patchesDir, treeDir: tree, treeId: id, onWarn: (text) => out.warn(text) }, channel);'
		);
		expect(source).toContain(
			'const result = await downChannel(patchesDir, channel.name, {\n' +
				'\t\t\t\t\texpectedTreeId: id,\n' +
				'\t\t\t\t\texpectedTreePath: tree,\n' +
				'\t\t\t\t\tonWarn: (text) => out.warn(text)\n' +
				'\t\t\t\t});'
		);
	});
});
