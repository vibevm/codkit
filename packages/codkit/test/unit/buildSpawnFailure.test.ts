/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-CHANNEL-LOCK */
// What happens to a daemon that was already spawned when a later step of `up`
// fails (PROP-010 sec. 2).
//
// The failure this pins is a leak, not a crash: `up` spawns a real watcher and
// then throws on any of several later steps - a refused write, a displaced
// generation, a throwing seam. If the reservation is retired without killing
// the child, the watcher survives with no record naming it. `status` reports
// nothing, `down` reports `not-running`, and the next `up` sees a dead record
// and starts a *second* watcher over the same tree. That is precisely the
// cross-run watcher leak the earlier repairs exist to prevent, reintroduced
// through the error path instead of the happy one.
//
// So the ordering is asserted, not just the outcome: the child dies first, the
// reservation is retired second, and a termination that itself fails is
// reported rather than swallowed under the original error.

import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { terminateSpawnedDaemon, upChannel, type ChannelConfig, type ProcessRunner, type SpawnedDaemon } from '../../src/lib/buildWrap.ts';
import { buildDir, readRecordState, recordPath } from '../../src/lib/buildRuntime.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const CHANNEL: ChannelConfig = {
	name: 'transpile',
	script: 'watch-client-transpile',
	passStart: [/^start$/],
	passEnd: [/^end$/],
	errorLine: [/^error: (.+)$/],
	errorCountLine: [],
	falseEndGuards: []
};

function fixture(label: string): { readonly patchesDir: string; readonly treeDir: string; readonly treeId: string } {
	const patchesDir = makeTempRoot(`${label}-patches`);
	const treeDir = makeTempRoot(`${label}-tree`);
	writeFileSync(join(treeDir, 'package.json'), JSON.stringify({ scripts: { 'watch-client-transpile': 'fixture' } }), 'utf8');
	return { patchesDir, treeDir, treeId: 'fixture-tree' };
}

function spawned(pid: number, onTerminate: () => void): SpawnedDaemon {
	return { pid, terminate: onTerminate };
}

describe('a daemon spawned by up never outlives the operation that started it', () => {
	it('terminates the child when an injected step after the spawn throws', () => {
		const current = fixture('spawn-fail-injected');
		const order: string[] = [];

		expect(() =>
			upChannel(current, CHANNEL, {
				spawn: () => spawned(4242, () => order.push('terminate')),
				beforeFinalize: () => {
					order.push('throw');
					throw new Error('injected failure after the spawn');
				}
			})
		).toThrow(/injected failure after the spawn/);

		expect(order).toEqual(['throw', 'terminate']);
		// Its own reservation is retired only after the child is dead, so no
		// record can name a process that is still running.
		expect(readRecordState(current.patchesDir, CHANNEL.name).state).toBe('absent');
	});

	it('terminates the child when the real record write is refused, before retiring the reservation', () => {
		const current = fixture('spawn-fail-write');
		const runtime = buildDir(current.patchesDir);
		const order: string[] = [];

		expect(() =>
			upChannel(current, CHANNEL, {
				spawn: () =>
					spawned(4243, () => {
						order.push('terminate');
						// Restoring write access here is what proves the ordering: the
						// cleanup below can only succeed because termination already
						// ran. A retirement-first implementation would fail here.
						chmodSync(runtime, 0o755);
					}),
				beforeFinalize: () => {
					order.push('refuse');
					chmodSync(runtime, 0o500);
				}
			})
		).toThrow();

		expect(order).toEqual(['refuse', 'terminate']);
		expect(readRecordState(current.patchesDir, CHANNEL.name).state).toBe('absent');
		expect(existsSync(join(runtime, `${CHANNEL.name}.json`))).toBe(false);
	});

	it('terminates exactly once, never twice, on a displaced generation', () => {
		const current = fixture('spawn-fail-once');
		let terminations = 0;

		expect(() =>
			upChannel(current, CHANNEL, {
				spawn: () => spawned(4244, () => (terminations += 1)),
				beforeFinalize: () => {
					// A foreign generation displaces the reservation: the finalize
					// comparison fails and the single termination path runs.
					writeFileSync(
						recordPath(current.patchesDir, CHANNEL.name),
						`${JSON.stringify(
							{
								codkitBuildDaemon: 1,
								channel: CHANNEL.name,
								script: CHANNEL.script,
								pid: 9191,
								cmdline: CHANNEL.script,
								startedAt: '2026-09-04T00:00:00.000Z',
								treeId: 'other-tree',
								treePath: '/other/tree',
								nonce: '33333333-3333-4333-8333-333333333333'
							},
							null,
							2
						)}\n`,
						'utf8'
					);
				}
			})
		).toThrow(/reservation was displaced/);

		expect(terminations).toBe(1);
		// The displacing generation is preserved: this operation retires only the
		// exact reservation it created.
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { pid: 9191 } });
	});

	it('reports a termination that itself fails instead of swallowing it', () => {
		const current = fixture('spawn-fail-terminate');

		let thrown: Error | null = null;
		try {
			upChannel(current, CHANNEL, {
				spawn: () =>
					spawned(4245, () => {
						throw new Error('the process group refused to die');
					}),
				beforeFinalize: () => {
					throw new Error('injected failure after the spawn');
				}
			});
		} catch (error) {
			thrown = error as Error;
		}

		// The operator needs the pid of the process nothing will clean up, and
		// the original cause that got them here; neither may be lost.
		expect(thrown?.message).toMatch(/could not be stopped/);
		expect(thrown?.message).toMatch(/injected failure after the spawn/);
		expect(thrown?.message).toMatch(/the process group refused to die/);
		// The reservation is preserved on this path: a record naming a process
		// that may still be running is better than a live watcher nothing names.
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { pid: 0 } });
	});

	it('leaves no reservation and no child behind on a clean start', () => {
		const current = fixture('spawn-clean');
		let terminations = 0;
		const result = upChannel(current, CHANNEL, { spawn: () => spawned(4246, () => (terminations += 1)) });

		expect(result).toMatchObject({ ok: true, pid: 4246 });
		expect(terminations).toBe(0);
		expect(readRecordState(current.patchesDir, CHANNEL.name)).toMatchObject({ state: 'valid', record: { pid: 4246 } });
	});
});

describe('the cleanup of a spawned daemon proves the target before it signals', () => {
	const SCRIPT = 'watch-client-transpile';

	/** A process table in which `pid` answers with `args`, or is absent. */
	function probeWith(args: readonly string[] | null, signals: Array<readonly [number, string]>) {
		const run: ProcessRunner = () =>
			args === null ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${args.join(' ')}\n`, stderr: '' };
		return {
			platform: 'darwin' as const,
			run,
			signal: (target: number, signal: 'SIGTERM' | 'SIGKILL') => void signals.push([target, signal])
		};
	}

	it('kills the group of a pid that still runs the channel script', () => {
		const signals: Array<readonly [number, string]> = [];
		terminateSpawnedDaemon(4242, SCRIPT, probeWith(['npm', 'run', SCRIPT], signals));
		expect(signals).toEqual([[-4242, 'SIGKILL']]);
	});

	it('signals nothing when the child is already gone', () => {
		const signals: Array<readonly [number, string]> = [];
		terminateSpawnedDaemon(4242, SCRIPT, probeWith(null, signals));
		expect(signals).toEqual([]);
	});

	it('refuses loudly, and signals nothing, when the pid runs something else', () => {
		// The pid was recycled onto a stranger - commonly a process-group leader,
		// since `setsid` daemons and CI jobs are exactly what fills a busy pid
		// space. Killing `-pid` here would take out that whole group.
		const signals: Array<readonly [number, string]> = [];
		expect(() => terminateSpawnedDaemon(4242, SCRIPT, probeWith(['sshd:', 'olegchir@pts/0'], signals))).toThrow(
			/pid 4242 no longer runs watch-client-transpile; refusing to signal a process group/
		);
		// Loud, and empty-handed: never a silent skip, which is how the watcher
		// leak returns, and never a kill, which is how a stranger's group dies.
		expect(signals).toEqual([]);
	});
});
