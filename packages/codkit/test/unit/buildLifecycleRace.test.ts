/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-CHANNEL-LOCK */
// Deterministic daemon reservation interleavings. Barriers are callbacks on the
// exclusive reservation and final CAS transition, never scheduler timing.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	DAEMON_RECORD_SCHEMA_VERSION,
	PROCESS_START_SETTLE_MS,
	downChannel,
	readFinishedPass,
	readPass,
	statusOf,
	upChannel,
	type ChannelConfig,
	type ProcessRunner,
	type SpawnedDaemon,
	type UpResult
} from '../../src/lib/buildWrap.ts';
import { daemonRecordBytes, readRecordState, recordPath, type DaemonRecord } from '../../src/lib/buildRuntime.ts';
import { acquireDaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
	cleanupDiskRoots();
});

const CHANNEL: ChannelConfig = {
	name: 'transpile',
	script: 'watch-transpile',
	passStart: [/^start$/],
	passEnd: [/^end$/],
	errorLine: [/^error: (.+)$/],
	errorCountLine: [],
	falseEndGuards: []
};

function fixture(label: string): { readonly patchesDir: string; readonly treeDir: string } {
	// The patches dir hosts the lock elections of `acquireDaemonChannelLock` -
	// hard-link retirement included - so it lives on the disk fixture root the
	// identity obligation names; the tree dir carries no inode semantics.
	const patchesDir = makeDiskRoot(`${label}-patches`);
	const treeDir = makeTempRoot(`${label}-tree`);
	writeFileSync(join(treeDir, 'package.json'), JSON.stringify({ scripts: { 'watch-transpile': 'fixture' } }), 'utf8');
	return { patchesDir, treeDir };
}

/** Above the kernel's pid ceiling: no process can carry it. */
const DEAD_PID = 4_194_305;

function spawned(pid: number, onTerminate: () => void = () => undefined): SpawnedDaemon {
	return { pid, terminate: onTerminate };
}

function context(current: ReturnType<typeof fixture>) {
	return { ...current, treeId: 'fixture-tree' };
}

/** The binding a command uses when it acts on the fixture's own tree. */
function ownTree(current: ReturnType<typeof fixture>) {
	return { expectedTreeId: 'fixture-tree', expectedTreePath: current.treeDir } as const;
}

describe('daemon reservation interleavings', () => {
	it('refuses a second up that arrives inside the first reservation window, before any pid exists', () => {
		const current = fixture('race-two-up');
		let second: UpResult | null = null;
		let during = '';
		let spawns = 0;
		const first = upChannel(context(current), CHANNEL, {
			spawn: () => {
				spawns += 1;
				return spawned(4242);
			},
			afterReservation: () => {
				during = statusOf(current.patchesDir, CHANNEL.name).state;
				second = upChannel(context(current), CHANNEL, {
					spawn: () => {
						spawns += 1;
						return spawned(5252);
					}
				});
			}
		});

		// Pins the lock-acquisition refusal (a pid-0 reservation reads `starting`), not reservation exclusivity - buildRuntime.test.ts holds that.
		expect(during).toBe('starting');
		expect(first).toMatchObject({ ok: true, pid: 4242 });
		expect(second).toMatchObject({ ok: false });
		expect(String((second as unknown as { reason: string }).reason)).toMatch(/still possibly alive and owns build up/);
		expect(spawns).toBe(1);
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { pid: 4242 } });
	});

	it('makes concurrent down/status/errors observe starting without mutation or stale-log certification', async () => {
		const current = fixture('race-up-observers');
		const oldLog = join(current.patchesDir, '.codkit', 'build', `${CHANNEL.name}.log`);
		mkdirSync(dirname(oldLog), { recursive: true });
		writeFileSync(oldLog, 'start\nend\n', 'utf8');
		let down: Promise<unknown> | null = null;
		let errors: Promise<unknown> | null = null;
		let observed = '';
		const signals: Array<readonly [number, string]> = [];
		const first = upChannel(context(current), CHANNEL, {
			spawn: () => spawned(4243),
			afterReservation: () => {
				observed = statusOf(current.patchesDir, CHANNEL.name).state;
				// `down` cannot even reach the record: the operation lock this `up`
				// holds is what linearizes them. `errors` is deliberately lock-free
				// and must still refuse to certify the pre-existing green log.
				down = downChannel(current.patchesDir, CHANNEL.name, {
					...ownTree(current),
					signal: (target, signal) => void signals.push([target, signal])
				});
				errors = readPass(current.patchesDir, CHANNEL, { timeoutMs: 0, pollMs: 0, probe: ownTree(current) });
			}
		});

		expect(observed).toBe('starting');
		await expect(down).rejects.toThrow(/still possibly alive and owns build up/);
		await expect(errors).resolves.toEqual({ state: 'timeout' });
		expect(signals).toEqual([]);
		expect(first).toMatchObject({ ok: true, pid: 4243 });
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { pid: 4243 } });
		// The pre-existing green pass was rotated away by this start, so nothing
		// could have certified it even if `errors` had reached the log.
		expect(existsSync(oldLog)).toBe(false);
		expect(readFileSync(`${oldLog}.1`, 'utf8')).toBe('start\nend\n');
	});

	it('terminates its spawned child when the reservation is displaced before final CAS', () => {
		const current = fixture('race-displaced-final');
		let terminated = 0;
		const replacement: DaemonRecord = {
			codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
			channel: CHANNEL.name,
			script: CHANNEL.script,
			pid: 0,
			cmdline: CHANNEL.script,
			startedAt: '2026-09-04T00:00:00.000Z',
			treeId: 'other-tree',
			treePath: '/other/tree',
			nonce: '22222222-2222-4222-8222-222222222222'
		};

		expect(() =>
			upChannel(context(current), CHANNEL, {
				spawn: () => spawned(4244, () => (terminated += 1)),
				beforeFinalize: () =>
					writeFileSync(recordPath(current.patchesDir, CHANNEL.name), `${JSON.stringify(replacement, null, 2)}\n`, 'utf8')
			})
		).toThrow(/reservation was displaced/);
		expect(terminated).toBe(1);
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: replacement });
	});
});

describe('ambiguous startup identity', () => {
	it('never calls a signal seam for a fresh mismatching pid and preserves the record', async () => {
		const current = fixture('race-fresh-mismatch');
		const record: DaemonRecord = {
			codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
			channel: CHANNEL.name,
			script: CHANNEL.script,
			pid: 4245,
			cmdline: CHANNEL.script,
			startedAt: new Date(Date.now() - Math.floor(PROCESS_START_SETTLE_MS / 2)).toISOString(),
			treeId: 'fixture-tree',
			treePath: current.treeDir,
			nonce: '33333333-3333-4333-8333-333333333333'
		};
		const path = recordPath(current.patchesDir, CHANNEL.name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
		const signals: Array<readonly [number, string]> = [];
		const run: ProcessRunner = (_command, args) =>
			args.includes('-p')
				? { status: 0, stdout: 'node somebody-else\n', stderr: '' }
				: { status: 0, stdout: '4245 4245 node somebody-else\n', stderr: '' };
		const probe = {
			...ownTree(current),
			platform: 'darwin' as const,
			run,
			signal: (target: number, signal: 'SIGTERM' | 'SIGKILL') => void signals.push([target, signal])
		};

		expect(statusOf(current.patchesDir, CHANNEL.name, probe).state).toBe('starting');
		// R10C: teardown waits the settle window out instead of refusing `starting`,
		// so the fresh mismatch resolves to `unknown` and refuses as such - same
		// refusal, same zero signals, same preserved record, resolved identity.
		await expect(downChannel(current.patchesDir, CHANNEL.name, probe)).rejects.toThrow(/identity is not proven|another process/);
		expect(signals).toEqual([]);
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { pid: 4245 } });

		writeFileSync(path, `${JSON.stringify({ ...record, startedAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`, 'utf8');
		expect(statusOf(current.patchesDir, CHANNEL.name, probe).state).toBe('unknown');
		await expect(downChannel(current.patchesDir, CHANNEL.name, probe)).rejects.toThrow(/identity is not proven|another process/);
		expect(signals).toEqual([]);
	});

	it.each([
		['empty', ''],
		['truncated', '{"pid":'],
		['malformed', '{ no'],
		['schema-invalid', '{}\n'],
		[
			'missing-nonce',
			`${JSON.stringify({
				codkitBuildDaemon: 1,
				channel: CHANNEL.name,
				script: CHANNEL.script,
				pid: 0,
				cmdline: CHANNEL.script,
				startedAt: '2026-09-04T00:00:00.000Z',
				treeId: 'fixture-tree',
				treePath: '/fixture/tree'
			})}\n`
		],
		['extra-field', `${JSON.stringify({ ...validRecordFixture(), extra: true })}\n`],
		['noncanonical-date', `${JSON.stringify({ ...validRecordFixture(), startedAt: '2026-09-04' })}\n`]
	])('makes every lifecycle action refuse a %s record without deletion or spawn', async (_label, bytes) => {
		const current = fixture(`race-invalid-${_label}`);
		const path = recordPath(current.patchesDir, CHANNEL.name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes, 'utf8');
		const beforeMtime = statSync(path).mtimeMs;
		let spawns = 0;
		expect(statusOf(current.patchesDir, CHANNEL.name).state).toBe('unknown');
		expect(upChannel(context(current), CHANNEL, { spawn: () => ((spawns += 1), spawned(6000)) })).toMatchObject({ ok: false });
		await expect(downChannel(current.patchesDir, CHANNEL.name, ownTree(current))).rejects.toThrow(/invalid|unreadable/);
		await expect(readPass(current.patchesDir, CHANNEL, { timeoutMs: 0, probe: ownTree(current) })).rejects.toThrow(/invalid|unreadable/);
		expect(spawns).toBe(0);
		expect(readFileSync(path, 'utf8')).toBe(bytes);
		expect(statSync(path).mtimeMs).toBe(beforeMtime);
	});

	it('makes every lifecycle action refuse an unreadable record without deletion', async () => {
		const current = fixture('race-unreadable-record');
		const path = recordPath(current.patchesDir, CHANNEL.name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ nope: true })}\n`, 'utf8');
		chmodSync(path, 0o000);
		try {
			expect(statusOf(current.patchesDir, CHANNEL.name).state).toBe('unknown');
			expect(upChannel(context(current), CHANNEL)).toMatchObject({ ok: false });
			await expect(downChannel(current.patchesDir, CHANNEL.name, ownTree(current))).rejects.toThrow(/unreadable|invalid/);
			await expect(readPass(current.patchesDir, CHANNEL, { timeoutMs: 0, probe: ownTree(current) })).rejects.toThrow(/unreadable|invalid/);
		} finally {
			chmodSync(path, 0o600);
		}
	});
});

describe('operation-lock barriers', () => {
	it('lets exactly one of two up operations past the lock; the loser does no destructive work', () => {
		const current = fixture('barrier-two-up');
		let spawns = 0;
		let loser: UpResult | null = null;
		const winner = upChannel(context(current), CHANNEL, {
			spawn: () => ((spawns += 1), spawned(4242)),
			afterLock: () => {
				loser = upChannel(context(current), CHANNEL, { spawn: () => ((spawns += 1), spawned(5252)) });
			}
		});

		expect(loser).toMatchObject({ ok: false });
		expect(String((loser as unknown as { reason: string }).reason)).toMatch(/still possibly alive and owns build up/);
		expect(winner).toMatchObject({ ok: true, pid: 4242 });
		expect(spawns).toBe(1);
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { pid: 4242 } });
	});

	it('lets exactly one of two down operations past the lock; the loser signals nothing', async () => {
		const current = fixture('barrier-two-down');
		const record = livingRecord(current.treeDir, 4242);
		plant(current.patchesDir, record);
		const signals: Array<readonly [number, string]> = [];
		const probe = livingProbe(4242, signals);
		let loser: Promise<unknown> | null = null;

		const winner = await downChannel(current.patchesDir, CHANNEL.name, {
			...probe,
			...ownTree(current),
			afterLock: () => {
				loser = downChannel(current.patchesDir, CHANNEL.name, { ...livingProbe(4242, signals), ...ownTree(current) });
			}
		});

		await expect(loser).rejects.toThrow(/still possibly alive and owns build down/);
		expect(winner).toMatchObject({ action: 'stopped', pid: 4242 });
		expect(signals).toEqual([[-4242, 'SIGTERM']]);
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toEqual({ state: 'absent' });
	});

	it('keeps down out of a channel an up operation holds', async () => {
		const current = fixture('barrier-up-down');
		const signals: Array<readonly [number, string]> = [];
		let blocked: Promise<unknown> | null = null;
		const started = upChannel(context(current), CHANNEL, {
			spawn: () => spawned(4243),
			afterLock: () => {
				blocked = downChannel(current.patchesDir, CHANNEL.name, {
					...ownTree(current),
					signal: (target, signal) => void signals.push([target, signal])
				});
			}
		});

		await expect(blocked).rejects.toThrow(/still possibly alive and owns build up/);
		expect(signals).toEqual([]);
		expect(started).toMatchObject({ ok: true, pid: 4243 });
	});
});

describe('the stale-record retirement of up', () => {
	it('refuses when the prior record changes between the read and its retirement', () => {
		// `down` has had a barrier at this atom since REPAIR-009; `up` had none,
		// so its symmetric guard could be deleted with the whole suite green -
		// the refusal state was simply unreachable from a test.
		const current = fixture('up-stale-retire');
		plant(current.patchesDir, livingRecord(current.treeDir, DEAD_PID));
		const path = recordPath(current.patchesDir, CHANNEL.name);
		const successor = { ...livingRecord(current.treeDir, DEAD_PID), nonce: '77777777-7777-4777-8777-777777777777' };
		let spawns = 0;

		const result = upChannel(context(current), CHANNEL, {
			spawn: () => {
				spawns += 1;
				return spawned(4242);
			},
			afterStaleRead: () => plant(current.patchesDir, successor)
		});

		expect(result).toMatchObject({ ok: false, reason: 'the prior daemon record changed before stale-record retirement' });
		// Nothing was started, and the generation that arrived is preserved.
		expect(spawns).toBe(0);
		expect(readFileSync(path)).toEqual(Buffer.from(daemonRecordBytes(successor)));
	});

	it('retires a prior record that did not change and starts the channel', () => {
		const current = fixture('up-stale-retire-clean');
		plant(current.patchesDir, livingRecord(current.treeDir, DEAD_PID));
		const result = upChannel(context(current), CHANNEL, { spawn: () => spawned(4242) });
		expect(result).toMatchObject({ ok: true, action: 'started', pid: 4242 });
	});
});

describe('post-comparison barriers', () => {
	it('terminates its own child and preserves a successor injected right after the finalize comparison', () => {
		const current = fixture('barrier-finalize-compare');
		const successor = { ...livingRecord('/other/tree', 9), treeId: 'other-tree', nonce: '66666666-6666-4666-8666-666666666666' };
		let terminated = 0;
		let successorMtime = 0;

		expect(() =>
			upChannel(context(current), CHANNEL, {
				spawn: () => spawned(4244, () => (terminated += 1)),
				afterFinalizeCompare: () => {
					plant(current.patchesDir, successor);
					successorMtime = statSync(recordPath(current.patchesDir, CHANNEL.name)).mtimeMs;
				}
			})
		).toThrow(/reservation was displaced/);

		expect(terminated).toBe(1);
		const path = recordPath(current.patchesDir, CHANNEL.name);
		expect(readFileSync(path)).toEqual(Buffer.from(daemonRecordBytes(successor)));
		expect(statSync(path).mtimeMs).toBe(successorMtime);
	});

	it('sends no TERM when the record generation changes right after the pre-TERM comparison', async () => {
		const current = fixture('barrier-term-compare');
		plant(current.patchesDir, livingRecord(current.treeDir, 4242));
		const successor = { ...livingRecord(current.treeDir, 4242), nonce: '77777777-7777-4777-8777-777777777777' };
		const signals: Array<readonly [number, string]> = [];
		let successorMtime = 0;

		await expect(
			downChannel(current.patchesDir, CHANNEL.name, {
				...livingProbe(4242, signals),
				...ownTree(current),
				afterTermCompare: () => {
					plant(current.patchesDir, successor);
					successorMtime = statSync(recordPath(current.patchesDir, CHANNEL.name)).mtimeMs;
				}
			})
		).rejects.toThrow(/generation changed after comparison/);

		expect(signals).toEqual([]);
		const path = recordPath(current.patchesDir, CHANNEL.name);
		expect(readFileSync(path)).toEqual(Buffer.from(daemonRecordBytes(successor)));
		expect(statSync(path).mtimeMs).toBe(successorMtime);
	});

	it('sends no KILL when the record generation changes right after the pre-KILL comparison', async () => {
		const current = fixture('barrier-kill-compare');
		plant(current.patchesDir, livingRecord(current.treeDir, 4242));
		const successor = { ...livingRecord(current.treeDir, 4242), nonce: '88888888-8888-4888-8888-888888888888' };
		const signals: Array<readonly [number, string]> = [];

		await expect(
			downChannel(current.patchesDir, CHANNEL.name, {
				// The group survives TERM, so `down` reaches the KILL comparison.
				...livingProbe(4242, signals, 'survives-term'),
				...ownTree(current),
				termGraceMs: 0,
				afterKillCompare: () => plant(current.patchesDir, successor)
			})
		).rejects.toThrow(/generation changed after comparison/);

		expect(signals).toEqual([[-4242, 'SIGTERM']]);
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { nonce: successor.nonce } });
	});

	it('preserves the record when the group is still alive after SIGKILL', async () => {
		// The last line of the cross-run-leak prevention. Nothing in the suite
		// could express a group that outlives SIGKILL, so deleting the guard -
		// falling through to removal - left every test green while a live
		// daemon's only kill handle was thrown away.
		const current = fixture('kill-survivor');
		plant(current.patchesDir, livingRecord(current.treeDir, 4242));
		const path = recordPath(current.patchesDir, CHANNEL.name);
		const before = readFileSync(path);
		const beforeMtime = statSync(path).mtimeMs;
		const signals: Array<readonly [number, string]> = [];
		let removalAttempted = false;

		await expect(
			downChannel(current.patchesDir, CHANNEL.name, {
				...livingProbe(4242, signals, 'survives-kill'),
				...ownTree(current),
				termGraceMs: 0,
				beforeRemove: () => {
					removalAttempted = true;
				}
			})
		).rejects.toThrow(/process group 4242 for .* is still alive after SIGKILL/);

		// Both signals were sent, in order, and then the teardown stopped.
		expect(signals).toEqual([
			[-4242, 'SIGTERM'],
			[-4242, 'SIGKILL']
		]);
		// The record is the kill handle of the next `build down`: byte-identical,
		// same mtime, and no removal was even attempted.
		expect(removalAttempted).toBe(false);
		expect(readFileSync(path)).toEqual(before);
		expect(statSync(path).mtimeMs).toBe(beforeMtime);
	});

	it('preserves the record when a native Windows teardown did not succeed', async () => {
		// Windows has no process group to signal: `taskkill /t` is the teardown,
		// and its exit status is the only evidence the tree died. A root that
		// simply disappeared while that teardown failed is not a completed stop,
		// and retiring the record there loses the tree's only handle. The suite
		// runs on Linux and the signal seam always reported success, so the guard
		// had no evidence on any platform.
		const current = fixture('windows-unproven-teardown');
		plant(current.patchesDir, livingRecord(current.treeDir, 4242));
		const path = recordPath(current.patchesDir, CHANNEL.name);
		const before = readFileSync(path);
		const beforeMtime = statSync(path).mtimeMs;
		const signals: Array<readonly [number, string]> = [];
		let gone = false;
		// A Windows process table: the recorded root answers until the teardown,
		// and is absent afterwards.
		const row = JSON.stringify({ pid: 4242, parentPid: 1, commandLine: `npm run ${CHANNEL.script}` });
		const run: ProcessRunner = () => ({ status: 0, stdout: gone ? '' : row, stderr: '' });

		await expect(
			downChannel(current.patchesDir, CHANNEL.name, {
				...ownTree(current),
				platform: 'win32',
				run,
				termGraceMs: 0,
				signal: (target, signal) => {
					signals.push([target, signal]);
					gone = true;
					// The native teardown reported failure: `taskkill` exited non-zero.
					return false;
				}
			})
		).rejects.toThrow(/the recorded Windows root disappeared without a successful native tree teardown/);

		expect(signals).toEqual([[4242, 'SIGTERM']]);
		expect(readFileSync(path)).toEqual(before);
		expect(statSync(path).mtimeMs).toBe(beforeMtime);
	});

	it('removes nothing when a successor lands right after the pre-removal comparison', async () => {
		const current = fixture('barrier-remove-compare');
		plant(current.patchesDir, livingRecord(current.treeDir, 4242));
		const successor = { ...livingRecord(current.treeDir, 4242), nonce: '99999999-9999-4999-8999-999999999999' };
		const signals: Array<readonly [number, string]> = [];
		let killed = false;
		const run: ProcessRunner = (_command, args) =>
			args.includes('-p')
				? killed
					? { status: 1, stdout: '', stderr: '' }
					: { status: 0, stdout: `${CHANNEL.script}\n`, stderr: '' }
				: killed
					? { status: 0, stdout: '', stderr: '' }
					: { status: 0, stdout: `4242 4242 ${CHANNEL.script}\n`, stderr: '' };

		await expect(
			downChannel(current.patchesDir, CHANNEL.name, {
				...ownTree(current),
				platform: 'darwin',
				run,
				termGraceMs: 0,
				signal: (target, signal) => {
					signals.push([target, signal]);
					killed = true;
				},
				afterRemoveCompare: () => plant(current.patchesDir, successor)
			})
		).rejects.toThrow(/changed before completed teardown|generation changed/);

		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { nonce: successor.nonce } });
	});
});

describe('current tree versus foreign tree', () => {
	it.each([
		['living', 4242],
		['starting', 0]
	])('refuses to signal, retire or certify a %s record owned by another tree', async (_label, pid) => {
		const current = fixture(`foreign-tree-${_label}`);
		const record = { ...livingRecord('/somewhere/else', pid), treeId: 'other-tree' };
		plant(current.patchesDir, record);
		const logFile = join(current.patchesDir, '.codkit', 'build', `${CHANNEL.name}.log`);
		writeFileSync(logFile, 'start\nend\n', 'utf8');
		const signals: Array<readonly [number, string]> = [];
		const probe = { ...livingProbe(pid === 0 ? 4242 : pid, signals), expectedTreeId: 'fixture-tree', expectedTreePath: current.treeDir };
		const before = readFileSync(recordPath(current.patchesDir, CHANNEL.name));

		const observed = statusOf(current.patchesDir, CHANNEL.name, probe);
		expect(observed).toMatchObject({ state: 'unknown', treeMatches: false });
		expect(observed.detail).toContain('/somewhere/else');
		await expect(downChannel(current.patchesDir, CHANNEL.name, probe)).rejects.toThrow(/another tree/);
		await expect(readPass(current.patchesDir, CHANNEL, { timeoutMs: 0, probe })).rejects.toThrow(/another tree/);
		expect(signals).toEqual([]);
		expect(readFileSync(recordPath(current.patchesDir, CHANNEL.name))).toEqual(before);
	});

	it('lets the owning tree act on the same record', async () => {
		const current = fixture('foreign-tree-owner');
		plant(current.patchesDir, livingRecord(current.treeDir, 4242));
		const signals: Array<readonly [number, string]> = [];
		const probe = { ...livingProbe(4242, signals), expectedTreeId: 'fixture-tree', expectedTreePath: current.treeDir };

		expect(statusOf(current.patchesDir, CHANNEL.name, probe)).toMatchObject({ state: 'living', treeMatches: true });
		await expect(downChannel(current.patchesDir, CHANNEL.name, probe)).resolves.toMatchObject({ action: 'stopped' });
		expect(signals).toEqual([[-4242, 'SIGTERM']]);
	});
});

describe('errors reads one stable daemon generation', () => {
	function withFinishedPass(label: string) {
		const current = fixture(label);
		plant(current.patchesDir, livingRecord(current.treeDir, 4242));
		writeFileSync(join(current.patchesDir, '.codkit', 'build', `${CHANNEL.name}.log`), 'start\nend\n', 'utf8');
		return current;
	}

	it('certifies a finished pass that stayed on one generation', async () => {
		const current = withFinishedPass('errors-stable');
		const outcome = await readPass(current.patchesDir, CHANNEL, { timeoutMs: 0, probe: { ...livingProbe(4242, []), ...ownTree(current) } });
		expect(outcome).toMatchObject({ state: 'ok', report: { errorCount: 0 } });
	});

	it('certifies nothing when the log rotates and the generation changes after the snapshot', async () => {
		const current = withFinishedPass('errors-rotated');
		const logFile = join(current.patchesDir, '.codkit', 'build', `${CHANNEL.name}.log`);
		await expect(
			readPass(current.patchesDir, CHANNEL, {
				timeoutMs: 0,
				probe: { ...livingProbe(4242, []), ...ownTree(current) },
				afterSnapshot: () => {
					renameSync(logFile, `${logFile}.1`);
					writeFileSync(logFile, 'start\n', 'utf8');
					plant(current.patchesDir, { ...livingRecord(current.treeDir, 4242), nonce: '12121212-1212-4121-8121-121212121212' });
				}
			})
		).rejects.toThrow(/generation changed while errors was reading it/);
	});

	it('certifies nothing when the generation changes between the pass and the verdict', async () => {
		const current = withFinishedPass('errors-late-generation');
		await expect(
			readPass(current.patchesDir, CHANNEL, {
				timeoutMs: 0,
				probe: { ...livingProbe(4242, []), ...ownTree(current) },
				beforeCertify: () =>
					plant(current.patchesDir, { ...livingRecord(current.treeDir, 4242), nonce: '13131313-1313-4131-8131-131313131313' })
			})
		).rejects.toThrow(/generation changed while errors was reading it/);
	});

	it('refuses the same way when a gone daemon' + "'" + 's finished pass is read', () => {
		const current = withFinishedPass('errors-finished-late-generation');
		expect(readFinishedPass(current.patchesDir, CHANNEL, { probe: ownTree(current) })).toMatchObject({ errorCount: 0 });
		expect(() =>
			readFinishedPass(current.patchesDir, CHANNEL, {
				probe: ownTree(current),
				beforeCertify: () =>
					plant(current.patchesDir, { ...livingRecord(current.treeDir, 4242), nonce: '14141414-1414-4141-8141-141414141414' })
			})
		).toThrow(/generation changed while errors was reading it/);
	});
});

describe('a crash between spawn and final publication', () => {
	it('leaves the pid-0 reservation fail-closed and never auto-recovers it', async () => {
		const current = fixture('crash-before-finalize');
		const reservation = { ...livingRecord(current.treeDir, 0), nonce: '15151515-1515-4151-8151-151515151515' };
		plant(current.patchesDir, reservation);
		const path = recordPath(current.patchesDir, CHANNEL.name);
		const before = readFileSync(path);
		const beforeMtime = statSync(path).mtimeMs;
		let spawns = 0;
		const signals: Array<readonly [number, string]> = [];

		expect(statusOf(current.patchesDir, CHANNEL.name).state).toBe('starting');
		expect(upChannel(context(current), CHANNEL, { spawn: () => ((spawns += 1), spawned(7777)) })).toMatchObject({ ok: false });
		await expect(
			downChannel(current.patchesDir, CHANNEL.name, {
				...ownTree(current),
				signal: (target, signal) => void signals.push([target, signal])
			})
		).rejects.toThrow(/reservation is in progress|refusing to discard/);
		await expect(readPass(current.patchesDir, CHANNEL, { timeoutMs: 0, probe: ownTree(current) })).resolves.toEqual({ state: 'timeout' });

		expect(spawns).toBe(0);
		expect(signals).toEqual([]);
		expect(readFileSync(path)).toEqual(before);
		expect(statSync(path).mtimeMs).toBe(beforeMtime);
	});

	it('recovers only the abandoned operation lock, never the reservation behind it', () => {
		const current = fixture('crash-lock-and-reservation');
		const reservation = { ...livingRecord(current.treeDir, 0), nonce: '16161616-1616-4161-8161-161616161616' };
		plant(current.patchesDir, reservation);
		// The crashed owner's operation lock is still on disk with a dead pid.
		const abandoned = acquireDaemonChannelLock(current.patchesDir, CHANNEL.name, 'build up transpile', { pid: 424_242 });
		const before = readFileSync(recordPath(current.patchesDir, CHANNEL.name));

		const recovered = acquireDaemonChannelLock(current.patchesDir, CHANNEL.name, 'build down transpile', { ownerAlive: () => false });
		try {
			expect(recovered.nonce).not.toBe(abandoned.nonce);
		} finally {
			recovered.release();
		}
		expect(upChannel(context(current), CHANNEL, { spawn: () => spawned(8888) })).toMatchObject({ ok: false });
		expect(readFileSync(recordPath(current.patchesDir, CHANNEL.name))).toEqual(before);
	});
});

function livingRecord(treePath: string, pid: number): DaemonRecord {
	return {
		codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
		channel: CHANNEL.name,
		script: CHANNEL.script,
		pid,
		cmdline: CHANNEL.script,
		startedAt: '2026-09-01T00:00:00.000Z',
		treeId: 'fixture-tree',
		treePath,
		nonce: '55555555-5555-4555-8555-555555555555'
	};
}

function plant(patchesDir: string, record: DaemonRecord): void {
	const path = recordPath(patchesDir, CHANNEL.name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, daemonRecordBytes(record));
}

/**
 * A process table in which `pid` leads its own group and answers with the
 * channel's own argv, so identity is proven and `down` reaches its signals.
 * The group never disappears: teardown is decided by the injected signal seam.
 */
function livingProbe(
	pid: number,
	signals: Array<readonly [number, string]>,
	teardown: 'on-first-signal' | 'survives-term' | 'survives-kill' = 'on-first-signal'
) {
	let gone = false;
	const run: ProcessRunner = (_command, args) =>
		args.includes('-p')
			? gone
				? { status: 1, stdout: '', stderr: '' }
				: { status: 0, stdout: `${CHANNEL.script}\n`, stderr: '' }
			: gone
				? { status: 0, stdout: '', stderr: '' }
				: { status: 0, stdout: `${pid} ${pid} ${CHANNEL.script}\n`, stderr: '' };
	return {
		platform: 'darwin' as const,
		run,
		termGraceMs: 0,
		signal: (target: number, signal: 'SIGTERM' | 'SIGKILL') => {
			signals.push([target, signal]);
			if (teardown === 'on-first-signal' || (signal === 'SIGKILL' && teardown !== 'survives-kill')) gone = true;
		}
	};
}

function validRecordFixture(): DaemonRecord {
	return {
		codkitBuildDaemon: 1,
		channel: CHANNEL.name,
		script: CHANNEL.script,
		pid: 0,
		cmdline: CHANNEL.script,
		startedAt: '2026-09-04T00:00:00.000Z',
		treeId: 'fixture-tree',
		treePath: '/fixture/tree',
		nonce: '55555555-5555-4555-8555-555555555555'
	};
}
