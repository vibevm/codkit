// The fast-path rule (PROP-006 sec. 1, ##FAST-PATH-RULE): the no-op load is
// allowed only when every one of its conditions holds.
//
// The test starts from a state that is consistent by construction - a real load
// on the fixture tree - and then breaks the conditions one at a time. Each of
// them alone must forbid the fast path, because each of them alone means the
// tree is no longer what the cache claims.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deltaFingerprint, treeId } from '../../src/lib/fingerprint.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { fastPathOk, readTreeCache, readTreeMark, treeCachePath, treeMarkPath } from '../../src/lib/treeCache.ts';
import type { FastPathInput } from '../../src/lib/treeCache.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

let fixture: SyncFixture;
let branch: string;
let cachePath: string;
let markPath: string;

beforeAll(() => {
	fixture = makeSyncFixture('fastpath');
	branch = `${fixture.config.generatedBranchPrefix}${fixture.config.pin.tag}`;
	const result = fixture.sync();
	expect(result.exitCode).toBe(0);
	expect(result.status).toBe('applied');
	cachePath = treeCachePath(fixture.patchesDir, treeId(fixture.treeDir));
	markPath = treeMarkPath(fixture.treeDir);
});

afterAll(() => {
	cleanupTempRoots();
});

/** The input as it is right now: cache and mark re-read from disk every time. */
function currentInput(): FastPathInput {
	return {
		treeDir: fixture.treeDir,
		branch,
		cache: readTreeCache(fixture.patchesDir, treeId(fixture.treeDir)),
		mark: readTreeMark(fixture.treeDir),
		pinSha: fixture.config.pin.sha,
		deltaFingerprint: deltaFingerprint(fixture.patchesDir, fixture.config.pin.sha)
	};
}

/** Break one thing, look at the verdict, put it back. */
function whileBroken(breakIt: () => void, restore: () => void): { ok: boolean; reason: string } {
	breakIt();
	try {
		const verdict = fastPathOk(currentInput());
		return verdict.ok ? { ok: true, reason: '' } : { ok: false, reason: verdict.reason };
	} finally {
		restore();
	}
}

describe('fastPathOk', () => {
	it('allows the no-op right after a load', () => {
		expect(fastPathOk(currentInput()).ok).toBe(true);
	});

	it('is refused when the cache is gone', () => {
		const saved = readFileSync(cachePath);
		const verdict = whileBroken(
			() => rmSync(cachePath),
			() => writeFileSync(cachePath, saved)
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('no apply cache');
	});

	it('is refused when the pin moved', () => {
		const verdict = fastPathOk({ ...currentInput(), pinSha: '0'.repeat(40) });
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain('pin');
	});

	it('is refused when the delta fingerprint moved', () => {
		const saved = readFileSync(join(fixture.patchesDir, 'delta', 'own', 'hello.ts'));
		const verdict = whileBroken(
			() => writeFileSync(join(fixture.patchesDir, 'delta', 'own', 'hello.ts'), '// edited in patchset\n'),
			() => writeFileSync(join(fixture.patchesDir, 'delta', 'own', 'hello.ts'), saved)
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('fingerprint');
	});

	it('is refused when the generated branch is gone', () => {
		const tip = runGit({ args: ['rev-parse', `refs/heads/${branch}`], cwd: fixture.treeDir }).stdout.trim();
		const verdict = whileBroken(
			() => {
				runGit({ args: ['symbolic-ref', 'HEAD', 'refs/heads/other'], cwd: fixture.treeDir });
				runGit({ args: ['update-ref', '-d', `refs/heads/${branch}`], cwd: fixture.treeDir });
			},
			() => {
				runGit({ args: ['update-ref', `refs/heads/${branch}`, tip], cwd: fixture.treeDir });
				runGit({ args: ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], cwd: fixture.treeDir });
			}
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('does not exist');
	});

	it('is refused when the branch tip is not the one in the cache', () => {
		const tip = runGit({ args: ['rev-parse', `refs/heads/${branch}`], cwd: fixture.treeDir }).stdout.trim();
		const parent = runGit({ args: ['rev-parse', `${tip}^`], cwd: fixture.treeDir }).stdout.trim();
		const verdict = whileBroken(
			() => runGit({ args: ['update-ref', `refs/heads/${branch}`, parent], cwd: fixture.treeDir }),
			() => runGit({ args: ['update-ref', `refs/heads/${branch}`, tip], cwd: fixture.treeDir })
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('the cache recorded');
	});

	it('is refused when HEAD is not on the branch', () => {
		const verdict = whileBroken(
			() => runGit({ args: ['checkout', '--quiet', '--detach', 'HEAD'], cwd: fixture.treeDir }),
			() => runGit({ args: ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], cwd: fixture.treeDir })
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('detached');
	});

	it('is refused when the mark disagrees with the cache', () => {
		const saved = readFileSync(markPath);
		const mark = JSON.parse(saved.toString('utf8')) as Record<string, unknown>;
		const verdict = whileBroken(
			() => writeFileSync(markPath, JSON.stringify({ ...mark, branchTip: '0'.repeat(40) })),
			() => writeFileSync(markPath, saved)
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('mark');
	});

	it('is allowed when the mark is absent, because the branch is the truth', () => {
		const saved = readFileSync(markPath);
		const verdict = whileBroken(
			() => rmSync(markPath),
			() => writeFileSync(markPath, saved)
		);
		expect(verdict.ok).toBe(true);
	});

	it('drives the second load to "up to date" and the broken state to a full apply', () => {
		const second = fixture.sync();
		expect(second.status).toBe('up-to-date');
		expect(second.exitCode).toBe(0);

		const patches = join(fixture.patchesDir, 'delta', 'own', 'hello.ts');
		const saved = readFileSync(patches);
		writeFileSync(patches, '// a change on the patchset side\n');
		try {
			const third = fixture.sync();
			expect(third.status).toBe('applied');
			expect(third.fastPathReason).toContain('fingerprint');
		} finally {
			writeFileSync(patches, saved);
			fixture.sync();
		}
	});
});
