/** @scope spec://codkit/modules/codkit/PROP-007#cmd-reresolve */
// Real-launcher coverage for source discovery, exit codes, JSON, and repository
// immutability around `codkit reresolve`.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { encodePatchName } from '../../src/lib/patchFormat.ts';
import { EXAMPLE_AREA_ANCHOR, EXAMPLE_PART_PATH, fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { PATCH_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const PATCH_ARTIFACT = `delta/patches/${encodePatchName(EXAMPLE_PART_PATH)}`;
const MERGE_IDENTITY = {
	GIT_AUTHOR_NAME: 'fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_AUTHOR_DATE: '2026-07-01T00:02:00Z',
	GIT_COMMITTER_NAME: 'fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_DATE: '2026-07-01T00:02:00Z'
};

let fixture: CliFixture;

beforeEach(() => {
	fixture = makeCliFixture('reresolve-e2e');
});

afterAll(() => cleanupTempRoots());

describe('codkit reresolve source selection', () => {
	it('prefers an explicit contained patch and reports the complete machine result', () => {
		const before = repositorySnapshot(fixture);
		chmodSync(fixture.treePath(EXAMPLE_PART_PATH), 0o751);

		const outcome = fixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', PATCH_ARTIFACT]);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data).toMatchObject({
			target: EXAMPLE_PART_PATH,
			patch: { artifact: PATCH_ARTIFACT, source: `--patch ${PATCH_ARTIFACT}` },
			replay: { outcome: 'clean', conflictCount: 0 }
		});
		expect(outcome.envelope.data['nextAction']).toContain('codkit save');
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain(`// codkit:begin ${PATCH_ID}`);
		expect(statSync(fixture.treePath(EXAMPLE_PART_PATH)).mode & 0o777).toBe(0o751);
		expectRepositoryUnmutatedExceptTarget(fixture, before);
	});

	it('uses .orig before any merge object', () => {
		copyFileSync(fixture.patchesPath(PATCH_ARTIFACT), fixture.patchesPath(`${PATCH_ARTIFACT}.orig`));

		const outcome = fixture.json(['reresolve', EXAMPLE_PART_PATH]);

		expect(outcome.run.status).toBe(0);
		expect((outcome.envelope.data['patch'] as Record<string, unknown>)['source']).toBe(`${PATCH_ARTIFACT}.orig`);
	});

	it('reads HEAD during an in-progress merge and HEAD^1 after its two-parent commit', () => {
		startMerge(fixture, false);
		const inProgress = fixture.json(['reresolve', EXAMPLE_PART_PATH]);
		expect(inProgress.run.status).toBe(0);
		expect((inProgress.envelope.data['patch'] as Record<string, unknown>)['source']).toBe(`HEAD:${PATCH_ARTIFACT}`);

		const completedFixture = makeCliFixture('reresolve-e2e-completed');
		startMerge(completedFixture, true);
		const completed = completedFixture.json(['reresolve', EXAMPLE_PART_PATH]);
		expect(completed.run.status).toBe(0);
		expect((completed.envelope.data['patch'] as Record<string, unknown>)['source']).toBe(`HEAD^1:${PATCH_ARTIFACT}`);
	});

	it('fails with the checked source list when no source exists', () => {
		const outcome = fixture.json(['reresolve', EXAMPLE_PART_PATH]);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-ARTIFACT-BROKEN');
		expect(outcome.envelope.errors[0]?.hint).toContain(`${PATCH_ARTIFACT}.orig`);
		expect(outcome.envelope.errors[0]?.hint).toContain(`HEAD:${PATCH_ARTIFACT}`);
		expect(outcome.envelope.errors[0]?.hint).toContain(`HEAD^1:${PATCH_ARTIFACT}`);
	});
});

describe('codkit reresolve replay outcomes', () => {
	it('materializes diff3 conflicts and exits 1 with an actionable JSON result', () => {
		const path = fixture.treePath(EXAMPLE_PART_PATH);
		const base = readFileSync(path, 'utf8');
		writeFileSync(path, base.replace(`${EXAMPLE_AREA_ANCHOR}\n`, `${EXAMPLE_AREA_ANCHOR}\n\t\t// upstream edit at the same anchor\n`));

		const outcome = fixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', PATCH_ARTIFACT]);
		const bytes = readFileSync(path, 'utf8');
		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors).toEqual([]);
		expect(outcome.envelope.data['replay']).toEqual({ outcome: 'conflict', conflictCount: 1 });
		expect(outcome.envelope.data['nextAction']).toContain('edit the diff3 conflicts');
		expect(bytes).toContain('<<<<<<< ours\n');
		expect(bytes).toContain('||||||| base\n');
		expect(bytes).toContain('>>>>>>> theirs\n');
	});

	it('reports a deleted target as exit 1 and never recreates it', () => {
		const path = fixture.treePath(EXAMPLE_PART_PATH);
		unlinkSync(path);

		const outcome = fixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', PATCH_ARTIFACT]);
		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-STALE-ARTIFACT');
		expect(outcome.envelope.errors[0]?.hint).toContain('checked sources');
		expect(outcome.envelope.data['replay']).toEqual({ outcome: 'target-deleted', conflictCount: 0 });
		expect(() => statSync(path)).toThrow();
	});

	it('rejects a patch whose exact target differs', () => {
		const mismatch = 'saved/mismatch.ckpatch';
		const bytes = readFileSync(fixture.patchesPath(PATCH_ARTIFACT), 'utf8').replaceAll(EXAMPLE_PART_PATH, 'source/base/common/util.ts');
		write(fixture.patchesDir, mismatch, bytes);

		const outcome = fixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', mismatch]);
		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-MARKER-ARTIFACT-MISMATCH');
	});
});

describe('codkit reresolve safety and CLI exits', () => {
	it('uses exit 2 for missing usage and unsafe containment', () => {
		expect(fixture.run(['reresolve']).status).toBe(2);
		expect(fixture.json(['reresolve', '../escape.ts', '--patch', PATCH_ARTIFACT]).run.status).toBe(2);
		expect(fixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', '../escape.ckpatch']).run.status).toBe(2);
	});

	it('refuses target and patch symlinks without touching their outside bytes', () => {
		const targetOutside = makeTempRoot('reresolve-e2e-target-outside');
		const patchOutside = makeTempRoot('reresolve-e2e-patch-outside');
		write(targetOutside, 'victim.ts', 'target sentinel\n');
		copyFileSync(fixture.patchesPath(PATCH_ARTIFACT), join(patchOutside, 'old.ckpatch'));
		unlinkSync(fixture.treePath(EXAMPLE_PART_PATH));
		symlinkSync(join(targetOutside, 'victim.ts'), fixture.treePath(EXAMPLE_PART_PATH));
		writeFileSync(fixture.patchesPath('saved-placeholder'), 'placeholder');
		unlinkSync(fixture.patchesPath('saved-placeholder'));
		mkdirSync(fixture.patchesPath('saved'), { recursive: true });
		symlinkSync(join(patchOutside, 'old.ckpatch'), fixture.patchesPath('saved/link.ckpatch'));

		const targetRefusal = fixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', PATCH_ARTIFACT]);
		expect(targetRefusal.run.status).toBe(2);
		expect(readFileSync(join(targetOutside, 'victim.ts'), 'utf8')).toBe('target sentinel\n');

		const fresh = makeCliFixture('reresolve-e2e-patch-link');
		mkdirSync(fresh.patchesPath('saved'), { recursive: true });
		symlinkSync(join(patchOutside, 'old.ckpatch'), fresh.patchesPath('saved/link.ckpatch'));
		const patchRefusal = fresh.json(['reresolve', EXAMPLE_PART_PATH, '--patch', 'saved/link.ckpatch']);
		expect(patchRefusal.run.status).toBe(2);
	});

	it('uses exit 1 for malformed patch bytes and exit 2 for an unreachable header ref', () => {
		write(fixture.patchesDir, 'saved/malformed.ckpatch', 'not a patch\n');
		const malformed = fixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', 'saved/malformed.ckpatch']);
		expect(malformed.run.status).toBe(1);
		expect(malformed.envelope.errors[0]?.hint).toContain('checked sources');

		const unreachableFixture = makeCliFixture('reresolve-e2e-unreachable');
		const unreachable = readFileSync(unreachableFixture.patchesPath(PATCH_ARTIFACT), 'utf8').replace(
			/^(# pin: [^@]+@)[0-9a-f]{40}$/m,
			`$1${'f'.repeat(40)}`
		);
		write(unreachableFixture.patchesDir, 'saved/unreachable.ckpatch', unreachable);
		const refFailure = unreachableFixture.json(['reresolve', EXAMPLE_PART_PATH, '--patch', 'saved/unreachable.ckpatch']);
		expect(refFailure.run.status).toBe(2);
		expect(refFailure.envelope.errors[0]?.code).toBe('CK-E-PIN-UNREACHABLE');
	});
});

type RepositorySnapshot = {
	readonly treeHead: string;
	readonly treeRefs: string;
	readonly treeIndex: Uint8Array;
	readonly patchsetHead: string;
	readonly patchsetStatus: string;
	readonly patch: Uint8Array;
};

function repositorySnapshot(current: CliFixture): RepositorySnapshot {
	return {
		treeHead: current.git(['rev-parse', 'HEAD']).stdout,
		treeRefs: current.git(['show-ref']).stdout,
		treeIndex: readFileSync(join(current.treeDir, '.git/index')),
		patchsetHead: current.patchGit(['rev-parse', 'HEAD']).stdout,
		patchsetStatus: current.patchGit(['status', '--porcelain=v1']).stdout,
		patch: readFileSync(current.patchesPath(PATCH_ARTIFACT))
	};
}

function expectRepositoryUnmutatedExceptTarget(current: CliFixture, before: RepositorySnapshot): void {
	expect(current.git(['rev-parse', 'HEAD']).stdout).toBe(before.treeHead);
	expect(current.git(['show-ref']).stdout).toBe(before.treeRefs);
	expect(readFileSync(join(current.treeDir, '.git/index'))).toEqual(before.treeIndex);
	expect(current.patchGit(['rev-parse', 'HEAD']).stdout).toBe(before.patchsetHead);
	expect(current.patchGit(['status', '--porcelain=v1']).stdout).toBe(before.patchsetStatus);
	expect(readFileSync(current.patchesPath(PATCH_ARTIFACT))).toEqual(before.patch);
}

function startMerge(current: CliFixture, completed: boolean): void {
	fixtureGit(current.patchesDir, ['switch', '--quiet', '--create', 'incoming']);
	write(current.patchesDir, 'incoming.txt', 'target branch\n');
	fixtureCommit(current.patchesDir, 'fixture patchset: incoming target', '2026-07-01T00:01:00Z');
	fixtureGit(current.patchesDir, ['switch', '--quiet', 'main']);
	if (completed) {
		fixtureGit(current.patchesDir, ['merge', '--quiet', '--no-ff', '--no-edit', 'incoming'], MERGE_IDENTITY);
	} else {
		fixtureGit(current.patchesDir, ['merge', '--quiet', '--no-ff', '--no-commit', 'incoming'], MERGE_IDENTITY);
	}
}

function write(root: string, relative: string, content: string): void {
	const absolute = join(root, ...relative.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}
