/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Restart reconciliation is isolated from init: it validates the recorded bump,
// survives reset deleting tracked state, and leaves a durable done record so a
// crash after the last mutation still has an idempotent answer.

import type { PinConfig } from './configFile.ts';
import { writeCycleControlRecord } from './cycleControlRecord.ts';
import type { CycleControlRecord } from './cycleControlRecord.ts';
import { cycleStatePath } from './cycleState.ts';
import type { CycleState, CycleStateFileSystem } from './cycleState.ts';
import { assertCommitDescends, currentBranchName, headCommit, mustGit, recognizeBump, samePin } from './cycleControlGit.ts';
import type { CycleGitRunner } from './cycleControlGit.ts';
import { ckError, isCkError } from './messages.ts';

export type RestartRuntime = {
	readonly git: CycleGitRunner;
	readonly stateFileSystem: CycleStateFileSystem;
	readonly controlFileSystem: CycleStateFileSystem;
	readonly temporarySuffix: () => string;
	readonly checkpoint: (checkpoint: 'restart-reset' | 'restart-state-removed') => void;
};

export type RestartResult = { readonly branch: string; readonly removedState: true; readonly resetTo: string };

export function resumeRestart(patchesDir: string, record: CycleControlRecord, runtime: RestartRuntime): RestartResult {
	const state = record.state;
	const transaction = state.transaction;
	if (transaction?.kind !== 'restart') {
		throw ckError('CONFIG', 'cycle state is not a restart transaction', 'inspect cycle status and retry');
	}
	const bump = recognizeBump(patchesDir, transaction.bumpCommit, state.targetPin, runtime.git);
	if (bump === null || bump.parent !== transaction.baseCommit || !samePin(bump.sourcePin, state.sourcePin)) {
		throw ckError(
			'CONFIG',
			'restart transaction does not identify the canonical bump',
			'restore the recorded branch objects before retrying'
		);
	}
	const head = headCommit(patchesDir, runtime.git);
	if (head !== transaction.baseCommit) {
		assertCommitDescends(patchesDir, transaction.bumpCommit, head, runtime.git);
		mustGit(
			runtime.git,
			{ args: ['reset', '--hard', transaction.baseCommit], cwd: patchesDir },
			'INTERNAL',
			`cannot reset ${state.branch}`,
			'repair patchset and retry; state was retained'
		);
		runtime.checkpoint('restart-reset');
	}
	removeCycleState(patchesDir, runtime.stateFileSystem);
	runtime.checkpoint('restart-state-removed');
	const done = { ...record, status: 'done' as const };
	writeCycleControlRecord(patchesDir, done, {
		fileSystem: runtime.controlFileSystem,
		temporarySuffix: runtime.temporarySuffix
	});
	return completedRestartResult(patchesDir, done, state.sourcePin, runtime.git);
}

export function completedRestartResult(
	patchesDir: string,
	record: CycleControlRecord,
	workingPin: PinConfig,
	git: CycleGitRunner
): RestartResult {
	const state = record.state;
	const transaction = state.transaction;
	if (record.status !== 'done' || transaction?.kind !== 'restart') {
		throw ckError('CONFIG', 'cycle control record is not a completed restart', 'finish restart with --yes');
	}
	assertCurrentCycleBranch(patchesDir, state, git);
	const bump = recognizeBump(patchesDir, transaction.bumpCommit, state.targetPin, git);
	if (bump === null || bump.parent !== transaction.baseCommit || !samePin(bump.sourcePin, state.sourcePin)) {
		throw ckError('CONFIG', 'completed restart record does not identify the canonical bump', 'restore the recorded objects');
	}
	if (headCommit(patchesDir, git) !== transaction.baseCommit || !samePin(workingPin, state.sourcePin)) {
		throw ckError('CONFIG', 'completed restart facts do not match the recorded base', 'restore the recorded base commit and source pin');
	}
	return { branch: state.branch, removedState: true, resetTo: transaction.baseCommit };
}

export function restartAction(patchesDir: string, state: CycleState, workingPin: PinConfig, git: CycleGitRunner): string {
	const transaction = state.transaction;
	if (transaction?.kind !== 'restart') {
		throw ckError('CONFIG', 'cycle state transaction is inconsistent', 'restore canonical state');
	}
	assertCurrentCycleBranch(patchesDir, state, git);
	const head = headCommit(patchesDir, git);
	if (head === transaction.baseCommit) {
		if (!samePin(workingPin, state.sourcePin)) {
			throw ckError('CONFIG', 'restart reset reached its base, but codkit.json is not the source pin', 'restore the recorded base commit');
		}
		return 'remove cycle/state.json to finish restart';
	}
	if (!samePin(workingPin, state.targetPin)) {
		throw ckError(
			'CONFIG',
			'restart transaction has not reset, but codkit.json is not the target pin',
			'restore the cycle branch before retrying'
		);
	}
	assertCommitDescends(patchesDir, transaction.bumpCommit, head, git);
	return `run codkit cycle restart --yes to reset to ${transaction.baseCommit}`;
}

export function assertCurrentCycleBranch(patchesDir: string, state: CycleState, git: CycleGitRunner): void {
	const current = currentBranchName(patchesDir, git);
	if (current !== state.branch) {
		throw ckError(
			'CONFIG',
			`cycle operation requires ${state.branch}; current branch is ${current}`,
			`switch to ${state.branch} and retry`
		);
	}
}

function removeCycleState(patchesDir: string, fileSystem: CycleStateFileSystem): void {
	const path = cycleStatePath(patchesDir);
	try {
		fileSystem.remove(path);
	} catch (error) {
		if (isCkError(error)) {
			throw error;
		}
		throw ckError(
			'CONFIG',
			`cycle branch was reset, but state removal failed: ${error instanceof Error ? error.message : String(error)}`,
			`remove ${path} after verifying containment`
		);
	}
}
