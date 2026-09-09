/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	REBASE_MOVE_PATH,
	assertCompletedRebaseMoveSyncTree,
	assertRebasePendingMoveBinding,
	materializeRebaseDesiredTree,
	rebaseMovePending,
	retireCompletedRebaseMove,
	retireHistoricalCompletedRebaseMove,
	type RebaseMoveOptions
} from '../../src/lib/rebaseOntoPinMove.ts';
import { rebasePendingPath, writeRebasePending } from '../../src/lib/rebaseOntoPinPending.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => cleanupTempRoots());

describe('completed rebase move receipt', () => {
	it('materializes changed LFS bytes, an executable mode, and a traversal-shaped symlink target with checkout semantics', () => {
		const current = materializationFixture('rebase-move-filter-link');
		const outside = join(current.tree, '..', '..', 'outside-target');
		expect(existsSync(outside)).toBe(false);
		const move = materializeRebaseDesiredTree(moveOptions(current));
		expect(move.paths).toEqual(['.gitattributes', 'asset.bin', 'link', 'script.sh']);
		expect(readFileSync(join(current.tree, 'asset.bin'), 'utf8')).toBe('new lfs payload\n');
		expect(readFileSync(join(current.tree, 'asset.bin'), 'utf8')).not.toContain('git-lfs.github.com/spec');
		expect(readlinkSync(join(current.tree, 'link'))).toBe('../../outside-target');
		expect(lstatSync(join(current.tree, 'link')).isSymbolicLink()).toBe(true);
		expect(lstatSync(join(current.tree, 'script.sh')).mode & 0o111).not.toBe(0);
		expect(existsSync(outside)).toBe(false);
		move.complete();
		const receipt = JSON.parse(readFileSync(join(current.patchset, REBASE_MOVE_PATH), 'utf8')) as {
			readonly codkitRebaseOntoPinMove: number;
			readonly state: string;
			readonly entries: readonly { readonly path: string; readonly after: { readonly mode: string } }[];
		};
		expect(receipt).toMatchObject({ codkitRebaseOntoPinMove: 2, state: 'complete' });
		expect(receipt.entries.find((entry) => entry.path === 'link')?.after.mode).toBe('120000');
		expect(fixtureGit(current.tree, ['show', `${current.desiredCommit}:asset.bin`]).stdout).toContain('git-lfs.github.com/spec');
		expect(() => assertCompletedRebaseMoveSyncTree(current.patchset, current.tree, current.desiredTree, current.desiredTree)).not.toThrow();
	});

	it('uses Git placeholder and ignored-filemode semantics when native links and mode trust are disabled', () => {
		const current = materializationFixture('rebase-move-portable-modes', { portableModes: true });
		expect(lstatSync(join(current.tree, 'link')).isFile()).toBe(true);
		expect(readFileSync(join(current.tree, 'link'), 'utf8')).toBe('old-target');
		const move = materializeRebaseDesiredTree(moveOptions(current));
		expect(lstatSync(join(current.tree, 'link')).isFile()).toBe(true);
		expect(readFileSync(join(current.tree, 'link'), 'utf8')).toBe('../../outside-target');
		expect(lstatSync(join(current.tree, 'script.sh')).mode & 0o111).toBe(0);
		move.complete();
		expect(() => assertCompletedRebaseMoveSyncTree(current.patchset, current.tree, current.desiredTree, current.desiredTree)).not.toThrow();
	});

	it('resumes a symlink temp rename window from the exact materialized receipt state', () => {
		const current = materializationFixture('rebase-move-link-resume');
		expect(() =>
			materializeRebaseDesiredTree({
				...moveOptions(current),
				tempCheckpoint(path) {
					if (path === 'link') throw new Error('injected symlink temp loss');
				}
			})
		).toThrow('injected symlink temp loss');
		const temp = join(current.tree, 'link.codkit-rebase-move.tmp');
		expect(lstatSync(temp).isSymbolicLink()).toBe(true);
		expect(readlinkSync(temp)).toBe('../../outside-target');
		const resumed = materializeRebaseDesiredTree(moveOptions(current));
		expect(existsSync(temp)).toBe(false);
		expect(readlinkSync(join(current.tree, 'link'))).toBe('../../outside-target');
		expect(readFileSync(join(current.tree, 'asset.bin'), 'utf8')).toBe('new lfs payload\n');
		resumed.complete();
	});

	it('fails closed before a receipt or worktree write when the required LFS object is unavailable', () => {
		const current = materializationFixture('rebase-move-lfs-missing');
		const pointer = fixtureGit(current.tree, ['show', `${current.desiredCommit}:asset.bin`]).stdout;
		const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
		if (oid === undefined) throw new Error('fixture LFS pointer missing');
		rmSync(join(current.tree, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid));
		expect(() => materializeRebaseDesiredTree(moveOptions(current))).toThrow(/required local LFS object is unavailable/);
		expect(readFileSync(join(current.tree, 'asset.bin'), 'utf8')).toBe('old lfs payload\n');
		expect(readlinkSync(join(current.tree, 'link'))).toBe('old-target');
		expect(existsSync(join(current.patchset, REBASE_MOVE_PATH))).toBe(false);
	});

	it('persists retry-identical pending intent and rejects a path collision', () => {
		const root = makeTempRoot('rebase-pending-retry');
		const override = {
			targetPath: 'src/conflict.ts',
			artifactPath: 'delta/patches/src__conflict.ts.ckpatch',
			artifactId: 'CK-workbench-999',
			cause: 'a'.repeat(40),
			pin: { tag: 't2', sha: 'b'.repeat(40) },
			artifactSha256: 'c'.repeat(64),
			headerMetadataSha256: 'e'.repeat(64),
			desiredTree: 'd'.repeat(40)
		};
		writeRebasePending(root, override);
		expect(() => writeRebasePending(root, override)).not.toThrow();
		writeFileSync(rebasePendingPath(root, override.targetPath), '{}\n');
		expect(() => writeRebasePending(root, override)).toThrow(/cannot be persisted atomically/);
	});

	it('recognizes but explicitly rejects a legacy v1 receipt without deleting its durable state', () => {
		const patchset = makeTempRoot('rebase-legacy-patchset');
		const tree = makeTempRoot('rebase-legacy-tree');
		fixtureGit(patchset, ['init', '--quiet', '--initial-branch=feature', '.']);
		fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
		writeFileSync(join(patchset, 'base.txt'), 'base\n');
		writeFileSync(join(tree, 'base.txt'), 'base\n');
		const patchsetHead = fixtureCommit(patchset, 'fixture: patchset head', '2026-08-21T00:03:00Z');
		const head = fixtureCommit(tree, 'fixture: fork head', '2026-08-21T00:04:00Z');
		const desiredTree = fixtureGit(tree, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
		const recordPath = join(patchset, REBASE_MOVE_PATH);
		mkdirSync(dirname(recordPath), { recursive: true });
		writeFileSync(
			recordPath,
			`${JSON.stringify({ codkitRebaseOntoPinMove: 1, state: 'complete', patchsetHead, head, desiredTree, entries: [] }, null, 2)}\n`
		);
		expect(rebaseMovePending(patchset)).toBe(true);
		expect(() => retireCompletedRebaseMove(patchset)).toThrow(/legacy v1 receipt lacks canonical object identity/);
		expect(existsSync(recordPath)).toBe(true);
	});

	it('binds conflict pending to one desired tree and retires only on a clean descendant merge', () => {
		const patchset = makeTempRoot('rebase-receipt-patchset');
		const tree = makeTempRoot('rebase-receipt-tree');
		fixtureGit(patchset, ['init', '--quiet', '--initial-branch=feature', '.']);
		fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
		writeFileSync(join(patchset, 'base.txt'), 'base\n');
		writeFileSync(join(tree, 'base.txt'), 'base\n');
		const oldPatchSetHead = fixtureCommit(patchset, 'fixture: old merge', '2026-08-20T00:00:00Z');
		const forkHead = fixtureCommit(tree, 'fixture: fork head', '2026-08-20T00:01:00Z');
		const desiredTree = fixtureGit(tree, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
		const target = 'src/conflict.ts';
		const record = {
			codkitRebaseOntoPinMove: 2,
			state: 'complete',
			patchsetHead: oldPatchSetHead,
			head: forkHead,
			desiredTree,
			entries: [{ path: target, before: null, after: null, beforeObject: null, afterObject: null }]
		};
		const recordPath = join(patchset, REBASE_MOVE_PATH);
		mkdirSync(dirname(recordPath), { recursive: true });
		writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

		expect(() => assertRebasePendingMoveBinding(patchset, tree, { desiredTree, targetPath: target }, false)).not.toThrow();
		expect(() => assertRebasePendingMoveBinding(patchset, tree, { desiredTree: 'f'.repeat(40), targetPath: target }, false)).toThrow(
			/not bound/
		);
		fixtureGit(patchset, ['checkout', '--quiet', '-b', 'later-target', oldPatchSetHead]);
		writeFileSync(join(patchset, 'target.txt'), 'target\n');
		fixtureCommit(patchset, 'fixture: later target', '2026-08-20T00:02:00Z');
		fixtureGit(patchset, ['checkout', '--quiet', 'feature']);
		writeFileSync(join(patchset, 'next.txt'), 'next\n');
		fixtureCommit(patchset, 'fixture: later feature', '2026-08-20T00:03:00Z');
		fixtureGit(patchset, [
			'-c',
			'user.name=fixture',
			'-c',
			'user.email=fixture@example.invalid',
			'merge',
			'--no-ff',
			'--no-edit',
			'later-target'
		]);
		const nextHead = fixtureGit(patchset, ['rev-parse', 'HEAD']).stdout.trim();
		expect(fixtureGit(patchset, ['rev-list', '--parents', '-n', '1', nextHead]).stdout.trim().split(' ')).toHaveLength(3);
		expect(retireHistoricalCompletedRebaseMove(patchset, tree, nextHead)).toBe(true);
		expect(existsSync(recordPath)).toBe(false);
	});
});

type MaterializationFixture = {
	readonly patchset: string;
	readonly tree: string;
	readonly head: string;
	readonly desiredTree: string;
	readonly desiredCommit: string;
	readonly patchsetHead: string;
};

function materializationFixture(label: string, options: { readonly portableModes?: boolean } = {}): MaterializationFixture {
	const tree = makeTempRoot(`${label}-tree`);
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.clean', 'git-lfs clean -- %f']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.smudge', 'git-lfs smudge -- %f']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.process', 'git-lfs filter-process']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.required', 'true']);
	writeFileSync(join(tree, 'asset.bin'), 'old lfs payload\n');
	writeFileSync(join(tree, 'script.sh'), '#!/bin/sh\nexit 0\n');
	symlinkSync('old-target', join(tree, 'link'));
	const head = fixtureCommit(tree, 'fixture: old checkout state', '2026-08-21T00:00:00Z');
	writeFileSync(join(tree, '.gitattributes'), 'asset.bin filter=lfs diff=lfs merge=lfs -text\n');
	writeFileSync(join(tree, 'asset.bin'), 'new lfs payload\n');
	chmodSync(join(tree, 'script.sh'), 0o755);
	unlinkSync(join(tree, 'link'));
	symlinkSync('../../outside-target', join(tree, 'link'));
	const desiredCommit = fixtureCommit(tree, 'fixture: desired checkout state', '2026-08-21T00:01:00Z');
	const desiredTree = fixtureGit(tree, ['rev-parse', `${desiredCommit}^{tree}`]).stdout.trim();
	if (options.portableModes === true) {
		fixtureGit(tree, ['config', 'core.symlinks', 'false']);
		fixtureGit(tree, ['config', 'core.filemode', 'false']);
	}
	fixtureGit(tree, ['checkout', '--quiet', head]);

	const patchset = makeTempRoot(`${label}-patchset`);
	fixtureGit(patchset, ['init', '--quiet', '--initial-branch=feature', '.']);
	writeFileSync(join(patchset, 'base.txt'), 'base\n');
	const patchsetHead = fixtureCommit(patchset, 'fixture: patchset head', '2026-08-21T00:02:00Z');
	return { patchset, tree, head, desiredTree, desiredCommit, patchsetHead };
}

function moveOptions(current: MaterializationFixture): RebaseMoveOptions {
	return {
		patchesDir: current.patchset,

		treeDir: current.tree,
		scratchTree: current.tree,
		desiredTree: current.desiredTree,
		patchsetHead: current.patchsetHead,
		allowedOwnBeforeTree: current.head,
		allowedIgnoredPrefixes: ['src/vs/patchset/'],
		allowedIgnoredPaths: [],
		allowCompletedRollover: false
	};
}
