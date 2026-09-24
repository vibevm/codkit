/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-RECORD-REPLACE-BUDGET */
// The pid transition of a daemon record replaces a reservation published a
// moment before, and on Windows a file that fresh is the one a kernel-mode
// holder keeps open. The transition therefore waits with the record budget of
// a minute, not with the 310 ms every other contained write gets - and still
// refuses once the minute is spent, leaving the reservation for `up` to retire.
//
// The rename, the platform and the clock come in through the transition's own
// seams, so the schedule is pinned on any OS without sleeping. Without that
// wiring, taking the budget out of `finalizeReservation` would leave every
// other test green.

import { readdirSync } from 'node:fs';
import { afterAll, expect, it } from 'vitest';
import {
	DAEMON_RECORD_SCHEMA_VERSION,
	buildDir,
	createReservation,
	daemonRecordBytes,
	finalizeReservation,
	readRecordState
} from '../../src/lib/buildRuntime.ts';
import type { DaemonRecord, RecordReplaceSeams } from '../../src/lib/buildRuntime.ts';
import { acquireDaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';
import type { DaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { heldRename } from '../support/heldRename.ts';
import type { HeldRename } from '../support/heldRename.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const RESERVATION: DaemonRecord = {
	codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
	channel: 'transpile',
	script: 'watch-transpile',
	pid: 0,
	cmdline: 'watch-transpile',
	startedAt: '2026-09-24T04:51:16.000Z',
	treeId: 'fixture-tree',
	treePath: '/fixture/tree',
	nonce: '44444444-4444-4444-8444-444444444444'
};

/** The waits of the record budget: 10, 20, 40, 80 and 160 ms, then 250 ms while the sum stays within 60 000 ms. */
const RECORD_WAITS: readonly number[] = [10, 20, 40, 80, 160, ...Array.from({ length: 238 }, () => 250)];

/** Publish the reservation in a fresh patch set and run `body` under the channel lock. */
function withReservation(label: string, body: (root: string, lock: DaemonChannelLock) => void): void {
	const root = makeTempRoot(label);
	const lock = acquireDaemonChannelLock(root, RESERVATION.channel, 'record replace test');
	try {
		expect(createReservation(root, RESERVATION, lock)).toBe(true);
		body(root, lock);
	} finally {
		lock.release();
	}
}

/** Windows, the held rename, and a clock that records its waits instead of sleeping. */
function onWindows(hold: HeldRename, waits: number[]): RecordReplaceSeams {
	return { renamePlatform: 'win32', applyRename: hold.rename, waitForRenameRetry: (milliseconds) => waits.push(milliseconds) };
}

it('outlasts a hold the default budget would have refused, and records the spawned pid', () => {
	withReservation('record-replace-held', (root, lock) => {
		const hold = heldRename(40);
		const waits: number[] = [];
		expect(finalizeReservation(root, RESERVATION, 4242, lock, undefined, onWindows(hold, waits))).toBe(true);
		// 9060 ms of waits, where the default budget stops at 310.
		expect(waits).toEqual(RECORD_WAITS.slice(0, 40));
		expect(hold.attempts()).toBe(41);
		expect(readRecordState(root, RESERVATION.channel)).toMatchObject({ state: 'valid', record: { pid: 4242, nonce: RESERVATION.nonce } });
		expect(readdirSync(buildDir(root))).toEqual(['transpile.json']);
	});
});

it('refuses once the minute of waits is spent, and keeps the reservation for up to retire', () => {
	withReservation('record-replace-refused', (root, lock) => {
		const hold = heldRename(Number.POSITIVE_INFINITY);
		const waits: number[] = [];
		let refusal: unknown;
		try {
			finalizeReservation(root, RESERVATION, 4242, lock, undefined, onWindows(hold, waits));
		} catch (error) {
			refusal = error;
		}
		expect(waits).toEqual(RECORD_WAITS);
		expect(waits.reduce((sum, wait) => sum + wait, 0)).toBe(59_810);
		expect(hold.attempts()).toBe(244);
		expect(isCkError(refusal) ? { code: refusal.code, hint: refusal.hint } : refusal).toEqual({
			code: 'CONFIG',
			hint: 'check the permissions of the parent directory'
		});
		expect(isCkError(refusal) ? refusal.message : '').toMatch(/cannot atomically replace .*transpile\.json: EPERM/);
		// The failure path of `up` retires exactly these bytes once it has
		// stopped the daemon it spawned; no temporary is left beside them.
		const kept = readRecordState(root, RESERVATION.channel);
		expect(kept.state === 'valid' ? Buffer.from(kept.bytes).toString('utf8') : kept.state).toBe(
			Buffer.from(daemonRecordBytes(RESERVATION)).toString('utf8')
		);
		expect(readdirSync(buildDir(root))).toEqual(['transpile.json']);
	});
});
