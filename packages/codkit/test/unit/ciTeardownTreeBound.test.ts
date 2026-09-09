/** @scope spec://codkit/modules/codkit/PROP-011#root */
// Adversarial evidence for the CI daemon teardown, driven as full `codkit ci`
// runs over the CLI fixture (REPAIR-010 findings 1 and 6).
//
// Daemon records live under the SHARED patch-set root by design, and one
// checkout driving two fork trees is the intended topology. The audit found the
// CI `finally` teardown calling `downChannel` unbound: a record owned by
// another tree read as `living`, took a real SIGTERM to its whole process
// group, and was deleted - while an unstoppable channel also replaced the real
// compile verdict. Both teardowns are now bound to the run's tree and sweep
// per-channel, and these runs prove it end to end:
//
//   * family 1: a foreign-tree record with a LIVE process behind it survives a
//     full green CI run unsignalled, byte- and mtime-identical, while the run
//     stops its own channels;
//   * family 6: the same poison in the teardown of a RED compile leaves the
//     verdict - exit 1, compile failed - untouched.
//
// Barriers are fixture states (planted records, a signal-tracing marker
// process), never sleeps: the stub watchers finish a pass in ~200 ms and the
// pass boundary is what `errors` waits on, as in the build/ci e2e suites.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCliFixture, provideTreeDependencies } from '../support/cliFixture.ts';
import type { CliFixture, Envelope } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const TIMEOUT = ['--timeout', '20'];
const CHANNEL_NAMES = ['transpile', 'typecheck', 'addons', 'extras'] as const;

type Step = { name: string; state: string; detail: string };

function stateOf(envelope: Envelope, name: string): string {
	const step = ((envelope.data as { steps: Step[] }).steps ?? []).find((entry) => entry.name === name);
	if (step === undefined) {
		throw new Error(`no step named ${name}`);
	}
	return step.state;
}

/** A daemon record owned by a different fork tree under this shared patch set. */
function foreignRecord(pid: number): Record<string, unknown> {
	return {
		codkitBuildDaemon: 1,
		channel: 'addons',
		script: 'watch-addons',
		pid,
		cmdline: 'watch-addons',
		startedAt: '2026-09-01T00:00:00.000Z',
		treeId: 'foreign-fork-tree',
		treePath: '/another/fork/tree',
		nonce: 'c3d4e5f6-a7b8-4c9d-8e0f-112233445566'
	};
}

function plantForeign(fixture: CliFixture, pid: number): { bytes: Buffer; mtimeMs: number } {
	const path = fixture.patchesPath('.codkit/build/addons.json');
	mkdirSync(dirname(path), { recursive: true });
	const bytes = Buffer.from(`${JSON.stringify(foreignRecord(pid), null, 2)}\n`);
	writeFileSync(path, bytes);
	return { bytes, mtimeMs: statSync(path).mtimeMs };
}

function expectForeignIntact(fixture: CliFixture, before: { bytes: Buffer; mtimeMs: number }): void {
	const path = fixture.patchesPath('.codkit/build/addons.json');
	expect(readFileSync(path)).toEqual(before.bytes);
	expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
}

/** Every stub daemon the run started is gone: the teardown stopped its own channels. */
function expectOwnChannelsStopped(fixture: CliFixture, pidLog: string): void {
	const pids = readFileSync(pidLog, 'utf8')
		.split('\n')
		.map((line) => Number.parseInt(line, 10))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
	expect(pids.length).toBeGreaterThanOrEqual(2);
	for (const pid of pids) {
		expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
	}
	for (const channel of ['transpile', 'typecheck']) {
		expect(existsSync(fixture.patchesPath(`.codkit/build/${channel}.json`))).toBe(false);
	}
}

/**
 * A live process standing in for the other tree's daemon: it leads its own
 * group, answers the recorded argv, records any signal it receives, and stays
 * alive through SIGTERM. A teardown that wrongly signals it leaves evidence;
 * one that wrongly escalates leaves it dead.
 */
function foreignDaemonMarker(): { process: ChildProcess; markerPath: string } {
	const markerPath = join(makeTempRoot('foreign-daemon-marker'), 'signals');
	const script = `
		const fs = require('node:fs');
		process.on('SIGTERM', () => { try { fs.appendFileSync(${JSON.stringify(markerPath)}, 'SIGTERM\\n'); } catch {} });
		process.on('SIGINT', () => { try { fs.appendFileSync(${JSON.stringify(markerPath)}, 'SIGINT\\n'); } catch {} });
		setInterval(() => {}, 60000);
	`;
	const marked = spawn(process.execPath, ['-e', script, 'watch-addons'], { detached: true, stdio: 'ignore' });
	expect(marked.pid).toBeGreaterThan(0);
	return { process: marked, markerPath };
}

describe('a full CI run over one tree and a foreign-tree daemon record over the same patch set', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('ci-foreign-tree');
		provideTreeDependencies(fixture);
	});

	afterAll(() => {
		fixture.run(['build', 'down', '--channel', 'all']);
		for (const channel of CHANNEL_NAMES) {
			const path = fixture.patchesPath(`.codkit/build/${channel}.json`);
			if (!existsSync(path)) continue;
			const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
			try {
				process.kill(-record.pid, 'SIGKILL');
			} catch {
				// Already gone, which is what we wanted.
			}
		}
		cleanupTempRoots();
	});

	it('leaves the foreign record unsignalled and byte-identical while stopping its own channels', () => {
		const { process: foreign, markerPath } = foreignDaemonMarker();
		const pidLog = join(makeTempRoot('ci-own-daemon-pids'), 'pids.log');
		const before = plantForeign(fixture, foreign.pid as number);
		try {
			const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], {
				STUB_MODE: 'ok',
				CODKIT_TEST_DAEMON_PID_LOG: pidLog
			});

			// The run itself is green and completed its compile.
			expect(run.status).toBe(0);
			expect(stateOf(envelope, 'compile')).toBe('ok');
			// The teardown said what it refused instead of acting on it.
			expect(run.stderr).toContain('addons');
			expect(run.stderr).toContain('another tree');

			// The foreign record: same bytes, same mtime, and zero TERM/KILL to
			// the process it names. An unbound teardown would have signalled the
			// group (marker written) and then deleted the record.
			expectForeignIntact(fixture, before);
			expect(existsSync(markerPath)).toBe(false);
			expect(() => process.kill(foreign.pid as number, 0)).not.toThrow();

			// Its own channels: records retired and every started daemon gone.
			expectOwnChannelsStopped(fixture, pidLog);
		} finally {
			try {
				process.kill(-(foreign.pid as number), 'SIGKILL');
			} catch {
				// Already gone, which is what we wanted.
			}
		}
	});

	it('does not let the poisoned teardown replace the real compile verdict', () => {
		// A foreign record again, this time without any process behind it: the
		// poison is the refusal, not the pid.
		const before = plantForeign(fixture, 424_242);
		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], { STUB_MODE: 'errors' });

		// Exit 1 is the compile verdict (PROP-007 sec. 13), not the teardown's
		// refusal (2) and not an unhandled throw: the `finally` that stops the
		// daemons may warn, never replace, the result it protects.
		//
		// This assertion was observed to return 2 exactly once, under full-suite
		// load, and has never reproduced since - not in a full suite, not in
		// repeated isolated runs, and not with the timeout driven down to 1s. An
		// exit code alone cannot say which half diverged, so the run's own
		// diagnosis travels with the failure: the next occurrence has to be
		// readable rather than re-guessed.
		expect(run.status, `stderr:\n${run.stderr}\nsteps: ${JSON.stringify((envelope.data as { steps?: unknown }).steps)}`).toBe(1);
		expect(stateOf(envelope, 'compile')).toBe('failed');
		expect(run.stderr).toContain('error TS2322');
		expect(run.stderr).toContain('addons');
		expectForeignIntact(fixture, before);
		for (const channel of ['transpile', 'typecheck']) {
			expect(existsSync(fixture.patchesPath(`.codkit/build/${channel}.json`))).toBe(false);
		}
	});
});
