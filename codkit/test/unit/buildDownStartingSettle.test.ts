/** @scope spec://codkit/modules/codkit/PROP-010#root */
// `build down` over a `starting` record (R10C): a teardown that runs inside
// PROCESS_START_SETTLE_MS of a spawn finds the record before the process has
// published its argv identity, and used to refuse exactly as it refuses
// `unknown` - one red cleanup item, and a whole cycle exit 3 on identical
// bytes. `starting` is transient, so the teardown waits the settle window the
// record still owes and re-probes once; the resolved state is then acted on,
// including the refusal when it resolves to `unknown`. Every wait here goes
// through the injected `settleWait` seam - the passing of the window itself is
// the record's `startedAt` aging past it, which the seam rewrites - so no test
// sleeps or depends on the wall clock or the scheduler.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DAEMON_RECORD_SCHEMA_VERSION, PROCESS_START_SETTLE_MS, downChannel, recordPath, statusOf } from '../../src/lib/buildWrap.ts';
import type { ProcessRunner } from '../../src/lib/buildWrap.ts';
import { readRecordState } from '../../src/lib/buildRuntime.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const TREE_ID = 'starting-settle-test-tree';
const TREE_PATH = '/starting/settle/recorded/tree';
const PID = 4242;
const NONCE = '11111111-1111-4111-8111-111111111111';

/** A schema-valid record of this tree whose daemon is mid-start. */
function record(pending: { readonly pid: number; readonly startedAt: string }): string {
	return `${JSON.stringify(
		{
			codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
			channel: 'transpile',
			script: 'watch-client-transpile',
			pid: pending.pid,
			cmdline: 'watch-client-transpile',
			startedAt: pending.startedAt,
			treeId: TREE_ID,
			treePath: TREE_PATH,
			nonce: NONCE
		},
		null,
		2
	)}\n`;
}

function install(root: string, pending: { readonly pid: number; readonly startedAt: string }): string {
	const path = recordPath(root, 'transpile');
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, record(pending), 'utf8');
	return path;
}

/** `ps` shapes: `-p` probes one recorded pid, `-eo` reads the process-group table. */
const FOREIGN_ARGS = 'someone else entirely\n';
const OUR_ARGS = 'npm run watch-client-transpile\n';

describe('codkit build down: a starting record is waited out, not refused', () => {
	afterAll(cleanupTempRoots);

	it('waits the settle window and tears the channel down once its identity publishes', async () => {
		const root = makeTempRoot('down-starting-resolves-living');
		install(root, { pid: PID, startedAt: new Date().toISOString() });
		const settleWaits: number[] = [];
		const signals: Array<readonly [number, string]> = [];
		let identityProbes = 0;
		const run: ProcessRunner = (_command, args) => {
			if (args.includes('-p')) {
				identityProbes += 1;
				// The first probe catches npm before it rewrote its process title;
				// the single re-probe after the settle wait sees the published argv.
				return { status: 0, stdout: identityProbes === 1 ? FOREIGN_ARGS : OUR_ARGS, stderr: '' };
			}
			// The process-group table: the group is gone once signalled.
			return { status: 0, stdout: '', stderr: '' };
		};

		await expect(
			downChannel(root, 'transpile', {
				expectedTreeId: TREE_ID,
				expectedTreePath: TREE_PATH,
				platform: 'darwin',
				run,
				termGraceMs: 0,
				signal: (target, signal) => {
					signals.push([target, signal]);
				},
				settleWait: (ms) => {
					settleWaits.push(ms);
					return Promise.resolve();
				}
			})
		).resolves.toEqual({ channel: 'transpile', action: 'stopped', pid: PID });

		// Exactly one TERM to the proven group, the record retired, and the wait
		// was the settle window the young record still owed - one bounded delay,
		// and one initial identity probe plus the single re-probe, nothing more.
		expect(signals).toEqual([[-PID, 'SIGTERM']]);
		expect(readRecordState(root, 'transpile').state).toBe('absent');
		expect(settleWaits).toHaveLength(1);
		expect(settleWaits[0]).toBeGreaterThan(PROCESS_START_SETTLE_MS - 100);
		expect(settleWaits[0]).toBeLessThanOrEqual(PROCESS_START_SETTLE_MS + 1);
		expect(identityProbes).toBe(2);
	});

	it('still refuses, and never signals, when the waited-out identity belongs to another process', async () => {
		const root = makeTempRoot('down-starting-resolves-unknown');
		const path = install(root, { pid: PID, startedAt: new Date().toISOString() });
		const settleWaits: number[] = [];
		const signals: Array<readonly [number, string]> = [];
		const run: ProcessRunner = (_command, args) => ({
			status: 0,
			stdout: args.includes('-p') ? FOREIGN_ARGS : '',
			stderr: ''
		});

		await expect(
			downChannel(root, 'transpile', {
				expectedTreeId: TREE_ID,
				expectedTreePath: TREE_PATH,
				platform: 'darwin',
				run,
				signal: (target, signal) => {
					signals.push([target, signal]);
				},
				settleWait: (ms) => {
					settleWaits.push(ms);
					// The settle window passing is the record aging past it.
					writeFileSync(
						path,
						record({ pid: PID, startedAt: new Date(Date.now() - (PROCESS_START_SETTLE_MS + 1000)).toISOString() }),
						'utf8'
					);
					return Promise.resolve();
				}
			})
		).rejects.toThrow(/belongs to another process; identity is not proven.*refusing to discard daemon record/s);

		// The refusal refused the signal and the removal both: a reused pid is
		// never signalled on the word of an unproven record, and the evidence
		// (the aged record) survives untouched.
		expect(signals).toEqual([]);
		expect(settleWaits).toHaveLength(1);
		expect(readRecordState(root, 'transpile')).toMatchObject({ state: 'valid', record: { pid: PID } });
	});

	it('still refuses a starting reservation that nobody finished', async () => {
		const root = makeTempRoot('down-starting-reservation');
		install(root, { pid: 0, startedAt: new Date().toISOString() });
		const settleWaits: number[] = [];
		const signals: Array<readonly [number, string]> = [];
		let identityProbes = 0;
		const run: ProcessRunner = (_command, args) => {
			if (args.includes('-p')) identityProbes += 1;
			return { status: 0, stdout: '', stderr: '' };
		};

		await expect(
			downChannel(root, 'transpile', {
				expectedTreeId: TREE_ID,
				expectedTreePath: TREE_PATH,
				platform: 'darwin',
				run,
				signal: (target, signal) => {
					signals.push([target, signal]);
				},
				settleWait: (ms) => {
					settleWaits.push(ms);
					return Promise.resolve();
				}
			})
		).rejects.toThrow(/start reservation is in progress.*refusing to discard daemon record/s);

		// pid 0 never publishes an identity, so the wait cannot resolve it: the
		// re-probe still says starting and the teardown still refuses, leaving
		// the exclusive reservation to whoever holds it.
		expect(signals).toEqual([]);
		expect(settleWaits).toHaveLength(1);
		expect(identityProbes).toBe(0);
		expect(readRecordState(root, 'transpile')).toMatchObject({ state: 'valid', record: { pid: 0 } });
	});

	it('does not wait a record that is not starting, and status stays read-only', async () => {
		const root = makeTempRoot('down-not-starting-no-wait');
		install(root, { pid: PID, startedAt: new Date().toISOString() });
		const settleWaits: number[] = [];
		const run: ProcessRunner = (_command, args) => ({
			status: 0,
			stdout: args.includes('-p') ? FOREIGN_ARGS : '',
			stderr: ''
		});
		const probe = {
			expectedTreeId: TREE_ID,
			expectedTreePath: TREE_PATH,
			platform: 'darwin' as const,
			run,
			signal: () => undefined,
			settleWait: (ms: number) => {
				settleWaits.push(ms);
				return Promise.resolve();
			}
		};

		// The read-only probe keeps reporting the transient state as `starting`;
		// only the teardown waits it out.
		expect(statusOf(root, 'transpile', probe)).toMatchObject({ state: 'starting', record: { pid: PID } });

		// A settled mismatch is `unknown` outright, with no wait before the
		// refusal - the window belongs to `starting` alone.
		writeFileSync(
			recordPath(root, 'transpile'),
			record({ pid: PID, startedAt: new Date(Date.now() - (PROCESS_START_SETTLE_MS + 1000)).toISOString() }),
			'utf8'
		);
		await expect(downChannel(root, 'transpile', probe)).rejects.toThrow(/identity is not proven/);
		expect(settleWaits).toEqual([]);
	});
});

describe('codkit build down: a record dated into the future is a clock, not a wait', () => {
	afterAll(cleanupTempRoots);

	it('refuses without waiting, signals nothing and preserves the record', async () => {
		// A record written before a backward NTP step, or by a host whose clock
		// disagrees. The settle arithmetic measures distance from `startedAt`, so
		// the skew was added to the wait: this teardown used to hold the channel
		// operation lock asleep for the whole skew - an hour is one `ntpdate`
		// away - refusing every other operation on the channel meanwhile.
		const root = makeTempRoot('down-starting-future-record');
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const path = install(root, { pid: PID, startedAt: future });
		const before = readFileSync(path);
		const settleWaits: number[] = [];
		const signals: Array<readonly [number, string]> = [];
		const run: ProcessRunner = (_command, args) => ({
			status: 0,
			stdout: args.includes('-p') ? FOREIGN_ARGS : '',
			stderr: ''
		});

		await expect(
			downChannel(root, 'transpile', {
				expectedTreeId: TREE_ID,
				expectedTreePath: TREE_PATH,
				platform: 'darwin',
				run,
				termGraceMs: 0,
				signal: (target, signal) => {
					signals.push([target, signal]);
				},
				settleWait: (ms) => {
					settleWaits.push(ms);
					return Promise.resolve();
				}
			})
		).rejects.toThrow(/dated \d+ ms into the future .*refusing to hold the channel lock for a skewed clock/);

		// Bounded and fail-closed: no wait was even entered, nothing was
		// signalled, and the record a human must inspect is byte-identical.
		expect(settleWaits).toEqual([]);
		expect(signals).toEqual([]);
		expect(readFileSync(path)).toEqual(before);
	});
});
