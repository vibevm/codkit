// e2e: codkit build up|down|status|errors (PROP-007 sec. 13, PROP-010 sec. 2).
//
// The real CLI over the fixture tree, whose npm scripts start the stub watcher
// instead of the upstream daemons: real detached processes, real process
// groups, real log files, and passes that are printed on demand rather than
// waited for. STUB_MODE picks what the daemon prints, so nothing here sleeps
// for a compiler.
//
// Every test leaves the channels it started stopped; the afterAll hook is the
// safety net, not the mechanism.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { treeId } from '../../src/lib/fingerprint.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

let fixture: CliFixture;

/** The `--timeout` every test that expects a pass uses: generous, never 600s. */
const TIMEOUT = ['--timeout', '20'];

const CHANNEL_NAMES = ['transpile', 'typecheck', 'extensions', 'copilot'] as const;

const LIVE_GREEN_PASS = [
	'[05:56:09] Starting compilation...',
	'[05:56:22] Finished watch-client-noEmit /workspace/fork/src/tsconfig.json with 0 errors.',
	'[05:56:22] Finished compilation with 0 errors after 12110 ms'
] as const;

const LIVE_TS7027_PASS = [
	LIVE_GREEN_PASS[0],
	'[05:43:37] src/vs/patchset/test/node/patchset.resources.test.ts(80,4): error TS7027: Unreachable code detected.',
	'[05:43:37] Finished watch-client-noEmit /workspace/fork/src/tsconfig.json with 1 errors.',
	'[05:43:37] Finished compilation with 1 errors after 12353 ms'
] as const;

type ChannelRow = {
	channel: string;
	state?: string;
	action?: string;
	pid?: number;
	daemonGone?: boolean;
	errorCount?: number;
	reportedCount?: number;
	countFromSummary?: boolean;
	lines?: string[];
	errors?: { file: string; line: number | null; column: number | null; code: string | null; message: string }[];
};

type BuildData = { channels: ChannelRow[]; mine?: boolean; foreignWatchers?: { pid: number }[] };

function channels(envelope: { data: Record<string, unknown> }): ChannelRow[] {
	return (envelope.data as unknown as BuildData).channels;
}

function rowOf(envelope: { data: Record<string, unknown> }, name: string): ChannelRow {
	const row = channels(envelope).find((entry) => entry.channel === name);
	if (row === undefined) {
		throw new Error(`no row for channel ${name}`);
	}
	return row;
}

/** The daemon record codkit writes, read the way another process would. */
function record(channel: string): { pid: number; script: string; treeId: string; treePath: string } | null {
	const path = fixture.patchesPath(`.codkit/build/${channel}.json`);
	if (!existsSync(path)) {
		return null;
	}
	return JSON.parse(readFileSync(path, 'utf8')) as { pid: number; script: string; treeId: string; treePath: string };
}

beforeAll(() => {
	fixture = makeCliFixture('build');
});

afterAll(() => {
	fixture.run(['build', 'down', '--channel', 'all']);
	// Belt and braces: if a probe ever went wrong, `down` would leave the daemon
	// alone, and a stub watcher would outlive the suite that started it.
	for (const channel of CHANNEL_NAMES) {
		const left = record(channel);
		if (left === null || left.pid <= 0) {
			continue;
		}
		try {
			process.kill(-left.pid, 'SIGKILL');
		} catch {
			// Already gone, which is what we wanted.
		}
	}
	cleanupTempRoots();
});

describe('codkit build up|status', () => {
	it('starts a channel in the background and reports it living by probing the process', () => {
		const started = fixture.json(['build', 'up', '--channel', 'transpile'], { STUB_MODE: 'ok' });
		expect(started.run.status).toBe(0);
		expect(rowOf(started.envelope, 'transpile').action).toBe('started');

		const written = record('transpile');
		expect(written?.script).toBe('watch-client-transpile');
		expect(written?.treePath).toBe(fixture.treeDir);
		expect(written?.pid).toBeGreaterThan(0);

		const status = fixture.json(['build', 'status', '--channel', 'transpile']);
		expect(status.run.status).toBe(0);
		expect(rowOf(status.envelope, 'transpile')).toMatchObject({ state: 'living', pid: written?.pid });
	});

	it('does not restart a living channel: a transpile restart would empty out/', () => {
		const before = record('transpile');
		const again = fixture.json(['build', 'up', '--channel', 'transpile'], { STUB_MODE: 'ok' });

		expect(again.run.status).toBe(0);
		expect(rowOf(again.envelope, 'transpile').action).toBe('already-running');
		expect(record('transpile')?.pid).toBe(before?.pid);
		expect(again.run.stderr + again.run.stdout).toContain('not restarted');
	});

	it('reports every channel when no channel is named', () => {
		const status = fixture.json(['build', 'status']);
		expect(channels(status.envelope).map((row) => row.channel)).toEqual(['transpile', 'typecheck', 'extensions', 'copilot']);
		expect(rowOf(status.envelope, 'typecheck').state).toBe('dead');
	});

	it('refuses an unknown channel', () => {
		const outcome = fixture.json(['build', 'status', '--channel', 'nope']);
		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
	});
});

describe('codkit build errors', () => {
	it('waits for the current pass and prints it whole', () => {
		const outcome = fixture.json(['build', 'errors', '--channel', 'transpile', ...TIMEOUT]);
		const row = rowOf(outcome.envelope, 'transpile');

		expect(outcome.run.status).toBe(0);
		expect(row.lines?.[0]).toBe('Starting transpilation...');
		expect(row.lines?.[row.lines.length - 1]).toMatch(/^Finished transpilation with 0 errors after \d+ ms$/);
		expect(row.errorCount).toBe(0);
	});

	it('returns the exact timestamped green live pass instead of timing out', () => {
		expect(fixture.run(['build', 'up', '--channel', 'typecheck'], { STUB_MODE: 'live-green' }).status).toBe(0);
		try {
			const outcome = fixture.json(['build', 'errors', '--channel', 'typecheck', '--timeout', '2']);
			const row = rowOf(outcome.envelope, 'typecheck');

			expect(outcome.run.status).toBe(0);
			expect(row.lines).toEqual(LIVE_GREEN_PASS);
			expect(row.errorCount).toBe(0);
			expect(row.countFromSummary).toBe(true);
			expect(row.errors).toEqual([]);
		} finally {
			fixture.run(['build', 'down', '--channel', 'typecheck']);
		}
	});

	it('parses the exact timestamped live TS7027 diagnostic and count', () => {
		expect(fixture.run(['build', 'up', '--channel', 'typecheck'], { STUB_MODE: 'live-ts7027' }).status).toBe(0);
		try {
			const outcome = fixture.json(['build', 'errors', '--channel', 'typecheck', '--timeout', '2']);
			const row = rowOf(outcome.envelope, 'typecheck');

			expect(outcome.run.status).toBe(1);
			expect(row.lines).toEqual(LIVE_TS7027_PASS);
			expect(row.errorCount).toBe(1);
			expect(row.countFromSummary).toBe(true);
			expect(row.errors).toEqual([
				{
					file: 'src/vs/patchset/test/node/patchset.resources.test.ts',
					line: 80,
					column: 4,
					code: 'TS7027',
					message: 'Unreachable code detected.'
				}
			]);
		} finally {
			fixture.run(['build', 'down', '--channel', 'typecheck']);
		}
	});

	it('finishes the exact timestamped extensions green pass instead of timing out', () => {
		expect(fixture.run(['build', 'up', '--channel', 'extensions'], { STUB_MODE: 'live-ext-green' }).status).toBe(0);
		try {
			const outcome = fixture.json(['build', 'errors', '--channel', 'extensions', '--timeout', '2']);
			const row = rowOf(outcome.envelope, 'extensions');

			expect(outcome.run.status).toBe(0);
			expect(row.lines?.[row.lines.length - 1]).toBe('[05:55:37] Finished compilation');
			expect(row.errorCount).toBe(0);
			expect(row.countFromSummary).toBe(false);
			expect(row.errors).toEqual([]);
		} finally {
			fixture.run(['build', 'down', '--channel', 'extensions']);
		}
	});

	it('keeps every diagnostic of the timestamped red extensions pass and stays red after a zero project', () => {
		expect(fixture.run(['build', 'up', '--channel', 'extensions'], { STUB_MODE: 'live-ext-red' }).status).toBe(0);
		try {
			const outcome = fixture.json(['build', 'errors', '--channel', 'extensions', '--timeout', '2']);
			const row = rowOf(outcome.envelope, 'extensions');

			// The pass reports a red project and then a zero-reporting one; the
			// count comes from the parsed diagnostics, so it cannot turn green.
			expect(outcome.run.status).toBe(1);
			expect(row.errorCount).toBe(2);
			expect(row.countFromSummary).toBe(false);
			expect(row.errors?.map((error) => error.file)).toEqual(['src/vs/patchset/hello.ts', 'src/vs/base/common/util.ts']);
			expect(row.errors?.[0]).toMatchObject({ line: 12, column: 7, code: 'TS2322' });
		} finally {
			fixture.run(['build', 'down', '--channel', 'extensions']);
		}
	});

	it('parses the diagnostics of a pass and takes the count from the summary line', () => {
		expect(fixture.run(['build', 'up', '--channel', 'typecheck'], { STUB_MODE: 'errors' }).status).toBe(0);

		const outcome = fixture.json(['build', 'errors', '--channel', 'typecheck', ...TIMEOUT]);
		const row = rowOf(outcome.envelope, 'typecheck');

		expect(outcome.run.status).toBe(1);
		expect(row.errors?.map((error) => error.file)).toEqual(['src/vs/patchset/hello.ts', 'src/vs/base/common/util.ts']);
		expect(row.errors?.[0]).toMatchObject({ line: 12, code: 'TS2322' });
		// The counter of the end line is the 0/1 flag; the real number is the one
		// the pass states on its own line.
		expect(row.errorCount).toBe(2);
		expect(row.countFromSummary).toBe(true);
	});

	it('--mine keeps the diagnostics about own code and the inventory targets', () => {
		const outcome = fixture.json(['build', 'errors', '--channel', 'typecheck', '--mine', ...TIMEOUT]);
		const row = rowOf(outcome.envelope, 'typecheck');

		expect(outcome.run.status).toBe(1);
		expect(row.errors?.map((error) => error.file)).toEqual(['src/vs/patchset/hello.ts']);
		expect(row.reportedCount).toBe(1);
		// The pass itself is still reported whole.
		expect(row.errorCount).toBe(2);
	});

	it('exits 2 with a hint when the channel has no daemon', () => {
		const outcome = fixture.json(['build', 'errors', '--channel', 'copilot', ...TIMEOUT]);
		expect(outcome.run.status).toBe(2);
		expect(outcome.run.stderr).toContain('codkit build up --channel copilot');
	});

	it('strips the ANSI a daemon writes into its log before matching anything', () => {
		expect(fixture.run(['build', 'up', '--channel', 'copilot'], { STUB_MODE: 'ansi' }).status).toBe(0);
		try {
			const outcome = fixture.json(['build', 'errors', '--channel', 'copilot', ...TIMEOUT]);
			const row = rowOf(outcome.envelope, 'copilot');

			expect(outcome.run.status).toBe(0);
			expect(row.lines?.[0]).toBe('[watch] build started');
			expect(row.lines?.[row.lines.length - 1]).toBe('[watch] build finished');
			// The log really does carry the escapes: it is the reader that removes them.
			expect(readFileSync(fixture.patchesPath('.codkit/build/copilot.log'), 'utf8')).toContain('\u001b[32m');
		} finally {
			fixture.run(['build', 'down', '--channel', 'copilot']);
		}
	});

	it('exits 2 when the pass does not finish within the timeout', () => {
		expect(fixture.run(['build', 'up', '--channel', 'extensions'], { STUB_MODE: 'never-end' }).status).toBe(0);

		const outcome = fixture.json(['build', 'errors', '--channel', 'extensions', '--timeout', '2']);
		expect(outcome.run.status).toBe(2);
		expect(outcome.run.stderr).toContain('did not finish within 2s');

		expect(fixture.run(['build', 'down', '--channel', 'extensions']).status).toBe(0);
	});

	it('waits for the real end of a pass, not for a code-generation marker', () => {
		expect(fixture.run(['build', 'down', '--channel', 'typecheck']).status).toBe(0);
		expect(fixture.run(['build', 'up', '--channel', 'typecheck'], { STUB_MODE: 'false-end' }).status).toBe(0);

		const outcome = fixture.json(['build', 'errors', '--channel', 'typecheck', ...TIMEOUT]);
		const row = rowOf(outcome.envelope, 'typecheck');

		expect(outcome.run.status).toBe(0);
		expect(row.lines).toContain('Finished compilation api-proposal-names with 0 errors after 12 ms');
		expect(row.lines?.[row.lines.length - 1]).toMatch(/^Finished compilation with 0 errors after \d+ ms$/);
	});

	it('rotated the previous log when the channel was started again', () => {
		expect(existsSync(fixture.patchesPath('.codkit/build/typecheck.log.1'))).toBe(true);
		// One generation, and it is the log of the run before this one.
		expect(readFileSync(fixture.patchesPath('.codkit/build/typecheck.log.1'), 'utf8')).toContain('error TS2322');
		expect(existsSync(fixture.patchesPath('.codkit/build/typecheck.log.2'))).toBe(false);
	});
});

describe('codkit build down', () => {
	it('stops every channel and removes their records', () => {
		const outcome = fixture.json(['build', 'down', '--channel', 'all']);
		expect(outcome.run.status).toBe(0);
		expect(channels(outcome.envelope).map((row) => row.channel)).toEqual(['transpile', 'typecheck', 'extensions', 'copilot']);

		const status = fixture.json(['build', 'status']);
		expect(channels(status.envelope).every((row) => row.state === 'dead')).toBe(true);
		for (const channel of CHANNEL_NAMES) {
			expect(record(channel)).toBeNull();
		}
	});

	it('is a no-op on a channel that is not running', () => {
		const outcome = fixture.json(['build', 'down', '--channel', 'transpile']);
		expect(outcome.run.status).toBe(0);
		expect(rowOf(outcome.envelope, 'transpile').action).toBe('not-running');
	});

	it('leaves `build errors` with nothing to report and a hint', () => {
		const outcome = fixture.json(['build', 'errors', ...TIMEOUT]);
		expect(outcome.run.status).toBe(2);
		expect(outcome.run.stderr).toContain('codkit build up');
		expect(channels(outcome.envelope)).toEqual([]);
	});
});

describe('codkit build fail-closed runtime records', () => {
	function exerciseRecord(bytes: string, expectedState: 'starting' | 'unknown'): void {
		const path = fixture.patchesPath('.codkit/build/transpile.json');
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, bytes, 'utf8');
		writeFileSync(
			fixture.patchesPath('.codkit/build/transpile.log'),
			'Starting transpilation...\nFinished transpilation with 0 errors after 1 ms\n',
			'utf8'
		);
		try {
			const status = fixture.json(['build', 'status', '--channel', 'transpile']);
			expect(status.run.status).toBe(0);
			expect(rowOf(status.envelope, 'transpile').state).toBe(expectedState);
			expect(fixture.run(['build', 'up', '--channel', 'transpile']).status).not.toBe(0);
			expect(fixture.run(['build', 'down', '--channel', 'transpile']).status).not.toBe(0);
			const errors = fixture.json(['build', 'errors', '--channel', 'transpile', '--timeout', '1']);
			expect(errors.run.status).toBe(2);
			expect(errors.run.stderr).toContain('refusing to read or certify');
			expect(readFileSync(path, 'utf8')).toBe(bytes);
		} finally {
			rmSync(path, { force: true });
			rmSync(fixture.patchesPath('.codkit/build/transpile.log'), { force: true });
		}
	}

	it('preserves malformed runtime state across status/up/down/errors', () => {
		exerciseRecord('{"codkitBuildDaemon":', 'unknown');
	});

	it('preserves a pid-zero reservation across status/up/down/errors and ignores an old green log', () => {
		exerciseRecord(`${JSON.stringify(reservationRecord(treeId(fixture.treeDir)))}\n`, 'starting');
	});

	it('reports a reservation owned by another fork tree as unknown and touches nothing', () => {
		// Same shape, foreign owner: `status` must say so instead of adopting it,
		// and no mutating or certifying command may act on it.
		exerciseRecord(`${JSON.stringify(reservationRecord('some-other-fork-tree'))}\n`, 'unknown');
	});

	function reservationRecord(owner: string) {
		return {
			codkitBuildDaemon: 1,
			channel: 'transpile',
			script: 'watch-client-transpile',
			pid: 0,
			cmdline: 'watch-client-transpile',
			startedAt: new Date().toISOString(),
			treeId: owner,
			treePath: fixture.treeDir,
			nonce: '44444444-4444-4444-8444-444444444444'
		};
	}
});

describe('codkit build up: a watcher somebody else started', () => {
	it('refuses to start next to a foreign watch process over the same tree', () => {
		// A process whose command line carries the marker of the upstream watcher
		// and the path of this tree. It does nothing; being visible is its job.
		const foreign: ChildProcess = spawn(
			process.execPath,
			['-e', 'setInterval(() => {}, 1000)', 'build/next/index.ts', 'transpile', '--watch', fixture.treeDir],
			{ cwd: fixture.treeDir, stdio: 'ignore' }
		);
		try {
			const outcome = fixture.json(['build', 'up', '--channel', 'transpile'], { STUB_MODE: 'ok' });

			expect(outcome.run.status).toBe(1);
			expect(outcome.run.stderr).toContain('foreign watcher');
			expect((outcome.envelope.data as unknown as BuildData).foreignWatchers?.[0]?.pid).toBe(foreign.pid);
			// Nothing was started.
			expect(record('transpile')).toBeNull();
		} finally {
			foreign.kill('SIGKILL');
		}
	});

	it('starts again once the foreign watcher is gone', () => {
		const outcome = fixture.json(['build', 'up', '--channel', 'transpile'], { STUB_MODE: 'ok' });
		expect(outcome.run.status).toBe(0);
		expect(rowOf(outcome.envelope, 'transpile').action).toBe('started');

		// Without --channel, `errors` reports every channel that is running.
		const reported = fixture.json(['build', 'errors', ...TIMEOUT]);
		expect(reported.run.status).toBe(0);
		expect(channels(reported.envelope).map((row) => row.channel)).toEqual(['transpile']);

		expect(fixture.run(['build', 'down', '--channel', 'transpile']).status).toBe(0);
		expect(fixture.json(['build', 'status', '--channel', 'transpile']).envelope.data).toMatchObject({
			channels: [{ channel: 'transpile', state: 'dead' }]
		});
	});
});

describe('codkit build errors: a daemon that is gone', () => {
	/**
	 * Kill a running daemon the way anything else on the machine would - the
	 * process and the group it leads, so the compiler under it goes too - and
	 * leave the record behind, which is the state `errors` has to cope with. The
	 * wait is on codkit's own probe, because that is what decides "dead".
	 */
	async function killDaemon(channel: string): Promise<void> {
		const pid = record(channel)?.pid ?? 0;
		expect(pid).toBeGreaterThan(0);
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			// Already gone: that is the state we were asking for.
		}
		for (let attempt = 0; attempt < 20; attempt += 1) {
			if (rowOf(fixture.json(['build', 'status', '--channel', channel]).envelope, channel).state === 'dead') {
				expect(record(channel)?.pid).toBe(pid);
				return;
			}
			await new Promise((done) => setTimeout(done, 50));
		}
		throw new Error(`the ${channel} daemon is still living after SIGKILL`);
	}

	it('prints the pass its log finished and says the daemon is no longer there', async () => {
		expect(fixture.run(['build', 'up', '--channel', 'transpile'], { STUB_MODE: 'ok' }).status).toBe(0);
		// A pass has to be in the log before the daemon can be said to have left
		// one behind.
		expect(fixture.run(['build', 'errors', '--channel', 'transpile', ...TIMEOUT]).status).toBe(0);
		await killDaemon('transpile');

		const outcome = fixture.json(['build', 'errors', '--channel', 'transpile', ...TIMEOUT]);
		const row = rowOf(outcome.envelope, 'transpile');

		expect(outcome.run.status).toBe(0);
		expect(outcome.run.stderr).toContain('the daemon is gone');
		expect(outcome.run.stderr).toContain('showing the finished pass from the log');
		expect(row.state).toBe('dead');
		expect(row.daemonGone).toBe(true);
		expect(row.errorCount).toBe(0);
		expect(row.lines?.[row.lines.length - 1]).toMatch(/^Finished transpilation with 0 errors after \d+ ms$/);

		// Without --channel the channel is found the same way: it still has an
		// answer, so it is still reported.
		const every = fixture.json(['build', 'errors', ...TIMEOUT]);
		expect(every.run.status).toBe(0);
		expect(channels(every.envelope).map((entry) => entry.channel)).toEqual(['transpile']);

		expect(fixture.run(['build', 'down', '--channel', 'transpile']).status).toBe(0);
	});

	it('exits 1 when the pass it shows had errors', async () => {
		expect(fixture.run(['build', 'up', '--channel', 'typecheck'], { STUB_MODE: 'errors' }).status).toBe(0);
		expect(fixture.run(['build', 'errors', '--channel', 'typecheck', ...TIMEOUT]).status).toBe(1);
		await killDaemon('typecheck');

		const outcome = fixture.json(['build', 'errors', '--channel', 'typecheck', ...TIMEOUT]);
		const row = rowOf(outcome.envelope, 'typecheck');

		expect(outcome.run.status).toBe(1);
		expect(outcome.run.stderr).toContain('the daemon is gone');
		expect(row.daemonGone).toBe(true);
		expect(row.errorCount).toBe(2);
		expect(row.errors?.map((error) => error.file)).toEqual(['src/vs/patchset/hello.ts', 'src/vs/base/common/util.ts']);

		expect(fixture.run(['build', 'down', '--channel', 'typecheck']).status).toBe(0);
	});

	it('is still exit 2 when the daemon died before it finished a pass', async () => {
		expect(fixture.run(['build', 'up', '--channel', 'extensions'], { STUB_MODE: 'never-end' }).status).toBe(0);
		await killDaemon('extensions');

		const outcome = fixture.json(['build', 'errors', '--channel', 'extensions', ...TIMEOUT]);

		expect(outcome.run.status).toBe(2);
		expect(outcome.run.stderr).toContain('codkit build up --channel extensions');
		expect(rowOf(outcome.envelope, 'extensions')).toEqual({ channel: 'extensions', state: 'dead' });

		expect(fixture.run(['build', 'down', '--channel', 'extensions']).status).toBe(0);
	});
});
