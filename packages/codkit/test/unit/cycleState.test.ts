/** @scope spec://codkit/modules/codkit/PROP-009#state */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	CYCLE_ARTIFACT_OUTCOMES,
	CYCLE_PHASES,
	CYCLE_STATE_PATH,
	cycleStatePath,
	nodeCycleStateFileSystem,
	parseCycleState,
	readCycleState,
	serializeCycleState,
	writeCycleState
} from '../../src/lib/cycleState.ts';
import type { CyclePhase, CycleState } from '../../src/lib/cycleState.ts';
import { CkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const SOURCE_SHA = '1'.repeat(40);
const TARGET_SHA = '2'.repeat(40);

function state(phase: CyclePhase = 'apply'): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: '1.134.0', sha: SOURCE_SHA, date: '2026-08-06' },
		targetPin: { tag: '1.135.0', sha: TARGET_SHA, date: '2026-08-13' },
		branch: 'codkit/cycle/1.135.0',
		startedAt: '2026-08-31T10:00:00.000Z',
		updatedAt: '2026-08-31T10:01:00.000Z',
		phase,
		nextAction: 'continue the cycle',
		transaction: phase === 'init' ? { kind: 'init', baseCommit: 'a'.repeat(40), baseBranch: 'main' } : null,
		artifacts: {
			clean: [],
			shifted: [],
			merged: [],
			conflict: [],
			'target-deleted': [],
			'target-renamed': [],
			'rule-broken': [],
			'contract-failed': []
		},
		resolved: [],
		renames: []
	};
}

describe('cycle state', () => {
	afterAll(() => {
		cleanupTempRoots();
	});

	it('round-trips the schema-v1 document with deterministic JSON and one LF', () => {
		const value: CycleState = {
			...state('renames'),
			artifacts: {
				clean: ['delta/patches/clean.ckpatch'],
				shifted: ['delta/patches/shifted.ckpatch'],
				merged: ['delta/patches/merged.ckpatch'],
				conflict: ['delta/patches/conflict.ckpatch'],
				'target-deleted': ['delta/patches/deleted.ckpatch'],
				'target-renamed': ['delta/patches/renamed.ckpatch'],
				'rule-broken': ['delta/rules/rule.json'],
				'contract-failed': ['delta/own/own.json']
			},
			resolved: ['delta/patches/conflict.ckpatch'],
			renames: [{ from: 'old.ts', to: 'new.ts', similarity: 94 }]
		};

		const document = serializeCycleState(value);
		expect(document.endsWith('\n')).toBe(true);
		expect(document.endsWith('\n\n')).toBe(false);
		expect(serializeCycleState(parseCycleState(document))).toBe(document);
		expect(parseCycleState(document)).toEqual(value);
	});

	it.each([{ tag: null }, { resolvedAt: '2026-10-03T12:00:00Z' }, { provenance: { source: 'fixture', sha256: 'c'.repeat(64) } }])(
		'refuses a new pin form under schema 2: %j',
		(change) => {
			const legacy = state();
			const targetPin = { ...legacy.targetPin, ...change };
			expect(() => serializeCycleState({ ...legacy, targetPin })).toThrow(/schema 3/);
			const document = serializeCycleState({ ...legacy, codkitCycleState: 3, targetPin });
			expect(parseCycleState(document).targetPin).toEqual(targetPin);
		}
	);

	it('accepts exactly every normative phase and artifact outcome key', () => {
		for (const phase of CYCLE_PHASES) {
			expect(parseCycleState(serializeCycleState(state(phase))).phase).toBe(phase);
		}
		expect(Object.keys(state().artifacts)).toEqual(CYCLE_ARTIFACT_OUTCOMES);
	});

	it('writes through a same-directory temporary file and makes identical writes no-ops', () => {
		const root = makeTempRoot('cycle-state-write');
		const calls: string[] = [];
		const fileSystem = {
			...nodeCycleStateFileSystem,
			writeBytes(path: string, document: Uint8Array) {
				calls.push(`write:${path}`);
				nodeCycleStateFileSystem.writeBytes(path, document);
			},
			rename(from: string, to: string) {
				calls.push(`rename:${from}->${to}`);
				nodeCycleStateFileSystem.rename(from, to);
			}
		};

		expect(writeCycleState(root, state(), { fileSystem, temporarySuffix: () => 'observed' })).toBe(true);
		expect(readCycleState(root)).toEqual(state());
		expect(calls).toEqual([
			`write:${cycleStatePath(root)}.observed.tmp`,
			`rename:${cycleStatePath(root)}.observed.tmp->${cycleStatePath(root)}`
		]);

		calls.length = 0;
		expect(writeCycleState(root, state(), { fileSystem, temporarySuffix: () => 'unused' })).toBe(false);
		expect(calls).toEqual([]);
	});

	it('retains the old bytes and cleans the temp file when atomic rename fails', () => {
		const root = makeTempRoot('cycle-state-interrupt');
		const oldState = state('apply');
		writeCycleState(root, oldState, { temporarySuffix: () => 'initial' });
		const oldBytes = readFileSync(cycleStatePath(root), 'utf8');
		const fileSystem = {
			...nodeCycleStateFileSystem,
			rename() {
				throw new Error('injected interruption before rename');
			}
		};

		expect(() => writeCycleState(root, { ...oldState, phase: 'resolve' }, { fileSystem, temporarySuffix: () => 'interrupted' })).toThrow(
			CkError
		);
		expect(readFileSync(cycleStatePath(root), 'utf8')).toBe(oldBytes);
		expect(readCycleState(root)).toEqual(oldState);
		expect(existsSync(`${cycleStatePath(root)}.interrupted.tmp`)).toBe(false);
	});

	it('returns null only for absence and fails closed on malformed or unknown state', () => {
		const root = makeTempRoot('cycle-state-invalid');
		expect(readCycleState(root)).toBeNull();

		writeFixture(cycleStatePath(root), '{\n');
		expectTypedConfigFailure(() => readCycleState(root));

		const withUnknown = { ...state(), surprise: true };
		writeFixture(cycleStatePath(root), `${JSON.stringify(withUnknown)}\n`);
		expectTypedConfigFailure(() => readCycleState(root));

		const withUnknownOutcome = { ...state(), artifacts: { ...state().artifacts, mystery: [] } };
		writeFixture(cycleStatePath(root), `${JSON.stringify(withUnknownOutcome)}\n`);
		expectTypedConfigFailure(() => readCycleState(root));
	});

	it('does not overwrite an existing malformed generation', () => {
		const root = makeTempRoot('cycle-state-refuse-overwrite');
		const path = join(root, ...CYCLE_STATE_PATH.split('/'));
		writeFixture(path, '{"partial":true}\n');
		const before = readFileSync(path, 'utf8');

		expectTypedConfigFailure(() => writeCycleState(root, state()));
		expect(readFileSync(path, 'utf8')).toBe(before);
	});

	it('converts file-system read failures into typed state errors', () => {
		const root = makeTempRoot('cycle-state-read-error');
		const fileSystem = {
			...nodeCycleStateFileSystem,
			readBytes() {
				throw new Error('injected read error');
			}
		};

		expectTypedConfigFailure(() => readCycleState(root, fileSystem));
	});

	it.each([
		['invalid UTF-8', new Uint8Array([0xff, 0x0a]), 'ENCODING'],
		['UTF-8 BOM', new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]), 'ENCODING'],
		['CRLF', new TextEncoder().encode('{}\r\n'), 'CRLF'],
		['missing final LF', new TextEncoder().encode('{}'), 'EOF-NEWLINE'],
		['double final LF', new TextEncoder().encode('{}\n\n'), 'EOF-NEWLINE']
	])('rejects %s bytes before schema parsing', (_label, bytes, code) => {
		const root = makeTempRoot('cycle-state-bytes');
		writeFixtureBytes(join(root, ...CYCLE_STATE_PATH.split('/')), bytes);
		expectCode(() => readCycleState(root), code);
	});

	it('rejects symlink components and a symlink state leaf for reads and writes', () => {
		const componentRoot = makeTempRoot('cycle-state-symlink-component');
		const outside = makeTempRoot('cycle-state-outside');
		symlinkSync(outside, join(componentRoot, 'cycle'), 'dir');
		expectTypedConfigFailure(() => readCycleState(componentRoot));
		expectTypedConfigFailure(() => writeCycleState(componentRoot, state()));

		const leafRoot = makeTempRoot('cycle-state-symlink-leaf');
		mkdirSync(join(leafRoot, 'cycle'));
		const outsideState = join(outside, 'state.json');
		writeFileSync(outsideState, serializeCycleState(state()), 'utf8');
		symlinkSync(outsideState, join(leafRoot, ...CYCLE_STATE_PATH.split('/')));
		expectTypedConfigFailure(() => readCycleState(leafRoot));
		expectTypedConfigFailure(() => writeCycleState(leafRoot, state()));
	});

	it('sorts paths and renames bytewise before serialization', () => {
		const unsorted: CycleState = {
			...state('resolve'),
			artifacts: { ...state().artifacts, conflict: ['delta/z', 'delta/a'] },
			resolved: ['delta/z', 'delta/a'],
			renames: [
				{ from: 'src/z.ts', to: 'src/zz.ts', similarity: 90 },
				{ from: 'src/a.ts', to: 'src/aa.ts', similarity: 100 }
			]
		};
		const parsed = parseCycleState(serializeCycleState(unsorted));
		expect(parsed.artifacts.conflict).toEqual(['delta/a', 'delta/z']);
		expect(parsed.resolved).toEqual(['delta/a', 'delta/z']);
		expect(parsed.renames.map((rename) => rename.from)).toEqual(['src/a.ts', 'src/z.ts']);
	});

	it.each([
		['branch', { ...state(), branch: 'bad branch' }],
		['portable pin tag', { ...state(), targetPin: { ...state().targetPin, tag: 'CON' }, branch: 'codkit/cycle/CON' }],
		['timestamps', { ...state(), updatedAt: '2026-08-31T09:59:00.000Z' }],
		['portable paths', { ...state(), artifacts: { ...state().artifacts, clean: ['../escape'] } }],
		['cross-outcome duplicate', { ...state(), artifacts: { ...state().artifacts, clean: ['delta/a'], conflict: ['delta/a'] } }],
		['resolved subset', { ...state(), resolved: ['delta/not-a-blocker'] }],
		['rename identity', { ...state(), renames: [{ from: 'src/a.ts', to: 'src/a.ts', similarity: 100 }] }],
		[
			'rename uniqueness',
			{
				...state(),
				renames: [
					{ from: 'src/a.ts', to: 'src/b.ts', similarity: 90 },
					{ from: 'src/a.ts', to: 'src/c.ts', similarity: 80 }
				]
			}
		],
		['advanced unresolved blockers', { ...state('done'), artifacts: { ...state().artifacts, conflict: ['delta/a'] } }]
	])('fails the %s cross-field invariant', (_label, value) => {
		expectTypedConfigFailure(() => serializeCycleState(value as CycleState));
	});

	it('allows the configured cycle branch prefix to differ from the default', () => {
		const configured = { ...state(), branch: 'team/upgrades/1.135.0' };
		expect(parseCycleState(serializeCycleState(configured))).toEqual(configured);
	});

	it('refuses a newer state schema with an update hint', () => {
		const newer = serializeCycleState(state()).replace('"codkitCycleState": 2', '"codkitCycleState": 5');
		try {
			parseCycleState(newer);
			throw new Error('expected newer state schema refusal');
		} catch (error) {
			expect(error).toBeInstanceOf(CkError);
			expect((error as CkError).code).toBe('CONFIG');
			expect((error as CkError).hint).toContain('update codkit');
		}
	});
});

function expectTypedConfigFailure(run: () => unknown): void {
	try {
		run();
		throw new Error('expected a typed cycle-state failure');
	} catch (error) {
		expect(error).toBeInstanceOf(CkError);
		expect((error as CkError).code).toBe('CONFIG');
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
