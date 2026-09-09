/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadBuildWatch } from '../../src/lib/buildWrap.ts';
import { readRecordState } from '../../src/lib/buildRuntime.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import { restartCycle, startCycle } from '../../src/lib/cycleControl.ts';
import { commitCycleAtom } from '../../src/lib/cycleCommit.ts';
import { continueCycle } from '../../src/lib/cycleEngine.ts';
import { readCycleApplyRecord } from '../../src/lib/cycleEngineRecord.ts';
import { readCycleTerminalRecord } from '../../src/lib/cycleEngineTerminal.ts';
import { CYCLE_TERMINAL_RECORD_PATH } from '../../src/lib/cycleEngineTerminal.ts';
import { committedTerminalReceipt } from '../../src/lib/cycleEngineTransactions.ts';
import {
	CYCLE_TRANSITION_RECORD_PATH,
	makeCycleTransitionRecord,
	readCycleTransitionRecord,
	writeCycleTransitionRecord
} from '../../src/lib/cycleEngineTransition.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { regeneratePatch } from '../../src/lib/patchGenerate.ts';
import { encodePatchName } from '../../src/lib/patchFormat.ts';
import { CYCLE_STATE_PATH, readCycleState, serializeCycleState } from '../../src/lib/cycleState.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { STATUS_PART_PATH, STATUSBAR_PART_PATH, fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { makeCliFixture, provideTreeDependencies } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const stabilizationRunner = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../src/lib/cycleStabilize.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../src/lib/cycleStabilize.ts')>();
	const [{ buildInventory }, { runGit: runFixtureGit }] = await Promise.all([
		import('../../src/lib/inventory.ts'),
		import('../../src/lib/gitx.ts')
	]);
	return {
		...original,
		continueCycleStabilization: (
			options: Parameters<typeof original.continueCycleStabilization>[0]
		): ReturnType<typeof original.continueCycleStabilization> =>
			original.continueCycleStabilization({
				...options,
				runner:
					options.runner ??
					(async (runnerOptions) => {
						stabilizationRunner.calls += 1;
						const inventory = buildInventory(runnerOptions.patchesDir, { config: runnerOptions.config });
						const tip = runFixtureGit({
							args: ['rev-parse', '--verify', 'HEAD^{commit}'],
							cwd: runnerOptions.resolution.path
						});
						if (tip.status !== 0 || !/^[0-9a-f]{40}$/.test(tip.stdout.trim())) throw new Error('fixture fork HEAD is missing');
						return {
							verify: { findings: [], warnings: [], counts: {}, inventory, checked: inventory.entries.length },
							verifyExitCode: 0,
							build: {
								exitCode: 0,
								profile: 'build',
								steps: [
									{ name: 'verify', state: 'ok', detail: 'fixture green' },
									{ name: 'compile', state: 'ok', detail: 'fixture green' },
									{ name: 'product tests', state: 'ok', detail: 'fixture green' }
								],
								branchTip: tip.stdout.trim(),
								effectiveDiff: null
							},
							log: [],
							errors: [],
							cleanupErrors: [],
							runnerFailure: null
						};
					})
			})
	};
});

const fixtures: CliFixture[] = [];

describe('cycle engine crash transactions', () => {
	afterAll(() => {
		try {
			stopFixtureDaemons(fixtures);
		} finally {
			cleanupTempRoots();
		}
	});

	it('recovers report/state, terminal deletion, final commit and history from durable records', async () => {
		stabilizationRunner.calls = 0;
		const fixture = startFixture('cycle-engine-crash');
		const config = requiredConfig(fixture);
		const first = await run(fixture, config);
		expect(first.state?.phase).toBe('deps-advisory');

		await expect(run(fixture, config, 'transition-reports-written')).rejects.toThrow('transition-reports-written');
		expect(readCycleTransitionRecord(fixture.patchesDir)?.checkpoint).toBe('planned');
		const transitionPath = fixture.patchesPath(CYCLE_TRANSITION_RECORD_PATH);
		const originalTransition = readFileSync(transitionPath, 'utf8');
		const forgedReport = JSON.parse(originalTransition) as Record<string, unknown>;
		const reportWrites = forgedReport['writes'];
		if (!Array.isArray(reportWrites) || reportWrites[0] === null || typeof reportWrites[0] !== 'object')
			throw new Error('transition writes missing');
		reportWrites[0] = { ...reportWrites[0], contents: '{"arbitrary":true}\n' };
		rehash(forgedReport);
		writeFileSync(transitionPath, `${JSON.stringify(forgedReport, null, 2)}\n`, 'utf8');
		await expect(run(fixture, config)).rejects.toThrow(/advisory|malformed|report/);
		writeFileSync(transitionPath, originalTransition, 'utf8');
		const forgedState = JSON.parse(originalTransition) as Record<string, unknown>;
		for (const key of ['inputState', 'nextState']) {
			const endpoint = forgedState[key];
			if (!recordValue(endpoint)) throw new Error('transition endpoint missing');
			const sourcePin = endpoint['sourcePin'];
			if (!recordValue(sourcePin)) throw new Error('source pin missing');
			sourcePin['tag'] = 'forged-source-tag';
		}
		rehash(forgedState);
		writeFileSync(transitionPath, `${JSON.stringify(forgedState, null, 2)}\n`, 'utf8');
		await expect(run(fixture, config)).rejects.toThrow(/state|advisory|mismatch/);
		writeFileSync(transitionPath, originalTransition, 'utf8');
		await expect(run(fixture, config, 'transition-state-written')).rejects.toThrow('transition-state-written');
		expect(readCycleTransitionRecord(fixture.patchesDir)?.checkpoint).toBe('planned');
		await expect(run(fixture, config, 'transition-commit-installed')).rejects.toThrow('transition-commit-installed');
		expect(readCycleTransitionRecord(fixture.patchesDir)?.checkpoint).toBe('written');
		await expect(run(fixture, config, 'transition-committed')).rejects.toThrow('transition-committed');
		expect(readCycleTransitionRecord(fixture.patchesDir)?.checkpoint).toBe('committed');
		expect(fixture.patchGit(['switch', '--quiet', '-c', 'receipt-wrong-branch']).status).toBe(0);
		await expect(run(fixture, config)).rejects.toThrow(/cycle branch/);
		expect(fixture.patchGit(['switch', '--quiet', `codkit/cycle/${config.pin.tag}`]).status).toBe(0);
		const resumed = await run(fixture, config);
		expect(resumed.state?.phase).toBe('stabilize');
		expect(readCycleTransitionRecord(fixture.patchesDir)).toBeNull();

		await expect(run(fixture, config, 'transition-planned')).rejects.toThrow('transition-planned');
		const stabilizeTransition = readFileSync(transitionPath, 'utf8');
		const forgedStabilize = JSON.parse(stabilizeTransition) as Record<string, unknown>;
		const stabilizeWrites = forgedStabilize['writes'];
		if (!Array.isArray(stabilizeWrites) || !recordValue(stabilizeWrites[0])) throw new Error('stabilize write missing');
		const stabilizeDocument = JSON.parse(String(stabilizeWrites[0]['contents'])) as Record<string, unknown>;
		const basis = stabilizeDocument['basis'];
		if (!recordValue(basis)) throw new Error('stabilize basis missing');
		basis['red'] = [{ kind: 'runner', id: 'forged', detail: 'forged red', artifact: null }];
		rehash(stabilizeDocument);
		stabilizeWrites[0]['contents'] = `${JSON.stringify(stabilizeDocument, null, 2)}\n`;
		rehash(forgedStabilize);
		writeFileSync(transitionPath, `${JSON.stringify(forgedStabilize, null, 2)}\n`, 'utf8');
		await expect(run(fixture, config)).rejects.toThrow(/red evidence|next state|stabilize/);
		writeFileSync(transitionPath, stabilizeTransition, 'utf8');
		const forkTamper = fixture.treePath('after-plan-tamper.txt');
		writeFileSync(forkTamper, 'tamper\n', 'utf8');
		let liveError: unknown;
		try {
			await run(fixture, config);
		} catch (error) {
			liveError = error;
		}
		expect(isCkError(liveError) && liveError.code).toBe('ARTIFACT-BROKEN');
		if (!(liveError instanceof Error)) throw new Error('expected live evidence error');
		expect(liveError.message).toMatch(/live evidence mismatch/);
		unlinkSync(forkTamper);
		const stabilized = await run(fixture, config);
		expect(stabilized.state?.phase).toBe('done');
		expect(stabilizationRunner.calls).toBe(1);
		await expect(run(fixture, config, 'terminal-state-deleted')).rejects.toThrow('terminal-state-deleted');
		expect(readCycleTerminalRecord(fixture.patchesDir)?.checkpoint).toBe('planned');
		await expect(run(fixture, config, 'terminal-commit-installed')).rejects.toThrow('terminal-commit-installed');
		expect(readCycleTerminalRecord(fixture.patchesDir)?.checkpoint).toBe('applied');
		await expect(run(fixture, config, 'terminal-committed')).rejects.toThrow('terminal-committed');
		expect(readCycleTerminalRecord(fixture.patchesDir)?.checkpoint).toBe('committed');
		const completed = await run(fixture, config);
		expect(completed.status).toBe('completed');
		expect(completed.state).toBeNull();
		expect(readCycleTerminalRecord(fixture.patchesDir)?.commitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(fixture.patchGit(['status', '--short']).stdout).toBe('');
		const receiptPath = fixture.patchesPath(CYCLE_TERMINAL_RECORD_PATH);
		const originalReceipt = readFileSync(receiptPath, 'utf8');
		const raw = JSON.parse(originalReceipt) as Record<string, unknown>;
		raw['finalParent'] = 'f'.repeat(40);
		const { digest: _digest, ...body } = raw;
		raw['digest'] = createHash('sha256').update(JSON.stringify(body)).digest('hex');
		writeFileSync(receiptPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
		expect(() => committedTerminalReceipt(fixture.patchesDir, config)).toThrow(/final parent differs/);
		writeFileSync(receiptPath, originalReceipt, 'utf8');
		const nested = JSON.parse(originalReceipt) as Record<string, unknown>;
		const plan = nested['plan'];
		if (!recordValue(plan)) throw new Error('terminal plan missing');
		const writes = plan['writes'];
		if (!Array.isArray(writes) || !recordValue(writes[0])) throw new Error('terminal writes missing');
		writes[0] = { ...writes[0], contents: 'forged final bytes\n' };
		const { digest: _planDigest, ...planBody } = plan;
		plan['digest'] = createHash('sha256').update(JSON.stringify(planBody)).digest('hex');
		const { digest: _outerDigest, ...outerBody } = nested;
		nested['digest'] = createHash('sha256').update(JSON.stringify(outerBody)).digest('hex');
		writeFileSync(receiptPath, `${JSON.stringify(nested, null, 2)}\n`, 'utf8');
		expect(() => committedTerminalReceipt(fixture.patchesDir, config)).toThrow(/finalization plan|binding|canonical outputs/);
		writeFileSync(receiptPath, originalReceipt, 'utf8');

		writeFileSync(join(fixture.upstream.dir, 'post-terminal-t3.txt'), 't3\n', 'utf8');
		fixtureCommit(fixture.upstream.dir, 'fixture: post-terminal t3', '2026-01-03T00:00:00Z');
		fixtureGit(fixture.upstream.dir, ['tag', 't3']);
		const fetched = runGit({ args: ['fetch', '--quiet', '--tags', 'origin'], cwd: fixture.treeDir, netAllowed: true });
		if (fetched.status !== 0) throw new Error(fetched.stderr);
		startCycle({ patchesDir: fixture.patchesDir, forkDir: fixture.treeDir, config, target: 't3' });
		expect(readCycleTerminalRecord(fixture.patchesDir)?.checkpoint).toBe('committed');
		const newConfig = requiredConfig(fixture);
		const next = await run(fixture, newConfig);
		expect(next.state?.targetPin.tag).toBe('t3');
		expect(readCycleTerminalRecord(fixture.patchesDir)).toBeNull();
	}, 30_000);

	it('refuses to infer completion from missing state without a receipt', async () => {
		const fixture = trackedFixture('cycle-engine-no-receipt');
		await expect(run(fixture, requiredConfig(fixture))).rejects.toThrow(/absent without a committed terminal receipt/);
	});

	it('stops recorded fixture daemons before temporary roots are removed', () => {
		const root = makeTempRoot('cycle-engine-daemon-cleanup');
		const recordPath = join(root, '.codkit', 'build', 'transpile.json');
		mkdirSync(join(root, '.codkit', 'build'), { recursive: true });
		writeFileSync(
			recordPath,
			`${JSON.stringify(
				{
					codkitBuildDaemon: 1,
					channel: 'transpile',
					script: 'watch-client-transpile',
					pid: 4242,
					cmdline: 'watch-client-transpile',
					startedAt: '2026-09-01T00:00:00.000Z',
					treeId: 'fixture-tree',
					treePath: '/fixture/tree',
					nonce: '44444444-4444-4444-8444-444444444444'
				},
				null,
				2
			)}\n`,
			'utf8'
		);
		const commands: string[][] = [];
		const target: FixtureDaemonTarget = {
			patchesDir: root,
			run(args) {
				commands.push([...args]);
				return { status: 0, stdout: '', stderr: '' };
			}
		};
		const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
		try {
			stopFixtureDaemons([target]);
			expect(commands).toEqual([['build', 'down', '--channel', 'all']]);
			expect(kill).toHaveBeenNthCalledWith(1, -4242, 0);
			expect(kill).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL');
		} finally {
			kill.mockRestore();
		}
	});

	it('does not accept or clear a written transition whose installed commit carries altered report bytes', async () => {
		const fixture = startFixture('cycle-transition-altered-commit');
		const config = requiredConfig(fixture);
		await run(fixture, config);
		await expect(run(fixture, config, 'transition-written')).rejects.toThrow('transition-written');
		const record = readCycleTransitionRecord(fixture.patchesDir);
		if (record === null || record.checkpoint !== 'written') throw new Error('written transition missing');
		const write = record.writes[0];
		if (write === undefined) throw new Error('transition report missing');
		writeFileSync(fixture.patchesPath(write.path), `${write.contents} `, 'utf8');
		writeFileSync(fixture.patchesPath(CYCLE_STATE_PATH), serializeCycleState(record.nextState), 'utf8');
		commitCycleAtom({
			patchesDir: fixture.patchesDir,
			expectedBranch: record.nextState.branch,
			expectedParent: record.parent,
			targetTag: record.nextState.targetPin.tag,
			subject: record.subject,
			paths: [...record.writes.filter((item) => item.previous !== item.contents).map((item) => item.path), CYCLE_STATE_PATH],
			timestamp: record.timestamp
		});
		await expect(run(fixture, config)).rejects.toThrow(/checkout bytes differ/);
		expect(readCycleTransitionRecord(fixture.patchesDir)?.checkpoint).toBe('written');
	});

	it('persists the exact review stop before its acknowledgement token', async () => {
		const fixture = startFixture('cycle-review-crash-after-token', true);
		const config = requiredConfig(fixture);
		await expect(run(fixture, config, 'apply-preview-persisted')).rejects.toThrow('apply-preview-persisted');
		const stopped = readCycleState(fixture.patchesDir);
		expect(stopped?.phase).toBe('apply');
		expect(stopped?.nextAction).toBe('review detected patch renames');
		expect(readCycleApplyRecord(fixture.patchesDir)).toMatchObject({ reviewStop: 'rename-review', reviewToken: expect.any(String) });
		const resumed = await run(fixture, config);
		expect(resumed.state?.phase).toBe('deps-advisory');
	});

	it('re-stops when review state landed but the token did not', async () => {
		const fixture = startFixture('cycle-review-crash-before-token', true);
		const config = requiredConfig(fixture);
		await expect(run(fixture, config, 'apply-review-state-written')).rejects.toThrow('apply-review-state-written');
		expect(readCycleState(fixture.patchesDir)?.nextAction).toBe('review detected patch renames');
		expect(readCycleApplyRecord(fixture.patchesDir)?.reviewToken ?? null).toBeNull();
		const restopped = await run(fixture, config);
		expect(restopped.exitCode).toBe(3);
		expect(restopped.stop).toBe('rename-review');
	});

	it('reconciles a classified record whose renames state was not written', async () => {
		const fixture = startFixture('cycle-classified-endpoint');
		const config = requiredConfig(fixture);
		await expect(run(fixture, config, 'apply-classified-record-written')).rejects.toThrow('apply-classified-record-written');
		expect(readCycleApplyRecord(fixture.patchesDir)?.checkpoint).toBe('classified');
		expect(readCycleState(fixture.patchesDir)?.phase).toBe('apply');
		const resumed = await run(fixture, config);
		expect(resumed.state?.phase).toBe('deps-advisory');
	});

	it('accepts the exact classified record and renames-state endpoint after the reverse crash boundary', async () => {
		const fixture = startFixture('cycle-classified-state-endpoint');
		const config = requiredConfig(fixture);
		await expect(run(fixture, config, 'apply-classified')).rejects.toThrow('apply-classified');
		expect(readCycleApplyRecord(fixture.patchesDir)?.checkpoint).toBe('classified');
		expect(readCycleState(fixture.patchesDir)?.phase).toBe('renames');
		const resumed = await run(fixture, config);
		expect(resumed.state?.phase).toBe('deps-advisory');
	});

	it('retains exact rename paths across a crash after classification mutation', async () => {
		const fixture = startFixture('cycle-classification-applied-crash', true);
		const config = requiredConfig(fixture);
		expect((await run(fixture, config)).stop).toBe('rename-review');
		await expect(run(fixture, config, 'apply-classification-applied')).rejects.toThrow('apply-classification-applied');
		const pending = readCycleApplyRecord(fixture.patchesDir);
		expect(pending?.checkpoint).toBe('preview');
		expect(pending?.renamePaths.length).toBeGreaterThan(0);
		const resumed = await run(fixture, config);
		expect(resumed.state?.phase).toBe('deps-advisory');
		const names = fixture.patchGit(['log', '--format=', '--name-only']).stdout;
		expect(names).toContain(encodePatchName(STATUS_PART_PATH));
		expect(names).toContain(encodePatchName(STATUSBAR_PART_PATH));
	});

	it('finishes a crashed restart and clears stale transactions before a new target', async () => {
		const fixture = startFixture('cycle-engine-restart-crash');
		const config = requiredConfig(fixture);
		await run(fixture, config);
		const state = readCycleState(fixture.patchesDir);
		if (state === null) throw new Error('cycle state missing');
		writeCycleTransitionRecord(
			fixture.patchesDir,
			makeCycleTransitionRecord(advisoryRecordInput(state, fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()))
		);
		expect(() =>
			restartCycle({
				patchesDir: fixture.patchesDir,
				forkDir: fixture.treeDir,
				config,
				yes: true,
				dependencies: {
					checkpoint(name) {
						if (name === 'restart-state-removed') throw new Error(name);
					}
				}
			})
		).toThrow('restart-state-removed');

		writeFileSync(join(fixture.upstream.dir, 't3-marker.txt'), 't3\n', 'utf8');
		fixtureCommit(fixture.upstream.dir, 'fixture: t3', '2026-01-02T00:00:00Z');
		fixtureGit(fixture.upstream.dir, ['tag', 't3']);
		const fetched = runGit({ args: ['fetch', '--quiet', '--tags', 'origin'], cwd: fixture.treeDir, netAllowed: true });
		if (fetched.status !== 0) throw new Error(fetched.stderr);
		const started = fixture.json(['cycle', 'start', 't3', '--ci'], { STUB_HYGIENE_MODE: 'fail' });
		expect(started.run.status, started.run.stderr).toBe(3);
		expect(readCycleTransitionRecord(fixture.patchesDir)).toBeNull();
		expect(readCycleApplyRecord(fixture.patchesDir)?.targetPin.tag).toBe('t3');
	}, 20_000);

	it('does not write a transition through a symlinked runtime-state ancestor', () => {
		const root = makeTempRoot('cycle-transition-symlink');
		const outside = makeTempRoot('cycle-transition-outside');
		symlinkSync(outside, join(root, '.codkit'));
		const state = transactionState();
		const record = makeCycleTransitionRecord(advisoryRecordInput(state, '3'.repeat(40)));
		expect(() => writeCycleTransitionRecord(root, record)).toThrow(/unsafe record path|symbolic link/);
	});
});

function startFixture(label: string, review = false): CliFixture {
	const fixture = trackedFixture(label);
	writeFileSync(join(fixture.patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
	provideTreeDependencies(fixture);
	if (review) addReviewPatch(fixture);
	const config = requiredConfig(fixture);
	startCycle({
		patchesDir: fixture.patchesDir,
		forkDir: fixture.treeDir,
		config,
		target: fixture.upstream.t2.tag
	});
	return fixture;
}

function trackedFixture(label: string): CliFixture {
	const fixture = makeCliFixture(label);
	fixtures.push(fixture);
	return fixture;
}

type FixtureDaemonTarget = Pick<CliFixture, 'patchesDir' | 'run'>;

function stopFixtureDaemons(targets: readonly FixtureDaemonTarget[]): void {
	for (const fixture of targets) {
		const records = loadBuildWatch(fixture.patchesDir)
			.channels.map((channel) => readRecordState(fixture.patchesDir, channel.name))
			.flatMap((observed) => (observed.state === 'valid' && observed.record.pid > 0 ? [observed.record] : []));
		fixture.run(['build', 'down', '--channel', 'all']);
		for (const record of records) {
			try {
				process.kill(-record.pid, 0);
				process.kill(-record.pid, 'SIGKILL');
			} catch {
				// The process group is already gone, which is the requested state.
			}
		}
	}
}

function addReviewPatch(fixture: CliFixture): void {
	const source = fixture.git(['show', `${fixture.upstream.t1.sha}:${STATUS_PART_PATH}`]);
	if (source.status !== 0) throw new Error(source.stderr);
	const id = 'CK-workbench-905';
	const header = [
		'# codkit-patch: 2',
		`# id: ${id}`,
		'# type: hook',
		'# category: follow',
		'# owner: workbench-core',
		'# reason: review crash fixture',
		'# link: none',
		'# cause: none',
		`# pin: ${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
		'# contract-tests: none',
		''
	].join('\n');
	const generated = regeneratePatch({
		targetPath: STATUS_PART_PATH,
		pinBytes: Buffer.from(source.stdout),
		pinExists: true,
		curBytes: Buffer.from(`${source.stdout}// codkit:begin ${id}\n// review crash hook\n// codkit:end ${id}\n`),
		header,
		existingBytes: null,
		tmpDir: makeTempRoot('cycle-review-crash-patch')
	});
	if (generated.unchanged) throw new Error('review patch generation produced no bytes');
	writeFileSync(fixture.patchesPath(`delta/patches/${encodePatchName(STATUS_PART_PATH)}`), generated.bytes);
	fixtureCommit(fixture.patchesDir, 'fixture: add review crash patch', '2026-02-06T00:00:00Z');
}

function requiredConfig(fixture: CliFixture) {
	const config = loadConfig(fixture.patchesDir);
	if (config === null) throw new Error('fixture config missing');
	return config;
}

function run(fixture: CliFixture, config: ReturnType<typeof requiredConfig>, crash?: string) {
	const out = new Output({
		command: 'cycle continue',
		version: 'test',
		jsonMode: true,
		streams: { writeOut() {}, writeErr() {} }
	});
	return continueCycle({
		patchesDir: fixture.patchesDir,
		resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null },
		config,
		ci: true,
		out,
		...(crash === undefined
			? {}
			: {
					dependencies: {
						checkpoint(name: string) {
							if (name === crash) throw new Error(name);
						}
					}
				})
	});
}

function transactionState(): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: 't1', sha: '1'.repeat(40), date: '2026-08-01' },
		targetPin: { tag: 't2', sha: '2'.repeat(40), date: '2026-08-08' },
		branch: 'codkit/cycle/t2',
		startedAt: '2026-08-31T20:00:00.000Z',
		updatedAt: '2026-08-31T20:00:00.000Z',
		phase: 'deps-advisory',
		nextAction: 'inspect advisory',
		transaction: null,
		artifacts: {
			clean: [],
			shifted: [],
			merged: [],
			conflict: [],
			'target-deleted': [],
			'target-renamed': [],
			'rule-broken': [],
			'contract-failed': []
		},
		resolved: [],
		renames: []
	};
}

function advisoryRecordInput(state: CycleState, parent: string) {
	const updatedAt = new Date(Date.parse(state.updatedAt) + 1).toISOString();
	const nextState: CycleState = {
		...state,
		phase: 'stabilize',
		nextAction: 'run verify, build and contract stabilization gates',
		updatedAt
	};
	const document = {
		codkitCycleDependencyAdvisory: 1,
		state,
		report: {},
		acknowledgement: null,
		acceptance: 'not-required'
	};
	return {
		inputState: state,
		nextState,
		writes: [
			{
				path: 'cycle/report/deps-advisory.json' as const,
				previous: null,
				contents: `${JSON.stringify(document, null, 2)}\n`
			}
		],
		parent,
		subject: `chore(cycle): record dependency advisory for ${state.targetPin.tag}`,
		timestamp: new Date(Math.ceil(Date.parse(updatedAt) / 1000) * 1000).toISOString(),
		checkpoint: 'planned' as const,
		commitSha: null
	};
}

function rehash(value: Record<string, unknown>): void {
	const { digest: _digest, ...body } = value;
	value['digest'] = createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
function recordValue(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
