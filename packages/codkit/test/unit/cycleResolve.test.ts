/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import { commitCycleAtom } from '../../src/lib/cycleCommit.ts';
import { serializeCycleJournalEntry, type CycleJournalEntry } from '../../src/lib/cycleJournal.ts';
import {
	planCycleResolve,
	runCycleResolve,
	nodeCycleResolvePatchAdapter,
	type CycleResolveArtifact,
	type CycleResolveOptions,
	type CycleResolveRuntime
} from '../../src/lib/cycleResolve.ts';
import { cycleResolveTreeCurrent } from '../../src/lib/cycleResolveCurrent.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { deltaFingerprint, treeId } from '../../src/lib/fingerprint.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import { runSave } from '../../src/lib/saveEngine.ts';
import { readTreeCache, readTreeMark } from '../../src/lib/treeCache.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { PATCH_FILE_NAME, PATCH_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

const TAG = '1.135.0';
const CAUSE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PATCH = 'delta/patches/conflict.ckpatch';
const TARGET = 'src/conflict.ts';
const JOURNAL = `cycle/log/${TAG}.jsonl`;

type Dirt = { status: string; path: string };
type Harness = {
	options: CycleResolveOptions;
	treeDirt: Dirt[];
	patchsetDirt: Dirt[];
	proof: Set<string>;
	saves: Array<{ paths: readonly string[]; commit: boolean }>;
	written: CycleState[];
	release: () => void;
};

function state(
	blockers: Partial<Record<'conflict' | 'target-deleted' | 'rule-broken' | 'contract-failed', readonly string[]>> = {}
): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: '1.134.0', sha: '1'.repeat(40), date: '2026-08-06' },
		targetPin: { tag: TAG, sha: '2'.repeat(40), date: '2026-08-13' },
		branch: `codkit/cycle/${TAG}`,
		startedAt: '2026-08-31T18:00:00.000Z',
		updatedAt: '2026-08-31T18:00:00.000Z',
		phase: 'resolve',
		nextAction: 'resolve every blocker',
		transaction: null,
		artifacts: {
			clean: [],
			shifted: [],
			merged: [],
			conflict: [...(blockers.conflict ?? [PATCH])],
			'target-deleted': [...(blockers['target-deleted'] ?? [])],
			'target-renamed': [],
			'rule-broken': [...(blockers['rule-broken'] ?? [])],
			'contract-failed': [...(blockers['contract-failed'] ?? [])]
		},
		resolved: [],
		renames: []
	};
}

function entry(
	artifact = PATCH,
	outcome: CycleJournalEntry['outcome'] = 'conflict',
	exitCode = 0,
	ts = '2026-08-31T18:01:02.000Z'
): CycleJournalEntry {
	return {
		codkitCycleJournal: 1,
		ts,
		artifact,
		outcome,
		resolution: `resolved ${artifact}`,
		cause: { sha: CAUSE, approx: false },
		by: 'agent:test',
		verified: [{ command: 'bin/codkit verify', exitCode }]
	};
}

function patchArtifact(path = PATCH, target = TARGET): CycleResolveArtifact {
	return {
		artifactPath: path,
		artifactId: 'CK-test-001',
		kind: 'patch',
		outcome: 'conflict',
		cause: { sha: CAUSE, approx: false },
		targetPath: target,
		patchesPaths: [path]
	};
}

function harness(
	overrides: {
		state?: CycleState;
		journal?: CycleJournalEntry[];
		artifacts?: CycleResolveArtifact[];
		treeText?: string;
		treeDirt?: Dirt[];
		patchsetDirt?: Dirt[];
		proved?: string[];
	} = {}
): Harness {
	const patchesDir = makeTempRoot('cycle-resolve-patchset');
	const tree = makeTempRoot('cycle-resolve-tree');
	const current = overrides.state ?? state();
	const config: CodkitConfig = {
		codkitConfig: 2,
		pin: current.targetPin,
		upstreamAnchorCommit: current.sourcePin.sha,
		type: 'stub',
		typeConfig: { ownRoot: 'source/own' },
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	};
	const cycle = acquireLock(patchesDir, 'cycle-global', 'cycle continue');
	const treeLock = acquireLock(patchesDir, treeId(tree), 'cycle continue');
	const treeDirt = [...(overrides.treeDirt ?? [{ status: ' M', path: TARGET }])];
	const patchsetDirt = [...(overrides.patchsetDirt ?? [{ status: '??', path: JOURNAL }])];
	const proof = new Set(overrides.proved ?? []);
	const saves: Harness['saves'] = [];
	const written: CycleState[] = [];
	const treeText = overrides.treeText ?? 'resolved\n';
	const runtime: CycleResolveRuntime = {
		status(root) {
			return root === tree ? treeDirt : patchsetDirt;
		},
		head: () => HEAD,
		branch: () => current.branch,
		treeBytes: (_root, path) => (path === TARGET || path.endsWith('.ts') ? Buffer.from(treeText) : null),
		writeState(_root, next) {
			written.push(next);
			if (!patchsetDirt.some((item) => item.path === 'cycle/state.json')) patchsetDirt.push({ status: ' M', path: 'cycle/state.json' });
		},
		patch: {
			extract(save) {
				saves.push({ paths: save.paths, commit: save.commit });
				for (const override of save.patchHeaderOverrides ?? []) {
					proof.add(override.artifactPath);
					if (!patchsetDirt.some((item) => item.path === override.artifactPath))
						patchsetDirt.push({ status: ' M', path: override.artifactPath });
				}
				return {
					exitCode: 0,
					status: 'saved',
					files: [],
					own: { copied: 0, removed: 0, kept: 0, total: 0 },
					branch: '',
					branchTip: null,
					commit: null,
					consumedRef: null
				};
			},
			prove: (_options, artifact) => proof.has(artifact.artifactPath)
		},
		treeCurrent: () => true,
		recoverTree: () => {}
	};
	const output = new Output({ command: 'cycle continue', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
	return {
		options: {
			patchesDir,
			resolution: { path: tree, source: 'settings', exists: true, warning: null },
			config,
			type: stubProjectType,
			state: current,
			journal: overrides.journal ?? [entry()],
			artifacts: overrides.artifacts ?? [patchArtifact()],
			locks: { cycle, tree: treeLock },
			out: output,
			runtime
		},
		treeDirt,
		patchsetDirt,
		proof,
		saves,
		written,
		release() {
			treeLock.release();
			cycle.release();
		}
	};
}

function use<T>(current: Harness, body: (fixture: Harness) => T): T {
	try {
		return body(current);
	} finally {
		current.release();
	}
}

describe('cycle resolve production adapter', () => {
	afterAll(cleanupTempRoots);

	it('uses only the latest matching all-green journal event', () =>
		use(harness({ journal: [entry(), entry(PATCH, 'conflict', 1)] }), ({ options }) => {
			expect(planCycleResolve(options).plans[0]?.status).toBe('journal-red');
		}));

	it.each([
		[{ sha: 'c'.repeat(40), approx: false }, 'sha'],
		[{ sha: CAUSE, approx: true }, 'approx']
	] as const)('rejects a latest journal whose immutable cause differs by %s', (cause, _label) =>
		use(harness({ journal: [{ ...entry(), cause }] }), ({ options }) => {
			expect(planCycleResolve(options).plans[0]?.status).toBe('journal-cause-mismatch');
		})
	);

	it('reports missing and wrong latest journal proofs across the full blocker list', () => {
		const rule = 'delta/rules/broken.ckrule.json';
		const current = state({ conflict: [PATCH], 'rule-broken': [rule] });
		const artifacts: CycleResolveArtifact[] = [
			patchArtifact(),
			{
				artifactPath: rule,
				artifactId: 'CK-test-002',
				kind: 'rule',
				outcome: 'rule-broken',
				cause: { sha: CAUSE, approx: false },
				patchesPaths: [rule],
				patchsetSnapshots: [{ path: rule, sha256: null }]
			}
		];
		use(harness({ state: current, artifacts, journal: [entry(PATCH, 'merged')] }), ({ options }) => {
			expect(planCycleResolve(options).plans.map((plan) => plan.status)).toEqual(['journal-mismatch', 'journal-missing']);
		});
	});

	it('keeps standard conflict markers red and never calls save', () =>
		use(harness({ treeText: '<<<<<<< ours\na\n||||||| base\nb\n=======\nc\n>>>>>>> theirs\n' }), (current) => {
			expect(runCycleResolve(current.options).plans[0]?.status).toBe('markers-remain');
			expect(current.saves).toEqual([]);
		}));

	it('extracts an exact target, marks state and emits the exact Cause/Cycle commit request', () =>
		use(harness(), (current) => {
			const result = runCycleResolve(current.options);
			expect(current.saves).toEqual([{ paths: [TARGET], commit: false }]);
			expect(result.status).toBe('commit-ready');
			expect(result.state.resolved).toEqual([PATCH]);
			expect(result.commit).toMatchObject({
				expectedBranch: `codkit/cycle/${TAG}`,
				expectedParent: HEAD,
				targetTag: TAG,
				cause: CAUSE,
				timestamp: '2026-08-31T18:01:02.000Z',
				paths: [JOURNAL, 'cycle/state.json', PATCH]
			});
		}));

	it('resumes after save-before-state/commit from exact artifact and tree facts', () =>
		use(
			harness({
				treeDirt: [],
				patchsetDirt: [
					{ status: ' M', path: PATCH },
					{ status: '??', path: JOURNAL }
				],
				proved: [PATCH]
			}),
			(current) => {
				const result = runCycleResolve(current.options);
				expect(current.saves).toEqual([]);
				expect(current.written).toHaveLength(1);
				expect(result.commit?.paths).toEqual([JOURNAL, 'cycle/state.json', PATCH]);
			}
		));

	it('resumes a state-written atom without selecting journal-only dirt as another fix', () => {
		const currentState = { ...state(), resolved: [PATCH] };
		use(
			harness({
				state: currentState,
				treeDirt: [],
				patchsetDirt: [
					{ status: ' M', path: PATCH },
					{ status: ' M', path: 'cycle/state.json' }
				],
				proved: [PATCH]
			}),
			(current) => expect(runCycleResolve(current.options).commit?.paths).toEqual(['cycle/state.json', PATCH])
		);
	});

	it('requires explicit patchset changes for deleted/rule/resource/overlay-style blockers', () => {
		const deleted = 'delta/resources/files/logo.bin';
		const current = state({ conflict: [], 'target-deleted': [deleted] });
		const artifact: CycleResolveArtifact = {
			artifactPath: deleted,
			artifactId: 'CK-resource-001',
			kind: 'resource',
			outcome: 'target-deleted',
			cause: { sha: CAUSE, approx: false },
			patchesPaths: [deleted, 'delta/resources/map.json'],
			patchsetSnapshots: [
				{ path: deleted, sha256: null },
				{ path: 'delta/resources/map.json', sha256: null }
			]
		};
		use(harness({ state: current, artifacts: [artifact], journal: [entry(deleted, 'target-deleted')], treeDirt: [] }), ({ options }) => {
			expect(planCycleResolve(options).plans[0]).toMatchObject({ status: 'patchset-change-missing' });
		});
	});

	it('prepares a non-patch atom only when every explicit path changed', () => {
		const rule = 'delta/rules/broken.ckrule.json';
		const current = state({ conflict: [], 'rule-broken': [rule] });
		const artifact: CycleResolveArtifact = {
			artifactPath: rule,
			artifactId: 'CK-rule-001',
			kind: 'rule',
			outcome: 'rule-broken',
			cause: { sha: CAUSE, approx: false },
			patchesPaths: [rule],
			patchsetSnapshots: [{ path: rule, sha256: null }]
		};
		use(
			harness({
				state: current,
				artifacts: [artifact],
				journal: [entry(rule, 'rule-broken')],
				treeDirt: [],
				patchsetDirt: [
					{ status: ' M', path: rule },
					{ status: '??', path: JOURNAL }
				]
			}),
			(currentHarness) => {
				const result = runCycleResolve(currentHarness.options);
				expect(currentHarness.saves).toEqual([]);
				expect(result.commit?.cause).toBe(CAUSE);
				expect(result.commit?.paths).toEqual([JOURNAL, 'cycle/state.json', rule]);
			}
		);
	});

	it('reports all blockers instead of stopping at the first red one', () => {
		const second = 'delta/patches/second.ckpatch';
		const current = state({ conflict: [PATCH, second] });
		use(
			harness({
				state: current,
				artifacts: [patchArtifact(), patchArtifact(second, 'src/second.ts')],
				journal: [entry(), entry(second)],
				treeText: '<<<<<<< still red\n'
			}),
			({ options }) => expect(planCycleResolve(options).plans.map((plan) => plan.artifactPath)).toEqual([PATCH, second])
		);
	});

	it('makes unrelated tree or staged patchset dirt a deterministic blocker', () => {
		use(
			harness({ treeDirt: [{ status: ' M', path: 'src/unknown.ts' }], patchsetDirt: [{ status: 'M ', path: JOURNAL }] }),
			({ options }) => {
				const result = planCycleResolve(options);
				expect(result.status).toBe('blocked');
				expect(result.plans[0]?.status).toBe('unknown-dirt');
			}
		);
	});

	it('runs two real-Git conflict atoms and reconciles only after both exact patches are committed', () => {
		const fixture = makeCliFixture('cycle-resolve-real-two');
		const util = 'source/base/common/util.ts';
		const utilPatch = 'delta/patches/source__base__common__util.ts.ckpatch';
		const utilId = 'CK-base-977';
		expect(fixture.run(['load']).status).toBe(0);
		expect(
			fixture.run(['marker', 'new', util, '--id', utilId, '--type', 'hook', '--owner', 'shell-core', '--reason', 'resolve test']).status
		).toBe(0);
		writeFileSync(fixture.treePath(util), blockBody(readFileSync(fixture.treePath(util), 'utf8'), utilId, '\t// original util body'));
		expect(fixture.run(['save', '--commit']).status).toBe(0);

		const config = loadConfig(fixture.patchesDir);
		if (config === null) throw new Error('missing fixture config');
		writeFileSync(fixture.patchesPath('.git/info/exclude'), '\n.codkit/\n', { flag: 'a' });
		const branch = `${config.cycleBranchPrefix}${config.pin.tag}`;
		expect(fixture.patchGit(['switch', '--quiet', '-c', branch]).status).toBe(0);
		writeFileSync(fixture.treePath(util), blockBody(readFileSync(fixture.treePath(util), 'utf8'), utilId, '\t// resolved util body'));
		writeFileSync(
			fixture.treePath(EXAMPLE_PART_PATH),
			blockBody(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8'), PATCH_ID, '\t\t// resolved example body')
		);
		const examplePatch = `delta/patches/${PATCH_FILE_NAME}`;
		let current: CycleState = {
			...state({ conflict: [utilPatch, examplePatch] }),
			sourcePin: config.pin,
			targetPin: config.pin,
			branch
		};
		const artifacts: CycleResolveArtifact[] = [
			{
				artifactPath: utilPatch,
				artifactId: utilId,
				kind: 'patch',
				outcome: 'conflict',
				cause: { sha: config.pin.sha, approx: false },
				targetPath: util,
				patchesPaths: [utilPatch]
			},
			{
				artifactPath: examplePatch,
				artifactId: PATCH_ID,
				kind: 'patch',
				outcome: 'conflict',
				cause: { sha: config.pin.sha, approx: false },
				targetPath: EXAMPLE_PART_PATH,
				patchesPaths: [examplePatch]
			}
		];
		const journal = artifacts.map((artifact, index) => ({
			...entry(artifact.artifactPath, 'conflict', 0, `2026-08-31T18:02:0${index}.000Z`),
			cause: artifact.cause
		}));
		const journalFile = fixture.patchesPath(`cycle/log/${config.pin.tag}.jsonl`);
		mkdirSync(dirname(journalFile), { recursive: true });
		writeFileSync(journalFile, journal.map(serializeCycleJournalEntry).join(''));
		const cycle = acquireLock(fixture.patchesDir, 'cycle-global', 'cycle continue');
		const tree = acquireLock(fixture.patchesDir, treeId(fixture.treeDir), 'cycle continue');
		try {
			const base = {
				patchesDir: fixture.patchesDir,
				resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null } as const,
				config,
				type: stubProjectType,
				journal,
				artifacts,
				locks: { cycle, tree },
				out: quietOutput()
			};
			const first = runCycleResolve({ ...base, state: current });
			if (first.commit === null) throw new Error(`first commit request missing: ${JSON.stringify(first.plans)}`);
			expect(commitCycleAtom(first.commit).status).toBe('committed');
			current = first.state;
			const second = runCycleResolve({ ...base, state: current });
			if (second.commit === null) throw new Error('second commit request missing');
			expect(commitCycleAtom(second.commit).status).toBe('committed');
			current = second.state;
			const completed = runCycleResolve({ ...base, state: current });
			expect(completed.status).toBe('complete');
			expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
			const fingerprint = deltaFingerprint(fixture.patchesDir, config.pin.sha);
			expect(readTreeMark(fixture.treeDir)?.deltaFingerprint).toBe(fingerprint);
			expect(readTreeCache(fixture.patchesDir, treeId(fixture.treeDir))?.deltaFingerprint).toBe(fingerprint);
			for (const artifact of artifacts) {
				const header = readFileSync(join(fixture.patchesDir, artifact.artifactPath), 'utf8');
				expect(header).toContain(`# cause: ${config.pin.sha}`);
				expect(header).toContain(`# pin: ${config.pin.tag}@${config.pin.sha}`);
			}
		} finally {
			tree.release();
			cycle.release();
		}
	});

	it.each(['worktree-moved', 'mark-written'] as const)('recovers the real load crash window after %s', (checkpoint) => {
		const fixture = makeCliFixture(`cycle-resolve-crash-${checkpoint}`);
		expect(fixture.run(['load']).status).toBe(0);
		const config = loadConfig(fixture.patchesDir);
		if (config === null) throw new Error('missing fixture config');
		writeFileSync(fixture.patchesPath('.git/info/exclude'), '\n.codkit/\n', { flag: 'a' });
		const branch = `${config.cycleBranchPrefix}${config.pin.tag}`;
		expect(fixture.patchGit(['switch', '--quiet', '-c', branch]).status).toBe(0);
		writeFileSync(
			fixture.treePath(EXAMPLE_PART_PATH),
			blockBody(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8'), PATCH_ID, '\t\t// crash-window resolution')
		);
		const artifactPath = `delta/patches/${PATCH_FILE_NAME}`;
		const artifact: CycleResolveArtifact = {
			artifactPath,
			artifactId: PATCH_ID,
			kind: 'patch',
			outcome: 'conflict',
			cause: { sha: config.pin.sha, approx: false },
			targetPath: EXAMPLE_PART_PATH,
			patchesPaths: [artifactPath]
		};
		const current: CycleState = {
			...state({ conflict: [artifactPath] }),
			sourcePin: config.pin,
			targetPin: config.pin,
			branch
		};
		const journal = [{ ...entry(artifactPath), cause: artifact.cause }];
		const journalFile = fixture.patchesPath(`cycle/log/${config.pin.tag}.jsonl`);
		mkdirSync(dirname(journalFile), { recursive: true });
		writeFileSync(journalFile, journal.map(serializeCycleJournalEntry).join(''));
		const cycle = acquireLock(fixture.patchesDir, 'cycle-global', 'cycle continue');
		const tree = acquireLock(fixture.patchesDir, treeId(fixture.treeDir), 'cycle continue');
		try {
			const base: CycleResolveOptions = {
				patchesDir: fixture.patchesDir,
				resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null },
				config,
				type: stubProjectType,
				state: current,
				journal,
				artifacts: [artifact],
				locks: { cycle, tree },
				out: quietOutput()
			};
			let failed = false;
			const patch = {
				extract(save: Parameters<typeof runSave>[0]) {
					return runSave({
						...save,
						syncCheckpoint(at) {
							if (!failed && at === checkpoint) {
								failed = true;
								throw new Error(`crash:${at}`);
							}
						}
					});
				},
				prove: nodeCycleResolvePatchAdapter.prove
			};
			expect(() => runCycleResolve({ ...base, runtime: { patch } })).toThrow(`crash:${checkpoint}`);
			expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
			expect(cycleResolveTreeCurrent(fixture.patchesDir, base.resolution, config)).toBe(false);
			if (checkpoint === 'worktree-moved') {
				const ownPath = fixture.treePath('source/own/hello.ts');
				const ownBefore = readFileSync(ownPath);
				const humanBytes = Buffer.from(`${ownBefore.toString('utf8')}\n// ignored human work\n`);
				writeFileSync(ownPath, humanBytes);
				expect(() => runCycleResolve(base)).toThrow(/clean fork tree|DIRTY-TREE|dirt/i);
				expect(readFileSync(ownPath)).toEqual(humanBytes);
				writeFileSync(ownPath, ownBefore);
			}
			const resumed = runCycleResolve(base);
			expect(resumed.status).toBe('commit-ready');
			expect(cycleResolveTreeCurrent(fixture.patchesDir, base.resolution, config)).toBe(true);
		} finally {
			tree.release();
			cycle.release();
		}
	});
});

function blockBody(text: string, id: string, body: string): string {
	const begin = `// codkit:begin ${id}`;
	const end = `// codkit:end ${id}`;
	const beginAt = text.indexOf(begin);
	const endAt = text.indexOf(end, beginAt);
	if (beginAt < 0 || endAt < 0) throw new Error(`missing marker block ${id}`);
	const afterBegin = text.indexOf('\n', beginAt) + 1;
	return `${text.slice(0, afterBegin)}${body}\n${text.slice(endAt)}`;
}

function quietOutput(): Output {
	return new Output({ command: 'cycle continue', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
}
