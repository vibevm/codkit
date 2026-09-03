/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CYCLE_CONTROL_RECORD_PATH, readCycleControlRecord, writeCycleControlRecord } from '../../src/lib/cycleControlRecord.ts';
import type { CycleControlRecord } from '../../src/lib/cycleControlRecord.ts';
import { nodeCycleStateFileSystem } from '../../src/lib/cycleState.ts';
import { CkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

function record(status: 'running' | 'done' = 'running'): CycleControlRecord {
	return {
		codkitCycleControl: 1,
		kind: 'restart',
		status,
		state: {
			codkitCycleState: 2,
			sourcePin: { tag: '1.135.0', sha: '1'.repeat(40), date: '2026-08-13' },
			targetPin: { tag: '1.136.0', sha: '2'.repeat(40), date: '2026-08-20' },
			branch: 'codkit/cycle/1.136.0',
			startedAt: '2026-08-31T10:00:00.000Z',
			updatedAt: '2026-08-31T10:01:00.000Z',
			phase: 'apply',
			nextAction: 'finish restart',
			transaction: { kind: 'restart', baseCommit: 'a'.repeat(40), bumpCommit: 'b'.repeat(40) },
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
		}
	};
}

function path(root: string): string {
	return join(root, ...CYCLE_CONTROL_RECORD_PATH.split('/'));
}

describe('cycle control record', () => {
	afterAll(cleanupTempRoots);

	it('round-trips canonical running/done records and makes identical writes no-ops', () => {
		const root = makeTempRoot('cycle-control-record');
		expect(writeCycleControlRecord(root, record(), { temporarySuffix: () => 'first' })).toBe(true);
		expect(readCycleControlRecord(root)).toEqual(record());
		expect(writeCycleControlRecord(root, record(), { temporarySuffix: () => 'unused' })).toBe(false);
		expect(writeCycleControlRecord(root, record('done'), { temporarySuffix: () => 'done' })).toBe(true);
		expect(readCycleControlRecord(root)?.status).toBe('done');
	});

	it('retains old bytes and cleans the temp when atomic replacement is interrupted', () => {
		const root = makeTempRoot('cycle-control-record-interrupt');
		writeCycleControlRecord(root, record(), { temporarySuffix: () => 'first' });
		const before = readFileSync(path(root));
		const fileSystem = {
			...nodeCycleStateFileSystem,
			rename() {
				throw new Error('injected control-record interruption');
			}
		};
		expect(() => writeCycleControlRecord(root, record('done'), { fileSystem, temporarySuffix: () => 'interrupted' })).toThrow(CkError);
		expect(readFileSync(path(root))).toEqual(before);
		expect(existsSync(`${path(root)}.interrupted.tmp`)).toBe(false);
	});

	it('fails closed on malformed, noncanonical and invalid UTF-8 records', () => {
		for (const [label, bytes] of [
			['malformed', new TextEncoder().encode('{}\n')],
			['noncanonical', new TextEncoder().encode(`${JSON.stringify(record())}\n`)],
			['encoding', new Uint8Array([0xff, 0x0a])]
		] as const) {
			const root = makeTempRoot(`cycle-control-record-${label}`);
			mkdirSync(dirname(path(root)), { recursive: true });
			writeFileSync(path(root), bytes);
			expect(() => readCycleControlRecord(root), label).toThrow(CkError);
		}
	});

	it('rejects a symlink component instead of escaping the patchset root', () => {
		const root = makeTempRoot('cycle-control-record-link');
		const outside = makeTempRoot('cycle-control-record-outside');
		symlinkSync(outside, join(root, '.codkit'), 'dir');
		expect(() => readCycleControlRecord(root)).toThrow(CkError);
		expect(() => writeCycleControlRecord(root, record())).toThrow(CkError);
	});
});
