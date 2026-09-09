// Patch-set hooks are useful only when the user's Git demonstrably executes
// the owned bytes. Linked worktrees and custom hooks paths are inactive: Codkit
// reports/refuses them and never writes a shared or foreign location.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitLocal, runGit } from '../../src/lib/gitx.ts';
import { hookPath, inspectHooks, installHooks } from '../../src/lib/hooksPatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

function repo(label: string): string {
	const root = makeTempRoot(label);
	runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: root });
	runGit({
		args: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base'],
		cwd: root
	});
	return root;
}

function commit(root: string): ReturnType<typeof gitLocal> {
	return gitLocal({
		args: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-m', 'probe'],
		cwd: root
	});
}

function sentinel(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	const bytes = '#!/bin/sh\necho effective-sentinel >&2\nexit 7\n';
	writeFileSync(path, bytes, 'utf8');
	chmodSync(path, 0o755);
	return bytes;
}

describe('effective patch-set hooks', () => {
	it('refuses linked-worktree hooks and leaves the common hook path untouched', () => {
		const main = repo('patch-hooks-linked-main');
		const worktree = join(makeTempRoot('patch-hooks-linked-worktree'), 'tree');
		mkdirSync(dirname(worktree), { recursive: true });
		runGit({ args: ['worktree', 'add', '--quiet', '-b', 'linked', worktree], cwd: main });

		expect(installHooks({ patchesDir: worktree, forkDir: worktree }).map((row) => row.state)).toEqual(['inactive', 'inactive']);
		expect(existsSync(join(main, '.git', 'hooks', 'pre-commit'))).toBe(false);
		expect(commit(worktree).status).toBe(0);
	});

	it.each(['local', 'global', 'system'] as const)('refuses a %s custom hooksPath and Git still executes the foreign hook', (scope) => {
		const root = repo(`patch-hooks-${scope}`);
		const external = makeTempRoot(`patch-hooks-${scope}-external`);
		const hook = join(external, 'pre-commit');
		const bytes = sentinel(hook);
		const config = join(makeTempRoot(`patch-hooks-${scope}-config`), 'gitconfig');
		writeFileSync(config, `[core]\n\thooksPath = ${external}\n`, 'utf8');
		const priorGlobal = process.env['GIT_CONFIG_GLOBAL'];
		const priorSystem = process.env['GIT_CONFIG_SYSTEM'];
		const priorNoSystem = process.env['GIT_CONFIG_NOSYSTEM'];
		try {
			if (scope === 'local') runGit({ args: ['config', 'core.hooksPath', external], cwd: root });
			if (scope === 'global') process.env['GIT_CONFIG_GLOBAL'] = config;
			if (scope === 'system') {
				process.env['GIT_CONFIG_SYSTEM'] = config;
				delete process.env['GIT_CONFIG_NOSYSTEM'];
			}
			const reports = installHooks({ patchesDir: root, forkDir: root });
			expect(reports.map((row) => row.state)).toEqual(['inactive', 'inactive']);
			expect(readFileSync(hook, 'utf8')).toBe(bytes);
			expect(existsSync(hookPath(root, 'pre-commit'))).toBe(false);
			const attempted = commit(root);
			expect(attempted.status).not.toBe(0);
			expect(attempted.stderr).toContain('effective-sentinel');
		} finally {
			if (priorGlobal === undefined) delete process.env['GIT_CONFIG_GLOBAL'];
			else process.env['GIT_CONFIG_GLOBAL'] = priorGlobal;
			if (priorSystem === undefined) delete process.env['GIT_CONFIG_SYSTEM'];
			else process.env['GIT_CONFIG_SYSTEM'] = priorSystem;
			if (priorNoSystem === undefined) delete process.env['GIT_CONFIG_NOSYSTEM'];
			else process.env['GIT_CONFIG_NOSYSTEM'] = priorNoSystem;
		}
	});

	it('treats /dev/null path resolution as inactive and a manual commit bypasses Codkit hooks', () => {
		const root = repo('patch-hooks-devnull');
		runGit({ args: ['config', 'core.hooksPath', '/dev/null'], cwd: root });
		expect(inspectHooks({ patchesDir: root, forkDir: root }).map((row) => row.state)).toEqual(['inactive', 'inactive']);
		expect(installHooks({ patchesDir: root, forkDir: root }).every((row) => row.action === 'refused')).toBe(true);
		expect(commit(root).status).toBe(0);
	});
});
