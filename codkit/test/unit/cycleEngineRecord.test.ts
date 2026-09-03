/** @scope spec://codkit/modules/codkit/PROP-009#state */
import { createHash } from 'node:crypto';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CycleApplyClassification } from '../../src/lib/cycleClassify.ts';
import {
	CYCLE_APPLY_RECORD_PATH,
	makeCycleApplyRecord,
	readCycleApplyRecord,
	writeCycleApplyRecord
} from '../../src/lib/cycleEngineRecord.ts';
import { makeTempRoot } from '../support/tmp.ts';

const ARTIFACT = 'delta/patches/src%2Fexample.ts.ckpatch';
const classification: CycleApplyClassification = {
	kind: 'patch',
	layer: 'patch',
	artifactPath: ARTIFACT,
	artifactId: 'CK-example-001',
	targetPath: 'src/example.ts',
	outcome: 'merged',
	bytes: new Uint8Array([0, 1, 255]),
	materials: {
		base: new Uint8Array([1]),
		baseExists: true,
		ours: new Uint8Array([2]),
		oursExists: true,
		theirs: new Uint8Array([3])
	}
};

describe('cycle apply record', () => {
	it('round-trips the full byte-bearing classification canonically', () => {
		const root = makeTempRoot('cycle-engine-record');
		const record = makeRecord();
		writeCycleApplyRecord(root, record);

		const loaded = readCycleApplyRecord(root);
		expect(loaded).toEqual(record);
		expect(readFileSync(`${root}/${CYCLE_APPLY_RECORD_PATH}`, 'utf8')).toMatch(/"codkitBytesBase64": "AAH\/"/);
	});

	it('rejects edited authority even when the JSON remains well formed', () => {
		const root = makeTempRoot('cycle-engine-record-tamper');
		writeCycleApplyRecord(root, makeRecord());
		const path = `${root}/${CYCLE_APPLY_RECORD_PATH}`;
		writeFileSync(path, readFileSync(path, 'utf8').replace('codkit/cycle/t2', 'codkit/cycle/t3'), 'utf8');

		expect(() => readCycleApplyRecord(root)).toThrow(/digest/);
	});

	it('rejects a logically inconsistent record even with a recomputed self-digest', () => {
		const root = makeTempRoot('cycle-engine-record-relations');
		writeCycleApplyRecord(root, makeRecord());
		const path = `${root}/${CYCLE_APPLY_RECORD_PATH}`;
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		const causes = raw['causes'];
		if (!Array.isArray(causes) || causes[0] === null || typeof causes[0] !== 'object') throw new Error('bad fixture record');
		causes[0] = { ...causes[0], outcome: 'conflict' };
		const { digest: _old, ...body } = raw;
		raw['digest'] = createHash('sha256').update(JSON.stringify(body)).digest('hex');
		writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

		expect(() => readCycleApplyRecord(root)).toThrow(/cause is not derived/);
	});

	it('does not follow a symlinked runtime-state ancestor', () => {
		const root = makeTempRoot('cycle-engine-record-symlink');
		const outside = makeTempRoot('cycle-engine-record-outside');
		symlinkSync(outside, `${root}/.codkit`);
		expect(() => writeCycleApplyRecord(root, makeRecord())).toThrow(/unsafe record path|symbolic link/);
	});
});

function makeRecord() {
	return makeCycleApplyRecord({
		sourcePin: { tag: 't1', sha: '1'.repeat(40), date: '2026-08-01' },
		targetPin: { tag: 't2', sha: '2'.repeat(40), date: '2026-08-08' },
		branch: 'codkit/cycle/t2',
		createdAt: '2026-08-31T20:00:00.000Z',
		classifications: [classification],
		causes: [
			{
				artifactPath: ARTIFACT,
				artifactId: 'CK-example-001',
				targetPath: 'src/example.ts',
				outcome: 'merged',
				cause: { sha: '3'.repeat(40), approx: false }
			}
		],
		buckets: {
			clean: [],
			shifted: [],
			merged: [ARTIFACT],
			conflict: [],
			'target-deleted': [],
			'target-renamed': [],
			'rule-broken': [],
			'contract-failed': []
		},
		renames: [],
		renamePaths: [],
		regenerationPaths: [],
		reviewToken: null,
		reviewStop: null,
		checkpoint: 'classified',
		renameParent: '4'.repeat(40),
		renameCommit: null,
		regenerationParent: null,
		regenerationCommit: null
	});
}
