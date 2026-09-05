// REPAIR-006 finding 1: a generated branch is one object shared by every
// worktree of its repository, and git plumbing permits two worktrees to sit on
// it (`symbolic-ref` does not check). Moving the ref from the second leaves the
// first worktree's index and work tree dirty against a HEAD it never moved.
// The guarded mutation (PROP-008 ##GENERATED-REF-WORKTREE-PREFLIGHT) refuses
// before anything changes, names both worktrees, and serializes the
// check-then-mutate pair with a lock in the common administrative directory.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { CkError } from '../../src/lib/messages.ts';
import { acquirePathLock } from '../../src/lib/lock.ts';
import { commonLockDirectory, mutateGeneratedRef } from '../../src/lib/worktrees.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

const REF = 'refs/heads/codkit/applied/1.135.0';

/**
 * A repository with two linked worktrees; the first has the generated branch
 * checked out legitimately, the second is pointed at it by plumbing - exactly
 * the shared state git permits and codkit must refuse to act on.
 */
function makeSharedRefWorktrees(label: string): { readonly main: string; readonly first: string; readonly second: string } {
	const main = makeTempRoot(`${label}-main`);
	runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: main });
	runGit({
		args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'commit', '--quiet', '--allow-empty', '-m', 'base'],
		cwd: main
	});
	runGit({ args: ['update-ref', REF, 'HEAD'], cwd: main });

	const first = join(makeTempRoot(`${label}-first`), 'wt-one');
	mkdirSync(dirname(first), { recursive: true });
	runGit({ args: ['worktree', 'add', '--quiet', first], cwd: main });
	// By branch name: a full refs/heads path would check out detached.
	runGit({ args: ['checkout', '--quiet', REF.replace('refs/heads/', '')], cwd: first });
	writeFileSync(join(first, 'tracked.txt'), 'base state\n', 'utf8');
	runGit({ args: ['add', 'tracked.txt'], cwd: first });
	runGit({ args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'commit', '--quiet', '-m', 'base state'], cwd: first });

	const second = join(makeTempRoot(`${label}-second`), 'wt-two');
	mkdirSync(dirname(second), { recursive: true });
	runGit({ args: ['worktree', 'add', '--quiet', '--detach', second], cwd: main });
	runGit({ args: ['symbolic-ref', 'HEAD', REF], cwd: second });
	return { main, first, second };
}

function refSha(tree: string): string {
	return runGit({ args: ['rev-parse', REF], cwd: tree }).stdout.trim();
}

function headRef(tree: string): string {
	return runGit({ args: ['symbolic-ref', 'HEAD'], cwd: tree }).stdout.trim();
}

function statusOf(tree: string): string {
	return runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: tree }).stdout;
}

describe('the generated-ref worktree preflight', () => {
	it('refuses while a sibling worktree has the branch checked out, changing nothing', () => {
		const { first, second } = makeSharedRefWorktrees('ref-shared');
		const refBefore = refSha(second);
		const firstStatus = statusOf(first);
		const secondHead = headRef(second);

		let mutated = 0;
		let error: unknown;
		try {
			mutateGeneratedRef(second, REF, () => {
				mutated += 1;
				runGit({ args: ['update-ref', REF, refSha(first)], cwd: second });
			});
		} catch (thrown) {
			error = thrown;
		}

		expect(error).toBeInstanceOf(CkError);
		expect((error as CkError).code).toBe('WORKTREE-REF-SHARED');
		const message = (error as Error).message;
		expect(message).toContain(first);
		expect(message).toContain(second);
		expect(mutated).toBe(0);
		// Every ref, index and work tree is exactly as it was.
		expect(refSha(second)).toBe(refBefore);
		expect(statusOf(first)).toBe(firstStatus);
		expect(headRef(second)).toBe(secondHead);
		expect(headRef(first)).toBe(REF);
	});

	it('moves the ref when the worktree holding it is the tree being synced', () => {
		const { first, second } = makeSharedRefWorktrees('ref-self');
		// The normal post-sync state: this worktree itself sits on the generated
		// branch, and no sibling does. A re-sync must be able to move it.
		runGit({ args: ['symbolic-ref', 'HEAD', 'refs/heads/ck-own'], cwd: first });
		runGit({ args: ['branch', 'ck-own'], cwd: first });
		runGit({ args: ['symbolic-ref', 'HEAD', 'refs/heads/ck-own'], cwd: first });

		const before = refSha(second);
		let mutated = 0;
		mutateGeneratedRef(second, REF, () => {
			mutated += 1;
		});
		expect(mutated).toBe(1);
		expect(refSha(second)).toBe(before);
	});

	it('moves the ref when no sibling worktree exists at all', () => {
		const repo = makeTempRoot('ref-lone');
		runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: repo });
		runGit({
			args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'commit', '--quiet', '--allow-empty', '-m', 'base'],
			cwd: repo
		});
		runGit({ args: ['update-ref', REF, 'HEAD'], cwd: repo });

		let mutated = 0;
		mutateGeneratedRef(repo, REF, () => {
			mutated += 1;
		});
		expect(mutated).toBe(1);
	});

	it('re-runs the preflight under the lock, so a sibling switched during the window still refuses', () => {
		const { first, second } = makeSharedRefWorktrees('ref-race');
		// The first worktree leaves the branch before the guarded call starts;
		// it switches back inside the window, after the lock is held - the
		// preflight must see the state as it is under the lock, not as it was.
		runGit({ args: ['checkout', '--quiet', '--detach'], cwd: first });
		const refBefore = refSha(second);

		let mutated = 0;
		let error: unknown;
		try {
			mutateGeneratedRef(
				second,
				REF,
				() => {
					mutated += 1;
				},
				{
					afterLock: () => {
						runGit({ args: ['symbolic-ref', 'HEAD', REF], cwd: first });
					}
				}
			);
		} catch (thrown) {
			error = thrown;
		}

		expect(error).toBeInstanceOf(CkError);
		expect((error as CkError).code).toBe('WORKTREE-REF-SHARED');
		expect(mutated).toBe(0);
		expect(refSha(second)).toBe(refBefore);
	});

	it('never mutates when the worktree safety proof cannot be obtained', () => {
		const repo = makeTempRoot('ref-list-unavailable');
		runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: repo });
		runGit({
			args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'commit', '--quiet', '--allow-empty', '-m', 'base'],
			cwd: repo
		});
		runGit({ args: ['update-ref', REF, 'HEAD'], cwd: repo });
		const before = refSha(repo);
		let mutated = 0;

		expect(() =>
			mutateGeneratedRef(
				repo,
				REF,
				() => {
					mutated += 1;
				},
				{
					assertExclusive: () => {
						throw new CkError({
							code: 'ARTIFACT-BROKEN',
							message: 'cannot inspect linked worktrees',
							hint: 'repair git worktree metadata'
						});
					}
				}
			)
		).toThrow(/cannot inspect linked worktrees/);
		expect(mutated).toBe(0);
		expect(refSha(repo)).toBe(before);
	});

	it('cannot mutate at all while another codkit process holds the common lock', () => {
		const { first, second } = makeSharedRefWorktrees('ref-locked');
		runGit({ args: ['checkout', '--quiet', '--detach'], cwd: first });
		const refBefore = refSha(second);

		// The identical hard-link protocol a second codkit process would use.
		const holder = acquirePathLock(`${commonLockDirectory(second)}/refs.lock`, 'competing sync');
		try {
			let mutated = 0;
			expect(() =>
				mutateGeneratedRef(second, REF, () => {
					mutated += 1;
				})
			).toThrow(/another codkit command/);
			expect(mutated).toBe(0);
			expect(refSha(second)).toBe(refBefore);
		} finally {
			holder.release();
		}

		// Once the competitor is gone the guarded mutation runs.
		let mutated = 0;
		mutateGeneratedRef(second, REF, () => {
			mutated += 1;
		});
		expect(mutated).toBe(1);
	});
});

describe('a full runSync over a tree whose sibling worktree holds the generated branch', () => {
	it('refuses with every ref, index and work tree unchanged', () => {
		const fixture = makeSyncFixture('ref-runsync');
		const applied = fixture.sync();
		expect(applied.status).toBe('applied');
		const branch = applied.branch;
		const ref = `refs/heads/${branch}`;

		// A sibling worktree of the fork tree's own repository, put on the
		// generated branch by plumbing - the state git permits and nothing
		// else checks.
		const sibling = join(makeTempRoot('ref-runsync-sibling'), 'sibling');
		mkdirSync(dirname(sibling), { recursive: true });
		runGit({ args: ['worktree', 'add', '--quiet', '--detach', sibling], cwd: fixture.treeDir });
		runGit({ args: ['symbolic-ref', 'HEAD', ref], cwd: sibling });
		writeFileSync(join(sibling, 'sibling-file.txt'), 'sibling state\n', 'utf8');
		const removable = join(fixture.treeDir, 'remove-on-fresh.txt');
		writeFileSync(removable, 'must survive refused fresh sync\n', 'utf8');

		const refBefore = runGit({ args: ['rev-parse', ref], cwd: fixture.treeDir }).stdout.trim();
		const indexBefore = runGit({ args: ['write-tree'], cwd: fixture.treeDir }).stdout.trim();
		const headTreeBefore = runGit({ args: ['rev-parse', 'HEAD^{tree}'], cwd: fixture.treeDir }).stdout.trim();
		const treeStatus = runGit({ args: ['status', '--porcelain'], cwd: fixture.treeDir }).stdout;
		const siblingStatus = runGit({ args: ['status', '--porcelain'], cwd: sibling }).stdout;

		const refused = fixture.sync({ fresh: true });
		expect(refused.exitCode).toBe(2);
		expect(refused.status).toBe('unfit');

		// Nothing moved: the generated ref, the tree and the sibling worktree
		// are exactly as they were before the refused run.
		expect(runGit({ args: ['rev-parse', ref], cwd: fixture.treeDir }).stdout.trim()).toBe(refBefore);
		expect(runGit({ args: ['write-tree'], cwd: fixture.treeDir }).stdout.trim()).toBe(indexBefore);
		expect(runGit({ args: ['rev-parse', 'HEAD^{tree}'], cwd: fixture.treeDir }).stdout.trim()).toBe(headTreeBefore);
		expect(runGit({ args: ['status', '--porcelain'], cwd: fixture.treeDir }).stdout).toBe(treeStatus);
		expect(runGit({ args: ['status', '--porcelain'], cwd: sibling }).stdout).toBe(siblingStatus);
		expect(existsSync(removable)).toBe(true);
		expect(readFileSync(removable, 'utf8')).toBe('must survive refused fresh sync\n');
	});
});
