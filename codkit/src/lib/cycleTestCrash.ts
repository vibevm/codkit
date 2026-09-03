/** @scope spec://codkit/modules/codkit/PROP-013#RESUMABILITY-TESTS */
// Test-only hard-process interruption for the real cycle CLI. The callback is
// passed into the existing control/engine dependency seams; it contains no
// cycle transitions of its own.

import { z } from 'zod';
import { ckError } from './messages.ts';

export const CYCLE_TEST_CRASH_ENV = 'CODKIT_TEST_CRASH_AT';
export const CYCLE_TEST_CRASH_EXIT_CODE = 86;
export const CYCLE_TEST_BUILD_CONDITION = '--conditions=codkit-test';

export const CYCLE_TEST_CRASH_CHECKPOINTS = [
	'init-state-written',
	'init-branch-created',
	'init-config-written',
	'init-config-staged',
	'init-bump-committed',
	'init-completed',
	'restart-state-written',
	'restart-reset',
	'restart-state-removed',
	'apply-review-state-written',
	'apply-preview-persisted',
	'apply-classification-applied',
	'apply-classified-record-written',
	'apply-classified',
	'renames-committed',
	'apply-materialized',
	'regeneration-planned',
	'apply-regenerated',
	'apply-committed',
	'resolve-commit-installed',
	'resolve-completed',
	'advisory-inspected',
	'advisory-planned',
	'stabilize-started',
	'stabilize-run-finished',
	'stabilize-planned',
	'transition-planned',
	'transition-reports-written',
	'transition-state-written',
	'transition-written',
	'transition-commit-installed',
	'deps-advisory-transition-commit-installed',
	'stabilize-transition-commit-installed',
	'transition-committed',
	'terminal-planned',
	'terminal-state-deleted',
	'terminal-applied',
	'terminal-commit-installed',
	'terminal-committed'
] as const;

export type CycleTestCrashCheckpoint = (typeof CYCLE_TEST_CRASH_CHECKPOINTS)[number];
export type CycleTestCrashTerminator = (exitCode: number) => never;

const checkpointSchema = z.enum(CYCLE_TEST_CRASH_CHECKPOINTS);

/** Validate the opt-in once at the CLI boundary and return the dependency hook. */
export function cycleTestCrashCheckpoint(
	crashAt: unknown,
	testBuild: boolean,
	terminate: CycleTestCrashTerminator = hardExit
): ((checkpoint: string) => void) | undefined {
	if (crashAt === undefined || crashAt === '') return undefined;
	const parsed = checkpointSchema.safeParse(crashAt);
	if (!parsed.success) {
		throw ckError(
			'CONFIG',
			`${CYCLE_TEST_CRASH_ENV} names an unknown cycle checkpoint`,
			`use one of: ${CYCLE_TEST_CRASH_CHECKPOINTS.join(', ')}`
		);
	}
	if (!testBuild) {
		throw ckError('CONFIG', `${CYCLE_TEST_CRASH_ENV} is disabled outside the test runtime`, 'unset the test-only crash injection variable');
	}
	return (checkpoint): void => {
		if (checkpoint === parsed.data) terminate(CYCLE_TEST_CRASH_EXIT_CODE);
	};
}

/** The production launcher never adds this condition; the e2e test build does. */
export function isCycleTestBuild(execArgv: readonly string[]): boolean {
	return execArgv.includes(CYCLE_TEST_BUILD_CONDITION);
}

function hardExit(exitCode: number): never {
	// Deliberately bypasses catch/finally and leaves process-owned locks behind,
	// matching the recovery obligations of an uncatchable process loss.
	process.exit(exitCode);
}
