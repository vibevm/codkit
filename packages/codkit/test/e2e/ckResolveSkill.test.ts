// e2e: ck-resolve's deterministic journal helper uses the real tree lock and
// the canonical cycle journal writer without committing or continuing a cycle.
//
// The helper ships inside the `agent-skills` package and is run from the copy
// `vibe skill install` projects, so it resolves the three roots through the
// installed launcher on `PATH` (PROP-014 ##STD-SKILLS-SOURCE-OF-TRUTH). The
// fixture puts this repository's own `bin/` on `PATH` for exactly that.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readCycleJournal } from '../../src/lib/cycleJournal.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { writeCycleState } from '../../src/lib/cycleState.ts';
import { makeCliFixture, STUB_TYPE_ENV, testBuildNodeDir } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const helper = join(
	packageRoot,
	'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v1.0.0/vibevm/vibespecs/skills/ck-resolve/scripts/append-journal.mjs'
);
const launcherDir = join(packageRoot, 'bin');
const artifact = 'delta/patches/source__base__common__util.ts.ckpatch';

afterAll(cleanupTempRoots);

describe('ck-resolve journal helper', () => {
	it('appends one validated assigned blocker under the real tree lock', () => {
		const fixture = makeCliFixture('ck-resolve-journal');
		writeCycleState(fixture.patchesDir, state('resolve'));
		const entry = '.codkit/agent-journal-entry.json';
		mkdirSync(dirname(fixture.patchesPath(entry)), { recursive: true });
		writeTask(fixture.patchesDir);
		writeResult(fixture.patchesDir);
		writeFileSync(fixture.patchesPath(entry), `${JSON.stringify(journalEntry(), null, 2)}\n`, 'utf8');

		const run = invoke(fixture.patchesDir, fixture.treeDir, entry);
		expect(run.status, run.stderr).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, artifact, by: 'agent:test' });
		expect(readCycleJournal(fixture.patchesDir, 't2')).toEqual([journalEntry()]);
		expect(lockFiles(fixture.patchesDir)).toEqual([]);
	});

	it('fails closed outside resolve and releases the lock', () => {
		const fixture = makeCliFixture('ck-resolve-journal-stop');
		writeCycleState(fixture.patchesDir, state('apply'));
		const entry = '.codkit/agent-journal-entry.json';
		mkdirSync(dirname(fixture.patchesPath(entry)), { recursive: true });
		writeTask(fixture.patchesDir);
		writeResult(fixture.patchesDir);
		writeFileSync(fixture.patchesPath(entry), `${JSON.stringify(journalEntry(), null, 2)}\n`, 'utf8');

		const run = invoke(fixture.patchesDir, fixture.treeDir, entry);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('cycle must be in resolve');
		expect(readCycleJournal(fixture.patchesDir, 't2')).toEqual([]);
		expect(lockFiles(fixture.patchesDir)).toEqual([]);
	});

	it.each([
		['missing result', null],
		['stopped result', { ...taskResult(), status: 'stopped', reason: 'needs a human' }],
		['red verification', { ...taskResult(), verifications: [{ command: 'git diff --check -- assigned.ts', exitCode: 1 }] }]
	] as const)('rejects %s before canonical journal mutation', (_label, result) => {
		const fixture = makeCliFixture(`ck-resolve-result-${_label.replaceAll(' ', '-')}`);
		writeCycleState(fixture.patchesDir, state('resolve'));
		const entry = '.codkit/agent-journal-entry.json';
		mkdirSync(dirname(fixture.patchesPath(entry)), { recursive: true });
		writeTask(fixture.patchesDir);
		if (result !== null) writeFileSync(fixture.patchesPath('.codkit/agent-task-result.json'), `${JSON.stringify(result, null, 2)}\n`);
		writeFileSync(fixture.patchesPath(entry), `${JSON.stringify(journalEntry(), null, 2)}\n`, 'utf8');

		const run = invoke(fixture.patchesDir, fixture.treeDir, entry);
		expect(run.status).toBe(1);
		expect(readCycleJournal(fixture.patchesDir, 't2')).toEqual([]);
		expect(lockFiles(fixture.patchesDir)).toEqual([]);
	});

	it('rejects a symlinked task result before reading outside bytes', () => {
		const fixture = makeCliFixture('ck-resolve-result-symlink');
		writeCycleState(fixture.patchesDir, state('resolve'));
		const entry = '.codkit/agent-journal-entry.json';
		mkdirSync(dirname(fixture.patchesPath(entry)), { recursive: true });
		writeTask(fixture.patchesDir);
		writeFileSync(fixture.patchesPath(entry), `${JSON.stringify(journalEntry(), null, 2)}\n`, 'utf8');
		const outside = fixture.patchesPath('outside-result.json');
		writeFileSync(outside, `${JSON.stringify(taskResult())}\n`, 'utf8');
		symlinkSync(outside, fixture.patchesPath('.codkit/agent-task-result.json'));

		const run = invoke(fixture.patchesDir, fixture.treeDir, entry);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain('safe bounded regular runtime file');
		expect(readCycleJournal(fixture.patchesDir, 't2')).toEqual([]);
	});
});

function invoke(patchesDir: string, treeDir: string, entry: string) {
	return spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', helper, '--entry', entry], {
		cwd: patchesDir,
		env: {
			...process.env,
			...STUB_TYPE_ENV,
			PATH: `${testBuildNodeDir('ck-resolve')}${delimiter}${launcherDir}${delimiter}${process.env['PATH'] ?? ''}`,
			CODKIT_PATCHES_DIR: patchesDir,
			CODKIT_FORK_DIR: treeDir
		},
		encoding: 'utf8'
	});
}

function state(phase: CycleState['phase']): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: 't1', sha: '1'.repeat(40), date: '2026-08-01' },
		targetPin: { tag: 't2', sha: '2'.repeat(40), date: '2026-08-08' },
		branch: 'codkit/cycle/t2',
		startedAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:01:00.000Z',
		phase,
		nextAction: 'resolve the assigned blocker',
		transaction: null,
		artifacts: {
			clean: [],
			shifted: [],
			merged: [],
			conflict: [artifact],
			'target-deleted': [],
			'target-renamed': [],
			'rule-broken': [],
			'contract-failed': []
		},
		resolved: [],
		renames: []
	};
}

function journalEntry() {
	return {
		codkitCycleJournal: 1 as const,
		ts: '2026-09-01T00:02:00.000Z',
		artifact,
		outcome: 'conflict' as const,
		resolution: 'kept the upstream branch and restored the assigned marker block',
		cause: { sha: '3'.repeat(40), approx: false },
		by: 'agent:test',
		verified: [{ command: 'git diff --check -- assigned.ts', exitCode: 0 }]
	};
}

function writeTask(patchesDir: string): void {
	writeFileSync(
		join(patchesDir, '.codkit', 'agent-task.json'),
		`${JSON.stringify(
			{
				codkitAgentTask: 1,
				kind: 'resolve',
				targetTag: 't2',
				actor: 'agent:test',
				blockers: [{ artifact, outcome: 'conflict', paths: ['source/base/common/util.ts'] }]
			},
			null,
			2
		)}\n`,
		'utf8'
	);
}

function taskResult() {
	return {
		codkitAgentTaskResult: 1,
		targetTag: 't2',
		actor: 'agent:test',
		status: 'resolved',
		blockers: [
			{
				artifact,
				outcome: 'conflict',
				status: 'resolved',
				resolution: journalEntry().resolution
			}
		],
		changedPaths: ['source/base/common/util.ts'],
		verifications: journalEntry().verified,
		reason: null
	};
}

function writeResult(patchesDir: string): void {
	writeFileSync(join(patchesDir, '.codkit', 'agent-task-result.json'), `${JSON.stringify(taskResult(), null, 2)}\n`, 'utf8');
}

function lockFiles(patchesDir: string): readonly string[] {
	try {
		return readdirSync(join(patchesDir, '.codkit', 'locks')).filter((name) => name.endsWith('.lock'));
	} catch {
		return [];
	}
}
