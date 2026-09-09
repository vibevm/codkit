import { describe, expect, it } from 'vitest';
import { isCkError } from '../../src/lib/messages.ts';
import {
	CYCLE_TEST_BUILD_CONDITION,
	CYCLE_TEST_CRASH_CHECKPOINTS,
	CYCLE_TEST_CRASH_EXIT_CODE,
	cycleTestCrashCheckpoint,
	isCycleTestBuild
} from '../../src/lib/cycleTestCrash.ts';

describe('cycle test-only crash injection', () => {
	it('is absent without the opt-in variable', () => {
		expect(cycleTestCrashCheckpoint(undefined, false)).toBeUndefined();
		expect(cycleTestCrashCheckpoint('', false)).toBeUndefined();
	});

	it('rejects an unknown checkpoint as CONFIG before a callback exists', () => {
		let failure: unknown;
		try {
			cycleTestCrashCheckpoint('not-a-checkpoint', true);
		} catch (error) {
			failure = error;
		}
		expect(isCkError(failure) && failure.code).toBe('CONFIG');
		if (!(failure instanceof Error)) throw new Error('expected checkpoint validation error');
		expect(failure.message).toContain('unknown cycle checkpoint');
	});

	it('rejects every activation outside the test runtime', () => {
		expect(() => cycleTestCrashCheckpoint(CYCLE_TEST_CRASH_CHECKPOINTS[0], false)).toThrow('disabled outside the test runtime');
	});

	it('recognizes only the explicit test-build condition', () => {
		expect(isCycleTestBuild([CYCLE_TEST_BUILD_CONDITION])).toBe(true);
		expect(isCycleTestBuild(['--conditions=development'])).toBe(false);
		expect(isCycleTestBuild([])).toBe(false);
	});

	it('hard-exits only at the exact validated checkpoint', () => {
		const exits: number[] = [];
		const checkpoint = cycleTestCrashCheckpoint('apply-classified', true, (exitCode): never => {
			exits.push(exitCode);
			throw new Error('hard exit');
		});
		if (checkpoint === undefined) throw new Error('checkpoint injector missing');
		checkpoint('apply-classified-record-written');
		expect(exits).toEqual([]);
		expect(() => checkpoint('apply-classified')).toThrow('hard exit');
		expect(exits).toEqual([CYCLE_TEST_CRASH_EXIT_CODE]);
	});
});
