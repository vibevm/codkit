import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readTreeEntries, writeHistory } from '../../src/lib/gitHistory.ts';
import type { HistoryCommit } from '../../src/lib/gitHistory.ts';
import * as git from '../../src/lib/gitx.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

describe('batched generated history', () => {
	it('matches commit-tree byte for byte, with binary, executable, Unicode and quoted paths; leaves refs and index alone', () => {
		const treeDir = makeTempRoot('history-batch');
		const run = (args: readonly string[], input?: string | Uint8Array): string =>
			git
				.gitOk(
					{ args, cwd: treeDir, ...(input === undefined ? {} : { input }) },
					{ code: 'INTERNAL', message: 'history fixture git failed' }
				)
				.stdout.trim();
		run(['init', '--quiet', '--initial-branch=main']);
		const emptyTree = run(['mktree'], '');
		const env = {
			GIT_AUTHOR_NAME: 'Олег Чирухин',
			GIT_COMMITTER_NAME: 'Олег Чирухин',
			GIT_AUTHOR_EMAIL: 'oleg@example.invalid',
			GIT_COMMITTER_EMAIL: 'oleg@example.invalid',
			GIT_AUTHOR_DATE: '2026-10-06T18:05:00+03:00',
			GIT_COMMITTER_DATE: '2026-10-06T18:05:00+03:00',
			GIT_INDEX_FILE: join(treeDir, 'oracle.index')
		};
		const oracleGit = (args: readonly string[], input?: string | Uint8Array): string =>
			git
				.gitOk(
					{ args, cwd: treeDir, env, ...(input === undefined ? {} : { input }) },
					{ code: 'INTERNAL', message: 'history oracle git failed' }
				)
				.stdout.trim();
		const parent = oracleGit(['commit-tree', emptyTree, '-m', 'base']);
		run(['update-ref', 'refs/heads/main', parent]);
		const commits: readonly HistoryCommit[] = [
			{
				message: 'one\n\nTrailer: value',
				changes: [
					{ path: 'directory/документ.txt', mode: '100644', bytes: Buffer.from('UTF-8\r\nтекст\n') },
					{ path: 'binary', mode: '100644', bytes: Uint8Array.from([0, 255, 13, 10, 128]) },
					{ path: 'run.sh', mode: '100755', bytes: Buffer.from('#!/bin/sh\necho hi\n') },
					{
						// update-index silently rejects Win32-illegal names on Windows.
						path: process.platform === 'win32' ? 'spaced Юникод.txt' : 'tab\tquote"back\\line\n',
						mode: '100644',
						bytes: Buffer.from('unusual Git path')
					}
				]
			},
			{
				message: 'replace and delete\n',
				changes: [
					{ path: 'binary', remove: true },
					{ path: 'directory/документ.txt', mode: '100644', bytes: Buffer.from('replacement') },
					{ path: 'symlink', mode: '120000', bytes: Buffer.from('run.sh') }
				]
			},
			{ message: 'empty atom', changes: [] }
		];
		oracleGit(['read-tree', parent]);
		const expected: string[] = [];
		let previous = parent;
		for (const commit of commits) {
			let entries = '';
			for (const change of commit.changes) {
				if ('remove' in change) entries += `0 ${'0'.repeat(40)}\t${change.path}\0`;
				else entries += `${change.mode} ${oracleGit(['hash-object', '-w', '--stdin', '--no-filters'], change.bytes)}\t${change.path}\0`;
			}
			oracleGit(['update-index', '--add', '-z', '--index-info'], entries);
			previous = oracleGit(['commit-tree', oracleGit(['write-tree']), '-p', previous, '-m', commit.message]);
			expected.push(previous);
		}
		const refs = run(['show-ref']);
		const spy = vi.spyOn(git, 'gitOk');
		try {
			const actual = writeHistory({
				treeDir,
				parent,
				dateIso: env.GIT_AUTHOR_DATE,
				authorName: env.GIT_AUTHOR_NAME,
				authorEmail: env.GIT_AUTHOR_EMAIL,
				commits
			});
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0].args).toContain('fast-import');
			const details =
				actual[0] === expected[0]
					? ''
					: [
							run(['cat-file', '-p', actual[0] ?? '']),
							run(['cat-file', '-p', expected[0] ?? '']),
							run(['diff-tree', '--no-commit-id', '--name-status', '-r', expected[0] ?? '', actual[0] ?? ''])
						].join('\n');
			expect(actual, details).toEqual(expected);
		} finally {
			spy.mockRestore();
		}
		expect(run(['show-ref'])).toBe(refs);
		expect(run(['rev-parse', 'HEAD'])).toBe(parent);
		expect(run(['ls-files'])).toBe('');
		expect(readTreeEntries(treeDir, previous).get('run.sh')?.mode).toBe('100755');
	}, 120_000);

	it('does not invoke Git for an empty history', () => {
		expect(writeHistory({ treeDir: 'absent', parent: 'absent', dateIso: '', authorName: '', authorEmail: '', commits: [] })).toEqual([]);
	});
});
