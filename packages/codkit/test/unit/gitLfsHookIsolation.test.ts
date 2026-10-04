import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { provideLfsContent, LFS_EXTRA } from '../fixtures/lfsUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
const available = runGit({ cwd: process.cwd(), args: ['lfs', 'version'] }).status === 0;
it.runIf(available)('keeps LFS filter checkouts clean without installing or executing isolated hooks', () => {
	const root = makeTempRoot('git-lfs-hook-isolation');
	const git = (args: readonly string[]) => runGit({ cwd: root, args });
	expect(git(['init', '--quiet', '--initial-branch=main']).status).toBe(0);
	const hook = join(root, '.git/hooks/pre-commit');
	const poison = '#!/bin/sh\nexit 73\n';
	writeFileSync(hook, poison);
	chmodSync(hook, 0o755);
	expect(git(['lfs', 'install', '--local', '--skip-repo']).status).toBe(0);
	provideLfsContent(root, [LFS_EXTRA]);
	writeFileSync(join(root, '.gitattributes'), 'asset.bin filter=lfs diff=lfs merge=lfs -text\n');
	writeFileSync(join(root, 'asset.bin'), LFS_EXTRA.content);
	expect(git(['add', '--all']).status).toBe(0);
	const committed = runGit({
		cwd: root,
		args: ['commit', '--quiet', '--message', 'fixture'],
		env: {
			GIT_AUTHOR_NAME: 'fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
		}
	});
	expect(committed.status, committed.stderr).toBe(0);
	expect(git(['show', 'HEAD:asset.bin']).stdout).toBe(LFS_EXTRA.pointer);
	unlinkSync(join(root, 'asset.bin'));
	expect(git(['checkout', 'HEAD', '--', 'asset.bin']).status).toBe(0);
	expect(readFileSync(join(root, 'asset.bin'))).toEqual(Buffer.from(LFS_EXTRA.content));
	expect(readFileSync(hook, 'utf8')).toBe(poison);
	expect(git(['status', '--porcelain=v1']).stdout).toBe('');
	expect(existsSync(join(root, 'dev'))).toBe(false);
});
