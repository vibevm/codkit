/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Durable init/status/restart transaction orchestration. Every externally
// visible mutation is preceded by canonical state, and every retry reconciles
// exact Git/config facts before advancing one idempotent step.

import { randomUUID } from 'node:crypto';
import type { CodkitConfig, ConfigFileSystem, PinConfig } from './configFile.ts';
import { CONFIG_FILE_NAME, writeConfigPin } from './configFile.ts';
import { readCycleControlRecord, removeCycleControlRecord, writeCycleControlRecord } from './cycleControlRecord.ts';
import type { CycleControlRecord } from './cycleControlRecord.ts';
import {
	assertOnlyCycleStatus,
	assertSourceToTargetAncestry,
	assertValidBranch,
	assertPatchSetRepositoryClean,
	branchTip,
	bumpSubject,
	bumpTrailer,
	configAt,
	currentBranchName,
	findCycleBump,
	headCommit,
	mustGit,
	readPatchSetStatus,
	recognizeBump,
	resolveTargetPin,
	samePin
} from './cycleControlGit.ts';
import type { CycleGitRunner, RecognizedBump } from './cycleControlGit.ts';
import { assertCurrentCycleBranch, completedRestartResult, restartAction, resumeRestart } from './cycleRestart.ts';
import type { RestartResult } from './cycleRestart.ts';
import { CYCLE_ARTIFACT_OUTCOMES, CYCLE_STATE_SCHEMA_VERSION, nodeCycleStateFileSystem } from './cycleState.ts';
import type { CycleArtifactOutcome, CycleState, CycleStateFileSystem } from './cycleState.ts';
import { readCycleState, writeCycleState } from './cycleState.ts';
import { treeId } from './fingerprint.ts';
import { gitLocal, runGit } from './gitx.ts';
import { acquireLock } from './lock.ts';
import { ckError } from './messages.ts';

const PATCHSET_CYCLE_LOCK_ID = 'cycle-global';

export { resolveTargetPin } from './cycleControlGit.ts';
export type { CycleGitRunner } from './cycleControlGit.ts';

export type CycleControlCheckpoint =
	| 'init-state-written'
	| 'init-branch-created'
	| 'init-config-written'
	| 'init-config-staged'
	| 'init-bump-committed'
	| 'init-completed'
	| 'restart-state-written'
	| 'restart-reset'
	| 'restart-state-removed';

export type CycleControlDependencies = {
	readonly git?: CycleGitRunner;
	readonly localGit?: CycleGitRunner;
	readonly stateFileSystem?: CycleStateFileSystem;
	readonly controlFileSystem?: CycleStateFileSystem;
	readonly configFileSystem?: ConfigFileSystem;
	readonly now?: () => Date;
	readonly temporarySuffix?: () => string;
	readonly acquireLock?: typeof acquireLock;
	readonly checkpoint?: (checkpoint: CycleControlCheckpoint) => void;
};

export type StartCycleOptions = {
	readonly patchesDir: string;
	readonly forkDir: string;
	readonly config: CodkitConfig;
	readonly target: string;
	readonly dependencies?: CycleControlDependencies;
};

export type StartCycleResult = {
	readonly branch: string;
	readonly sourcePin: PinConfig;
	readonly targetPin: PinConfig;
	readonly bumpCommit: string;
	readonly phase: 'apply';
	readonly resumed: boolean;
};

export type CycleOutcomeCounts = Readonly<Record<CycleArtifactOutcome, number>>;
export type CycleStatus =
	| { readonly status: 'absent'; readonly nextAction: string }
	| {
			readonly status: 'active';
			readonly branch: string;
			readonly targetPin: PinConfig;
			readonly phase: CycleState['phase'];
			readonly transaction: 'init' | 'restart' | null;
			readonly counts: CycleOutcomeCounts;
			readonly resolved: number;
			readonly nextAction: string;
	  };

export type RestartCycleOptions = {
	readonly patchesDir: string;
	readonly forkDir: string;
	readonly config: CodkitConfig;
	readonly yes: boolean;
	readonly dependencies?: CycleControlDependencies;
};

export type RestartCycleResult = RestartResult;

type ResolvedDependencies = {
	readonly git: CycleGitRunner;
	readonly localGit: CycleGitRunner;
	readonly stateFileSystem: CycleStateFileSystem;
	readonly controlFileSystem: CycleStateFileSystem;
	readonly configFileSystem?: ConfigFileSystem;
	readonly now: () => Date;
	readonly temporarySuffix: () => string;
	readonly acquireLock: typeof acquireLock;
	readonly checkpoint: (checkpoint: CycleControlCheckpoint) => void;
};

type InitStep = 'create-branch' | 'write-config' | 'stage-config' | 'commit-bump' | 'complete';

export function startCycle(options: StartCycleOptions): StartCycleResult {
	const dependencies = resolvedDependencies(options.dependencies);
	return withCycleLocks(options.patchesDir, options.forkDir, 'cycle start', dependencies, () => {
		const control = readCycleControlRecord(options.patchesDir, dependencies.controlFileSystem);
		if (control !== null) {
			if (control.status === 'running') {
				throw ckError('CONFIG', 'a restart transaction is still running', 'finish it with codkit cycle restart --yes');
			}
			completedRestartResult(options.patchesDir, control, options.config.pin, dependencies.git);
		}
		const targetPin = resolveTargetPin(options.forkDir, options.config.upstreamAnchorCommit, options.target, dependencies.git);
		const existing = readCycleState(options.patchesDir, dependencies.stateFileSystem);
		if (existing !== null) {
			if (existing.phase === 'init' && existing.transaction?.kind === 'init') {
				assertInitIdentity(existing, options, targetPin, dependencies.git);
				if (control?.status === 'done') {
					removeCycleControlRecord(options.patchesDir, dependencies.controlFileSystem);
				}
				return resumeInit(existing, options, dependencies, options.config.pin, true);
			}
			if (isPristineApplyState(existing)) {
				return recognizeCompletedInit(existing, options, targetPin, dependencies.git);
			}
			throw ckError('CONFIG', 'an upgrade cycle is already active', 'run codkit cycle status or continue/restart the current cycle');
		}

		assertPatchSetRepositoryClean(options.patchesDir, dependencies.git);
		assertSourceToTargetAncestry(options.forkDir, options.config.pin, targetPin, dependencies.git);
		const branch = `${options.config.cycleBranchPrefix}${targetPin.tag}`;
		assertValidBranch(options.patchesDir, branch, dependencies.git);
		const baseBranch = currentBranchName(options.patchesDir, dependencies.git);
		const baseCommit = headCommit(options.patchesDir, dependencies.git);
		const existingTip = branchTip(options.patchesDir, branch, dependencies.git);
		const reusableResetBranch =
			control?.status === 'done' && control.state.branch === branch && baseBranch === branch && existingTip === baseCommit;
		if (existingTip !== null && !reusableResetBranch) {
			throw ckError('CONFIG', `reserved cycle branch ${branch} already exists`, 'inspect or remove it before starting a new cycle');
		}
		const baseConfig = configAt(options.patchesDir, baseCommit, dependencies.git);
		if (baseConfig === null || !samePin(baseConfig.pin, options.config.pin)) {
			throw ckError(
				'CONFIG',
				'source pin does not match codkit.json at patchset HEAD',
				'commit the exact source config before cycle start'
			);
		}
		const state = makeState(options.config.pin, targetPin, branch, dependencies.now(), {
			phase: 'init',
			nextAction: `create ${branch} from ${baseCommit}`,
			transaction: { kind: 'init', baseCommit, baseBranch }
		});
		writeCycleState(options.patchesDir, state, stateWriteOptions(dependencies));
		if (control?.status === 'done') {
			removeCycleControlRecord(options.patchesDir, dependencies.controlFileSystem);
		}
		dependencies.checkpoint('init-state-written');
		return resumeInit(state, options, dependencies, options.config.pin, false);
	});
}

function recognizeCompletedInit(
	state: CycleState,
	options: StartCycleOptions,
	targetPin: PinConfig,
	git: CycleGitRunner
): StartCycleResult {
	assertBranchMatchesConfig(state, options.config);
	if (!samePin(state.targetPin, targetPin) || !samePin(options.config.pin, state.targetPin)) {
		throw ckError(
			'CONFIG',
			'completed init does not match the requested target/config pin',
			`inspect cycle status for ${state.targetPin.tag}`
		);
	}
	assertCurrentCycleBranch(options.patchesDir, state, git);
	const bump = requiredHeadBump(options.patchesDir, state, git);
	return {
		branch: state.branch,
		sourcePin: state.sourcePin,
		targetPin: state.targetPin,
		bumpCommit: bump.commit,
		phase: 'apply',
		resumed: true
	};
}

function isPristineApplyState(state: CycleState): boolean {
	return (
		state.phase === 'apply' &&
		state.transaction === null &&
		state.resolved.length === 0 &&
		state.renames.length === 0 &&
		CYCLE_ARTIFACT_OUTCOMES.every((outcome) => state.artifacts[outcome].length === 0)
	);
}

export function cycleStatus(patchesDir: string, config: CodkitConfig, dependencies: CycleControlDependencies = {}): CycleStatus {
	const resolved = resolvedDependencies(dependencies);
	const state = readCycleState(patchesDir, resolved.stateFileSystem);
	if (state === null) {
		const control = readCycleControlRecord(patchesDir, resolved.controlFileSystem);
		if (control?.status === 'running') {
			assertBranchMatchesConfig(control.state, config);
			return activeStatus(control.state, restartAction(patchesDir, control.state, config.pin, resolved.git));
		}
		if (control?.status === 'done') {
			completedRestartResult(patchesDir, control, config.pin, resolved.git);
			return { status: 'absent', nextAction: 'restart completed; run codkit cycle start <tag-or-sha>' };
		}
		return { status: 'absent', nextAction: 'run codkit cycle start <tag-or-sha>' };
	}
	assertBranchMatchesConfig(state, config);
	let nextAction = state.nextAction;
	if (state.transaction?.kind === 'init') {
		nextAction = initAction(inspectInitStep(patchesDir, state, config.pin, resolved.git), state);
	} else if (state.transaction?.kind === 'restart') {
		nextAction = restartAction(patchesDir, state, config.pin, resolved.git);
	} else {
		const current = currentBranchName(patchesDir, resolved.git);
		if (current !== state.branch) {
			nextAction = `switch to ${state.branch}`;
		} else {
			if (!samePin(config.pin, state.targetPin)) {
				throw ckError(
					'CONFIG',
					'cycle branch is current, but codkit.json does not carry its target pin',
					'restore the canonical bump commit'
				);
			}
			findCycleBump(patchesDir, state, resolved.git);
		}
	}
	return activeStatus(state, nextAction);
}

export function restartCycle(options: RestartCycleOptions): RestartCycleResult {
	const dependencies = resolvedDependencies(options.dependencies);
	const observed = readCycleState(options.patchesDir, dependencies.stateFileSystem);
	const observedControl = readCycleControlRecord(options.patchesDir, dependencies.controlFileSystem);
	if (observed === null && observedControl === null) {
		throw ckError('CONFIG', 'there is no active upgrade cycle to restart', 'run codkit cycle start <tag-or-sha> first');
	}
	if (!options.yes) {
		throw ckError(
			'CONFIG',
			'cycle restart requires explicit --yes confirmation',
			're-run with --yes only if discarding cycle changes is intended'
		);
	}
	return withCycleLocks(options.patchesDir, options.forkDir, 'cycle restart', dependencies, () => {
		const control = readCycleControlRecord(options.patchesDir, dependencies.controlFileSystem);
		if (control?.status === 'done') {
			return completedRestartResult(options.patchesDir, control, options.config.pin, dependencies.git);
		}
		if (control?.status === 'running') {
			assertBranchMatchesConfig(control.state, options.config);
			assertCurrentCycleBranch(options.patchesDir, control.state, dependencies.git);
			return resumeRestart(options.patchesDir, control, dependencies);
		}
		let state = readCycleState(options.patchesDir, dependencies.stateFileSystem);
		if (state === null) {
			throw ckError('CONFIG', 'the active cycle disappeared before restart', 'inspect cycle status and retry');
		}
		assertBranchMatchesConfig(state, options.config);
		assertCurrentCycleBranch(options.patchesDir, state, dependencies.git);
		if (state.transaction?.kind === 'init') {
			throw ckError('CONFIG', 'cycle init is incomplete', 're-run cycle start to finish the bump before restart');
		}
		if (state.transaction?.kind !== 'restart') {
			const bump = findCycleBump(options.patchesDir, state, dependencies.git);
			state = {
				...state,
				updatedAt: nextTimestamp(state, dependencies.now()),
				nextAction: `reset ${state.branch} to ${bump.parent}`,
				transaction: { kind: 'restart', baseCommit: bump.parent, bumpCommit: bump.commit }
			};
			writeCycleState(options.patchesDir, state, stateWriteOptions(dependencies));
		}
		const record: CycleControlRecord = {
			codkitCycleControl: 1,
			kind: 'restart',
			status: 'running',
			state
		};
		writeCycleControlRecord(options.patchesDir, record, controlWriteOptions(dependencies));
		dependencies.checkpoint('restart-state-written');
		return resumeRestart(options.patchesDir, record, dependencies);
	});
}

function resumeInit(
	state: CycleState,
	options: StartCycleOptions,
	dependencies: ResolvedDependencies,
	initialWorkingPin: PinConfig,
	resumed: boolean
): StartCycleResult {
	let workingPin = initialWorkingPin;
	for (;;) {
		const step = inspectInitStep(options.patchesDir, state, workingPin, dependencies.git);
		switch (step) {
			case 'create-branch':
				mustGit(
					dependencies.git,
					{ args: ['switch', '--create', state.branch], cwd: options.patchesDir },
					'INTERNAL',
					`cannot create ${state.branch}`,
					'repair patchset and retry'
				);
				dependencies.checkpoint('init-branch-created');
				break;
			case 'write-config':
				writeConfigPin(options.patchesDir, state.targetPin, configWriteOptions(dependencies));
				workingPin = state.targetPin;
				dependencies.checkpoint('init-config-written');
				break;
			case 'stage-config':
				mustGit(
					dependencies.git,
					{ args: ['add', '--', CONFIG_FILE_NAME], cwd: options.patchesDir },
					'INTERNAL',
					`cannot stage ${CONFIG_FILE_NAME}`,
					'repair the index and retry'
				);
				dependencies.checkpoint('init-config-staged');
				break;
			case 'commit-bump':
				mustGit(
					dependencies.localGit,
					{
						args: [
							'commit',
							'--message',
							bumpSubject(state.targetPin.tag),
							'--message',
							bumpTrailer(state.targetPin.tag),
							'--',
							CONFIG_FILE_NAME
						],
						cwd: options.patchesDir
					},
					'INTERNAL',
					'cannot create the canonical cycle pin-bump commit',
					'fix the commit identity or hook failure and retry; init state was retained'
				);
				dependencies.checkpoint('init-bump-committed');
				break;
			case 'complete': {
				const bump = requiredHeadBump(options.patchesDir, state, dependencies.git);
				const completed = {
					...state,
					updatedAt: nextTimestamp(state, dependencies.now()),
					phase: 'apply' as const,
					nextAction: 'run codkit cycle continue to classify and apply every artifact',
					transaction: null
				};
				writeCycleState(options.patchesDir, completed, stateWriteOptions(dependencies));
				dependencies.checkpoint('init-completed');
				return {
					branch: state.branch,
					sourcePin: state.sourcePin,
					targetPin: state.targetPin,
					bumpCommit: bump.commit,
					phase: 'apply',
					resumed
				};
			}
		}
	}
}

function inspectInitStep(patchesDir: string, state: CycleState, workingPin: PinConfig, git: CycleGitRunner): InitStep {
	const transaction = state.transaction;
	if (state.phase !== 'init' || transaction?.kind !== 'init') {
		throw ckError('CONFIG', 'cycle state is not an init transaction', 'inspect cycle status before retrying start');
	}
	const current = currentBranchName(patchesDir, git);
	const head = headCommit(patchesDir, git);
	const tip = branchTip(patchesDir, state.branch, git);
	const status = readPatchSetStatus(patchesDir, git);
	if (current === transaction.baseBranch && head === transaction.baseCommit && tip === null && samePin(workingPin, state.sourcePin)) {
		assertOnlyCycleStatus(status, 'none');
		return 'create-branch';
	}
	if (
		current === transaction.baseBranch &&
		current === state.branch &&
		head === transaction.baseCommit &&
		tip === transaction.baseCommit &&
		samePin(workingPin, state.sourcePin)
	) {
		assertOnlyCycleStatus(status, 'none');
		return 'write-config';
	}
	if (current !== state.branch || tip !== head) {
		throw initMismatch(state, `current=${current}, HEAD=${head}, branchTip=${tip ?? 'absent'}`);
	}
	if (head === transaction.baseCommit && samePin(workingPin, state.sourcePin)) {
		assertOnlyCycleStatus(status, 'none');
		return 'write-config';
	}
	if (head === transaction.baseCommit && samePin(workingPin, state.targetPin)) {
		const configCode = status.find((entry) => entry.path === CONFIG_FILE_NAME)?.code;
		if (configCode === ' M') {
			assertOnlyCycleStatus(status, 'unstaged');
			return 'stage-config';
		}
		if (configCode === 'M ') {
			assertOnlyCycleStatus(status, 'staged');
			return 'commit-bump';
		}
	}
	if (samePin(workingPin, state.targetPin)) {
		const bump = recognizeBump(patchesDir, 'HEAD', state.targetPin, git);
		if (bump !== null && bump.parent === transaction.baseCommit && samePin(bump.sourcePin, state.sourcePin)) {
			assertOnlyCycleStatus(status, 'none');
			return 'complete';
		}
	}
	throw initMismatch(state, `HEAD=${head}, config pin=${workingPin.tag}@${workingPin.sha}`);
}

function assertInitIdentity(state: CycleState, options: StartCycleOptions, targetPin: PinConfig, git: CycleGitRunner): void {
	assertBranchMatchesConfig(state, options.config);
	if (!samePin(state.targetPin, targetPin)) {
		throw ckError('CONFIG', 'cycle start target does not match the durable init transaction', `retry with ${state.targetPin.tag}`);
	}
	assertSourceToTargetAncestry(options.forkDir, state.sourcePin, state.targetPin, git);
}

function assertBranchMatchesConfig(state: CycleState, config: CodkitConfig): void {
	const expected = `${config.cycleBranchPrefix}${state.targetPin.tag}`;
	if (state.branch !== expected) {
		throw ckError(
			'CONFIG',
			`cycle state branch ${state.branch} does not match configured branch ${expected}`,
			'restore the matching cycleBranchPrefix'
		);
	}
}

function requiredHeadBump(patchesDir: string, state: CycleState, git: CycleGitRunner): RecognizedBump {
	const bump = recognizeBump(patchesDir, 'HEAD', state.targetPin, git);
	if (bump === null || !samePin(bump.sourcePin, state.sourcePin)) {
		throw initMismatch(state, 'HEAD is not the canonical bump');
	}
	return bump;
}

function makeState(
	sourcePin: PinConfig,
	targetPin: PinConfig,
	branch: string,
	now: Date,
	step: Pick<CycleState, 'phase' | 'nextAction' | 'transaction'>
): CycleState {
	const timestamp = now.toISOString();
	return {
		codkitCycleState: CYCLE_STATE_SCHEMA_VERSION,
		sourcePin,
		targetPin,
		branch,
		startedAt: timestamp,
		updatedAt: timestamp,
		...step,
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

function activeStatus(state: CycleState, nextAction: string): Extract<CycleStatus, { status: 'active' }> {
	const counts = Object.fromEntries(CYCLE_ARTIFACT_OUTCOMES.map((outcome) => [outcome, state.artifacts[outcome].length])) as Record<
		CycleArtifactOutcome,
		number
	>;
	return {
		status: 'active',
		branch: state.branch,
		targetPin: state.targetPin,
		phase: state.phase,
		transaction: state.transaction?.kind ?? null,
		counts,
		resolved: state.resolved.length,
		nextAction
	};
}

function initAction(step: InitStep, state: CycleState): string {
	return {
		'create-branch': `create ${state.branch}`,
		'write-config': `write target pin ${state.targetPin.tag}`,
		'stage-config': `stage ${CONFIG_FILE_NAME}`,
		'commit-bump': 'retry canonical bump commit',
		complete: 'finish init state and continue apply'
	}[step];
}

function initMismatch(state: CycleState, detail: string) {
	const base = state.transaction?.kind === 'init' ? state.transaction.baseCommit : 'recorded base';
	return ckError('CONFIG', `init transaction does not match its exact checkpoint: ${detail}`, `restore ${base} or the canonical bump`);
}

function nextTimestamp(state: CycleState, now: Date): string {
	return Date.parse(now.toISOString()) < Date.parse(state.updatedAt) ? state.updatedAt : now.toISOString();
}

function resolvedDependencies(input: CycleControlDependencies | undefined): ResolvedDependencies {
	return {
		git: input?.git ?? runGit,
		localGit: input?.localGit ?? gitLocal,
		stateFileSystem: input?.stateFileSystem ?? nodeCycleStateFileSystem,
		controlFileSystem: input?.controlFileSystem ?? nodeCycleStateFileSystem,
		...(input?.configFileSystem === undefined ? {} : { configFileSystem: input.configFileSystem }),
		now: input?.now ?? (() => new Date()),
		temporarySuffix: input?.temporarySuffix ?? randomUUID,
		acquireLock: input?.acquireLock ?? acquireLock,
		checkpoint: input?.checkpoint ?? (() => undefined)
	};
}

function withCycleLocks<T>(patchesDir: string, forkDir: string, command: string, dependencies: ResolvedDependencies, body: () => T): T {
	const patchsetLock = dependencies.acquireLock(patchesDir, PATCHSET_CYCLE_LOCK_ID, command);
	try {
		const treeLock = dependencies.acquireLock(patchesDir, treeId(forkDir), command);
		try {
			return body();
		} finally {
			treeLock.release();
		}
	} finally {
		patchsetLock.release();
	}
}

function configWriteOptions(dependencies: ResolvedDependencies) {
	return {
		...(dependencies.configFileSystem === undefined ? {} : { fileSystem: dependencies.configFileSystem }),
		temporarySuffix: dependencies.temporarySuffix
	};
}

function stateWriteOptions(dependencies: ResolvedDependencies) {
	return { fileSystem: dependencies.stateFileSystem, temporarySuffix: dependencies.temporarySuffix };
}

function controlWriteOptions(dependencies: ResolvedDependencies) {
	return { fileSystem: dependencies.controlFileSystem, temporarySuffix: dependencies.temporarySuffix };
}
