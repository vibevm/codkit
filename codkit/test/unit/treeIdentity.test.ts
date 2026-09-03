// unit: the identity checks of PROP-008 sec. 2, on generated fixtures.
//
// Every case runs against a real git repository on an unrelated temp path
// (PROP-013 ##TP-REAL-GIT-FAKE-HEAVY, ##TP-UNRELATED-PATHS); nothing here looks
// at the machine's real fork tree.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import type { ForkDirResolution } from '../../src/lib/paths.ts';
import { checkTree, LFS_POINTER_MARKER } from '../../src/lib/treeIdentity.ts';
import type { TreeCheck, TreeCheckId } from '../../src/lib/treeIdentity.ts';
import { fixtureCommit, fixtureGit, makeUpstream, pinDate } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

/** A pre-resolved flag source; path resolution has its own focused suite. */
function resolution(path: string): ForkDirResolution {
	return { path, source: 'flag', exists: true, warning: null };
}

function configFor(fixture: UpstreamFixture): CodkitConfig {
	return {
		codkitConfig: 1,
		pin: { tag: fixture.t1.tag, sha: fixture.t1.sha, date: pinDate(fixture.t1.dateIso) },
		upstreamAnchorCommit: fixture.anchorSha,
		ownDirName: 'patchset',
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	};
}

function withPin(config: CodkitConfig, sha: string): CodkitConfig {
	return { ...config, pin: { ...config.pin, sha } };
}

function upstreamFixture(label: string): UpstreamFixture {
	return makeUpstream(makeTempRoot(label));
}

function ids(checks: readonly TreeCheck[]): TreeCheckId[] {
	return checks.map((check) => check.id);
}

function find(checks: readonly TreeCheck[], id: TreeCheckId): TreeCheck {
	const found = checks.find((check) => check.id === id);
	if (found === undefined) {
		throw new Error(`check ${id} did not run`);
	}
	return found;
}

describe('checkTree on a healthy tree', () => {
	it('passes every check in spec order', () => {
		const fixture = upstreamFixture('healthy');
		const result = checkTree(resolution(fixture.dir), configFor(fixture), { mode: 'read' });

		expect(result.fatal).toBeNull();
		expect(ids(result.checks)).toEqual(['repo', 'upstream', 'pin', 'lfs']);
		expect(result.checks.every((check) => check.ok)).toBe(true);
		// A read-only caller is not asked to prove it can write.
		expect(result.dirtyFiles).toBeUndefined();
	});

	it('adds the write probe in write mode and leaves nothing behind', () => {
		const fixture = upstreamFixture('writable');
		const result = checkTree(resolution(fixture.dir), configFor(fixture), { mode: 'write' });

		expect(result.fatal).toBeNull();
		expect(ids(result.checks)).toEqual(['repo', 'upstream', 'pin', 'lfs', 'write']);
		expect(find(result.checks, 'write').ok).toBe(true);
		expect(existsSync(join(fixture.dir, '.git', 'codkit', '.write-probe'))).toBe(false);
	});
});

describe('checkTree fatal conditions', () => {
	it('reports NOT-A-REPO for a directory that is not a repository', () => {
		const plain = makeTempRoot('plain');
		const fixture = upstreamFixture('anchor-source');
		const result = checkTree(resolution(plain), configFor(fixture), { mode: 'read' });

		expect(result.fatal?.code).toBe('NOT-A-REPO');
		expect(result.fatal?.hint).toContain('codkit clone');
		expect(ids(result.checks)).toEqual(['repo']);
		expect(find(result.checks, 'repo').ok).toBe(false);
	});

	it('reports NOT-A-REPO for a path that does not exist', () => {
		const missing = join(makeTempRoot('missing'), 'no-such-tree');
		const fixture = upstreamFixture('anchor-source');
		const result = checkTree(resolution(missing), configFor(fixture), { mode: 'read' });

		expect(result.fatal?.code).toBe('NOT-A-REPO');
	});

	it('reports NOT-UPSTREAM for a git repository from another history', () => {
		const stranger = makeTempRoot('stranger');
		fixtureGit(stranger, ['init', '--quiet', '--initial-branch=main', '.']);
		writeFileSync(join(stranger, 'unrelated.txt'), 'not vs code\n', 'utf8');
		fixtureCommit(stranger, 'unrelated project', '2026-01-03T00:00:00Z');

		const fixture = upstreamFixture('anchor-source');
		const result = checkTree(resolution(stranger), configFor(fixture), { mode: 'read' });

		expect(result.fatal?.code).toBe('NOT-UPSTREAM');
		expect(result.fatal?.message).toContain(fixture.anchorSha);
		expect(ids(result.checks)).toEqual(['repo', 'upstream']);
	});

	it('reports PIN-UNREACHABLE when the pin sha is well-formed but absent', () => {
		const fixture = upstreamFixture('no-pin');
		const absent = 'deadbeef'.repeat(5);
		const result = checkTree(resolution(fixture.dir), withPin(configFor(fixture), absent), { mode: 'read' });

		expect(result.fatal?.code).toBe('PIN-UNREACHABLE');
		expect(result.fatal?.hint).toContain('fetch origin tag');
		expect(ids(result.checks)).toEqual(['repo', 'upstream', 'pin']);
	});

	it('reports PIN-UNREACHABLE when the pin exists but is not a descendant of the anchor', () => {
		const fixture = upstreamFixture('orphan-pin');
		// A parentless commit over the pin's own tree: present as an object, but
		// outside the history the anchor belongs to.
		const orphan = fixtureGit(fixture.dir, ['commit-tree', `${fixture.t1.sha}^{tree}`, '-m', 'orphan'], {
			GIT_AUTHOR_NAME: 'fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_AUTHOR_DATE: '2026-01-01T00:10:00Z',
			GIT_COMMITTER_NAME: 'fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_DATE: '2026-01-01T00:10:00Z'
		}).stdout.trim();

		const result = checkTree(resolution(fixture.dir), withPin(configFor(fixture), orphan), { mode: 'read' });

		expect(result.fatal?.code).toBe('PIN-UNREACHABLE');
		expect(result.fatal?.message).toContain('does not descend');
	});

	it('reports TREE-READONLY when the scratch directory cannot be created', () => {
		const fixture = upstreamFixture('read-only');
		// A plain file where codkit wants its scratch directory: the write probe
		// fails the same way a read-only mount makes it fail, on any uid.
		writeFileSync(join(fixture.dir, '.git', 'codkit'), 'in the way\n', 'utf8');

		const result = checkTree(resolution(fixture.dir), configFor(fixture), { mode: 'write' });

		expect(result.fatal?.code).toBe('TREE-READONLY');
		expect(ids(result.checks)).toEqual(['repo', 'upstream', 'pin', 'lfs', 'write']);
		expect(find(result.checks, 'write').ok).toBe(false);
	});
});

describe('checkTree git-lfs check', () => {
	it('passes vacuously on a tree that tracks nothing with lfs', () => {
		const fixture = upstreamFixture('no-lfs');
		const result = checkTree(resolution(fixture.dir), configFor(fixture), { mode: 'read' });

		const lfs = find(result.checks, 'lfs');
		expect(lfs.ok).toBe(true);
		// The info line is what tells a reader the check did not silently skip.
		expect(lfs.info).toContain('no LFS-tracked paths');
	});

	it('reports LFS when a tracked path is still a pointer file', () => {
		const tree = makeTempRoot('lfs-pointer');
		fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
		writeFileSync(join(tree, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n', 'utf8');
		// Exactly the bytes git-lfs leaves behind when the content was never pulled.
		writeFileSync(join(tree, 'blob.bin'), `${LFS_POINTER_MARKER}\noid sha256:${'0'.repeat(64)}\nsize 3\n`, 'utf8');
		const sha = fixtureCommit(tree, 'lfs fixture', '2026-01-03T00:00:00Z');

		const config: CodkitConfig = {
			codkitConfig: 1,
			pin: { tag: 'lfs-fixture', sha, date: '2026-01-03' },
			upstreamAnchorCommit: sha,
			ownDirName: 'patchset',
			generatedBranchPrefix: 'codkit/applied/',
			cycleBranchPrefix: 'codkit/cycle/',
			releaseRefPrefix: 'codkit/release/',
			publishRemoteUrl: null,
			buildWatchFile: null,
			conventionsExtensionFile: null
		};
		const result = checkTree(resolution(tree), config, { mode: 'read' });

		// Whichever branch the machine takes - git-lfs present (ls-files sees the
		// path, the sample sees the pointer) or absent (filter=lfs in
		// .gitattributes at the pin) - the verdict is the same code.
		expect(result.fatal?.code).toBe('LFS');
		expect(find(result.checks, 'lfs').ok).toBe(false);
	});
});

describe('checkTree cleanliness', () => {
	it('lists changes outside the own directory', () => {
		const fixture = upstreamFixture('dirty');
		writeFileSync(join(fixture.dir, 'README.md'), 'edited by hand\n', 'utf8');

		const result = checkTree(resolution(fixture.dir), configFor(fixture), { mode: 'read', requireClean: true });

		expect(result.fatal).toBeNull();
		expect(result.dirtyFiles).toEqual(['README.md']);
		expect(find(result.checks, 'clean').ok).toBe(false);
	});

	it('does not count own code as dirt', () => {
		const fixture = upstreamFixture('own-only');
		const own = join(fixture.dir, 'src', 'vs', 'patchset');
		mkdirSync(own, { recursive: true });
		writeFileSync(join(own, 'scratch.ts'), 'export const scratch = 1;\n', 'utf8');

		const result = checkTree(resolution(fixture.dir), configFor(fixture), { mode: 'read', requireClean: true });

		expect(result.fatal).toBeNull();
		expect(result.dirtyFiles).toEqual([]);
		expect(find(result.checks, 'clean').ok).toBe(true);
	});
});
