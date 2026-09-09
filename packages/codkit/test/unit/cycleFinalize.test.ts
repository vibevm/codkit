// unit: terminal cycle reports and metrics are proved, deterministic, and retry-safe.

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { serializeCycleJournalEntry } from '../../src/lib/cycleJournal.ts';
import type { CycleJournalEntry } from '../../src/lib/cycleJournal.ts';
import {
	applyCycleFinalizationPlan,
	CYCLE_FINALIZATION_CHECKLIST,
	CYCLE_METRICS_HEADER,
	CYCLE_METRICS_PATH,
	planCycleFinalization,
	renderCycleHumanLog
} from '../../src/lib/cycleFinalize.ts';
import type { CycleFinalizationInventory } from '../../src/lib/cycleFinalize.ts';
import type { CycleFinalizationPlan, CycleFinalizeGitRunner } from '../../src/lib/cycleFinalize.ts';
import { CYCLE_STATE_PATH, serializeCycleState } from '../../src/lib/cycleState.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const SOURCE_SHA = '1'.repeat(40);
const TARGET_SHA = '2'.repeat(40);
const CAUSE_SHA = '3'.repeat(40);

function state(overrides: Partial<CycleState> = {}): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: 't1', sha: SOURCE_SHA, date: '2026-03-01' },
		targetPin: { tag: 't2', sha: TARGET_SHA, date: '2026-03-08' },
		branch: 'codkit/cycle/t2',
		startedAt: '2026-03-08T10:00:00.000Z',
		updatedAt: '2026-03-08T11:02:03.500Z',
		phase: 'done',
		nextAction: 'finalize the cycle',
		transaction: null,
		artifacts: {
			clean: ['delta/c.ckpatch'],
			shifted: ['delta/a.ckpatch'],
			merged: [],
			conflict: ['delta/b.ckpatch'],
			'target-deleted': [],
			'target-renamed': [],
			'rule-broken': [],
			'contract-failed': []
		},
		resolved: ['delta/b.ckpatch'],
		renames: [{ from: 'src/old.ts', to: 'src/new.ts', similarity: 96 }],
		...overrides
	};
}

function entry(artifact: string, outcome: CycleJournalEntry['outcome'], exitCode = 0, ts = '2026-03-08T10:30:00.000Z'): CycleJournalEntry {
	return {
		codkitCycleJournal: 1,
		ts,
		artifact,
		outcome,
		resolution: `resolved ${artifact}`,
		cause: { sha: CAUSE_SHA, approx: artifact.endsWith('a.ckpatch') },
		by: artifact.endsWith('b.ckpatch') ? 'agent:test' : 'human',
		verified: [
			{ command: 'bin/codkit verify', exitCode },
			{ command: 'npm test', exitCode }
		]
	};
}

function entries(): readonly CycleJournalEntry[] {
	return [entry('delta/a.ckpatch', 'shifted'), entry('delta/b.ckpatch', 'conflict', 0, '2026-03-08T11:00:00.000Z')];
}

function inventory(overrides: Partial<CycleFinalizationInventory> = {}): CycleFinalizationInventory {
	return {
		entryCount: 3,
		metrics: {
			byLayer: { own: 1, patch: 2 },
			bySubsystem: { product: 1, workbench: 2 },
			patchAndRuleCount: 2,
			hunks: 4,
			patchLineTotal: 17,
			contractCoverage: { covered: 2, requiredCovered: 1, requiredTotal: 1 }
		},
		...overrides
	};
}

function write(root: string, relative: string, contents: string): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function writeJournal(root: string, journal: readonly CycleJournalEntry[] = entries(), tag = 't2'): void {
	write(root, `cycle/log/${tag}.jsonl`, journal.map(serializeCycleJournalEntry).join(''));
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) return error.code;
		throw error;
	}
	throw new Error('expected codkit error');
}

function gitFor(root: string, ignoredPath: string | null = null, unstageablePath: string | null = null): CycleFinalizeGitRunner {
	return (_cwd, args) => {
		if (args[0] === 'rev-parse') return { status: 0, stdout: `${root}\n`, stderr: '' };
		if (args[0] === 'ls-files') return { status: 1, stdout: '', stderr: '' };
		if (args[0] === 'check-ignore') {
			const path = args.at(-1);
			return { status: path === ignoredPath ? 0 : 1, stdout: '', stderr: '' };
		}
		if (args[0] === 'add') return { status: args.at(-1) === unstageablePath ? 1 : 0, stdout: '', stderr: 'not stageable' };
		return { status: 128, stdout: '', stderr: 'unexpected git call' };
	};
}

function clonePlan(plan: CycleFinalizationPlan): CycleFinalizationPlan {
	return JSON.parse(JSON.stringify(plan)) as CycleFinalizationPlan;
}

describe('cycle finalization', () => {
	afterAll(cleanupTempRoots);

	it('plans exact deterministic human/CSV writes and state deletion only after terminal proof', () => {
		const root = makeTempRoot('cycle-finalize-plan');
		writeJournal(root);
		write(root, CYCLE_STATE_PATH, serializeCycleState(state()));
		const first = planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() });
		const second = planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() });
		expect(second).toEqual(first);
		expect(first.writes.map((item) => item.path)).toEqual(['cycle/log/t2.md', CYCLE_METRICS_PATH]);
		expect(first.deletions).toEqual([{ path: CYCLE_STATE_PATH, expected: serializeCycleState(state()) }]);
		expect(first.checklist).toEqual(CYCLE_FINALIZATION_CHECKLIST);
		expect(first.digest).toMatch(/^[0-9a-f]{64}$/);

		const human = first.writes[0]?.contents ?? '';
		expect(renderCycleHumanLog(state(), entries())).toBe(human);
		expect(human).toContain('# codkit cycle t2');
		expect(human).toContain(`${CAUSE_SHA} (approx)`);
		expect(human).toContain('\\"bin/codkit verify\\" => 0; \\"npm test\\" => 0');
		expect(human).toContain('| conflict | 1 |');
		const csv = first.writes[1]?.contents ?? '';
		expect(csv.split('\n')[0]).toBe(CYCLE_METRICS_HEADER.join(','));
		expect(csv).toContain('3723.5');
		expect(csv).toContain('"{""own"":1,""patch"":2}"');
	});

	it.each([
		['missing', [entry('delta/a.ckpatch', 'shifted')]],
		['latest-red', [...entries(), entry('delta/b.ckpatch', 'conflict', 1, '2026-03-08T11:01:00.000Z')]]
	] as const)('refuses %s journal without exposing a deletion plan', (_name, journal) => {
		const root = makeTempRoot('cycle-finalize-incomplete');
		writeJournal(root, journal);
		expect(codeOf(() => planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() }))).toBe('LOG-INCOMPLETE');
		expect(existsSync(join(root, CYCLE_STATE_PATH))).toBe(false);
	});

	it('treats a later cross-outcome event as the authoritative latest proof', () => {
		const root = makeTempRoot('cycle-finalize-cross-outcome');
		const journal = [...entries(), entry('delta/b.ckpatch', 'shifted', 0, '2026-03-08T11:01:00.000Z')];
		writeJournal(root, journal);
		expect(codeOf(() => planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() }))).toBe('LOG-INCOMPLETE');
	});

	it('requires done, no transaction, and terminal state before planning', () => {
		const root = makeTempRoot('cycle-finalize-phase');
		writeJournal(root);
		expect(codeOf(() => planCycleFinalization({ patchesDir: root, state: state({ phase: 'stabilize' }), inventory: inventory() }))).toBe(
			'CONFIG'
		);
		expect(
			codeOf(() =>
				planCycleFinalization({
					patchesDir: root,
					state: state({ transaction: { kind: 'restart', baseCommit: SOURCE_SHA, bumpCommit: TARGET_SHA } }),
					inventory: inventory()
				})
			)
		).toBe('CONFIG');
	});

	it('rejects malformed existing CSV and conflicting human reports', () => {
		const csvRoot = makeTempRoot('cycle-finalize-bad-csv');
		writeJournal(csvRoot);
		write(csvRoot, CYCLE_METRICS_PATH, 'wrong,header\n');
		expect(codeOf(() => planCycleFinalization({ patchesDir: csvRoot, state: state(), inventory: inventory() }))).toBe('CONFIG');

		const mdRoot = makeTempRoot('cycle-finalize-bad-md');
		writeJournal(mdRoot);
		write(mdRoot, 'cycle/log/t2.md', '# handwritten\n');
		expect(codeOf(() => planCycleFinalization({ patchesDir: mdRoot, state: state(), inventory: inventory() }))).toBe('CONFIG');
	});

	it('makes an identical cycle a no-op and rejects conflicting metrics for the same cycle', () => {
		const root = makeTempRoot('cycle-finalize-duplicate');
		writeJournal(root);
		write(root, CYCLE_STATE_PATH, serializeCycleState(state()));
		const first = planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() });
		applyCycleFinalizationPlan(root, first, { git: gitFor(root) });
		const duplicate = planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() });
		expect(duplicate.writes.every((write) => write.previous === write.contents)).toBe(true);

		const changed = inventory({
			entryCount: 4,
			metrics: {
				...inventory().metrics,
				byLayer: { own: 2, patch: 2 },
				bySubsystem: { product: 2, workbench: 2 }
			}
		});
		expect(codeOf(() => planCycleFinalization({ patchesDir: root, state: state(), inventory: changed }))).toBe('CONFIG');
	});

	it('resumes after an atomic write checkpoint and deletes state last', () => {
		const root = makeTempRoot('cycle-finalize-interrupt');
		writeJournal(root);
		write(root, CYCLE_STATE_PATH, serializeCycleState(state()));
		const plan = planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() });
		expect(() =>
			applyCycleFinalizationPlan(root, plan, {
				git: gitFor(root),
				temporarySuffix: () => 'fixed',
				checkpoint(operation, path) {
					if (operation === 'write' && path === 'cycle/log/t2.md') throw new Error('process loss');
				}
			})
		).toThrow('process loss');
		expect(readFileSync(join(root, 'cycle/log/t2.md'), 'utf8')).toBe(plan.writes[0]?.contents);
		expect(existsSync(join(root, CYCLE_STATE_PATH))).toBe(true);
		applyCycleFinalizationPlan(root, plan, { git: gitFor(root), temporarySuffix: () => 'retry' });
		expect(existsSync(join(root, CYCLE_STATE_PATH))).toBe(false);
		expect(readFileSync(join(root, CYCLE_METRICS_PATH), 'utf8')).toBe(plan.writes[1]?.contents);
	});

	it('rejects forged, incomplete, or relabelled public plans before mutation', () => {
		const root = makeTempRoot('cycle-finalize-forged');
		writeJournal(root);
		write(root, CYCLE_STATE_PATH, serializeCycleState(state()));
		const plan = planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() });
		const forged = [
			{ ...clonePlan(plan), writes: [{ ...plan.writes[0]!, contents: 'forged\n' }, plan.writes[1]!] },
			{ ...clonePlan(plan), writes: [plan.writes[0]!] },
			{ ...clonePlan(plan), checklist: ['forged'] as unknown as typeof CYCLE_FINALIZATION_CHECKLIST },
			{ ...clonePlan(plan), targetTag: 'other' },
			{
				...clonePlan(plan),
				authority: { ...plan.authority, entries: [...plan.authority.entries, entry('delta/fabricated.ckpatch', 'clean')] }
			}
		] as CycleFinalizationPlan[];
		for (const candidate of forged) {
			expect(codeOf(() => applyCycleFinalizationPlan(root, candidate, { git: gitFor(root) }))).toBe('CONFIG');
			expect(existsSync(join(root, CYCLE_STATE_PATH))).toBe(true);
		}
	});

	it('requires the actual JSONL and CASes its exact bytes without rewriting it', () => {
		const absent = makeTempRoot('cycle-finalize-no-jsonl');
		write(absent, CYCLE_STATE_PATH, serializeCycleState(state()));
		expect(codeOf(() => planCycleFinalization({ patchesDir: absent, state: state(), inventory: inventory() }))).toBe('LOG-INCOMPLETE');

		const changed = makeTempRoot('cycle-finalize-changed-jsonl');
		writeJournal(changed);
		write(changed, CYCLE_STATE_PATH, serializeCycleState(state()));
		const plan = planCycleFinalization({ patchesDir: changed, state: state(), inventory: inventory() });
		writeJournal(changed, [...entries(), entry('delta/fabricated.ckpatch', 'clean')]);
		expect(codeOf(() => applyCycleFinalizationPlan(changed, plan, { git: gitFor(changed) }))).toBe('CONFIG');
		expect(existsSync(join(changed, 'cycle/log/t2.md'))).toBe(false);
		expect(existsSync(join(changed, CYCLE_STATE_PATH))).toBe(true);
	});

	it('allows missing state only for an exact post-delete retry', () => {
		const absentRoot = makeTempRoot('cycle-finalize-missing-state');
		writeJournal(absentRoot);
		expect(codeOf(() => planCycleFinalization({ patchesDir: absentRoot, state: state(), inventory: inventory() }))).toBe('CONFIG');

		const completeRoot = makeTempRoot('cycle-finalize-post-delete');
		writeJournal(completeRoot);
		write(completeRoot, CYCLE_STATE_PATH, serializeCycleState(state()));
		const plan = planCycleFinalization({ patchesDir: completeRoot, state: state(), inventory: inventory() });
		applyCycleFinalizationPlan(completeRoot, plan, { git: gitFor(completeRoot) });
		expect(() => applyCycleFinalizationPlan(completeRoot, plan, { git: gitFor(completeRoot) })).not.toThrow();
	});

	it('rejects ignored or unstageable finalization paths during Git preflight before writes', () => {
		const root = makeTempRoot('cycle-finalize-ignored');
		writeJournal(root);
		write(root, CYCLE_STATE_PATH, serializeCycleState(state()));
		const plan = planCycleFinalization({ patchesDir: root, state: state(), inventory: inventory() });
		expect(codeOf(() => applyCycleFinalizationPlan(root, plan, { git: gitFor(root, CYCLE_METRICS_PATH) }))).toBe('CONFIG');
		expect(existsSync(join(root, 'cycle/log/t2.md'))).toBe(false);
		expect(existsSync(join(root, CYCLE_STATE_PATH))).toBe(true);
		expect(codeOf(() => applyCycleFinalizationPlan(root, plan, { git: gitFor(root, null, 'cycle/log/t2.jsonl') }))).toBe('CONFIG');
	});

	it('accepts removed-registry coverage where required covered exceeds entry covered', () => {
		const root = makeTempRoot('cycle-finalize-removed-coverage');
		writeJournal(root);
		write(root, CYCLE_STATE_PATH, serializeCycleState(state()));
		const removedCoverage = inventory({
			metrics: { ...inventory().metrics, contractCoverage: { covered: 1, requiredCovered: 2, requiredTotal: 2 } }
		});
		expect(() => planCycleFinalization({ patchesDir: root, state: state(), inventory: removedCoverage })).not.toThrow();
	});

	it('refuses unsafe tags and symlinked output directories', () => {
		const unsafeRoot = makeTempRoot('cycle-finalize-tag');
		expect(
			codeOf(() =>
				planCycleFinalization({
					patchesDir: unsafeRoot,
					state: state({ targetPin: { ...state().targetPin, tag: '../escape' } }),
					inventory: inventory()
				})
			)
		).toBe('CONFIG');

		const linkRoot = makeTempRoot('cycle-finalize-link');
		const outside = makeTempRoot('cycle-finalize-outside');
		write(outside, 't2.jsonl', entries().map(serializeCycleJournalEntry).join(''));
		mkdirSync(join(linkRoot, 'cycle'), { recursive: true });
		symlinkSync(outside, join(linkRoot, 'cycle/log'), 'dir');
		expect(codeOf(() => planCycleFinalization({ patchesDir: linkRoot, state: state(), inventory: inventory() }))).toBe('CONFIG');
	});
});
