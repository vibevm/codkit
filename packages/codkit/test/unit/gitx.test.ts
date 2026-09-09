// gitx: environment isolation and the network policy.
//
// PROP-013 ##TP-POISON-GITCONFIG: a poisoned machine-level git configuration
// must not change what codkit sees. The control assertions below run the same
// git command WITHOUT the wrapper to prove the poison is real.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentGitConfigGlobal, runGit, runGitBytes, useGitConfigGlobal } from '../../src/lib/gitx.ts';
import { CkError, isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const POISON = ['[core]', '\tautocrlf = true', '[diff]', '\talgorithm = histogram', ''].join('\n');

const COMMIT_ENV = {
	GIT_AUTHOR_NAME: 'codkit-test',
	GIT_AUTHOR_EMAIL: 'codkit-test@patchset.invalid',
	GIT_COMMITTER_NAME: 'codkit-test',
	GIT_COMMITTER_EMAIL: 'codkit-test@patchset.invalid'
};

function catchCkError(run: () => unknown): CkError {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error('expected a CkError, but nothing was thrown');
}

describe('runGit environment isolation', () => {
	let repo: string;
	let poisonHome: string;
	let poisonFile: string;

	beforeEach(() => {
		repo = makeTempRoot('repo');
		poisonHome = makeTempRoot('poison-home');
		poisonFile = join(poisonHome, '.gitconfig');
		writeFileSync(poisonFile, POISON, 'utf8');
		const init = runGit({ args: ['init', '-q'], cwd: repo });
		expect(init.status).toBe(0);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		cleanupTempRoots();
	});

	it('control: the poisoned global config really is picked up without the wrapper', () => {
		const control = spawnSync('git', ['config', '--get', 'diff.algorithm'], {
			cwd: repo,
			env: { ...process.env, HOME: poisonHome, GIT_CONFIG_GLOBAL: poisonFile },
			encoding: 'utf8'
		});
		expect(control.stdout.trim()).toBe('histogram');
	});

	it('ignores a poisoned global config even when the caller passes it in env', () => {
		const result = runGit({
			args: ['config', '--get', 'diff.algorithm'],
			cwd: repo,
			env: { HOME: poisonHome, GIT_CONFIG_GLOBAL: poisonFile }
		});

		// `git config --get` exits 1 when the key is unset anywhere.
		expect(result.status).not.toBe(0);
		expect(result.stdout.trim()).toBe('');
	});

	it('forces core.autocrlf=false regardless of the poisoned global value', () => {
		const result = runGit({
			args: ['config', '--get', 'core.autocrlf'],
			cwd: repo,
			env: { HOME: poisonHome, GIT_CONFIG_GLOBAL: poisonFile }
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe('false');
	});

	it('passes through non-isolation variables from the caller', () => {
		const result = runGit({
			args: ['var', 'GIT_AUTHOR_IDENT'],
			cwd: repo,
			env: {
				GIT_AUTHOR_NAME: 'codkit',
				GIT_AUTHOR_EMAIL: 'codkit@patchset.invalid',
				GIT_AUTHOR_DATE: '2026-08-25T00:00:00+0000'
			}
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('codkit <codkit@patchset.invalid>');
	});

	it('preserves arbitrary blob bytes without UTF-8 replacement', () => {
		const bytes = new Uint8Array([0x00, 0x66, 0x80, 0xff, 0x0a]);
		writeFileSync(join(repo, 'blob.bin'), bytes);
		expect(runGit({ args: ['add', '--', 'blob.bin'], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['commit', '--quiet', '--message', 'binary fixture'], cwd: repo, env: COMMIT_ENV }).status).toBe(0);

		const result = runGitBytes({ args: ['cat-file', 'blob', 'HEAD:blob.bin'], cwd: repo });
		expect(result.status).toBe(0);
		expect([...result.stdout]).toEqual([...bytes]);
	});

	it('ignores repository-local replace refs for exact object reads', () => {
		writeFileSync(join(repo, 'tracked.txt'), 'before replacement\n', 'utf8');
		expect(runGit({ args: ['add', '--', 'tracked.txt'], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['commit', '--quiet', '--message', 'before'], cwd: repo, env: COMMIT_ENV }).status).toBe(0);
		const before = runGit({ args: ['rev-parse', 'HEAD'], cwd: repo }).stdout.trim();
		writeFileSync(join(repo, 'tracked.txt'), 'exact head bytes\n', 'utf8');
		expect(runGit({ args: ['commit', '--quiet', '--all', '--message', 'after'], cwd: repo, env: COMMIT_ENV }).status).toBe(0);
		const after = runGit({ args: ['rev-parse', 'HEAD'], cwd: repo }).stdout.trim();
		expect(runGit({ args: ['replace', after, before], cwd: repo }).status).toBe(0);

		const control = spawnSync('git', ['show', 'HEAD:tracked.txt'], { cwd: repo, encoding: 'utf8' });
		expect(control.stdout).toBe('before replacement\n');
		expect(runGit({ args: ['show', 'HEAD:tracked.txt'], cwd: repo }).stdout).toBe('exact head bytes\n');
		expect([...runGitBytes({ args: ['cat-file', 'blob', 'HEAD:tracked.txt'], cwd: repo }).stdout]).toEqual([
			...new TextEncoder().encode('exact head bytes\n')
		]);
	});

	it('strips repository redirection and config injection inherited from the parent', () => {
		const decoy = makeTempRoot('decoy-repo');
		expect(runGit({ args: ['init', '-q'], cwd: decoy }).status).toBe(0);
		expect(runGit({ args: ['config', '--local', 'probe.location', 'expected'], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['config', '--local', 'probe.location', 'decoy'], cwd: decoy }).status).toBe(0);

		writeFileSync(join(repo, 'tracked.txt'), 'at head\n', 'utf8');
		expect(runGit({ args: ['add', '--', 'tracked.txt'], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['commit', '--quiet', '--message', 'fixture'], cwd: repo, env: COMMIT_ENV }).status).toBe(0);

		vi.stubEnv('GIT_DIR', join(decoy, '.git'));
		vi.stubEnv('GIT_WORK_TREE', decoy);
		vi.stubEnv('GIT_INDEX_FILE', join(decoy, '.git', 'index'));
		vi.stubEnv('GIT_IMPLICIT_WORK_TREE', '0');
		vi.stubEnv('GIT_COMMON_DIR', join(decoy, '.git'));
		vi.stubEnv('GIT_CEILING_DIRECTORIES', repo);
		vi.stubEnv('GIT_DISCOVERY_ACROSS_FILESYSTEM', '1');
		vi.stubEnv('GIT_OBJECT_DIRECTORY', join(decoy, '.git', 'objects'));
		vi.stubEnv('GIT_ALTERNATE_OBJECT_DIRECTORIES', join(decoy, '.git', 'objects'));
		vi.stubEnv('GIT_QUARANTINE_PATH', join(decoy, '.git', 'objects'));
		vi.stubEnv('GIT_SHALLOW_FILE', join(decoy, '.git', 'shallow'));
		vi.stubEnv('GIT_NAMESPACE', 'poison');
		vi.stubEnv('GIT_PREFIX', 'poison/');
		vi.stubEnv('GIT_ATTR_SOURCE', 'refs/heads/poison');
		vi.stubEnv('GIT_GRAFT_FILE', join(decoy, 'grafts'));
		vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/replace/poison/');
		vi.stubEnv('GIT_NO_REPLACE_OBJECTS', '1');
		vi.stubEnv('GIT_CONFIG_COUNT', '1');
		vi.stubEnv('GIT_CONFIG_KEY_0', 'probe.count');
		vi.stubEnv('GIT_CONFIG_VALUE_0', 'poison');
		vi.stubEnv('GIT_CONFIG_PARAMETERS', "'probe.parameters=poison'");
		vi.stubEnv('GIT_EXTERNAL_DIFF', join(decoy, 'missing-external-diff'));

		const topLevel = runGit({ args: ['rev-parse', '--show-toplevel'], cwd: repo });
		expect(topLevel.status).toBe(0);
		expect(topLevel.stdout.trim()).toBe(repo);
		expect(runGit({ args: ['config', '--get', 'probe.location'], cwd: repo }).stdout.trim()).toBe('expected');
		expect(runGit({ args: ['cat-file', '-e', 'HEAD:tracked.txt'], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['status', '--porcelain'], cwd: repo }).stdout.trim()).toBe('');
		expect(runGit({ args: ['config', '--get', 'probe.count'], cwd: repo }).status).not.toBe(0);
		expect(runGit({ args: ['config', '--get', 'probe.parameters'], cwd: repo }).status).not.toBe(0);

		writeFileSync(join(repo, 'tracked.txt'), 'changed\n', 'utf8');
		const diff = runGit({ args: ['diff', '--', 'tracked.txt'], cwd: repo });
		expect(diff.status).toBe(0);
		expect(diff.stdout).toContain('+changed');
	});

	it('honours explicit repository and temporary-index overrides', () => {
		const outside = makeTempRoot('outside-repo');
		const selected = runGit({
			args: ['rev-parse', '--show-toplevel'],
			cwd: outside,
			env: { GIT_DIR: join(repo, '.git'), GIT_WORK_TREE: repo }
		});
		expect(selected.status).toBe(0);
		expect(selected.stdout.trim()).toBe(repo);

		writeFileSync(join(repo, 'indexed.txt'), 'temporary index\n', 'utf8');
		const indexRoot = makeTempRoot('explicit-index');
		const inheritedIndex = join(indexRoot, 'inherited.index');
		const explicitIndex = join(indexRoot, 'explicit.index');
		vi.stubEnv('GIT_INDEX_FILE', inheritedIndex);

		expect(runGit({ args: ['add', '--', 'indexed.txt'], cwd: repo, env: { GIT_INDEX_FILE: explicitIndex } }).status).toBe(0);
		expect(existsSync(explicitIndex)).toBe(true);
		expect(existsSync(inheritedIndex)).toBe(false);
		expect(runGit({ args: ['ls-files'], cwd: repo, env: { GIT_INDEX_FILE: explicitIndex } }).stdout.trim()).toBe('indexed.txt');
	});

	it('disables hooks, fsmonitor, external diff and textconv without disabling checkout filters', () => {
		const missingCommand = join(makeTempRoot('missing-command'), 'not-there');
		expect(runGit({ args: ['config', '--local', 'core.hooksPath', missingCommand], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['config', '--local', 'core.fsmonitor', missingCommand], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['config', '--get', 'core.hooksPath'], cwd: repo }).stdout.trim()).toBe('/dev/null');
		expect(runGit({ args: ['config', '--get', 'core.fsmonitor'], cwd: repo }).stdout.trim()).toBe('false');

		writeFileSync(join(repo, '.gitattributes'), '*.txt diff=poison\n*.lfs filter=lfs\n', 'utf8');
		writeFileSync(join(repo, 'tracked.txt'), 'before\n', 'utf8');
		expect(runGit({ args: ['config', '--local', 'diff.external', missingCommand], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['config', '--local', 'diff.poison.textconv', missingCommand], cwd: repo }).status).toBe(0);

		const smudge = join(makeTempRoot('smudge-filter'), 'smudge.mjs');
		writeFileSync(
			smudge,
			"let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { input += chunk; }); process.stdin.on('end', () => process.stdout.write(input.replace('stored', 'materialized')));\n",
			'utf8'
		);
		expect(runGit({ args: ['config', '--local', 'filter.lfs.clean', 'cat'], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['config', '--local', 'filter.lfs.smudge', `node ${smudge}`], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['config', '--local', 'filter.lfs.required', 'true'], cwd: repo }).status).toBe(0);
		writeFileSync(join(repo, 'asset.lfs'), 'stored\n', 'utf8');

		expect(runGit({ args: ['add', '--', '.gitattributes', 'tracked.txt', 'asset.lfs'], cwd: repo }).status).toBe(0);
		expect(runGit({ args: ['commit', '--quiet', '--message', 'fixture'], cwd: repo, env: COMMIT_ENV }).status).toBe(0);
		writeFileSync(join(repo, 'tracked.txt'), 'after\n', 'utf8');

		const diff = runGit({ args: ['diff', '--', 'tracked.txt'], cwd: repo });
		expect(diff.status).toBe(0);
		expect(diff.stdout).toContain('+after');

		unlinkSync(join(repo, 'asset.lfs'));
		expect(runGit({ args: ['checkout', 'HEAD', '--', 'asset.lfs'], cwd: repo }).status).toBe(0);
		expect(readFileSync(join(repo, 'asset.lfs'), 'utf8')).toBe('materialized\n');
	});
});

describe('the one configuration file ci may add', () => {
	let repo: string;
	let configFile: string;

	beforeEach(() => {
		repo = makeTempRoot('repo');
		configFile = join(makeTempRoot('ci-config'), 'gitconfig-ci');
		// The shape `ci` writes: safe.directory entries for the tree and for patchset.
		// A key git can be asked about is added, so the test can see the file take
		// effect - the entries themselves only matter to a tree of another owner,
		// which cannot be staged without chown.
		writeFileSync(configFile, ['[safe]', `\tdirectory = ${repo}`, '[user]', '\tname = ci-config-probe', ''].join('\n'), 'utf8');
		expect(runGit({ args: ['init', '-q'], cwd: repo }).status).toBe(0);
	});

	afterEach(() => {
		useGitConfigGlobal(null);
		cleanupTempRoots();
	});

	it('is not read unless it is asked for', () => {
		const result = runGit({ args: ['config', '--get', 'user.name'], cwd: repo });

		expect(result.status).not.toBe(0);
		expect(result.stdout.trim()).toBe('');
		expect(currentGitConfigGlobal()).toBeNull();
	});

	it('replaces /dev/null for the call that names it', () => {
		const result = runGit({ args: ['config', '--get', 'user.name'], cwd: repo, gitConfigGlobal: configFile });

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe('ci-config-probe');
		expect(runGit({ args: ['config', '--get', 'safe.directory'], cwd: repo, gitConfigGlobal: configFile }).stdout.trim()).toBe(repo);
	});

	it('replaces it for the rest of the run once ci sets it', () => {
		// This is what makes the safe.directory entries reach the engines: they
		// call runGit without ever hearing about the file.
		useGitConfigGlobal(configFile);
		expect(currentGitConfigGlobal()).toBe(configFile);

		expect(runGit({ args: ['config', '--get', 'user.name'], cwd: repo }).stdout.trim()).toBe('ci-config-probe');

		useGitConfigGlobal(null);
		expect(runGit({ args: ['config', '--get', 'user.name'], cwd: repo }).status).not.toBe(0);
	});

	it('does not weaken the rest of the isolation', () => {
		useGitConfigGlobal(configFile);
		const poisonHome = makeTempRoot('poison-home-2');
		writeFileSync(join(poisonHome, '.gitconfig'), POISON, 'utf8');

		const result = runGit({
			args: ['config', '--get', 'core.autocrlf'],
			cwd: repo,
			env: { HOME: poisonHome, GIT_CONFIG_GLOBAL: join(poisonHome, '.gitconfig') }
		});

		// The caller's GIT_CONFIG_GLOBAL still loses, and core.autocrlf is still
		// forced on the command line.
		expect(result.stdout.trim()).toBe('false');
	});
});

describe('runGit network policy', () => {
	afterEach(() => {
		cleanupTempRoots();
	});

	it('refuses network subcommands without starting a process', () => {
		// A cwd that does not exist: if git were spawned, the failure would be a
		// spawn error (CK-E-INTERNAL), not the network refusal.
		const missingCwd = join(makeTempRoot('gone'), 'no-such-dir');

		for (const args of [
			['fetch', 'origin'],
			['clone', 'https://example.invalid/x'],
			['pull'],
			['push', 'origin', 'main'],
			['ls-remote', 'origin'],
			['lfs', 'pull'],
			['lfs', 'fetch']
		]) {
			const error = catchCkError(() => runGit({ args, cwd: missingCwd }));
			expect(error.code, `git ${args.join(' ')}`).toBe('NET-FORBIDDEN');
			expect(error.hint).toContain('git ');
		}
	});

	it('does spawn for a non-network command, proving the refusal is not a blanket failure', () => {
		const missingCwd = join(makeTempRoot('gone'), 'no-such-dir');
		const error = catchCkError(() => runGit({ args: ['status'], cwd: missingCwd }));
		expect(error.code).toBe('INTERNAL');
	});

	it('allows a local lfs subcommand that does not reach the network', () => {
		const repo = makeTempRoot('repo');
		expect(runGit({ args: ['init', '-q'], cwd: repo }).status).toBe(0);
		// `lfs env` is local; it must not be refused. git-lfs may be absent on the
		// machine, in which case git still runs and reports an unknown command --
		// either way, no CkError is thrown.
		expect(() => runGit({ args: ['lfs', 'env'], cwd: repo })).not.toThrow();
	});
});
