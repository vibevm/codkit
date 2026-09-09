/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-RUNTIME-STATE */
// Type-level evidence: `removeRecord` retires exactly one OBSERVED generation,
// and the expected bytes are a required argument - not an optional courtesy.
//
// The optional form let a lock-holding caller delete a record it never
// compared, which is the same collapse the discriminated record reader exists
// to prevent one level up. The guard is in the SIGNATURE, so the evidence is a
// compile-time one: these assertions run as no-ops under vitest and are enforced
// by `npm run typecheck`. Before the guard existed, a call without the expected
// generation compiled and silently deleted whatever was on disk; now the
// `@ts-expect-error` below would itself be an error if the argument ever became
// optional again.

import { describe, expect, expectTypeOf, it } from 'vitest';
import { removeRecord } from '../../src/lib/buildRuntime.ts';
import type { DaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';

describe('removeRecord requires the generation it is about to retire', () => {
	it('has the expected bytes as a mandatory fourth argument', () => {
		// Exactly Uint8Array, not Uint8Array | undefined: an optional parameter
		// would surface as the union and fail here.
		expectTypeOf(removeRecord).parameter(3).toEqualTypeOf<Uint8Array>();
		expectTypeOf(removeRecord).parameter(3).not.toBeNullable();
	});

	it('does not compile a call that omits it', () => {
		const attempted: string[] = [];
		// Never invoked: the assertion is that the body does not typecheck.
		const withoutGeneration = (root: string, channel: string, lock: DaemonChannelLock): boolean => {
			// @ts-expect-error the compared generation is mandatory: a lock holder must not delete a record it never read
			const retired = removeRecord(root, channel, lock);
			attempted.push(String(retired));
			return retired;
		};
		expectTypeOf(withoutGeneration).toBeFunction();
		expect(attempted).toEqual([]);
	});
});
