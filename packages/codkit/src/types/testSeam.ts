/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-TEST-SEAM */
// The one type a test build may add to the registry, and nothing else.
//
// ##TYPE-TEST-SEAM: the engine's own e2e suites drive the real CLI as a
// subprocess, and that subprocess resolves a type only through the fixed table
// of ##TYPE-REGISTRY - so the stub type of ##TYPE-ENGINE-TESTS, which lives in
// the test tree and is no package, would be unreachable to every e2e scenario.
// This seam is the answer, in the shape the standards, runtime and crash seams
// already have: a variable the test build alone reads.

import { isAbsolute } from 'node:path';
import { isCycleTestBuild } from '../lib/cycleTestCrash.ts';

/** ##TYPE-TEST-SEAM: the variable that names one extra type in a test build. */
export const TYPE_PACKAGE_ENV = 'CODKIT_TEST_TYPE_PACKAGE';

/**
 * ##TYPE-TEST-SEAM: `<id>=<absolute path of a module exporting projectType>`,
 * honoured only under the test build condition - the seam
 * `CODKIT_TEST_STANDARDS_SOURCE` and `CODKIT_TEST_CRASH_AT` already use. The
 * engine's own e2e suites drive the real CLI as a subprocess, and a stub type
 * that lives in the test tree is otherwise unreachable to that subprocess.
 *
 * Outside the test build the value is ignored, so no environment can widen the
 * registry of a real run; a value that is not `<id>=<absolute path>` names
 * nothing and is ignored the same way.
 */
export function testSeamEntry(value: string | undefined, execArgv: readonly string[]): readonly [string, string] | null {
	if (value === undefined || value === '' || !isCycleTestBuild(execArgv)) {
		return null;
	}
	const at = value.indexOf('=');
	const id = value.slice(0, at);
	const modulePath = value.slice(at + 1);
	if (at <= 0 || id.includes('/') || !isAbsolute(modulePath)) {
		return null;
	}
	return [id, modulePath];
}
