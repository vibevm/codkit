/** @scope spec://codkit/modules/codkit/PROP-007#root */
// The CLI `build down` sweep, poisoned on its FIRST channel (REPAIR-010
// finding 6). `downChannel` throws on several conditions - a foreign-tree,
// invalid or `unknown` record among them - and the audit found the sweep
// aborting on the first throw: every later channel's watcher kept running and
// the JSON envelope was skipped, so the command reported nothing about the
// channels it did stop. The sweep is now per-channel with the worst exit code,
// the same shape `up` already had.
//
// The poison here is a planted foreign-tree record on `transpile` - the first
// channel of the configuration - while the two later channels run real stub
// daemons. No sleeps: the daemons are the fixture stubs, and the sweep is
// synchronous per channel.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

type Row = { channel: string; action?: string; pid?: number; detail?: string };

function rows(envelope: { data: Record<string, unknown> }): Row[] {
	return (envelope.data as unknown as { channels: Row[] }).channels;
}

describe('codkit build down: one poisoned channel does not abort the sweep', () => {
	let fixture: CliFixture;
	let pidLog: string;
	let poisonBytes: Buffer;
	let poisonMtime: number;

	beforeAll(() => {
		fixture = makeCliFixture('down-poison');
		pidLog = join(makeTempRoot('down-poison-pids'), 'pids.log');
		// Every later channel running for real, started the normal way; their
		// stubs append their pids so the sweep can be proven to have stopped them.
		// (copilot is started too so the sweep has a daemon to stop on every
		// channel it reaches - the absent-record no-op is a different question,
		// not this family's.)
		for (const channel of ['typecheck', 'addons', 'extras']) {
			expect(fixture.run(['build', 'up', '--channel', channel], { STUB_MODE: 'ok', CODKIT_TEST_DAEMON_PID_LOG: pidLog }).status).toBe(0);
		}

		// The poison: transpile is the FIRST channel of the configuration, and its
		// record belongs to another fork tree - the exact state the teardown
		// binding exists to refuse.
		const path = fixture.patchesPath('.codkit/build/transpile.json');
		mkdirSync(dirname(path), { recursive: true });
		poisonBytes = Buffer.from(
			`${JSON.stringify(
				{
					codkitBuildDaemon: 1,
					channel: 'transpile',
					script: 'watch-transpile',
					pid: 424_242,
					cmdline: 'watch-transpile',
					startedAt: '2026-09-01T00:00:00.000Z',
					treeId: 'foreign-fork-tree',
					treePath: '/another/fork/tree',
					nonce: 'd5e6f7a8-b9c0-4d1e-9f2a-223344556677'
				},
				null,
				2
			)}\n`
		);
		writeFileSync(path, poisonBytes);
		poisonMtime = statSync(path).mtimeMs;
	});

	afterAll(() => {
		fixture.run(['build', 'down', '--channel', 'all']);
		for (const channel of ['transpile', 'typecheck', 'addons', 'extras']) {
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

	it('stops and reports every channel anyway, keeps the poison, and returns the worst exit code', () => {
		const { run, envelope } = fixture.json(['build', 'down', '--channel', 'all']);

		// The refused channel makes the sweep exit 2 - the worst outcome of the
		// channels - not a crash and not silence.
		expect(run.status).toBe(2);

		// Every channel is in the envelope, in configuration order, each with the
		// verdict the sweep actually reached for it.
		expect(rows(envelope).map((row) => [row.channel, row.action])).toEqual([
			['transpile', 'refused'],
			['typecheck', 'stopped'],
			['addons', 'stopped'],
			['extras', 'stopped']
		]);
		expect(rows(envelope)[0]?.detail).toContain('another tree');

		// The poisoned record is untouched: a refusal that deleted the evidence
		// would be worse than the leak this sweep exists to prevent.
		const path = fixture.patchesPath('.codkit/build/transpile.json');
		expect(readFileSync(path)).toEqual(poisonBytes);
		expect(statSync(path).mtimeMs).toBe(poisonMtime);

		// The remaining channels were really stopped: records retired and the
		// daemons the sweep claimed to have stopped are gone.
		for (const channel of ['typecheck', 'addons', 'extras']) {
			expect(existsSync(fixture.patchesPath(`.codkit/build/${channel}.json`))).toBe(false);
		}
		for (const pid of readFileSync(pidLog, 'utf8')
			.split('\n')
			.map((line) => Number.parseInt(line, 10))
			.filter((pid) => Number.isInteger(pid) && pid > 0)) {
			expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
		}
	});
});
