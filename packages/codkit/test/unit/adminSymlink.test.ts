// REPAIR-006 finding 3: every file codkit reads or writes inside git
// administration must be a real regular file inside a real directory of that
// administration. A symlink at the leaf, or at any parent component (the hooks
// or info directory, the codkit mark directory), can redirect the operation to
// a file outside git administration; the outside bytes must never move, and
// the operation must refuse instead. Sentinels outside the repository prove it.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { hookScript, inspectHook, installHooks } from '../../src/lib/hooksPatchSet.ts';
import { writeExclude, writeTreeHook } from '../../src/lib/syncEngine.ts';
import { gitDirOf, readTreeMark, writeTreeMark } from '../../src/lib/treeCache.ts';
import type { TreeMark } from '../../src/lib/treeCache.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

/** The generated branch the tree hook names in its reminder. */
const BRANCH = 'codkit/applied/t1';

function makeNormalRepo(label: string): string {
	const repo = makeTempRoot(label);
	runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: repo });
	writeFileSync(join(repo, 'readme.txt'), 'upstream file\n', 'utf8');
	runGit({ args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'add', 'readme.txt'], cwd: repo });
	runGit({ args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'commit', '--quiet', '-m', 'base'], cwd: repo });
	return repo;
}

/** An Output that records every human-facing line, warnings included. */
function collectingOutput(): { readonly out: Output; readonly lines: readonly string[] } {
	const lines: string[] = [];
	const out = new Output({
		command: 'load',
		version: 'test',
		jsonMode: false,
		streams: {
			writeOut: (chunk) => lines.push(chunk),
			writeErr: (chunk) => lines.push(chunk)
		}
	});
	return { out, lines };
}

const SENTINEL_EXCLUDE = '# foreign exclude rules\n*.secret\n';
const SENTINEL_HOOK = '#!/bin/sh\necho sentinel-veto >&2\nexit 7\n';
const SENTINEL_MODE = 0o741;

const MARK: TreeMark = {
	codkitTreeMark: 1,
	pinSha: '1111111111111111111111111111111111111111',
	deltaFingerprint: 'fingerprint',
	branchTip: '2222222222222222222222222222222222222222'
};

function plantSentinel(root: string, name: string, bytes: string, mode: number): string {
	mkdirSync(root, { recursive: true });
	const path = join(root, name);
	writeFileSync(path, bytes, 'utf8');
	chmodSync(path, mode);
	return path;
}

describe('git-admin writes refuse symlinked paths', () => {
	it('refuses an info parent swapped after the exclude leaf opens', () => {
		const repo = makeNormalRepo('exclude-parent-swap');
		const info = join(gitDirOf(repo), 'info');
		const held = `${info}-held`;
		const outside = makeTempRoot('exclude-parent-swap-outside');
		const sentinel = plantSentinel(outside, 'exclude', SENTINEL_EXCLUDE, 0o644);
		try {
			expect(() =>
				writeExclude(repo, 'src/vs/patchset', {
					afterOpen: () => {
						renameSync(info, held);
						symlinkSync(outside, info);
					}
				})
			).toThrow(/resolves outside the root/);
			expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_EXCLUDE);
		} finally {
			rmSync(info, { force: true });
			renameSync(held, info);
		}
	});
	it('never modifies an external file a symlinked info/exclude points at', () => {
		const repo = makeNormalRepo('exclude-leaf-symlink');
		const outside = makeTempRoot('exclude-leaf-symlink-outside');
		const sentinel = plantSentinel(outside, 'exclude', SENTINEL_EXCLUDE, 0o644);
		const info = join(gitDirOf(repo), 'info');
		mkdirSync(info, { recursive: true });
		rmSync(join(info, 'exclude'), { force: true });
		symlinkSync(sentinel, join(info, 'exclude'));

		// The leaf-shape refusal of the contained reader names a link as a link:
		// a bare toThrow() here was satisfied by any failure anywhere in the
		// write path.
		expect(() => writeExclude(repo, 'src/vs/patchset')).toThrow(/must be a regular non-symlink file/);
		expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_EXCLUDE);
	});

	it('never creates a hook through a symlinked hooks directory', () => {
		const repo = makeNormalRepo('hooks-dir-symlink');
		const outside = makeTempRoot('hooks-dir-symlink-outside');
		const gitDir = gitDirOf(repo);
		rmSync(join(gitDir, 'hooks'), { recursive: true, force: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(gitDir, 'hooks'));

		const warned = collectingOutput();
		expect(writeTreeHook(repo, BRANCH, warned.out)).toBe(false);
		expect(existsSync(join(outside, 'pre-commit'))).toBe(false);
		// The repository keeps its link, but no codkit hook was pushed through it.
		expect(existsSync(join(outside, 'pre-commit'))).toBe(false);
		const text = warned.lines.join('\n').toLowerCase();
		expect(text).toContain('symlink');
	});

	it('never overwrites an external hook a symlinked pre-commit points at', () => {
		const repo = makeNormalRepo('hook-leaf-symlink');
		const outside = makeTempRoot('hook-leaf-symlink-outside');
		const sentinel = plantSentinel(outside, 'pre-commit', SENTINEL_HOOK, SENTINEL_MODE);
		const hooks = join(gitDirOf(repo), 'hooks');
		mkdirSync(hooks, { recursive: true });
		symlinkSync(sentinel, join(hooks, 'pre-commit'));

		const warned = collectingOutput();
		expect(writeTreeHook(repo, BRANCH, warned.out)).toBe(false);
		expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_HOOK);
		expect(statSync(sentinel).mode & 0o777).toBe(SENTINEL_MODE);
		const text = warned.lines.join('\n').toLowerCase();
		expect(text).toContain('symlink');
	});

	it('never writes a tree mark through a symlinked codkit directory', () => {
		const repo = makeNormalRepo('mark-dir-symlink');
		const outside = makeTempRoot('mark-dir-symlink-outside');
		const gitDir = gitDirOf(repo);
		rmSync(join(gitDir, 'codkit'), { recursive: true, force: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(gitDir, 'codkit'));

		const warned: string[] = [];
		expect(writeTreeMark(repo, MARK, (text) => warned.push(text))).toBe(false);
		expect(existsSync(join(outside, 'applied.json'))).toBe(false);
		expect(warned.join('\n').toLowerCase()).toContain('symlink');
	});

	it('never reads a tree mark through a symlinked codkit directory', () => {
		const repo = makeNormalRepo('mark-read-dir-symlink');
		const outside = makeTempRoot('mark-read-dir-symlink-outside');
		const gitDir = gitDirOf(repo);
		rmSync(join(gitDir, 'codkit'), { recursive: true, force: true });
		writeFileSync(join(outside, 'applied.json'), `${JSON.stringify(MARK)}\n`, 'utf8');
		symlinkSync(outside, join(gitDir, 'codkit'));

		const warned: string[] = [];
		expect(readTreeMark(repo, (text) => warned.push(text))).toBeNull();
		expect(warned.join('\n').toLowerCase()).toContain('symlink');
		expect(readFileSync(join(outside, 'applied.json'), 'utf8')).toBe(`${JSON.stringify(MARK)}\n`);
	});

	it('refuses a tree-mark parent swapped after the leaf opens', () => {
		const repo = makeNormalRepo('mark-read-parent-swap');
		expect(writeTreeMark(repo, MARK)).toBe(true);
		const parent = join(gitDirOf(repo), 'codkit');
		const held = `${parent}-held`;
		const outside = makeTempRoot('mark-read-parent-swap-outside');
		const sentinel = plantSentinel(outside, 'applied.json', `${JSON.stringify(MARK)}\n`, 0o644);
		try {
			expect(
				readTreeMark(repo, undefined, () => {
					renameSync(parent, held);
					symlinkSync(outside, parent);
				})
			).toBeNull();
			expect(readFileSync(sentinel, 'utf8')).toBe(`${JSON.stringify(MARK)}\n`);
		} finally {
			rmSync(parent, { force: true });
			renameSync(held, parent);
		}
	});

	it('refuses a tree-hook parent swapped after the leaf opens', () => {
		const repo = makeNormalRepo('tree-hook-parent-swap');
		const hooks = join(gitDirOf(repo), 'hooks');
		const owned = join(hooks, 'pre-commit');
		writeFileSync(owned, '#!/bin/sh\n# codkit-hook v1\nexit 0\n', 'utf8');
		const held = `${hooks}-held`;
		const outside = makeTempRoot('tree-hook-parent-swap-outside');
		const sentinel = plantSentinel(outside, 'pre-commit', SENTINEL_HOOK, SENTINEL_MODE);
		try {
			const warned = collectingOutput();
			expect(
				writeTreeHook(repo, BRANCH, warned.out, () => {
					renameSync(hooks, held);
					symlinkSync(outside, hooks);
				})
			).toBe(false);
			expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_HOOK);
		} finally {
			rmSync(hooks, { force: true });
			renameSync(held, hooks);
		}
	});
});

describe('patch-set hook installation refuses symlinked paths', () => {
	const PARAMETERS = { patchesDir: '', forkDir: '/nowhere' };

	it('never creates a hook through a symlinked hooks directory', () => {
		const repo = makeNormalRepo('patchset-hooks-dir-symlink');
		const outside = makeTempRoot('patchset-hooks-dir-symlink-outside');
		const gitDir = gitDirOf(repo);
		rmSync(join(gitDir, 'hooks'), { recursive: true, force: true });
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(gitDir, 'hooks'));

		expect(installHooks({ ...PARAMETERS, patchesDir: repo }).every((report) => report.action === 'refused')).toBe(true);
		expect(existsSync(join(outside, 'pre-commit'))).toBe(false);
		expect(existsSync(join(outside, 'commit-msg'))).toBe(false);
	});

	it('treats a symlinked hook leaf as foreign and never writes through it', () => {
		const repo = makeNormalRepo('patchset-hook-leaf-symlink');
		const outside = makeTempRoot('patchset-hook-leaf-symlink-outside');
		const sentinel = plantSentinel(outside, 'pre-commit', SENTINEL_HOOK, SENTINEL_MODE);
		const hooks = join(gitDirOf(repo), 'hooks');
		mkdirSync(hooks, { recursive: true });
		symlinkSync(sentinel, join(hooks, 'pre-commit'));

		const reports = installHooks({ ...PARAMETERS, patchesDir: repo });
		expect(reports.find((report) => report.name === 'pre-commit')?.action).toBe('refused');
		expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_HOOK);
		expect(statSync(sentinel).mode & 0o777).toBe(SENTINEL_MODE);
	});

	it('refuses a patch-set hook parent swapped after the leaf opens', () => {
		const repo = makeNormalRepo('patchset-hook-parent-swap');
		const hooks = join(gitDirOf(repo), 'hooks');
		const parameters = { ...PARAMETERS, patchesDir: repo };
		writeFileSync(join(hooks, 'pre-commit'), hookScript('pre-commit', parameters), 'utf8');
		const held = `${hooks}-held`;
		const outside = makeTempRoot('patchset-hook-parent-swap-outside');
		const sentinel = plantSentinel(outside, 'pre-commit', SENTINEL_HOOK, SENTINEL_MODE);
		try {
			expect(
				inspectHook('pre-commit', {
					...parameters,
					afterOpen: () => {
						renameSync(hooks, held);
						symlinkSync(outside, hooks);
					}
				})
			).toMatchObject({ state: 'foreign' });
			expect(readFileSync(sentinel, 'utf8')).toBe(SENTINEL_HOOK);
		} finally {
			rmSync(hooks, { force: true });
			renameSync(held, hooks);
		}
	});
});
