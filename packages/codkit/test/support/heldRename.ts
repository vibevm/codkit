// A stand-in for the rename of an atomic replacement - the `applyRename` seam of
// PROP-002 ##CONTAINED-WINDOWS-REPLACE-RETRY: it refuses its first attempts with
// the errno a held target produces on Windows, then renames for real.
//
// The real rename lands on a file the test wrote moments before, which is the
// very file a Windows kernel-mode holder keeps open under load. A real refusal
// reaching the code under test would count as one more injected failure, and
// with the clock injected as well the budget would be spent in no time: the
// case would fail for the machine's reason, not the code's. So the real rename
// waits out a real hold by itself, on the real clock, and only the injected
// failures reach the code.

import { renameSync } from 'node:fs';
import { errnoOf } from '../../src/lib/containedPath.ts';

const REAL_HOLD_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
/** Inside the 30 s test timeout, so a hold this long fails with its own errno. */
const REAL_HOLD_LIMIT_MS = 20_000;
const pauseCell = new Int32Array(new SharedArrayBuffer(4));

export type HeldRename = {
	readonly rename: (temporary: string, destination: string) => void;
	/** Every call so far, the injected failures included. */
	readonly attempts: () => number;
};

/** Refuse the first `failures` attempts with `code`, then rename. */
export function heldRename(failures: number, code = 'EPERM'): HeldRename {
	let attempts = 0;
	return {
		rename: (temporary, destination) => {
			attempts += 1;
			if (attempts <= failures) {
				throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
			}
			renameOutlastingRealHolds(temporary, destination);
		},
		attempts: () => attempts
	};
}

function renameOutlastingRealHolds(temporary: string, destination: string): void {
	const deadline = Date.now() + REAL_HOLD_LIMIT_MS;
	for (;;) {
		try {
			renameSync(temporary, destination);
			return;
		} catch (error) {
			if (!REAL_HOLD_ERRORS.has(errnoOf(error) ?? '') || Date.now() > deadline) throw error;
			Atomics.wait(pauseCell, 0, 0, 25);
		}
	}
}
