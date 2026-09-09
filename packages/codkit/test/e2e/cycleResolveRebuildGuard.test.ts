/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Exact cycle save/rebuild integration: every normative channel transition is
// explained, while a patchset patch movement outside the save remains internal.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/configFile.ts';
import { serializeCycleJournalEntry, type CycleJournalEntry } from '../../src/lib/cycleJournal.ts';
import { runCycleResolve, type CycleResolveArtifact } from '../../src/lib/cycleResolve.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import { runSync } from '../../src/lib/syncEngine.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { PATCH_FILE_NAME, PATCH_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

afterAll(cleanupTempRoots);

describe('cycle resolve save rebuild guard', () => {
	it('accepts the exact conflict save when the selected channel dematerializes an overlay', () => {
		const fixture = makeCliFixture('cycle-resolve-overlay-channel');
		const config = loadConfig(fixture.patchesDir);
		if (config === null) throw new Error('missing fixture config');
		const resolution = { path: fixture.treeDir, source: 'flag', exists: true, warning: null } as const;
		expect(
			runSync({
				patchesDir: fixture.patchesDir,
				resolution,
				config,
				type: stubProjectType,
				out: quietOutput(),
				fresh: true,
				dryRun: false,
				verbose: false,
				materializeOverlays: true
			}).exitCode
		).toBe(0);
		expect(JSON.parse(readFileSync(fixture.treePath('manifest.json'), 'utf8'))).toMatchObject({ displayName: 'Fixture PatchSet' });

		writeFileSync(fixture.patchesPath('.git/info/exclude'), '\n.codkit/\n', { flag: 'a' });
		const branch = `${config.cycleBranchPrefix}${config.pin.tag}`;
		expect(fixture.patchGit(['switch', '--quiet', '-c', branch]).status).toBe(0);
		writeFileSync(
			fixture.treePath(EXAMPLE_PART_PATH),
			blockBody(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8'), '\t\t// resolved overlay-channel body')
		);
		const artifactPath = `delta/patches/${PATCH_FILE_NAME}`;
		const artifact: CycleResolveArtifact = {
			artifactPath,
			artifactId: PATCH_ID,
			kind: 'patch',
			outcome: 'conflict',
			cause: { sha: config.pin.sha, approx: false },
			targetPath: EXAMPLE_PART_PATH,
			patchesPaths: [artifactPath]
		};
		const current: CycleState = {
			codkitCycleState: 2,
			sourcePin: config.pin,
			targetPin: config.pin,
			branch,
			startedAt: '2026-08-31T18:00:00.000Z',
			updatedAt: '2026-08-31T18:00:00.000Z',
			phase: 'resolve',
			nextAction: 'resolve every blocker',
			transaction: null,
			artifacts: {
				clean: [],
				shifted: [],
				merged: [],
				conflict: [artifactPath],
				'target-deleted': [],
				'target-renamed': [],
				'rule-broken': [],
				'contract-failed': []
			},
			resolved: [],
			renames: []
		};
		const journal = [journalEntry(artifactPath, config.pin.sha)];
		const journalPath = `cycle/log/${config.pin.tag}.jsonl`;
		const journalFile = fixture.patchesPath(journalPath);
		mkdirSync(dirname(journalFile), { recursive: true });
		writeFileSync(journalFile, journal.map(serializeCycleJournalEntry).join(''));
		const cycle = acquireLock(fixture.patchesDir, 'cycle-global', 'cycle continue');
		const tree = acquireLock(fixture.patchesDir, treeId(fixture.treeDir), 'cycle continue');
		try {
			const result = runCycleResolve({
				patchesDir: fixture.patchesDir,
				resolution,
				config,
				type: stubProjectType,
				state: current,
				journal,
				artifacts: [artifact],
				locks: { cycle, tree },
				out: quietOutput()
			});
			expect(result.status).toBe('commit-ready');
			expect(result.commit?.paths).toEqual([journalPath, 'cycle/state.json', artifactPath]);
			expect(JSON.parse(readFileSync(fixture.treePath('manifest.json'), 'utf8'))).toMatchObject({ displayName: 'Fixture Upstream' });
			expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
		} finally {
			tree.release();
			cycle.release();
		}
	});

	it('refuses a patchset-only patch movement before the rewrite it would cause (was CK-E-INTERNAL)', () => {
		const fixture = makeCliFixture('save-unexplained-rewrite');
		expect(fixture.run(['load']).status).toBe(0);
		const artifact = fixture.patchesPath(`delta/patches/${PATCH_FILE_NAME}`);
		const patch = readFileSync(artifact, 'utf8');
		const changedPatch = patch.replace(
			'// (hook body lives in own/ code; this block only delegates)',
			'// patchset-only patch movement that this save did not extract'
		);
		expect(changedPatch).not.toBe(patch);
		writeFileSync(artifact, changedPatch, 'utf8');
		writeFileSync(
			fixture.treePath('source/own/hello.ts'),
			'// edited in the tree to trigger a rebuild\nexport function hello(name: string): string {\n\treturn name;\n}\n',
			'utf8'
		);

		// Before Phase 7 this shape ended in CK-E-INTERNAL AFTER the ref had
		// moved and the patch target had been rewritten (spike S0.7/H1): the
		// rebuild had no normative channel explaining the rewrite. The
		// moved-check now refuses earlier, before any write
		// (##PATCHSET-MOVED-RULE); assertNothingMoved keeps guarding the
		// unexplained rewrites codkit itself produces.
		const outcome = fixture.json(['save']);
		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]).toMatchObject({ code: 'CK-E-PATCHSET-MOVED' });
		expect(outcome.envelope.errors[0]?.message).toContain(`delta/patches/${PATCH_FILE_NAME}`);
	});
});

function journalEntry(artifact: string, cause: string): CycleJournalEntry {
	return {
		codkitCycleJournal: 1,
		ts: '2026-08-31T18:01:02.000Z',
		artifact,
		outcome: 'conflict',
		resolution: `resolved ${artifact}`,
		cause: { sha: cause, approx: false },
		by: 'agent:test',
		verified: [{ command: 'bin/codkit verify', exitCode: 0 }]
	};
}

function blockBody(text: string, body: string): string {
	const begin = `// codkit:begin ${PATCH_ID}`;
	const end = `// codkit:end ${PATCH_ID}`;
	const beginAt = text.indexOf(begin);
	const endAt = text.indexOf(end, beginAt);
	if (beginAt < 0 || endAt < 0) throw new Error(`missing marker block ${PATCH_ID}`);
	const afterBegin = text.indexOf('\n', beginAt) + 1;
	return `${text.slice(0, afterBegin)}${body}\n${text.slice(endAt)}`;
}

function quietOutput(): Output {
	return new Output({ command: 'cycle continue', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
}
