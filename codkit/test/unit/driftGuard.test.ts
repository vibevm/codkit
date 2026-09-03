// The drift guard (PROP-008 ##DRIFT-GUARD-PREDICATE).
//
// The two halves are tested separately, because they see different things: git
// sees the upstream files, and only a byte comparison sees own code, which is
// excluded from git locally.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driftDirty, porcelainEntries, upstreamDirt } from '../../src/lib/driftGuard.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const OWN_IN_TREE = 'src/vs/patchset/hello.ts';
const OWN_IN_PATCHSET = 'delta/own/hello.ts';

let fixture: SyncFixture;

beforeAll(() => {
	fixture = makeSyncFixture('drift');
	expect(fixture.sync().exitCode).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

function guard(): ReturnType<typeof driftDirty> {
	return driftDirty(fixture.treeDir, fixture.config.ownDirName, fixture.patchesDir);
}

/** Change something in the tree, look, put it back. */
function whileChanged<T>(relative: string, content: string, look: () => T): T {
	const absolute = join(fixture.treeDir, relative);
	let saved: Buffer | null = null;
	try {
		saved = readFileSync(absolute);
	} catch {
		saved = null;
	}
	writeFileSync(absolute, content, 'utf8');
	try {
		return look();
	} finally {
		if (saved === null) {
			rmSync(absolute, { force: true });
		} else {
			writeFileSync(absolute, saved);
		}
	}
}

describe('driftDirty', () => {
	it('is clean right after a sync', () => {
		const result = guard();
		expect(result.dirty).toBe(false);
		expect(result.files).toEqual([]);
		// Own code exists on both sides and matches byte for byte.
		expect(result.own).toEqual([]);
	});

	it('reports an edit of an upstream file', () => {
		const result = whileChanged(EXAMPLE_PART_PATH, '// replaced by hand\n', guard);
		expect(result.dirty).toBe(true);
		expect(result.files).toContain(EXAMPLE_PART_PATH);
		expect(result.upstream).toContain(EXAMPLE_PART_PATH);
	});

	it('reports an edit of own code that git cannot see', () => {
		const result = whileChanged(OWN_IN_TREE, '// edited in the tree\n', guard);

		expect(result.dirty).toBe(true);
		// git says nothing about it: the own directory is excluded locally.
		expect(result.upstream).toEqual([]);
		expect(upstreamDirt(fixture.treeDir, fixture.config.ownDirName)).toEqual([]);
		expect(result.own).toContainEqual({ relative: 'hello.ts', kind: 'both' });
		expect(result.files.some((path) => path.startsWith(OWN_IN_TREE) && path.includes(OWN_IN_PATCHSET))).toBe(true);
	});

	it('reports an own file the tree has and patchset does not', () => {
		const result = whileChanged('src/vs/patchset/strayNote.ts', '// never extracted\n', guard);
		expect(result.dirty).toBe(true);
		expect(result.own).toContainEqual({ relative: 'strayNote.ts', kind: 'tree-only' });
	});

	it('does not call own code that is merely not materialized yet dirt', () => {
		const inTree = join(fixture.treeDir, OWN_IN_TREE);
		const saved = readFileSync(inTree);
		rmSync(inTree);
		try {
			const result = guard();
			expect(result.own).toContainEqual({ relative: 'hello.ts', kind: 'patchset-only' });
			expect(result.dirty).toBe(false);
		} finally {
			writeFileSync(inTree, saved);
		}
	});

	it('counts untracked paths, unless the caller is about to clean them', () => {
		const litter = join(fixture.treeDir, 'left-behind.txt');
		writeFileSync(litter, 'junk\n', 'utf8');
		try {
			expect(guard().files).toContain('left-behind.txt');
			const fresh = driftDirty(fixture.treeDir, fixture.config.ownDirName, fixture.patchesDir, { untrackedIsDirt: false });
			expect(fresh.dirty).toBe(false);
		} finally {
			rmSync(litter, { force: true });
		}
	});
});

describe('.gitkeep in own code', () => {
	it('is not materialized in the tree and is not a divergence', () => {
		const keep = join(fixture.patchesDir, 'delta', 'own', 'modes', '.gitkeep');
		mkdirSync(dirname(keep), { recursive: true });
		writeFileSync(keep, '', 'utf8');

		// The fingerprint moved, so this is a full apply, own copy included.
		expect(fixture.sync().exitCode).toBe(0);

		expect(existsSync(join(fixture.treeDir, 'src', 'vs', 'patchset', 'modes', '.gitkeep'))).toBe(false);
		expect(guard().dirty).toBe(false);
	});
});

describe('porcelainEntries', () => {
	it('keeps the status and takes the new path of a rename', () => {
		expect(porcelainEntries(' M src/vs/a.ts\n?? litter.txt\nR  old.ts -> new.ts\n')).toEqual([
			{ status: ' M', path: 'src/vs/a.ts' },
			{ status: '??', path: 'litter.txt' },
			{ status: 'R ', path: 'new.ts' }
		]);
	});
});
