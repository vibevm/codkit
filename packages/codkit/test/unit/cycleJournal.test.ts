/** @scope spec://codkit/modules/codkit/PROP-009#journal */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	appendCycleJournalEntry,
	assertCycleJournalComplete,
	cycleJournalEntrySchema,
	cycleJournalPath,
	nodeCycleJournalFileSystem,
	parseCycleJournal,
	readCycleJournal,
	requiredCycleJournalEntries,
	serializeCycleJournalEntry
} from '../../src/lib/cycleJournal.ts';
import type { CycleJournalEntry } from '../../src/lib/cycleJournal.ts';
import { CYCLE_ARTIFACT_OUTCOMES } from '../../src/lib/cycleState.ts';
import type { CycleArtifactOutcome, CycleState } from '../../src/lib/cycleState.ts';
import { CkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const SHA = 'a'.repeat(40);
const TAG = '1.135.0';

function entry(artifact: string, outcome: CycleArtifactOutcome, by = 'human'): CycleJournalEntry {
	return {
		codkitCycleJournal: 1,
		ts: '2026-08-31T11:00:00.000Z',
		artifact,
		outcome,
		resolution: `resolved ${artifact}`,
		cause: { sha: SHA, approx: false },
		by,
		verified: [
			{ command: 'bin/codkit verify', exitCode: 0 },
			{ command: 'npm test -- --run cycle', exitCode: 0 }
		]
	};
}

function cycleState(): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: '1.134.0', sha: '1'.repeat(40), date: '2026-08-06' },
		targetPin: { tag: TAG, sha: '2'.repeat(40), date: '2026-08-13' },
		branch: `codkit/cycle/${TAG}`,
		startedAt: '2026-08-31T10:00:00.000Z',
		updatedAt: '2026-08-31T11:00:00.000Z',
		phase: 'resolve',
		nextAction: 'resolve every red artifact',
		transaction: null,
		artifacts: {
			clean: ['delta/clean'],
			shifted: ['delta/shifted'],
			merged: ['delta/merged'],
			conflict: ['delta/conflict'],
			'target-deleted': ['delta/deleted'],
			'target-renamed': ['delta/renamed'],
			'rule-broken': ['delta/rule'],
			'contract-failed': ['delta/contract']
		},
		resolved: [],
		renames: []
	};
}

describe('cycle journal', () => {
	afterAll(() => {
		cleanupTempRoots();
	});

	it('accepts all eight exact outcomes and the two normative actor forms', () => {
		for (const outcome of CYCLE_ARTIFACT_OUTCOMES) {
			expect(cycleJournalEntrySchema.parse(entry(`delta/${outcome}`, outcome)).outcome).toBe(outcome);
		}
		expect(cycleJournalEntrySchema.parse(entry('delta/agent', 'conflict', 'agent:test')).by).toBe('agent:test');
		expect(() => cycleJournalEntrySchema.parse(entry('delta/agent', 'conflict', 'agent:   '))).toThrow();
	});

	it('appends complete LF records and round-trips every field', () => {
		const root = makeTempRoot('cycle-journal-append');
		const first = entry('delta/shifted', 'shifted');
		const second = entry('delta/conflict', 'conflict', 'agent:resolver');

		appendCycleJournalEntry(root, TAG, first);
		appendCycleJournalEntry(root, TAG, second);

		const document = readFileSync(cycleJournalPath(root, TAG), 'utf8');
		expect(document).toMatch(/^\{"codkitCycleJournal":1,/);
		expect(document).toBe(`${serializeCycleJournalEntry(first)}${serializeCycleJournalEntry(second)}`);
		expect(document.split('\n')).toHaveLength(3);
		expect(readCycleJournal(root, TAG)).toEqual([first, second]);
	});

	it('treats absence as zero records but rejects an existing empty file', () => {
		const root = makeTempRoot('cycle-journal-empty');
		expect(readCycleJournal(root, TAG)).toEqual([]);
		writeFixture(cycleJournalPath(root, TAG), '');
		expectCode(() => readCycleJournal(root, TAG), 'EOF-NEWLINE');
	});

	it.each([
		['partial last JSON value', '{"ts":', 'EOF-NEWLINE'],
		['valid JSON without its final LF', serializeCycleJournalEntry(entry('delta/a', 'merged')).trimEnd(), 'EOF-NEWLINE'],
		['blank record', `${serializeCycleJournalEntry(entry('delta/a', 'merged'))}\n`, 'EOF-NEWLINE'],
		['malformed record', '{}\n', 'LOG-INCOMPLETE'],
		['unknown field', `${JSON.stringify({ ...entry('delta/a', 'merged'), unknown: true })}\n`, 'LOG-INCOMPLETE'],
		['noncanonical pretty JSON', `${JSON.stringify(entry('delta/a', 'merged'), null, 2)}\n`, 'LOG-INCOMPLETE'],
		['CRLF record', serializeCycleJournalEntry(entry('delta/a', 'merged')).replace('\n', '\r\n'), 'CRLF']
	])('rejects %s', (_label, document, code) => {
		expectCode(() => parseCycleJournal(document), code);
	});

	it('validates old bytes before append and never extends corruption', () => {
		const root = makeTempRoot('cycle-journal-corrupt-append');
		const path = cycleJournalPath(root, TAG);
		writeFixture(path, '{"partial":true}');
		const before = readFileSync(path, 'utf8');

		expectCode(() => appendCycleJournalEntry(root, TAG, entry('delta/a', 'conflict')), 'EOF-NEWLINE');
		expect(readFileSync(path, 'utf8')).toBe(before);
	});

	it('derives every non-clean obligation from state and lists all missing pairs', () => {
		const state = cycleState();
		const required = requiredCycleJournalEntries(state);
		expect(required).toEqual([
			{ artifact: 'delta/shifted', outcome: 'shifted' },
			{ artifact: 'delta/merged', outcome: 'merged' },
			{ artifact: 'delta/conflict', outcome: 'conflict' },
			{ artifact: 'delta/deleted', outcome: 'target-deleted' },
			{ artifact: 'delta/renamed', outcome: 'target-renamed' },
			{ artifact: 'delta/rule', outcome: 'rule-broken' },
			{ artifact: 'delta/contract', outcome: 'contract-failed' }
		]);

		try {
			assertCycleJournalComplete(state, [entry('delta/shifted', 'merged'), entry('delta/not-required', 'conflict')]);
			throw new Error('expected incomplete journal');
		} catch (error) {
			expect(error).toBeInstanceOf(CkError);
			expect((error as CkError).code).toBe('LOG-INCOMPLETE');
			for (const obligation of required) {
				expect((error as CkError).message).toContain(`${obligation.outcome}:${obligation.artifact}`);
			}
		}
	});

	it('accepts matching entries, including duplicate valid records', () => {
		const state = {
			...cycleState(),
			resolved: ['delta/conflict', 'delta/deleted', 'delta/renamed', 'delta/rule', 'delta/contract']
		};
		const entries = requiredCycleJournalEntries(state).map((required) => entry(required.artifact, required.outcome));
		expect(() => assertCycleJournalComplete(state, [...entries, entries[0] as CycleJournalEntry])).not.toThrow();
	});

	it('does not let an invalid duplicate serve as completion proof', () => {
		const state = {
			...cycleState(),
			artifacts: {
				clean: [],
				shifted: [],
				merged: [],
				conflict: ['delta/conflict'],
				'target-deleted': [],
				'target-renamed': [],
				'rule-broken': [],
				'contract-failed': []
			},
			resolved: ['delta/conflict']
		};
		const invalid = { ...entry('delta/conflict', 'conflict'), cause: { sha: 'not-a-sha', approx: false } };
		expectLogIncomplete(() => assertCycleJournalComplete(state, [invalid as CycleJournalEntry]));
	});

	it('does not count a matching event whose terminal verification failed', () => {
		const state = {
			...cycleState(),
			artifacts: {
				...cycleState().artifacts,
				shifted: [],
				merged: [],
				conflict: ['delta/conflict'],
				'target-deleted': [],
				'target-renamed': [],
				'rule-broken': [],
				'contract-failed': []
			},
			resolved: ['delta/conflict']
		};
		const failed = { ...entry('delta/conflict', 'conflict'), verified: [{ command: 'bin/codkit verify', exitCode: 1 }] };
		expectLogIncomplete(() => assertCycleJournalComplete(state, [failed]));
	});

	it('uses the latest proof for one artifact and outcome', () => {
		const state = {
			...cycleState(),
			artifacts: {
				clean: [],
				shifted: ['delta/shifted'],
				merged: [],
				conflict: [],
				'target-deleted': [],
				'target-renamed': [],
				'rule-broken': [],
				'contract-failed': []
			}
		};
		const green = entry('delta/shifted', 'shifted');
		const red = {
			...green,
			ts: '2026-08-31T11:01:00.000Z',
			verified: [{ command: 'bin/codkit verify', exitCode: 1 }]
		};
		expectLogIncomplete(() => assertCycleJournalComplete(state, [green, red]));
		expect(() => assertCycleJournalComplete(state, [red, green])).not.toThrow();
	});

	it('lets a later contradictory outcome invalidate an older green proof for the artifact', () => {
		const state = {
			...cycleState(),
			artifacts: {
				clean: [],
				shifted: ['delta/shifted'],
				merged: [],
				conflict: [],
				'target-deleted': [],
				'target-renamed': [],
				'rule-broken': [],
				'contract-failed': []
			}
		};
		const shifted = entry('delta/shifted', 'shifted');
		const laterConflict = {
			...entry('delta/shifted', 'conflict'),
			ts: '2026-08-31T11:02:00.000Z',
			verified: [{ command: 'bin/codkit verify', exitCode: 1 }]
		};
		expectLogIncomplete(() => assertCycleJournalComplete(state, [shifted, laterConflict]));
		expect(() => assertCycleJournalComplete(state, [laterConflict, shifted])).not.toThrow();
	});

	it('does not count a green blocker event until state marks the artifact resolved', () => {
		const state = {
			...cycleState(),
			artifacts: {
				...cycleState().artifacts,
				shifted: [],
				merged: [],
				conflict: ['delta/conflict'],
				'target-deleted': [],
				'target-renamed': [],
				'rule-broken': [],
				'contract-failed': []
			}
		};
		expectLogIncomplete(() => assertCycleJournalComplete(state, [entry('delta/conflict', 'conflict')]));
	});

	it('retains old bytes and removes temp when atomic append rename is interrupted', () => {
		const root = makeTempRoot('cycle-journal-interrupt');
		appendCycleJournalEntry(root, TAG, entry('delta/a', 'merged'), { temporarySuffix: () => 'initial' });
		const path = cycleJournalPath(root, TAG);
		const before = readFileSync(path);
		const fileSystem = {
			...nodeCycleJournalFileSystem,
			rename() {
				throw new Error('injected journal interruption');
			}
		};
		expectLogIncomplete(() =>
			appendCycleJournalEntry(root, TAG, entry('delta/b', 'conflict'), { fileSystem, temporarySuffix: () => 'interrupted' })
		);
		expect(readFileSync(path)).toEqual(before);
		expect(existsSync(`${path}.interrupted.tmp`)).toBe(false);
	});

	it.each(['CON', '../escape', 'bad:tag', 'bad/tag', 'trailing.', 'trailing '])('rejects unsafe portable tag %j', (tag) => {
		const root = makeTempRoot('cycle-journal-tag');
		expectCode(() => cycleJournalPath(root, tag), 'CONFIG');
	});

	it('rejects invalid UTF-8, BOM and symlink components before reading records', () => {
		const utfRoot = makeTempRoot('cycle-journal-bytes');
		writeFixtureBytes(join(utfRoot, 'cycle/log', `${TAG}.jsonl`), new Uint8Array([0xff, 0x0a]));
		expectCode(() => readCycleJournal(utfRoot, TAG), 'ENCODING');

		const bomRoot = makeTempRoot('cycle-journal-bom');
		writeFixtureBytes(join(bomRoot, 'cycle/log', `${TAG}.jsonl`), new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]));
		expectCode(() => readCycleJournal(bomRoot, TAG), 'ENCODING');

		const linkRoot = makeTempRoot('cycle-journal-link');
		const outside = makeTempRoot('cycle-journal-outside');
		mkdirSync(join(linkRoot, 'cycle'));
		symlinkSync(outside, join(linkRoot, 'cycle/log'), 'dir');
		expectCode(() => readCycleJournal(linkRoot, TAG), 'CONFIG');
		expectCode(() => appendCycleJournalEntry(linkRoot, TAG, entry('delta/a', 'merged')), 'CONFIG');
	});

	it('requires schema version one and at least one verification command', () => {
		const withoutVersion = { ...entry('delta/a', 'merged') } as Record<string, unknown>;
		delete withoutVersion['codkitCycleJournal'];
		expectLogIncomplete(() => parseCycleJournal(`${JSON.stringify(withoutVersion)}\n`));
		expectLogIncomplete(() => serializeCycleJournalEntry({ ...entry('delta/a', 'merged'), verified: [] }));
		expectLogIncomplete(() => serializeCycleJournalEntry(entry('../escape', 'merged')));
	});

	it('refuses a newer journal schema with an update hint and structured line', () => {
		const newer = `${JSON.stringify({ ...entry('delta/a', 'merged'), codkitCycleJournal: 2 })}\n`;
		try {
			parseCycleJournal(newer, 'cycle/log/new.jsonl');
			throw new Error('expected newer journal schema refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(CkError);
			expect((error as CkError).code).toBe('CONFIG');
			expect((error as CkError).hint).toContain('update codkit');
			expect((error as CkError).line).toBe(1);
		}
	});
});

function expectLogIncomplete(run: () => unknown): void {
	try {
		run();
		throw new Error('expected a typed journal failure');
	} catch (error) {
		expect(error).toBeInstanceOf(CkError);
		expect((error as CkError).code).toBe('LOG-INCOMPLETE');
	}
}

function writeFixture(path: string, document: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, document, 'utf8');
}

function writeFixtureBytes(path: string, bytes: Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes);
}

function expectCode(run: () => unknown, code: string): void {
	try {
		run();
		throw new Error(`expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(CkError);
		expect((error as CkError).code).toBe(code);
	}
}
