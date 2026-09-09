/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CiResult } from '../../src/lib/ciEngine.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import {
	continueCycleStabilization,
	DEPENDENCY_ADVISORY_REPORT_PATH,
	STABILIZE_REPORT_PATH,
	type ContinueCycleStabilizationOptions,
	type StabilizeExecution
} from '../../src/lib/cycleStabilize.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import type { Inventory, InventoryEntry } from '../../src/lib/inventory.ts';
import { acquireLock, type LockHandle } from '../../src/lib/lock.ts';
import type { ForkDirResolution } from '../../src/lib/paths.ts';
import type { VerifyResult } from '../../src/lib/verifyEngine.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

type Fixture = {
	readonly root: string;
	readonly tree: string;
	readonly state: CycleState;
	readonly config: CodkitConfig;
	readonly resolution: ForkDirResolution;
};

const UPDATED = '2026-08-31T12:00:00.000Z';

describe('cycle dependency advisory and stabilization adapter', () => {
	afterAll(cleanupTempRoots);

	it('advances an empty advisory without a stop and returns its exact report write', async () => {
		const current = fixture(false);
		await locked(current, async (locks) => {
			const result = await continueCycleStabilization(options(current, locks));
			expect(result.exitCode).toBe(0);
			expect(result.stopCode).toBeNull();
			expect(result.nextState.phase).toBe('stabilize');
			expect(result.advisory?.changedFiles).toEqual([]);
			expect(result.acknowledgement).toBeNull();
			expect(result.writes).toHaveLength(1);
			expect(result.writes[0]?.path).toBe(DEPENDENCY_ADVISORY_REPORT_PATH);
			expect(result.writes[0]?.contents).toContain('"acceptance": "not-required"');
		});
	});

	it('stops once for a nonempty interactive advisory, accepts only the exact ack, and resumes accepted bytes', async () => {
		const current = fixture(true);
		await locked(current, async (locks) => {
			const first = await continueCycleStabilization(options(current, locks));
			expect(first.exitCode).toBe(3);
			expect(first.nextState.phase).toBe('deps-advisory');
			expect(first.acknowledgement).toMatch(/^deps-advisory-v1:/);
			const pending = first.writes[0]?.contents ?? '';
			const precomputed = await continueCycleStabilization(options(current, locks, { acknowledgement: first.acknowledgement }));
			expect(precomputed.exitCode).toBe(3);
			expect(precomputed.nextState.phase).toBe('deps-advisory');
			expect(precomputed.writes[0]?.contents).toBe(pending);

			const stale = await continueCycleStabilization(
				options(current, locks, { acknowledgement: 'stale', existingAdvisoryReport: pending })
			);
			expect(stale.exitCode).toBe(3);
			expect(stale.writes).toEqual([]);

			const accepted = await continueCycleStabilization(
				options(current, locks, { acknowledgement: first.acknowledgement, existingAdvisoryReport: pending })
			);
			expect(accepted.nextState.phase).toBe('stabilize');
			expect(accepted.writes[0]?.contents).toContain('"acceptance": "interactive"');

			const resumed = await continueCycleStabilization(
				options(current, locks, { existingAdvisoryReport: accepted.writes[0]?.contents ?? null })
			);
			expect(resumed.resumed).toBe(true);
			expect(resumed.nextState).toEqual(accepted.nextState);
		});
	});

	it('records a nonempty CI advisory and continues without an acknowledgement', async () => {
		const current = fixture(true);
		await locked(current, async (locks) => {
			const result = await continueCycleStabilization(options(current, locks, { ci: true }));
			expect(result.exitCode).toBe(0);
			expect(result.nextState.phase).toBe('stabilize');
			expect(result.writes[0]?.contents).toContain('"acceptance": "ci"');
		});
	});

	it('captures all red gates, attributes multiple failed contract ids, and moves their artifacts to contract-failed', async () => {
		const current = fixture(false, 'stabilize');
		const entries = [entry('guard.alpha', 'delta/a.json'), entry('guard.beta', 'delta/b.json')];
		const run = execution({
			entries,
			findings: [{ code: 'RULE-DRIFT', message: 'rule drift', hint: 'repair', file: 'delta/rule.json' }],
			steps: [
				{ name: 'compile', state: 'failed', detail: '2 errors' },
				{ name: 'product tests', state: 'failed', detail: 'tests red' }
			],
			log: ['FAIL guard.alpha: expected value', 'FAIL guard.beta: upstream drift'],
			errors: [{ code: 'CK-E-LOG-INCOMPLETE', message: 'full runner diagnosis' }],
			exitCode: 1
		});
		await locked(current, async (locks) => {
			const result = await continueCycleStabilization(options(current, locks, { runner: async () => run }));
			expect(result.exitCode).toBe(3);
			expect(result.nextState.phase).toBe('resolve');
			expect(result.contractFailures).toEqual([
				{ test: 'guard.alpha', artifacts: ['delta/a.json'] },
				{ test: 'guard.beta', artifacts: ['delta/b.json'] }
			]);
			expect(result.nextState.artifacts.clean).toEqual([]);
			expect(result.nextState.artifacts.shifted).toEqual([]);
			expect(result.nextState.artifacts['contract-failed']).toEqual(['delta/a.json', 'delta/b.json']);
			expect(result.nextState.sourcePin).toEqual(current.state.sourcePin);
			expect(result.nextState.targetPin).toEqual(current.state.targetPin);
			expect(result.nextState.branch).toBe(current.state.branch);
			expect(result.nextState.renames).toEqual(current.state.renames);
			expect(result.red.filter((item) => item.kind === 'contract')).toHaveLength(2);
			expect(result.red.some((item) => item.kind === 'verify')).toBe(true);
			expect(result.red.some((item) => item.kind === 'build')).toBe(true);
			expect(result.writes[0]?.path).toBe(STABILIZE_REPORT_PATH);
			expect(result.execution).toEqual(run);
		});
	});

	it('turns a missing or throwing heavy runner into an explicit red result, never a false green', async () => {
		const current = fixture(false, 'stabilize');
		await locked(current, async (locks) => {
			const missing = await continueCycleStabilization(
				options(current, locks, {
					runner: async () =>
						execution({
							steps: [{ name: 'product tests', state: 'failed', detail: 'runner missing' }],
							errors: [{ code: 'CK-E-LOG-INCOMPLETE', message: 'npm test-node is missing' }],
							cleanupErrors: [
								{ code: 'CK-E-INTERNAL', message: 'cannot stop transpile' },
								{ code: 'CK-E-INTERNAL', message: 'cannot stop typecheck' }
							],
							exitCode: 2
						})
				})
			);
			expect(missing.nextState.phase).toBe('resolve');
			expect(missing.red.some((item) => item.id === 'CK-E-LOG-INCOMPLETE')).toBe(true);
			expect(missing.red.filter((item) => item.kind === 'cleanup')).toHaveLength(2);

			const thrown = await continueCycleStabilization(
				options(current, locks, { runner: async () => Promise.reject(new Error('spawn exploded')) })
			);
			expect(thrown.nextState.phase).toBe('resolve');
			expect(thrown.red.some((item) => item.kind === 'runner')).toBe(true);
			expect(thrown.red.some((item) => item.kind === 'error')).toBe(true);
			expect(thrown.execution?.runnerFailure).toBe('spawn exploded');
		});
	});

	it('moves a fully green stabilization to done', async () => {
		const current = fixture(false, 'stabilize');
		await locked(current, async (locks) => {
			const result = await continueCycleStabilization(
				options(current, locks, { runner: async () => execution({ steps: greenSteps(), exitCode: 0 }) })
			);
			expect(result.exitCode).toBe(0);
			expect(result.nextState.phase).toBe('done');
			expect(result.red).toEqual([]);
		});
	});

	it('refuses a schema-valid exit-zero stub that did not observe every required green gate', async () => {
		const current = fixture(false, 'stabilize');
		await locked(current, async (locks) => {
			const result = await continueCycleStabilization(
				options(current, locks, { runner: async () => execution({ steps: [], exitCode: 0 }) })
			);
			expect(result.nextState.phase).toBe('resolve');
			expect(result.red.filter((item) => item.kind === 'build').map((item) => item.id)).toEqual(['verify', 'compile', 'product tests']);
		});
	});

	it('resumes a durable stabilization report after interruption without running heavy work twice', async () => {
		const current = fixture(false, 'stabilize');
		let calls = 0;
		await locked(current, async (locks) => {
			const first = await continueCycleStabilization(
				options(current, locks, {
					runner: async () => {
						calls += 1;
						return execution({ steps: greenSteps(), exitCode: 0 });
					}
				})
			);
			const durable = first.writes[0]?.contents ?? '';
			const resumed = await continueCycleStabilization(
				options(current, locks, {
					existingStabilizeReport: durable,
					runner: async () => {
						calls += 1;
						throw new Error('must not rerun');
					}
				})
			);
			expect(calls).toBe(1);
			expect(resumed.resumed).toBe(true);
			expect(resumed.writes).toEqual([]);
			expect(resumed.nextState).toEqual(first.nextState);
		});
	});

	it.each(['patchset dirt', 'patchset HEAD', 'fork HEAD'] as const)(
		'rejects a stale %s-bound report and reruns heavy work',
		async (change) => {
			const current = fixture(false, 'stabilize');
			let calls = 0;
			await locked(current, async (locks) => {
				const runner = async () => {
					calls += 1;
					return execution({ steps: greenSteps(), exitCode: 0 });
				};
				const first = await continueCycleStabilization(options(current, locks, { runner }));
				const changedRoot = change === 'fork HEAD' ? current.tree : current.root;
				write(changedRoot, 'README.md', `${change}\n`);
				if (change !== 'patchset dirt') fixtureCommit(changedRoot, `move ${change}`, '2026-08-02T00:01:00Z');
				const rerun = await continueCycleStabilization(
					options(current, locks, { existingStabilizeReport: first.writes[0]?.contents ?? null, runner })
				);
				expect(calls).toBe(2);
				expect(rerun.resumed).toBe(false);
				expect(rerun.writes[0]?.previous).toBe(first.writes[0]?.contents);
			});
		}
	);

	it('rejects a forged self-consistent hash when execution, evidence, or next state were relabelled', async () => {
		const current = fixture(false, 'stabilize');
		const run = execution({
			entries: [entry('guard.alpha', 'delta/a.json')],
			steps: [{ name: 'product tests', state: 'failed', detail: 'red' }],
			log: ['FAIL guard.alpha: drift'],
			exitCode: 1
		});
		await locked(current, async (locks) => {
			const first = await continueCycleStabilization(options(current, locks, { runner: async () => run }));
			const forged = JSON.parse(first.writes[0]?.contents ?? '') as {
				basis: { contractFailures: unknown[]; red: unknown[] };
				nextState: CycleState;
				digest: string;
				[key: string]: unknown;
			};
			forged.basis.contractFailures = [];
			forged.basis.red = [];
			forged.nextState = { ...current.state, phase: 'done', updatedAt: UPDATED, nextAction: 'finalize the completed cycle' };
			const { digest: _digest, ...body } = forged;
			forged.digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
			await expect(
				continueCycleStabilization(options(current, locks, { existingStabilizeReport: `${JSON.stringify(forged, null, 2)}\n` }))
			).rejects.toMatchObject({ code: 'CONFIG' });
		});
	});

	it('checks locks again after heavy work and exposes the concrete verify/build/contract/finally implementation', async () => {
		const current = fixture(false, 'stabilize');
		const source = readFileSync(join(import.meta.dirname, '../../src/lib/cycleStabilize.ts'), 'utf8');
		expect(source).toContain('verify = runVerify({ ...options, type: options.type })');
		expect(source).toContain('build = await runCi({');
		expect(source).toContain("profile: 'build'");
		// The anchored teardown call carries its tree binding: the probe argument is
		// part of the asserted shape, so an unbound `downChannel(patchesDir,
		// channel)` cannot satisfy the assertion. It also carries the warning
		// channel: a teardown whose lock could not retire its own generation is
		// reported, not silent.
		expect(source).toContain(
			'await downChannel(options.patchesDir, channel, {\n' +
				'\t\t\t\t\texpectedTreeId: treeId(options.resolution.path),\n' +
				'\t\t\t\t\texpectedTreePath: options.resolution.path,\n' +
				'\t\t\t\t\tonWarn: (text) => out.warn(text)\n' +
				'\t\t\t\t});'
		);

		await locked(current, async (locks) => {
			await expect(
				continueCycleStabilization(
					options(current, locks, {
						runner: async () => {
							locks.tree.release();
							return execution({ steps: greenSteps(), exitCode: 0 });
						}
					})
				)
			).rejects.toMatchObject({ code: 'LOCKED' });
		});
	});
});

function fixture(advisoryChanged: boolean, phase: CycleState['phase'] = 'deps-advisory'): Fixture {
	const tree = makeTempRoot('cycle-stabilize-tree');
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	write(tree, '.nvmrc', '20.0.0\n');
	write(tree, 'README.md', 'old\n');
	const sourceSha = fixtureCommit(tree, 'old pin', '2026-08-01T00:00:00Z');
	write(tree, 'README.md', 'new\n');
	if (advisoryChanged) write(tree, '.nvmrc', '22.0.0\n');
	const targetSha = fixtureCommit(tree, 'new pin', '2026-08-02T00:00:00Z');
	const root = makeTempRoot('cycle-stabilize-patchset');
	fixtureGit(root, ['init', '--quiet', '--initial-branch=main', '.']);
	write(root, '.gitignore', '.codkit/\ncycle/report/\n');
	write(root, 'README.md', 'patchset\n');
	fixtureCommit(root, 'patchset state', '2026-08-02T00:00:00Z');
	const targetPin = { tag: 't2', sha: targetSha, date: '2026-08-02' };
	const state: CycleState = {
		codkitCycleState: 2,
		sourcePin: { tag: 't1', sha: sourceSha, date: '2026-08-01' },
		targetPin,
		branch: 'codkit/cycle/t2',
		startedAt: '2026-08-02T00:00:00.000Z',
		updatedAt: '2026-08-02T01:00:00.000Z',
		phase,
		nextAction: 'continue',
		transaction: null,
		artifacts: {
			clean: ['delta/a.json'],
			shifted: ['delta/b.json'],
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
	const config: CodkitConfig = {
		codkitConfig: 2,
		pin: targetPin,
		upstreamAnchorCommit: sourceSha,
		type: 'vscode',
		typeConfig: { ownRoot: 'src/vs/patchset' },
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	};
	return { root, tree, state, config, resolution: { path: tree, source: 'flag', exists: true, warning: null } };
}

async function locked(current: Fixture, body: (locks: { cycle: LockHandle; tree: LockHandle }) => Promise<void>): Promise<void> {
	const cycle = acquireLock(current.root, 'cycle-global', 'test stabilize');
	const tree = acquireLock(current.root, treeId(current.tree), 'test stabilize');
	try {
		await body({ cycle, tree });
	} finally {
		tree.release();
		cycle.release();
	}
}

function options(
	current: Fixture,
	locks: { readonly cycle: LockHandle; readonly tree: LockHandle },
	overrides: Partial<ContinueCycleStabilizationOptions> = {}
): ContinueCycleStabilizationOptions {
	return {
		patchesDir: current.root,
		resolution: current.resolution,
		config: current.config,
		type: vscodeType,
		state: current.state,
		locks,
		ci: false,
		updatedAt: UPDATED,
		...overrides
	};
}

type ExecutionInput = {
	readonly entries?: readonly InventoryEntry[];
	readonly findings?: VerifyResult['findings'];
	readonly steps?: CiResult['steps'];
	readonly log?: readonly string[];
	readonly errors?: StabilizeExecution['errors'];
	readonly cleanupErrors?: StabilizeExecution['cleanupErrors'];
	readonly exitCode?: number;
};

function execution(input: ExecutionInput = {}): StabilizeExecution {
	const inventory: Inventory = {
		codkitInventory: 2,
		patchSetCommit: 'dirty',
		pin: 't2@' + '2'.repeat(40),
		entries: input.entries ?? [],
		metrics: {
			byLayer: {},
			bySubsystem: {},
			patchAndRuleCount: 0,
			hunks: 0,
			patchLineTotal: 0,
			contractCoverage: { covered: 0, requiredCovered: 0, requiredTotal: 0 }
		}
	};
	return {
		verify: {
			findings: input.findings ?? [],
			warnings: [],
			counts: {},
			inventory,
			checked: inventory.entries.length
		},
		verifyExitCode: 0,
		build: {
			exitCode: input.exitCode ?? 0,
			profile: 'build',
			steps: input.steps ?? [],
			branchTip: null,
			effectiveDiff: null
		},
		log: input.log ?? [],
		errors: input.errors ?? [],
		cleanupErrors: input.cleanupErrors ?? [],
		runnerFailure: null
	};
}

function entry(test: string, artifact: string): InventoryEntry {
	return {
		id: `CK-test-${artifact.endsWith('a.json') ? 'a' : 'b'}`,
		layer: 'config-overlay',
		type: 'modify',
		category: 'own',
		subsystem: 'test',
		files: ['product.json'],
		owner: 'test',
		reason: 'fixture',
		link: 'none',
		cause: null,
		pin: 't2@' + '2'.repeat(40),
		contractTests: [test],
		artifact
	};
}

function greenSteps(): CiResult['steps'] {
	return [
		{ name: 'verify', state: 'ok', detail: 'clean' },
		{ name: 'compile', state: 'ok', detail: 'clean' },
		{ name: 'product tests', state: 'ok', detail: 'clean' }
	];
}

function write(root: string, relative: string, contents: string): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}
