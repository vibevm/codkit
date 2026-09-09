/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commitCycleAtom, cycleCommitMessage, validateCycleCommitHistory, validateCycleCommitReceipt } from '../../src/lib/cycleCommit.ts';
import type { CycleCommitGitRunner, CycleCommitOptions } from '../../src/lib/cycleCommit.ts';
import { gitLocal, runGit } from '../../src/lib/gitx.ts';
import { CkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const TAG = '1.136.0';
const CAUSE = 'a'.repeat(40);
const TIMESTAMP = '2026-08-31T17:00:00.000Z';
const IDENTITY = {
	GIT_AUTHOR_NAME: 'Fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.test',
	GIT_COMMITTER_NAME: 'Fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.test'
};

type Repository = { readonly root: string; readonly branch: string; readonly base: string };

function git(root: string, args: readonly string[]): string {
	const result = runGit({ args, cwd: root });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout);
	}
	return result.stdout;
}

function makeRepository(label: string): Repository {
	const root = makeTempRoot(label);
	const branch = `codkit/cycle/${TAG}`;
	git(root, ['init', '--quiet', '--initial-branch', branch]);
	writeFileSync(join(root, 'a.txt'), 'a0\n');
	writeFileSync(join(root, 'b.txt'), 'b0\n');
	writeFileSync(join(root, 'outside.txt'), 'outside0\n');
	git(root, ['add', '--all']);
	const committed = runGit({ args: ['commit', '--quiet', '--message', 'base'], cwd: root, env: IDENTITY });
	if (committed.status !== 0) {
		throw new Error(committed.stderr);
	}
	gitLocal({ args: ['config', 'user.name', 'Local Person'], cwd: root });
	gitLocal({ args: ['config', 'user.email', 'local@example.test'], cwd: root });
	return { root, branch, base: git(root, ['rev-parse', 'HEAD']).trim() };
}

function atom(repository: Repository, overrides: Partial<CycleCommitOptions> = {}) {
	const base: CycleCommitOptions = {
		patchesDir: repository.root,
		expectedBranch: repository.branch,
		expectedParent: repository.base,
		targetTag: TAG,
		subject: 'fix(cycle): adapt exact artifacts',
		paths: ['a.txt', 'b.txt'],
		timestamp: TIMESTAMP,
		cause: CAUSE
	};
	return commitCycleAtom({ ...base, ...overrides });
}

function indexBytes(repository: Repository): Buffer {
	return readFileSync(join(repository.root, '.git', 'index'));
}

function assertNoIndexDebris(repository: Repository): void {
	expect(existsSync(join(repository.root, '.git', 'index.lock'))).toBe(false);
	const entries = git(repository.root, ['ls-files', '--others', '--directory', '--', '.git']).trim();
	expect(entries).toBe('');
}

function manualCommit(root: string, path: string, message: string): string {
	writeFileSync(join(root, path), `${Math.random()}\n`);
	git(root, ['add', '--', path]);
	const result = runGit({ args: ['commit', '--quiet', '--message', message], cwd: root, env: IDENTITY });
	if (result.status !== 0) {
		throw new Error(result.stderr);
	}
	return git(root, ['rev-parse', 'HEAD']).trim();
}

describe('exact cycle commits', () => {
	afterAll(cleanupTempRoots);

	it('CAS-installs exact raw paths, identity, date and trailers, then resumes cleanly', () => {
		const repository = makeRepository('cycle-commit-exact');
		writeFileSync(join(repository.root, 'a.txt'), 'a1\n');
		writeFileSync(join(repository.root, 'b.txt'), 'b1\n');
		const result = atom(repository);
		expect(result.status).toBe('committed');
		if (result.status === 'noop') {
			throw new Error('unexpected no-op');
		}
		const object = git(repository.root, ['cat-file', 'commit', result.sha]);
		expect(object.slice(object.indexOf('\n\n') + 2)).toBe(cycleCommitMessage('fix(cycle): adapt exact artifacts', TAG, CAUSE));
		expect(object).toContain('author Local Person <local@example.test> 1788195600 +0000\n');
		expect(object).toContain('committer Local Person <local@example.test> 1788195600 +0000\n');
		expect(git(repository.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', result.sha]).trim().split('\n').sort()).toEqual([
			'a.txt',
			'b.txt'
		]);
		expect(git(repository.root, ['status', '--porcelain'])).toBe('');
		expect(atom(repository)).toEqual({ status: 'resumed', sha: result.sha });
		validateCycleCommitReceipt({
			patchesDir: repository.root,
			expectedBranch: repository.branch,
			expectedParent: repository.base,
			targetTag: TAG,
			subject: 'fix(cycle): adapt exact artifacts',
			paths: ['a.txt', 'b.txt'],
			timestamp: TIMESTAMP,
			cause: CAUSE,
			commitSha: result.sha
		});
		gitLocal({ args: ['config', 'user.name', 'Changed Later'], cwd: repository.root });
		gitLocal({ args: ['config', 'user.email', 'changed@example.test'], cwd: repository.root });
		expect(() =>
			validateCycleCommitReceipt({
				patchesDir: repository.root,
				expectedBranch: repository.branch,
				expectedParent: repository.base,
				targetTag: TAG,
				subject: 'fix(cycle): adapt exact artifacts',
				paths: ['a.txt', 'b.txt'],
				timestamp: TIMESTAMP,
				cause: CAUSE,
				commitSha: result.sha
			})
		).not.toThrow();
		for (const changed of [
			{ subject: 'fix(cycle): different subject' },
			{ paths: ['a.txt'] },
			{ timestamp: '2026-08-31T17:00:01.000Z' }
		] as const) {
			expect(() =>
				validateCycleCommitReceipt({
					patchesDir: repository.root,
					expectedBranch: repository.branch,
					expectedParent: repository.base,
					targetTag: TAG,
					subject: 'fix(cycle): adapt exact artifacts',
					paths: ['a.txt', 'b.txt'],
					timestamp: TIMESTAMP,
					cause: CAUSE,
					commitSha: result.sha,
					...changed
				})
			).toThrow(/exact recorded atom|identity or timestamp/);
		}
		expect(git(repository.root, ['rev-list', '--count', `${repository.base}..HEAD`]).trim()).toBe('1');
		writeFileSync(join(repository.root, 'outside.txt'), 'later dirt\n');
		expect(() => atom(repository)).toThrowError(/absolutely clean/);
	});

	it('ignores hostile hooks and inherited author injection', () => {
		const repository = makeRepository('cycle-commit-hooks');
		const hooks = join(repository.root, '.git', 'hooks');
		mkdirSync(hooks, { recursive: true });
		for (const name of ['pre-commit', 'commit-msg']) {
			const path = join(hooks, name);
			writeFileSync(path, '#!/bin/sh\necho hook-ran >> hook-ran\nexit 1\n');
			chmodSync(path, 0o755);
		}
		writeFileSync(join(repository.root, 'a.txt'), 'a1\n');
		writeFileSync(join(repository.root, 'b.txt'), 'b1\n');
		const injected: CycleCommitGitRunner = (options) =>
			runGit({
				...options,
				env: { GIT_AUTHOR_NAME: 'Injected', GIT_COMMITTER_NAME: 'Injected', ...(options.env ?? {}) }
			});
		const result = atom(repository, { git: injected });
		expect(result.status).toBe('committed');
		expect(git(repository.root, ['status', '--porcelain', '--', 'hook-ran'])).toBe('');
		expect(git(repository.root, ['show', '-s', '--format=%an <%ae>', 'HEAD']).trim()).toBe('Local Person <local@example.test>');
	});

	it('rejects a canonical-trailer receipt whose commit changed an unexpected path', () => {
		const repository = makeRepository('cycle-commit-receipt-extra-path');
		writeFileSync(join(repository.root, 'a.txt'), 'a1\n');
		writeFileSync(join(repository.root, 'b.txt'), 'b1\n');
		writeFileSync(join(repository.root, 'outside.txt'), 'outside1\n');
		const committed = atom(repository, { paths: ['a.txt', 'b.txt', 'outside.txt'] });
		if (committed.sha === null) throw new Error('unexpected no-op');
		expect(() =>
			validateCycleCommitReceipt({
				patchesDir: repository.root,
				expectedBranch: repository.branch,
				expectedParent: repository.base,
				targetTag: TAG,
				subject: 'fix(cycle): adapt exact artifacts',
				paths: ['a.txt', 'b.txt'],
				timestamp: TIMESTAMP,
				cause: CAUSE,
				commitSha: committed.sha
			})
		).toThrow(/exact recorded atom/);
	});

	it('refuses every real staged path, unrelated worktree dirt and the wrong branch', () => {
		const staged = makeRepository('cycle-commit-staged-dirt');
		writeFileSync(join(staged.root, 'a.txt'), 'a1\n');
		git(staged.root, ['add', '--', 'a.txt']);
		expect(() => atom(staged)).toThrowError(/clean real index/);

		const unstaged = makeRepository('cycle-commit-unstaged-dirt');
		writeFileSync(join(unstaged.root, 'a.txt'), 'a1\n');
		writeFileSync(join(unstaged.root, 'b.txt'), 'b1\n');
		writeFileSync(join(unstaged.root, 'outside.txt'), 'outside1\n');
		expect(() => atom(unstaged)).toThrowError(/unexpected worktree dirt/);

		const branch = makeRepository('cycle-commit-wrong-branch');
		git(branch.root, ['switch', '--quiet', '-c', 'other']);
		expect(() => atom(branch)).toThrowError(/requires branch/);
	});

	it('retains the real index byte-for-byte after commit-tree failure and retries', () => {
		const repository = makeRepository('cycle-commit-retry');
		writeFileSync(join(repository.root, 'a.txt'), 'a1\n');
		writeFileSync(join(repository.root, 'b.txt'), 'b1\n');
		const before = indexBytes(repository);
		let failed = false;
		const once: CycleCommitGitRunner = (options) => {
			if (!failed && options.args[0] === 'commit-tree') {
				failed = true;
				return { status: 1, stdout: '', stderr: 'injected commit failure\n' };
			}
			return runGit(options);
		};
		expect(() => atom(repository, { git: once })).toThrowError(/injected commit failure/);
		expect(indexBytes(repository)).toEqual(before);
		expect(git(repository.root, ['rev-parse', 'HEAD']).trim()).toBe(repository.base);
		assertNoIndexDebris(repository);
		expect(atom(repository).status).toBe('committed');
	});

	it('loses a CAS race without touching the real index', () => {
		const repository = makeRepository('cycle-commit-cas');
		writeFileSync(join(repository.root, 'a.txt'), 'a1\n');
		writeFileSync(join(repository.root, 'b.txt'), 'b1\n');
		const before = indexBytes(repository);
		const tree = git(repository.root, ['rev-parse', `${repository.base}^{tree}`]).trim();
		const race = runGit({
			args: ['commit-tree', tree, '-p', repository.base, '-m', 'race'],
			cwd: repository.root,
			env: { ...IDENTITY, GIT_AUTHOR_DATE: '@1788195500 +0000', GIT_COMMITTER_DATE: '@1788195500 +0000' }
		}).stdout.trim();
		let raced = false;
		const runner: CycleCommitGitRunner = (options) => {
			if (!raced && options.args[0] === 'update-ref') {
				raced = true;
				runGit({ args: ['update-ref', `refs/heads/${repository.branch}`, race, repository.base], cwd: repository.root });
			}
			return runGit(options);
		};
		expect(() => atom(repository, { git: runner })).toThrowError(/changed before CAS/);
		expect(git(repository.root, ['rev-parse', 'HEAD']).trim()).toBe(race);
		expect(indexBytes(repository)).toEqual(before);
		assertNoIndexDebris(repository);
	});

	it('detects same-path races and blocks concurrent real-index staging', () => {
		const changed = makeRepository('cycle-commit-same-path-race');
		writeFileSync(join(changed.root, 'a.txt'), 'a1\n');
		writeFileSync(join(changed.root, 'b.txt'), 'b1\n');
		const before = indexBytes(changed);
		let mutated = false;
		const mutation: CycleCommitGitRunner = (options) => {
			if (!mutated && options.args[0] === 'hash-object' && options.args.includes('-w')) {
				mutated = true;
				writeFileSync(join(changed.root, 'a.txt'), 'raced\n');
			}
			return runGit(options);
		};
		expect(() => atom(changed, { git: mutation })).toThrowError(/changed while captured/);
		expect(indexBytes(changed)).toEqual(before);
		expect(git(changed.root, ['rev-parse', 'HEAD']).trim()).toBe(changed.base);

		const staged = makeRepository('cycle-commit-stage-race');
		writeFileSync(join(staged.root, 'a.txt'), 'a1\n');
		writeFileSync(join(staged.root, 'b.txt'), 'b1\n');
		let stageStatus: number | null = null;
		const staging: CycleCommitGitRunner = (options) => {
			if (stageStatus === null && options.args[0] === 'hash-object' && options.args.includes('-w')) {
				stageStatus = runGit({ args: ['add', '--', 'outside.txt'], cwd: staged.root }).status;
			}
			return runGit(options);
		};
		expect(atom(staged, { git: staging }).status).toBe('committed');
		expect(stageStatus).not.toBe(0);
		expect(git(staged.root, ['show', '--format=', '--name-only', 'HEAD']).trim().split('\n').sort()).toEqual(['a.txt', 'b.txt']);
	});

	it.each(['true', 'false'])('detects chmod races even with core.filemode=%s', (filemode) => {
		const repository = makeRepository(`cycle-commit-mode-race-${filemode}`);
		writeFileSync(join(repository.root, 'a.txt'), 'a1\n');
		writeFileSync(join(repository.root, 'b.txt'), 'b1\n');
		chmodSync(join(repository.root, 'a.txt'), 0o644);
		expect(runGit({ args: ['config', 'core.filemode', filemode], cwd: repository.root }).status).toBe(0);
		const before = indexBytes(repository);
		let raced = false;
		const runner: CycleCommitGitRunner = (options) => {
			if (!raced && options.args[0] === 'update-ref') {
				raced = true;
				chmodSync(join(repository.root, 'a.txt'), 0o755);
			}
			return runGit(options);
		};
		expect(() => atom(repository, { git: runner })).toThrowError(/content or mode changed/);
		expect(git(repository.root, ['rev-parse', 'HEAD']).trim()).toBe(repository.base);
		expect(indexBytes(repository)).toEqual(before);
	});

	it('bypasses clean filters and makes no-op/failure paths preserve the real index', () => {
		let repository = makeRepository('cycle-commit-raw-filter');
		writeFileSync(join(repository.root, '.gitattributes'), 'a.txt filter=evil\n');
		manualCommit(repository.root, '.gitattributes', 'attributes');
		repository = { ...repository, base: git(repository.root, ['rev-parse', 'HEAD']).trim() };
		gitLocal({ args: ['config', 'filter.evil.clean', "sed 's/raw/FILTERED/'"], cwd: repository.root });
		writeFileSync(join(repository.root, 'a.txt'), 'raw\n');
		writeFileSync(join(repository.root, 'b.txt'), 'b1\n');
		expect(atom(repository).status).toBe('committed');
		expect(git(repository.root, ['show', 'HEAD:a.txt'])).toBe('raw\n');

		const noop = makeRepository('cycle-commit-noop');
		const before = indexBytes(noop);
		expect(() => atom(noop)).toThrowError(/unchanged/);
		expect(indexBytes(noop)).toEqual(before);
		expect(atom(noop, { allowNoop: true })).toEqual({ status: 'noop', sha: null });
		expect(indexBytes(noop)).toEqual(before);
		expect(() => atom(noop, { paths: ['../escape'] })).toThrow(CkError);
		expect(() => atom(noop, { paths: ['.git/config'] })).toThrow(CkError);
	});
});

describe('cycle history validation', () => {
	afterAll(cleanupTempRoots);

	it('accepts only one canonical terminal block and Cause on every fix', () => {
		const repository = makeRepository('cycle-history-valid');
		manualCommit(repository.root, 'a.txt', `feat(cycle): classify\n\nCodkit-Cycle: ${TAG}`);
		const fix = manualCommit(repository.root, 'b.txt', `fix(cycle): adapt\n\nCause: ${CAUSE}\nCodkit-Cycle: ${TAG}`);
		expect(validateCycleCommitHistory({ patchesDir: repository.root, fromExclusive: repository.base, targetTag: TAG })).toEqual({
			commits: expect.arrayContaining([fix]),
			fixCommits: [fix]
		});
	});

	it('rejects duplicate, case-variant/body, malformed and missing reserved trailers', () => {
		const duplicate = makeRepository('cycle-history-duplicate');
		manualCommit(duplicate.root, 'a.txt', `feat: duplicate\n\ncodkit-cycle: ${TAG}\nCodkit-Cycle: ${TAG}`);
		expect(() => validateCycleCommitHistory({ patchesDir: duplicate.root, fromExclusive: duplicate.base, targetTag: TAG })).toThrowError(
			/exactly one canonical Codkit-Cycle/
		);

		const body = makeRepository('cycle-history-body');
		manualCommit(body.root, 'a.txt', `feat: mentions Cause: ${CAUSE}\n\nCodkit-Cycle: ${TAG}`);
		expect(() => validateCycleCommitHistory({ patchesDir: body.root, fromExclusive: body.base, targetTag: TAG })).toThrowError(
			/noncanonical Cause|terminal trailer block/
		);

		const malformed = makeRepository('cycle-history-malformed');
		manualCommit(malformed.root, 'a.txt', `fix: malformed\n\nCause: short\nCodkit-Cycle: ${TAG}`);
		expect(() => validateCycleCommitHistory({ patchesDir: malformed.root, fromExclusive: malformed.base, targetTag: TAG })).toThrowError(
			/noncanonical Cause/
		);

		const missing = makeRepository('cycle-history-missing');
		manualCommit(missing.root, 'a.txt', `fix: missing\n\nCodkit-Cycle: ${TAG}`);
		expect(() => validateCycleCommitHistory({ patchesDir: missing.root, fromExclusive: missing.base, targetTag: TAG })).toThrowError(
			/wrong number.*Cause/
		);
	});
});
