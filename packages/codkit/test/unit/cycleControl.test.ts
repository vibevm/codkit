/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, serializeBaseConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig, PinConfig } from '../../src/lib/configFile.ts';
import { cycleStatus, restartCycle, resolveTargetPin, startCycle } from '../../src/lib/cycleControl.ts';
import type { CycleControlCheckpoint, CycleControlDependencies } from '../../src/lib/cycleControl.ts';
import { nodeCycleStateFileSystem, readCycleState, writeCycleState } from '../../src/lib/cycleState.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { acquireLock as realAcquireLock } from '../../src/lib/lock.ts';
import { CkError, ckError } from '../../src/lib/messages.ts';
import { makeUpstream, fixtureCommit, fixtureGit, pinDate } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

const NOW = new Date('2026-08-31T12:34:56.000Z');

type Fixture = {
	readonly upstream: UpstreamFixture;
	readonly patchesDir: string;
	readonly sourceHead: string;
};

function fixture(label: string): Fixture {
	const upstream = makeUpstream(makeTempRoot(`${label}-upstream`));
	const patchesDir = makeTempRoot(`${label}-patchset`);
	makePatchSet(patchesDir, upstream);
	fixtureGit(patchesDir, ['config', 'user.name', 'Cycle Fixture']);
	fixtureGit(patchesDir, ['config', 'user.email', 'cycle@example.invalid']);
	// Runtime locks are ignored by a real patchset checkout. The small patchset
	// fixture deliberately has no project .gitignore, so reproduce that fact in
	// the repository-private exclude file without adding a tracked fixture file.
	writeFileSync(join(patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
	return { upstream, patchesDir, sourceHead: fixtureGit(patchesDir, ['rev-parse', 'HEAD']).stdout.trim() };
}

function config(root: string) {
	const loaded = loadConfig(root);
	if (loaded === null) {
		throw new Error('fixture codkit.json disappeared');
	}
	return loaded;
}

function start(fixtureValue: Fixture, target = 't2') {
	return startCycle({
		patchesDir: fixtureValue.patchesDir,
		forkDir: fixtureValue.upstream.dir,
		config: config(fixtureValue.patchesDir),
		type: stubProjectType,
		target,
		dependencies: { now: () => NOW }
	});
}

function startWith(
	fixtureValue: Fixture,
	dependencies: CycleControlDependencies,
	target = 't2',
	configValue = config(fixtureValue.patchesDir)
) {
	return startCycle({
		patchesDir: fixtureValue.patchesDir,
		forkDir: fixtureValue.upstream.dir,
		config: configValue,
		type: stubProjectType,
		target,
		dependencies: { now: () => NOW, ...dependencies }
	});
}

function restartWith(fixtureValue: Fixture, dependencies: CycleControlDependencies = {}, configValue = config(fixtureValue.patchesDir)) {
	return restartCycle({
		patchesDir: fixtureValue.patchesDir,
		forkDir: fixtureValue.upstream.dir,
		config: configValue,
		type: stubProjectType,
		yes: true,
		dependencies: { now: () => NOW, ...dependencies }
	});
}

function interruptAt(checkpointToInterrupt: CycleControlCheckpoint): CycleControlDependencies {
	return {
		checkpoint(checkpoint) {
			if (checkpoint === checkpointToInterrupt) {
				throw new Error(`injected process loss after ${checkpoint}`);
			}
		}
	};
}

function mutableFacts(root: string) {
	return {
		branch: fixtureGit(root, ['branch', '--show-current']).stdout.trim(),
		branches: fixtureGit(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).stdout,
		head: fixtureGit(root, ['rev-parse', 'HEAD']).stdout.trim(),
		configBytes: readFileSync(join(root, 'codkit.json'), 'utf8'),
		state: readCycleState(root)
	};
}

function writeCommittedConfig(current: Fixture, update: (value: CodkitConfig) => CodkitConfig): CodkitConfig {
	const next = update(config(current.patchesDir));
	writeFileSync(join(current.patchesDir, 'codkit.json'), serializeBaseConfig(next), 'utf8');
	fixtureCommit(current.patchesDir, 'fixture: configure cycle test', '2026-02-01T00:00:00Z');
	return config(current.patchesDir);
}

function assertExactlyOneCompletedBump(current: Fixture): void {
	expect(fixtureGit(current.patchesDir, ['rev-list', '--count', `${current.sourceHead}..HEAD`]).stdout.trim()).toBe('1');
	expect(fixtureGit(current.patchesDir, ['show', '-s', '--format=%s', 'HEAD']).stdout.trim()).toBe('codkit cycle: bump pin to t2');
	expect(readCycleState(current.patchesDir)).toMatchObject({ phase: 'apply', transaction: null });
}

function errorOf(body: () => unknown): CkError {
	try {
		body();
	} catch (error) {
		if (error instanceof CkError) {
			return error;
		}
		throw error;
	}
	throw new Error('expected CkError');
}

describe('cycle control', () => {
	afterAll(() => {
		cleanupTempRoots();
	});

	it('starts from a portable explicit tag with one exact canonical bump and phase=apply state', () => {
		const current = fixture('cycle-start-tag');
		fixtureGit(current.upstream.dir, ['tag', 'a-alternative', current.upstream.t2.sha]);

		const result = start(current, 't2');

		expect(result).toMatchObject({
			branch: 'codkit/cycle/t2',
			sourcePin: {
				tag: current.upstream.t1.tag,
				sha: current.upstream.t1.sha,
				date: pinDate(current.upstream.t1.dateIso)
			},
			targetPin: {
				tag: 't2',
				sha: current.upstream.t2.sha,
				date: pinDate(current.upstream.t2.dateIso)
			},
			phase: 'apply',
			resumed: false
		});
		expect(fixtureGit(current.patchesDir, ['branch', '--show-current']).stdout.trim()).toBe('codkit/cycle/t2');
		expect(fixtureGit(current.patchesDir, ['show', '-s', '--format=%B', 'HEAD']).stdout.trimEnd()).toBe(
			'codkit cycle: bump pin to t2\n\nCodkit-Cycle: t2'
		);
		expect(fixtureGit(current.patchesDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout).toBe('codkit.json\n');
		expect(fixtureGit(current.patchesDir, ['rev-parse', 'HEAD^']).stdout.trim()).toBe(current.sourceHead);
		expect(config(current.patchesDir).pin).toEqual(result.targetPin);
		expect(readCycleState(current.patchesDir)).toEqual({
			codkitCycleState: 2,
			sourcePin: result.sourcePin,
			targetPin: result.targetPin,
			branch: result.branch,
			startedAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
			phase: 'apply',
			nextAction: 'run codkit cycle continue to classify and apply every artifact',
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
		});
	});

	it('uses the bytewise-first exact portable tag for a raw SHA and falls back deterministically when none exists', () => {
		const tagged = fixture('cycle-start-sha-tagged');
		fixtureGit(tagged.upstream.dir, ['tag', 'z-last', tagged.upstream.t2.sha]);
		fixtureGit(tagged.upstream.dir, ['tag', 'a-first', tagged.upstream.t2.sha]);
		expect(resolveTargetPin(tagged.upstream.dir, tagged.upstream.anchorSha, tagged.upstream.t2.sha).tag).toBe('a-first');
		expect(start(tagged, tagged.upstream.t2.sha).branch).toBe('codkit/cycle/a-first');

		const untagged = fixture('cycle-start-sha-fallback');
		writeFileSync(join(untagged.upstream.dir, 'after-t2.txt'), 'untagged target\n', 'utf8');
		const sha = fixtureCommit(untagged.upstream.dir, 'fixture: untagged target', '2026-01-02T00:00:00Z');
		const resolved = resolveTargetPin(untagged.upstream.dir, untagged.upstream.anchorSha, sha);
		expect(resolved).toEqual({ tag: `sha-${sha.slice(0, 12)}`, sha, date: '2026-01-02' });
		expect(start(untagged, sha).targetPin).toEqual(resolved);
	});

	it('refuses existing state, a dirty patchset tree, and a target absent from local fork objects', () => {
		const existing = fixture('cycle-start-existing');
		writeCycleState(existing.patchesDir, sampleState(existing));
		expect(errorOf(() => start(existing)).code).toBe('CONFIG');

		const dirty = fixture('cycle-start-dirty');
		writeFileSync(join(dirty.patchesDir, 'uncommitted.txt'), 'local work\n', 'utf8');
		expect(errorOf(() => start(dirty)).code).toBe('DIRTY-TREE');
		expect(fixtureGit(dirty.patchesDir, ['branch', '--show-current']).stdout.trim()).toBe('main');

		const unreachable = fixture('cycle-start-unreachable');
		const error = errorOf(() => start(unreachable, '3'.repeat(40)));
		expect(error.code).toBe('PIN-UNREACHABLE');
		expect(error.hint).toContain('fetch --tags');
		expect(readCycleState(unreachable.patchesDir)).toBeNull();
	});

	it('resumes an exact committed bump after interruption before state replacement', () => {
		const current = fixture('cycle-start-resume');

		expect(() =>
			startCycle({
				patchesDir: current.patchesDir,
				forkDir: current.upstream.dir,
				config: config(current.patchesDir),
				type: stubProjectType,
				target: 't2',
				dependencies: {
					now: () => NOW,
					checkpoint(checkpoint) {
						if (checkpoint === 'init-bump-committed') {
							throw new Error('injected process loss after bump commit');
						}
					}
				}
			})
		).toThrow('injected process loss');
		expect(readCycleState(current.patchesDir)).toMatchObject({ phase: 'init', transaction: { kind: 'init' } });
		const committed = fixtureGit(current.patchesDir, ['rev-parse', 'HEAD']).stdout.trim();
		expect(fixtureGit(current.patchesDir, ['rev-parse', 'HEAD^']).stdout.trim()).toBe(current.sourceHead);

		const resumed = startCycle({
			patchesDir: current.patchesDir,
			forkDir: current.upstream.dir,
			config: config(current.patchesDir),
			type: stubProjectType,
			target: 't2',
			dependencies: { now: () => NOW }
		});
		expect(resumed.resumed).toBe(true);
		expect(resumed.bumpCommit).toBe(committed);
		expect(fixtureGit(current.patchesDir, ['rev-list', '--count', `${current.sourceHead}..HEAD`]).stdout.trim()).toBe('1');
		expect(readCycleState(current.patchesDir)?.phase).toBe('apply');
	});

	it.each([
		['init-state-written', 'create codkit/cycle/t2'],
		['init-branch-created', 'write target pin t2'],
		['init-config-written', 'stage codkit.json'],
		['init-config-staged', 'retry canonical bump commit'],
		['init-bump-committed', 'finish init state and continue apply']
	] as const)('recovers the exact init transaction after %s', (checkpoint, expectedNextAction) => {
		const current = fixture(`cycle-init-${checkpoint}`);

		expect(() => startWith(current, interruptAt(checkpoint))).toThrow(`injected process loss after ${checkpoint}`);
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toMatchObject({
			status: 'active',
			transaction: 'init',
			nextAction: expectedNextAction
		});

		const resumed = startWith(current, {});
		expect(resumed.resumed).toBe(true);
		assertExactlyOneCompletedBump(current);
	});

	it('treats interruption after init completion as a retryable completed start', () => {
		const current = fixture('cycle-init-completed');

		expect(() => startWith(current, interruptAt('init-completed'))).toThrow('injected process loss after init-completed');
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toMatchObject({
			status: 'active',
			phase: 'apply',
			transaction: null,
			nextAction: 'run codkit cycle continue to classify and apply every artifact'
		});

		const resumed = startWith(current, {});
		expect(resumed.resumed).toBe(true);
		assertExactlyOneCompletedBump(current);
	});

	it('retains the staged init transaction when commit fails and retries exactly once', () => {
		const current = fixture('cycle-init-commit-failure');
		let failCommit = true;
		const localGit: NonNullable<CycleControlDependencies['localGit']> = (options) => {
			if (options.args[0] === 'commit' && failCommit) {
				failCommit = false;
				return { status: 1, stdout: '', stderr: 'injected commit failure' };
			}
			return runGit(options);
		};

		const failed = errorOf(() => startWith(current, { localGit }));
		expect(failed.code).toBe('INTERNAL');
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toMatchObject({
			transaction: 'init',
			nextAction: 'retry canonical bump commit'
		});

		expect(startWith(current, { localGit }).resumed).toBe(true);
		assertExactlyOneCompletedBump(current);
	});

	it.each(['noncurrent', 'current'] as const)('refuses a pre-existing %s reserved branch without mutation', (placement) => {
		const current = fixture(`cycle-existing-branch-${placement}`);
		fixtureGit(current.patchesDir, ['branch', 'codkit/cycle/t2']);
		if (placement === 'current') {
			fixtureGit(current.patchesDir, ['switch', 'codkit/cycle/t2']);
		}
		const before = mutableFacts(current.patchesDir);

		const error = errorOf(() => start(current));

		expect(error.code).toBe('CONFIG');
		expect(error.message).toContain('reserved cycle branch');
		expect(mutableFacts(current.patchesDir)).toEqual(before);
	});

	it('uses a custom cycle branch prefix consistently and rejects a mismatched prefix', () => {
		const current = fixture('cycle-custom-prefix');
		const custom = writeCommittedConfig(current, (value) => ({ ...value, cycleBranchPrefix: 'upgrade/run/' }));
		const customBase = fixtureGit(current.patchesDir, ['rev-parse', 'HEAD']).stdout.trim();

		const started = startWith(current, {}, 't2', custom);
		expect(started.branch).toBe('upgrade/run/t2');
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toMatchObject({ branch: 'upgrade/run/t2' });

		const beforeMismatch = mutableFacts(current.patchesDir);
		const mismatched = { ...config(current.patchesDir), cycleBranchPrefix: 'other/run/' };
		expect(errorOf(() => cycleStatus(current.patchesDir, mismatched)).message).toContain('does not match configured branch');
		expect(errorOf(() => restartWith(current, {}, mismatched)).message).toContain('does not match configured branch');
		expect(mutableFacts(current.patchesDir)).toEqual(beforeMismatch);

		expect(restartWith(current)).toEqual({ branch: 'upgrade/run/t2', removedState: true, resetTo: customBase });
	});

	it.each(['missing', 'non-ancestor', 'downgrade'] as const)('rejects a %s source pin before mutation', (kind) => {
		const current = fixture(`cycle-source-${kind}`);
		let sourcePin: PinConfig;
		let target = 't2';
		if (kind === 'missing') {
			sourcePin = { tag: 'missing', sha: '3'.repeat(40), date: '2026-01-01' };
		} else if (kind === 'non-ancestor') {
			fixtureGit(current.upstream.dir, ['config', 'user.name', 'Cycle Fixture']);
			fixtureGit(current.upstream.dir, ['config', 'user.email', 'cycle@example.invalid']);
			const tree = fixtureGit(current.upstream.dir, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
			const sha = fixtureGit(current.upstream.dir, ['commit-tree', tree, '-m', 'independent source']).stdout.trim();
			sourcePin = { tag: 'independent', sha, date: '2026-01-01' };
		} else {
			sourcePin = { tag: current.upstream.t2.tag, sha: current.upstream.t2.sha, date: pinDate(current.upstream.t2.dateIso) };
			target = 't1';
		}
		const sourceConfig = writeCommittedConfig(current, (value) => ({ ...value, pin: sourcePin }));
		const before = mutableFacts(current.patchesDir);

		const error = errorOf(() => startWith(current, {}, target, sourceConfig));

		expect(['PIN-UNREACHABLE', 'CONFIG']).toContain(error.code);
		expect(mutableFacts(current.patchesDir)).toEqual(before);
	});

	it('reports absent state or all outcome counts and the persisted next action without writing', () => {
		const current = fixture('cycle-status');
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toEqual({
			status: 'absent',
			nextAction: 'run codkit cycle start <tag-or-sha>'
		});
		start(current);
		const state = readCycleState(current.patchesDir);
		if (state === null) {
			throw new Error('start did not write state');
		}
		writeCycleState(current.patchesDir, {
			...state,
			phase: 'resolve',
			nextAction: 'resolve the complete red list',
			artifacts: {
				...state.artifacts,
				clean: ['delta/patches/clean.ckpatch'],
				conflict: ['delta/patches/conflict.ckpatch'],
				'target-deleted': ['delta/patches/deleted.ckpatch']
			},
			resolved: ['delta/patches/conflict.ckpatch']
		});

		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toEqual({
			status: 'active',
			branch: 'codkit/cycle/t2',
			targetPin: state.targetPin,
			phase: 'resolve',
			transaction: null,
			counts: {
				clean: 1,
				shifted: 0,
				merged: 0,
				conflict: 1,
				'target-deleted': 1,
				'target-renamed': 0,
				'rule-broken': 0,
				'contract-failed': 0
			},
			resolved: 1,
			nextAction: 'resolve the complete red list'
		});
	});

	it('requires --yes and the matching current branch, then resets to the bump parent and removes state', () => {
		const current = fixture('cycle-restart');
		const started = start(current);
		const bump = fixtureGit(current.patchesDir, ['rev-parse', 'HEAD']).stdout.trim();

		const withoutYes = errorOf(() =>
			restartCycle({
				patchesDir: current.patchesDir,
				forkDir: current.upstream.dir,
				config: config(current.patchesDir),
				type: stubProjectType,
				yes: false
			})
		);
		expect(withoutYes.code).toBe('CONFIG');
		expect(fixtureGit(current.patchesDir, ['rev-parse', 'HEAD']).stdout.trim()).toBe(bump);
		expect(readCycleState(current.patchesDir)).not.toBeNull();

		fixtureGit(current.patchesDir, ['switch', 'main']);
		const wrongBranch = errorOf(() =>
			restartCycle({
				patchesDir: current.patchesDir,
				forkDir: current.upstream.dir,
				config: config(current.patchesDir),
				type: stubProjectType,
				yes: true
			})
		);
		expect(wrongBranch.code).toBe('CONFIG');
		expect(wrongBranch.message).toContain('current branch is main');
		expect(readCycleState(current.patchesDir)).not.toBeNull();

		fixtureGit(current.patchesDir, ['switch', started.branch]);
		const discardedPath = join(current.patchesDir, 'delta', 'owners.json');
		appendFileSync(discardedPath, 'discard me\n', 'utf8');
		const result = restartCycle({
			patchesDir: current.patchesDir,
			forkDir: current.upstream.dir,
			config: config(current.patchesDir),
			type: stubProjectType,
			yes: true
		});
		expect(result).toEqual({ branch: started.branch, removedState: true, resetTo: current.sourceHead });
		expect(fixtureGit(current.patchesDir, ['rev-parse', 'HEAD']).stdout.trim()).toBe(current.sourceHead);
		expect(config(current.patchesDir).pin).toEqual(started.sourcePin);
		expect(readCycleState(current.patchesDir)).toBeNull();
		expect(readFileSync(discardedPath, 'utf8')).not.toContain('discard me');
	});

	it.each([
		['restart-state-written', `run codkit cycle restart --yes to reset to BASE`],
		['restart-reset', 'remove cycle/state.json to finish restart']
	] as const)('recovers restart after %s', (checkpoint, expectedNextActionTemplate) => {
		const current = fixture(`cycle-${checkpoint}`);
		start(current);

		expect(() => restartWith(current, interruptAt(checkpoint))).toThrow(`injected process loss after ${checkpoint}`);
		const expectedNextAction = expectedNextActionTemplate.replace('BASE', current.sourceHead);
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toMatchObject({
			transaction: 'restart',
			nextAction: expectedNextAction
		});

		expect(restartWith(current)).toEqual({ branch: 'codkit/cycle/t2', removedState: true, resetTo: current.sourceHead });
		expect(readCycleState(current.patchesDir)).toBeNull();
		expect(fixtureGit(current.patchesDir, ['rev-parse', 'HEAD']).stdout.trim()).toBe(current.sourceHead);
	});

	it('retains restart state when removal fails after reset and retries cleanup', () => {
		const current = fixture('cycle-restart-remove-failure');
		start(current);
		let failRemove = true;
		const stateFileSystem = {
			...nodeCycleStateFileSystem,
			remove(path: string) {
				if (failRemove) {
					failRemove = false;
					throw new Error('injected state removal failure');
				}
				nodeCycleStateFileSystem.remove(path);
			}
		};

		const failed = errorOf(() => restartWith(current, { stateFileSystem }));
		expect(failed.code).toBe('CONFIG');
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toMatchObject({
			transaction: 'restart',
			nextAction: 'remove cycle/state.json to finish restart'
		});

		expect(restartWith(current, { stateFileSystem })).toEqual({
			branch: 'codkit/cycle/t2',
			removedState: true,
			resetTo: current.sourceHead
		});
		expect(readCycleState(current.patchesDir)).toBeNull();
	});

	it('recovers restart after reset deletes a committed state file', () => {
		const current = fixture('cycle-restart-committed-state');
		start(current);
		fixtureGit(current.patchesDir, ['add', 'cycle/state.json']);
		fixtureGit(current.patchesDir, ['commit', '--quiet', '--message', 'fixture: commit active cycle state']);

		expect(() => restartWith(current, interruptAt('restart-reset'))).toThrow('injected process loss after restart-reset');
		expect(readCycleState(current.patchesDir)).toBeNull();
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toMatchObject({
			status: 'active',
			transaction: 'restart',
			nextAction: 'remove cycle/state.json to finish restart'
		});

		const completed = restartWith(current);
		expect(completed).toEqual({ branch: 'codkit/cycle/t2', removedState: true, resetTo: current.sourceHead });
		expect(restartWith(current)).toEqual(completed);
		expect(cycleStatus(current.patchesDir, config(current.patchesDir))).toEqual({
			status: 'absent',
			nextAction: 'restart completed; run codkit cycle start <tag-or-sha>'
		});

		const startedAgain = start(current);
		expect(startedAgain).toMatchObject({ branch: 'codkit/cycle/t2', phase: 'apply', resumed: false });
		expect(readCycleState(current.patchesDir)).toMatchObject({ phase: 'apply', transaction: null });
	});

	it('acquires global then tree lock and releases them in reverse order', () => {
		const current = fixture('cycle-lock-order');
		const events: string[] = [];
		// Real handles: the config pin write requires the live cycle-global
		// capability, and a structurally identical stand-in is not one. Only the
		// release order is observed here.
		const acquireLock: NonNullable<CycleControlDependencies['acquireLock']> = (root, id, command) => {
			events.push(`acquire:${id}`);
			const handle = realAcquireLock(root, id, command);
			const release = handle.release;
			handle.release = () => {
				events.push(`release:${id}`);
				release();
			};
			return handle;
		};

		startWith(current, { acquireLock });

		expect(events).toHaveLength(4);
		expect(events[0]).toBe('acquire:cycle-global');
		expect(events[1]).toMatch(/^acquire:(?!cycle-global$).+/);
		expect(events[2]).toBe(events[1]?.replace('acquire:', 'release:'));
		expect(events[3]).toBe('release:cycle-global');
	});

	it('releases the global lock and aborts before mutation when the tree lock collides', () => {
		const current = fixture('cycle-lock-collision');
		const before = mutableFacts(current.patchesDir);
		const events: string[] = [];
		const acquireLock: NonNullable<CycleControlDependencies['acquireLock']> = (_root, id, command) => {
			events.push(`acquire:${id}`);
			if (id !== 'cycle-global') {
				throw ckError('LOCKED', 'injected tree-lock collision', 'retry later');
			}
			return {
				path: `fake:${id}`,
				info: { pid: 1, startedAt: NOW.toISOString(), command },
				release() {
					events.push(`release:${id}`);
				}
			};
		};

		expect(errorOf(() => startWith(current, { acquireLock })).code).toBe('LOCKED');
		expect(events[0]).toBe('acquire:cycle-global');
		expect(events[1]).toMatch(/^acquire:(?!cycle-global$).+/);
		expect(events[2]).toBe('release:cycle-global');
		expect(mutableFacts(current.patchesDir)).toEqual(before);
	});
});

function sampleState(current: Fixture): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: config(current.patchesDir).pin,
		targetPin: {
			tag: current.upstream.t2.tag,
			sha: current.upstream.t2.sha,
			date: pinDate(current.upstream.t2.dateIso)
		},
		branch: `codkit/cycle/${current.upstream.t2.tag}`,
		startedAt: NOW.toISOString(),
		updatedAt: NOW.toISOString(),
		phase: 'apply',
		nextAction: 'continue fixture cycle',
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
