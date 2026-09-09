// The classification behind `load --fresh --discard` (PROP-007
// ##CMD-LOAD-DISCARD-WORKTREE), at the level where the decision is made.
//
// The drift guard stays generic and only asks: these tests pin what the answer
// is for each kind of dirt, and - just as importantly - which dirt the guard
// never asks about at all, because own code and untracked litter have other
// halves to answer for them.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConventions } from '../../src/lib/conventionsFile.ts';
import type { Conventions } from '../../src/lib/conventionsFile.ts';
import { emptyWorktreeDiscardPlan, worktreeDiscardClassifier } from '../../src/lib/discardWorktree.ts';
import type { WorktreeDiscardPlan } from '../../src/lib/discardWorktree.ts';
import { driftDirty } from '../../src/lib/driftGuard.ts';
import type { DriftOptions, DriftResult, PorcelainEntry } from '../../src/lib/driftGuard.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { materializerOf } from '../../src/lib/layers/ownExtensions.ts';
import { oneOwnedRoot, ownedRoot } from '../support/ownedRoots.ts';

/** A tracked upstream file no artifact of the delta touches: it carries no block. */
const PLAIN_UPSTREAM = 'src/vs/base/common/lifecycle.ts';
const OWN_IN_TREE = 'src/vs/patchset/hello.ts';

let fixture: SyncFixture;
let conventions: Conventions;

beforeAll(() => {
	fixture = makeSyncFixture('discard-worktree');
	expect(fixture.sync().exitCode).toBe(0);
	conventions = loadConventions(vscodeType, fixture.patchesDir);
});

afterAll(() => {
	cleanupTempRoots();
});

function generated(): DriftOptions['generated'] {
	return { pinSha: fixture.config.pin.sha, branch: `${fixture.config.generatedBranchPrefix}${fixture.config.pin.tag}` };
}

/** The guard as `load --fresh --discard` arms it, plus the plan it filled in. */
function classify(spy?: (entry: PorcelainEntry) => void): { plan: WorktreeDiscardPlan; drift: DriftResult } {
	const plan = emptyWorktreeDiscardPlan();
	const decide = worktreeDiscardClassifier(fixture.treeDir, conventions, plan);
	const drift = driftDirty(
		materializerOf(vscodeType),
		fixture.treeDir,
		oneOwnedRoot(fixture.config.typeConfig.ownRoot),
		fixture.patchesDir,
		{
			untrackedIsDirt: false,
			generated: generated(),
			isDiscardable: (entry) => {
				spy?.(entry);
				return decide(entry);
			}
		}
	);
	return { plan, drift };
}

/** Change something in the tree, look, put it back. */
function whileChanged<T>(relative: string, content: string, look: () => T): T {
	const absolute = join(fixture.treeDir, relative);
	let saved: Buffer | null = null;
	try {
		saved = readFileSync(absolute);
	} catch {
		saved = null;
	}
	writeFileSync(absolute, content, 'utf8');
	try {
		return look();
	} finally {
		if (saved === null) {
			rmSync(absolute, { force: true });
		} else {
			writeFileSync(absolute, saved);
		}
	}
}

describe('the working-tree discard classifier', () => {
	it('takes a tracked upstream file that carries no marker block', () => {
		const { plan, drift } = whileChanged(PLAIN_UPSTREAM, '// rewritten by the tree build\n', classify);

		expect(plan.discard).toEqual([PLAIN_UPSTREAM]);
		expect(plan.markerCarrying).toEqual([]);
		// Taken means gone from half (a): the guard has nothing left to refuse over.
		expect(drift.upstream).toEqual([]);
		expect(drift.dirty).toBe(false);
	});

	it('takes a tracked upstream file the build deleted', () => {
		const absolute = join(fixture.treeDir, PLAIN_UPSTREAM);
		const saved = readFileSync(absolute);
		rmSync(absolute);
		try {
			const { plan, drift } = classify();
			expect(plan.discard).toEqual([PLAIN_UPSTREAM]);
			expect(drift.dirty).toBe(false);
		} finally {
			writeFileSync(absolute, saved);
		}
	});

	it('leaves a file that carries a marker block alone, and names it', () => {
		const applied = readFileSync(join(fixture.treeDir, EXAMPLE_PART_PATH), 'utf8');
		const { plan, drift } = whileChanged(EXAMPLE_PART_PATH, `${applied}// a hand edit outside the block\n`, classify);

		expect(plan.markerCarrying).toEqual([EXAMPLE_PART_PATH]);
		expect(plan.discard).toEqual([]);
		// Refused means still dirt: the refusal the guard raises is the one the
		// flag never lifts.
		expect(drift.upstream).toEqual([EXAMPLE_PART_PATH]);
		expect(drift.dirty).toBe(true);
	});

	it('leaves a path the tip does not carry alone: there is nothing to return it to', () => {
		const relative = 'src/vs/base/common/generatedByTheBuild.ts';
		const absolute = join(fixture.treeDir, relative);
		writeFileSync(absolute, '// produced by the build and staged\n', 'utf8');
		runGit({ args: ['add', '--', relative], cwd: fixture.treeDir });
		try {
			const { plan, drift } = classify();
			expect(plan.discard).toEqual([]);
			expect(plan.markerCarrying).toEqual([]);
			expect(drift.upstream).toEqual([relative]);
		} finally {
			runGit({ args: ['rm', '--quiet', '--force', '--', relative], cwd: fixture.treeDir });
		}
	});

	it('is never asked about own code: git cannot see it, and save owns it', () => {
		const asked: string[] = [];
		const { plan, drift } = whileChanged(OWN_IN_TREE, '// edited in the tree\n', () =>
			classify((entry) => {
				asked.push(entry.path);
			})
		);

		expect(asked).toEqual([]);
		expect(plan.discard).toEqual([]);
		// Half (b) still carries the verdict, untouched by the flag.
		expect(drift.own).toContainEqual({ relative: 'hello.ts', kind: 'both', owned: ownedRoot('src/vs/patchset') });
		expect(drift.dirty).toBe(true);
	});

	it('is never asked about untracked litter: the cleanup whitelist speaks for it', () => {
		const asked: string[] = [];
		const litter = join(fixture.treeDir, 'left-behind.txt');
		writeFileSync(litter, 'junk\n', 'utf8');
		try {
			const { plan, drift } = classify((entry) => {
				asked.push(entry.path);
			});

			expect(asked).toEqual([]);
			expect(plan.discard).toEqual([]);
			// `--fresh` already answered for it: untracked is not dirt in that run,
			// and the whitelist decides whether the path survives the cleanup.
			expect(drift.dirty).toBe(false);
		} finally {
			rmSync(litter, { force: true });
		}
	});
});
