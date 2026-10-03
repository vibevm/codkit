/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-CHANNEL-LOCK */
// Two wirings audits found silent or unbounded: the operational warning of a
// lock that could not retire its own generation, and the settle arithmetic of
// a record dated ahead of this machine's clock.
//
// Every interleaving here is a barrier (`afterLock`) or an injected probe -
// never a sleep.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	CLOCK_SKEW_TOLERANCE_MS,
	DAEMON_RECORD_SCHEMA_VERSION,
	PROCESS_START_SETTLE_MS,
	downChannel,
	recordPath,
	statusOf,
	upChannel
} from '../../src/lib/buildWrap.ts';
import type { ChannelConfig, ProcessRunner, SpawnedDaemon } from '../../src/lib/buildWrap.ts';
import { daemonChannelLockPath } from '../../src/lib/daemonChannelLock.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const TREE_ID = 'lock-warn-test-tree';
const TREE_PATH = '/lock/warn/recorded/tree';
const CHANNEL: ChannelConfig = {
	name: 'transpile',
	script: 'watch-transpile',
	passStart: [/^start$/],
	passEnd: [/^end$/],
	errorLine: [/^error: (.+)$/],
	errorCountLine: [],
	falseEndGuards: []
};
/** No process may carry this pid: it is above the kernel's own ceiling. */
const ABSENT_PID = 4194305;

/** `ps` shapes: `-p` probes one recorded pid, `-eo` reads the process-group table. */
const run: ProcessRunner = (_command, args) => ({ status: 0, stdout: args.includes('-p') ? 'someone else entirely\n' : '', stderr: '' });

function fixture(label: string): { readonly patchesDir: string; readonly treeDir: string } {
	const patchesDir = makeTempRoot(`${label}-patches`);
	const treeDir = makeTempRoot(`${label}-tree`);
	writeFileSync(join(treeDir, 'package.json'), JSON.stringify({ scripts: { 'watch-transpile': 'fixture' } }), 'utf8');
	return { patchesDir, treeDir };
}

function installRecord(patchesDir: string, pending: { readonly pid: number; readonly startedAt: string }): void {
	const path = recordPath(patchesDir, 'transpile');
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
				channel: 'transpile',
				script: 'watch-transpile',
				pid: pending.pid,
				cmdline: 'watch-transpile',
				startedAt: pending.startedAt,
				treeId: TREE_ID,
				treePath: TREE_PATH,
				nonce: '11111111-1111-4111-8111-111111111111'
			},
			null,
			2
		)}\n`,
		'utf8'
	);
}

describe('an acquisition that cannot retire its own generation is not silent', () => {
	it("reports it through the up context's warning channel", () => {
		// The fixture the release-warning test builds, applied to the acquisition
		// path itself: the lock directory is removed underneath the holder at the
		// after-lock barrier, so the release can prove nothing - and the warning
		// must travel through the onWarn the context supplies, not vanish.
		const current = fixture('up-warn');
		const warnings: string[] = [];
		const spawned: SpawnedDaemon = { pid: 4242, terminate: () => undefined };
		const result = upChannel(
			{ patchesDir: current.patchesDir, treeDir: current.treeDir, treeId: 'fixture-tree', onWarn: (text) => warnings.push(text) },
			CHANNEL,
			{
				spawn: () => spawned,
				afterLock: () => {
					rmSync(dirname(daemonChannelLockPath(current.patchesDir, 'transpile')), { recursive: true, force: true });
				}
			}
		);
		expect(result.ok).toBe(true);
		expect(warnings).toEqual([expect.stringMatching(/transpile: the operation lock could not retire its own generation \(lost\)/)]);
		expect(result.ok && result.action).toBe('started');
	});

	it("reports it through the down probe's warning channel", async () => {
		const current = fixture('down-warn');
		const warnings: string[] = [];
		const result = await downChannel(current.patchesDir, 'transpile', {
			expectedTreeId: TREE_ID,
			expectedTreePath: TREE_PATH,
			platform: 'darwin',
			run,
			onWarn: (text) => warnings.push(text),
			afterLock: () => {
				rmSync(dirname(daemonChannelLockPath(current.patchesDir, 'transpile')), { recursive: true, force: true });
			}
		});
		expect(result.action).toBe('not-running');
		expect(warnings).toEqual([expect.stringMatching(/transpile: the operation lock could not retire its own generation \(lost\)/)]);
	});

	it('carries the warning channel at every production acquisition point', () => {
		// The command surfaces are not injectable, so their wiring is anchored by
		// the exact call shape in the source - the same way the stabilization
		// teardown pins its tree binding. All five acquisition points of the
		// protocol pass a sink: build up and down here, the CI start and
		// teardown and the cycle-stabilization teardown in their own files.
		const build = readFileSync(join(import.meta.dirname, '../../src/commands/build.ts'), 'utf8');
		expect(build.replace(/\s/g, '')).toContain(
			'const result = upChannel({ patchesDir: ctx.patchesDir, treeDir, treeId: id, ...(workspaceId === undefined ? {} : { workspaceId }), onWarn: (text) => ctx.out.warn(text) }, channel);'.replace(
				/\s/g,
				''
			)
		);
		expect(build.replace(/\s/g, '')).toContain(
			'const result = await downChannel(ctx.patchesDir, channel.name, { ...treeProbe(treeDir, workspaceIdOf(ctx)), onWarn: (text) => ctx.out.warn(text) });'.replace(
				/\s/g,
				''
			)
		);
		const ciEngine = readFileSync(join(import.meta.dirname, '../../src/lib/ciEngine.ts'), 'utf8');
		expect(ciEngine.replace(/\s/g, '')).toContain(
			'const result = upChannel({ patchesDir, treeDir: tree, treeId: id, ...(options.config.workspace === undefined ? {} : { workspaceId: options.config.workspace.record.id }), onWarn: (text) => out.warn(text) }, channel);'.replace(
				/\s/g,
				''
			)
		);
		expect(ciEngine).toContain('\t\t\t\t\tonWarn: (text) => out.warn(text)\n');
		const stabilize = readFileSync(join(import.meta.dirname, '../../src/lib/cycleStabilize.ts'), 'utf8');
		expect(stabilize).toContain('\t\t\t\t\tonWarn: (text) => out.warn(text)\n');
	});
});

describe('a record dated ahead of this clock', () => {
	it('is waited out inside the tolerance band instead of refused', async () => {
		// Half a second of skew is routine between two hosts sharing a patch
		// set; before the band existed it was a hard INTERNAL refusal where the
		// correct answer was to wait the window out.
		const patchesDir = makeTempRoot('skew-band-wait');
		installRecord(patchesDir, { pid: ABSENT_PID, startedAt: new Date(Date.now() + 500).toISOString() });
		const settleWaits: number[] = [];
		await expect(
			downChannel(patchesDir, 'transpile', {
				expectedTreeId: TREE_ID,
				expectedTreePath: TREE_PATH,
				platform: 'darwin',
				run,
				settleWait: (ms) => {
					settleWaits.push(ms);
					return Promise.resolve();
				}
			})
		).rejects.toThrow(/has not published the expected argv identity yet; the record is dated \d+ ms into the future/);
		// The wait was entered (window plus skew plus the boundary millisecond),
		// and no clock refusal fired - the re-probe simply still cannot prove
		// the absent pid's identity.
		expect(settleWaits).toHaveLength(1);
		expect(settleWaits[0]).toBeGreaterThan(PROCESS_START_SETTLE_MS);
		expect(settleWaits[0]).toBeLessThanOrEqual(PROCESS_START_SETTLE_MS + 500 + 1);
	});

	it('is refused, not waited out, beyond the tolerance band', async () => {
		const patchesDir = makeTempRoot('skew-band-refuse');
		installRecord(patchesDir, {
			pid: ABSENT_PID,
			startedAt: new Date(Date.now() + CLOCK_SKEW_TOLERANCE_MS + PROCESS_START_SETTLE_MS + 500).toISOString()
		});
		const settleWaits: number[] = [];
		await expect(
			downChannel(patchesDir, 'transpile', {
				expectedTreeId: TREE_ID,
				expectedTreePath: TREE_PATH,
				platform: 'darwin',
				run,
				settleWait: (ms) => {
					settleWaits.push(ms);
					return Promise.resolve();
				}
			})
		).rejects.toThrow(/dated \d+ ms into the future \(startedAt [^)]*\); refusing to hold the channel lock for a skewed clock/);
		expect(settleWaits).toEqual([]);
	});

	it('names the clock in the starting verdict, so up never reports an indefinite "not yet"', () => {
		// `up` does not wait the settle window; a future-dated record leaves it
		// refusing `starting` for the whole skew, and a verdict that sounds
		// transient while resting on a clock disagreement hides the one fact a
		// human can act on.
		const patchesDir = makeTempRoot('skew-clock-named');
		installRecord(patchesDir, { pid: ABSENT_PID, startedAt: new Date(Date.now() + 3_600_000).toISOString() });
		const probe = { expectedTreeId: TREE_ID, expectedTreePath: TREE_PATH, platform: 'darwin' as const, run };
		expect(statusOf(patchesDir, 'transpile', probe)).toMatchObject({
			state: 'starting',
			detail: expect.stringMatching(/has not published the expected argv identity yet; the record is dated \d+ ms into the future/)
		});
		// The context binds the recorded tree (path and id), so the verdict is
		// the clock's, not a tree-mismatch refusal.
		const result = upChannel({ patchesDir, treeDir: TREE_PATH, treeId: TREE_ID }, CHANNEL);
		expect(result).toMatchObject({
			ok: false,
			reason: expect.stringMatching(
				/into the future, so this machine's clock is behind the one that wrote it; the existing daemon record is retained/
			)
		});
	});
});
