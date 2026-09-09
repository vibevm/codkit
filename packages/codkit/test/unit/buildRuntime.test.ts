// Fail-closed daemon runtime state: portable channel names, complete exclusive
// reservations, CAS finalization, and contained log/record operations.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	DAEMON_RECORD_SCHEMA_VERSION,
	closeLog,
	createReservation,
	finalizeReservation,
	logPath,
	openLogAppend,
	readLog,
	readRecordState,
	recordPath,
	removeRecord,
	rotateLog,
	validateChannelName,
	type DaemonRecord
} from '../../src/lib/buildRuntime.ts';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { acquireDaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';
import type { DaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';

afterAll(() => {
	cleanupTempRoots();
	cleanupDiskRoots();
});

function reservation(channel = 'transpile'): DaemonRecord {
	return {
		codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
		channel,
		script: 'watch-transpile',
		pid: 0,
		cmdline: 'watch-transpile',
		startedAt: '2026-09-04T00:00:00.000Z',
		treeId: 'fixture-tree',
		treePath: '/fixture/tree',
		nonce: '11111111-1111-4111-8111-111111111111'
	};
}

function withChannelLock<T>(root: string, body: (lock: DaemonChannelLock) => T): T {
	const lock = acquireDaemonChannelLock(root, 'transpile', 'runtime test');
	try {
		return body(lock);
	} finally {
		lock.release();
	}
}

describe('daemon record publication', () => {
	it('publishes a complete reservation exclusively and finalizes only its exact generation', () => {
		const root = makeDiskRoot('runtime-reservation');
		const record = reservation();
		withChannelLock(root, (lock) => {
			expect(createReservation(root, record, lock)).toBe(true);
			expect(JSON.parse(readFileSync(recordPath(root, record.channel), 'utf8'))).toEqual(record);
			expect(createReservation(root, { ...record, nonce: '22222222-2222-4222-8222-222222222222' }, lock)).toBe(false);
			expect(finalizeReservation(root, record, 4242, lock)).toBe(true);
		});
		expect(readRecordState(root, record.channel)).toMatchObject({ state: 'valid', record: { pid: 4242, nonce: record.nonce } });
	});

	it('refuses a displaced reservation and preserves the replacing generation', () => {
		const root = makeDiskRoot('runtime-reservation-displaced');
		const first = reservation();
		const replacement = { ...first, nonce: '33333333-3333-4333-8333-333333333333' };
		withChannelLock(root, (lock) => {
			expect(createReservation(root, first, lock)).toBe(true);
			writeFileSync(recordPath(root, first.channel), `${JSON.stringify(replacement, null, 2)}\n`, 'utf8');
			expect(finalizeReservation(root, first, 4242, lock)).toBe(false);
		});
		expect(readRecordState(root, first.channel)).toMatchObject({ state: 'valid', record: replacement });
	});

	it.each([
		['empty', ''],
		['truncated', '{"codkitBuildDaemon":'],
		['malformed', '{ nope'],
		['schema-invalid', '{}\n'],
		['missing-nonce', `${JSON.stringify((({ nonce: _omitted, ...rest }: DaemonRecord) => rest)(reservation()))}\n`],
		['extra-field', `${JSON.stringify({ ...reservation(), extra: true })}\n`],
		['noncanonical-date', `${JSON.stringify({ ...reservation(), startedAt: '2026-09-04' })}\n`]
	])('classifies %s existing bytes as invalid and never removes them', (_label, bytes) => {
		const root = makeDiskRoot(`runtime-record-${_label}`);
		const path = recordPath(root, 'transpile');
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes, 'utf8');
		const before = readFileSync(path);
		expect(readRecordState(root, 'transpile').state).toBe('invalid');
		// The expected generation is mandatory, so an invalid record cannot be
		// removed even by a caller holding the lock: there is nothing to compare.
		withChannelLock(root, (lock) => expect(removeRecord(root, 'transpile', lock, before)).toBe(false));
		expect(readFileSync(path)).toEqual(before);
	});
});

describe('portable channel names', () => {
	it.each([
		'',
		'.',
		'..',
		'../x',
		'a/b',
		'a\\b',
		'/abs',
		'C:\\drive',
		'\\\\server\\share',
		'CON',
		'nul.txt',
		'aux',
		'name.',
		'name ',
		'a\u0001b'
	])('rejects hostile channel key %j before deriving a runtime path', (channel) => {
		expect(() => validateChannelName(channel)).toThrow(/unsafe build channel name/);
	});

	it('keeps valid channel paths as direct runtime children', () => {
		const root = makeDiskRoot('runtime-channel-direct');
		expect(logPath(root, 'typecheck')).toBe(join(root, '.codkit', 'build', 'typecheck.log'));
		expect(recordPath(root, 'typecheck')).toBe(join(root, '.codkit', 'build', 'typecheck.json'));
	});
});

describe('contained daemon runtime files', () => {
	it.each(['codkit', 'build'] as const)('refuses a symlinked .codkit/%s runtime ancestor', (level) => {
		const root = makeDiskRoot(`runtime-${level}-symlink`);
		const outside = makeTempRoot(`runtime-${level}-outside`);
		if (level === 'codkit') symlinkSync(outside, join(root, '.codkit'));
		else {
			mkdirSync(join(root, '.codkit'));
			symlinkSync(outside, join(root, '.codkit', 'build'));
		}
		expect(() => withChannelLock(root, (lock) => createReservation(root, reservation(), lock))).toThrow(/symlink/);
		expect(existsSync(join(outside, 'transpile.json'))).toBe(false);
		expect(readdirSync(outside)).toEqual([]);
	});

	it('refuses symlinked log, record and rotation leaves without changing outside sentinels', () => {
		const root = makeDiskRoot('runtime-leaf-links');
		const outside = makeTempRoot('runtime-leaf-links-outside');
		const runtime = join(root, '.codkit', 'build');
		mkdirSync(runtime, { recursive: true });
		const sentinel = join(outside, 'sentinel');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		const beforeMtime = statSync(sentinel).mtimeMs;
		for (const name of ['transpile.log', 'transpile.json', 'transpile.log.1']) symlinkSync(sentinel, join(runtime, name));

		expect(() => readLog(root, 'transpile')).toThrow(/symlink|regular/);
		expect(readRecordState(root, 'transpile').state).toBe('invalid');
		withChannelLock(root, (lock) => {
			expect(() => rotateLog(root, 'transpile', lock)).toThrow(/symlink|regular/);
			expect(() => openLogAppend(root, 'transpile', lock)).toThrow(/symlink|regular/);
		});
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
		expect(statSync(sentinel).mtimeMs).toBe(beforeMtime);
	});

	it('refuses a build ancestor swapped after a runtime log opens', () => {
		const root = makeDiskRoot('runtime-parent-swap');
		const runtime = join(root, '.codkit', 'build');
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, 'transpile.log'), 'inside\n', 'utf8');
		const held = `${runtime}-held`;
		const outside = makeTempRoot('runtime-parent-swap-outside');
		const sentinel = join(outside, 'transpile.log');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		try {
			expect(() =>
				readLog(root, 'transpile', () => {
					renameSync(runtime, held);
					symlinkSync(outside, runtime);
				})
			).toThrow(/outside|symlink|changed|prove/);
			expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
		} finally {
			rmSync(runtime, { force: true });
			renameSync(held, runtime);
		}
	});

	it('marks a record invalid when its build ancestor is swapped after open', () => {
		const root = makeDiskRoot('runtime-record-parent-swap');
		const runtime = join(root, '.codkit', 'build');
		mkdirSync(runtime, { recursive: true });
		const record = reservation();
		writeFileSync(join(runtime, 'transpile.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
		const held = `${runtime}-held`;
		const outside = makeTempRoot('runtime-record-parent-swap-outside');
		const outsideRecord = { ...record, treeId: 'outside' };
		const sentinel = join(outside, 'transpile.json');
		writeFileSync(sentinel, `${JSON.stringify(outsideRecord, null, 2)}\n`, 'utf8');
		try {
			expect(
				readRecordState(root, 'transpile', () => {
					renameSync(runtime, held);
					symlinkSync(outside, runtime);
				}).state
			).toBe('invalid');
			expect(JSON.parse(readFileSync(sentinel, 'utf8'))).toEqual(outsideRecord);
		} finally {
			rmSync(runtime, { force: true });
			renameSync(held, runtime);
		}
	});

	it('refuses a rotation ancestor swapped before rename and preserves outside bytes', () => {
		const root = makeDiskRoot('runtime-rotate-parent-swap');
		const runtime = join(root, '.codkit', 'build');
		mkdirSync(runtime, { recursive: true });
		writeFileSync(join(runtime, 'transpile.log'), 'inside\n', 'utf8');
		const held = `${runtime}-held`;
		const outside = makeTempRoot('runtime-rotate-parent-swap-outside');
		writeFileSync(join(outside, 'transpile.log'), 'outside-current\n', 'utf8');
		writeFileSync(join(outside, 'transpile.log.1'), 'outside-rotated\n', 'utf8');
		const lock = acquireDaemonChannelLock(root, 'transpile', 'runtime test');
		try {
			expect(() =>
				rotateLog(root, 'transpile', lock, () => {
					renameSync(runtime, held);
					symlinkSync(outside, runtime);
				})
			).toThrow(/symlink|changed/);
			expect(readFileSync(join(outside, 'transpile.log'), 'utf8')).toBe('outside-current\n');
			expect(readFileSync(join(outside, 'transpile.log.1'), 'utf8')).toBe('outside-rotated\n');
		} finally {
			rmSync(runtime, { force: true });
			renameSync(held, runtime);
			lock.release();
		}
	});

	it('opens and closes a normal contained append log', () => {
		const root = makeDiskRoot('runtime-log-normal');
		const handle = withChannelLock(root, (lock) => openLogAppend(root, 'transpile', lock));
		closeLog(handle);
		expect(readLog(root, 'transpile')).toBe('');
	});
});
