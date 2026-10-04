import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { assertWorkspaceClean, workspaceGitOwnedPaths, workspaceOwnedPaths } from '../../src/lib/workspaceFinish.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const root = makeTempRoot('workspace-link-projection');
	expect(runGit({ cwd: root, args: ['init', '--quiet', '--initial-branch=main'] }).status).toBe(0);
	return { root, lock: acquireLock(root, 'fixture-tree', 'fixture') };
}
it('admits only a physically owned leaf link while keeping Git aliases out of deletion custody', () => {
	const f = fixture();
	try {
		const outside = makeTempRoot('workspace-link-foreign');
		writeFileSync(join(outside, 'keep.txt'), 'foreign bytes');
		symlinkSync(outside, join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
		expect(() => assertWorkspaceClean(f.root, f.lock, [])).toThrow(/uncommitted or untracked/);
		expect(() => assertWorkspaceClean(f.root, f.lock, ['link'])).not.toThrow();
		const physical = workspaceOwnedPaths(f.root, f.lock, ['link']);
		expect(physical.has('link/keep.txt')).toBe(false);
		if (process.platform === 'win32') expect(workspaceGitOwnedPaths(f.root, f.lock, ['link']).has('link/keep.txt')).toBe(true);
		unlinkSync(join(f.root, 'link'));
		mkdirSync(join(f.root, 'link'));
		writeFileSync(join(f.root, 'link/keep.txt'), 'new local data');
		expect(() => assertWorkspaceClean(f.root, f.lock, ['link'])).toThrow(/uncommitted or untracked/);
		expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('foreign bytes');
	} finally {
		f.lock.release();
	}
});
it('never turns a staged path into an owned untracked alias', () => {
	const f = fixture();
	try {
		writeFileSync(join(f.root, 'tracked.txt'), 'staged data');
		expect(runGit({ cwd: f.root, args: ['add', '--', 'tracked.txt'] }).status).toBe(0);
		expect(() => assertWorkspaceClean(f.root, f.lock, ['tracked.txt'])).toThrow(/uncommitted or untracked/);
	} finally {
		f.lock.release();
	}
});
