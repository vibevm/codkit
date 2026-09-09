// The save selector (PROP-008 sec. 4, campaign decision D4): work is the tree's
// final state relative to the last applied tip, never `git status` alone. The
// cases here are the states of that decision - staged, unstaged, untracked,
// deleted, committed-only, committed-then-modified - plus the own-directory
// filter and the forced paths of the internal addressed callers.
//
// The committed-only case is the reason the module exists: over a commit the
// porcelain output is empty, and before this selector `save` answered
// "nothing to save" over work that existed (F7).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitLocal, runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { CkError } from '../../src/lib/messages.ts';
import { bytesOf, changesSince } from '../../src/lib/treeState.ts';
import type { StateChange } from '../../src/lib/treeState.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { oneOwnedRoot } from '../support/ownedRoots.ts';

const IDENTITY: GitEnv = {
	GIT_AUTHOR_NAME: 'human',
	GIT_AUTHOR_EMAIL: 'human@example.invalid',
	GIT_AUTHOR_DATE: '2026-09-06T11:00:00Z',
	GIT_COMMITTER_NAME: 'human',
	GIT_COMMITTER_EMAIL: 'human@example.invalid',
	GIT_COMMITTER_DATE: '2026-09-06T11:00:00Z'
};

const TARGET = 'src/vs/workbench/browser/parts/example/examplePart.ts';

let fixture: SyncFixture;

beforeAll(() => {
	fixture = makeSyncFixture('treestate');
	expect(fixture.sync().exitCode).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

function branch(): string {
	return `${fixture.config.generatedBranchPrefix}${fixture.config.pin.tag}`;
}

/** Absolute path of a tree-relative POSIX path. */
function treePath(relative: string): string {
	return join(fixture.treeDir, ...relative.split('/'));
}

/** The last applied tip the loaded tree stands on. */
function base(): string {
	return runGit({ args: ['rev-parse', `refs/heads/${branch()}`], cwd: fixture.treeDir }).stdout.trim();
}

function changes(forcedPaths: readonly string[] = []): readonly StateChange[] {
	return changesSince(fixture.treeDir, base(), { kind: 'worktree' }, oneOwnedRoot(fixture.config.typeConfig.ownRoot), forcedPaths);
}

function statusOf(path: string): string {
	return changes().find((entry) => entry.path === path)?.status ?? '';
}

function readTarget(): string {
	return readFileSync(treePath(TARGET), 'utf8');
}

/** One `--no-verify` commit that appends a line to the example part (F12). */
function commitWithLine(line: string, subject: string): string {
	writeFileSync(treePath(TARGET), `${readTarget()}${line}\n`, 'utf8');
	const committed = gitLocal({
		args: ['commit', '--quiet', '--all', '--no-verify', '--message', subject],
		cwd: fixture.treeDir,
		env: IDENTITY
	});
	expect(committed.status).toBe(0);
	return runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.treeDir }).stdout.trim();
}

describe('changesSince over the worktree state', () => {
	it('sees nothing right after a load', () => {
		expect(changes()).toEqual([]);
	});

	it('sees a staged modification', () => {
		writeFileSync(treePath(TARGET), `${readTarget()}// staged line\n`, 'utf8');
		try {
			expect(gitLocal({ args: ['add', '--', TARGET], cwd: fixture.treeDir }).status).toBe(0);
			expect(changes().map((entry) => entry.path)).toEqual([TARGET]);
		} finally {
			gitLocal({ args: ['reset', '--quiet', 'HEAD', '--', TARGET], cwd: fixture.treeDir });
			gitLocal({ args: ['checkout', '--quiet', '--', TARGET], cwd: fixture.treeDir });
		}
	});

	it('sees an unstaged modification', () => {
		writeFileSync(treePath(TARGET), `${readTarget()}// unstaged line\n`, 'utf8');
		try {
			expect(changes().map((entry) => entry.path)).toEqual([TARGET]);
			expect(statusOf(TARGET)).toBe('M');
		} finally {
			gitLocal({ args: ['checkout', '--quiet', '--', TARGET], cwd: fixture.treeDir });
		}
	});

	it('sees an untracked path with the porcelain letters', () => {
		const path = 'src/vs/workbench/browser/parts/example/newFile.ts';
		writeFileSync(treePath(path), '// untracked\n', 'utf8');
		try {
			expect(changes().map((entry) => entry.path)).toEqual([path]);
			expect(statusOf(path)).toBe('??');
		} finally {
			rmSync(treePath(path));
		}
	});

	it('sees a deletion', () => {
		rmSync(treePath(TARGET));
		try {
			expect(changes().map((entry) => entry.path)).toEqual([TARGET]);
			expect(statusOf(TARGET)).toBe('D');
		} finally {
			gitLocal({ args: ['checkout', '--quiet', '--', TARGET], cwd: fixture.treeDir });
		}
	});

	it('sees work that is only committed - the case porcelain cannot see', () => {
		// A commit on the generated branch moves the branch ref with it; the
		// selection base is the topmost *generated* commit, which stays put.
		const appliedTip = base();
		commitWithLine('// committed line', 'work in the tree');
		try {
			// The porcelain view over a commit is empty; the selector is not.
			expect(runGit({ args: ['status', '--porcelain'], cwd: fixture.treeDir }).stdout).toBe('');
			expect(
				changesSince(fixture.treeDir, appliedTip, { kind: 'worktree' }, oneOwnedRoot(fixture.config.typeConfig.ownRoot)).map(
					(entry) => entry.path
				)
			).toEqual([TARGET]);
		} finally {
			gitLocal({ args: ['reset', '--quiet', '--hard', `refs/heads/${branch()}`], cwd: fixture.treeDir });
		}
	});

	it('sees committed-then-modified work once, as the final state', () => {
		const appliedTip = base();
		commitWithLine('// committed half', 'committed half');
		writeFileSync(treePath(TARGET), `${readTarget()}// uncommitted half\n`, 'utf8');
		try {
			const changes = changesSince(fixture.treeDir, appliedTip, { kind: 'worktree' }, oneOwnedRoot(fixture.config.typeConfig.ownRoot));
			expect(changes.map((entry) => entry.path)).toEqual([TARGET]);
			// The selection carries the final state; the byte read proves it.
			expect(Buffer.from(bytesOf(fixture.treeDir, { kind: 'worktree' }, TARGET)).toString('utf8')).toContain('// uncommitted half');
		} finally {
			gitLocal({ args: ['reset', '--quiet', '--hard', `refs/heads/${branch()}`], cwd: fixture.treeDir });
		}
	});

	it('filters the own directory out of the untracked union', () => {
		const ownPath = join(fixture.config.typeConfig.ownRoot, 'probe.ts');
		mkdirSync(dirname(treePath(ownPath)), { recursive: true });
		writeFileSync(treePath(ownPath), '// own side\n', 'utf8');
		try {
			expect(changes()).toEqual([]);
		} finally {
			rmSync(treePath(ownPath));
		}
	});

	it('appends a forced path that no diff reported, and never duplicates one', () => {
		writeFileSync(treePath(TARGET), `${readTarget()}// unstaged line\n`, 'utf8');
		try {
			const forced = changes([TARGET, 'src/other.ts']);
			expect(forced.map((entry) => entry.path)).toEqual(['src/other.ts', TARGET]);
			expect(forced.find((entry) => entry.path === TARGET)?.status).toBe('M');
			expect(forced.find((entry) => entry.path === 'src/other.ts')?.status).toBe(' M');
		} finally {
			gitLocal({ args: ['checkout', '--quiet', '--', TARGET], cwd: fixture.treeDir });
		}
	});

	it('refuses a forced path under the own prefix', () => {
		const ownForced = join(fixture.config.typeConfig.ownRoot, 'probe.ts');
		let thrown: unknown;
		try {
			changes([ownForced]);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CkError);
		expect((thrown as CkError).code).toBe('CONFIG');
	});
});

describe('changesSince over a commit state', () => {
	it('lists the committed state relative to base and reads its bytes from the blob', () => {
		const appliedTip = base();
		const sha = commitWithLine('// state of one commit', 'selector fixture commit');
		// An edit the commit does not hold separates the two byte sources.
		writeFileSync(treePath(TARGET), `${readTarget()}// after the commit\n`, 'utf8');
		try {
			const committed = changesSince(fixture.treeDir, appliedTip, { kind: 'commit', sha }, oneOwnedRoot(fixture.config.typeConfig.ownRoot));
			expect(committed.map((entry) => entry.path)).toEqual([TARGET]);
			const blob = Buffer.from(bytesOf(fixture.treeDir, { kind: 'commit', sha }, TARGET)).toString('utf8');
			expect(blob).toContain('// state of one commit');
			// A commit-state read answers from the blob, never the working file.
			expect(blob).not.toContain('// after the commit');
			expect(readTarget()).toContain('// after the commit');
		} finally {
			gitLocal({ args: ['reset', '--quiet', '--hard', `refs/heads/${branch()}`], cwd: fixture.treeDir });
		}
	});
});
