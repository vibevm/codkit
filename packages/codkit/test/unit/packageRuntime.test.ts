// unit: the default runner of a packaging command (PROP-007
// ##INPUTS-BUILD-PORTABLE): the bare name of the program is found along the
// PATH the command runs with - the directory a type's environment hook puts
// first - and not along codkit's own, which is what let the GNU tar of a Git
// installation answer for the bsdtar of Windows (finding of 2026-11-02).

import { chmodSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultPackageCommandRunner } from '../../src/lib/packageRuntime.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const PROBE = 'ck-runner-probe';

/** A program of that name in the directory that prints the word. */
function probe(directory: string, word: string): void {
	if (process.platform === 'win32') {
		writeFileSync(join(directory, `${PROBE}.cmd`), `@echo ${word}\r\n`, 'utf8');
		return;
	}
	const path = join(directory, PROBE);
	writeFileSync(path, `#!/bin/sh\necho ${word}\n`, 'utf8');
	chmodSync(path, 0o755);
}

describe('the default command runner', () => {
	it('finds the program along the PATH of the command, whatever its own PATH answers', () => {
		const first = makeTempRoot('runner-first');
		const second = makeTempRoot('runner-second');
		probe(first, 'first');
		probe(second, 'second');
		const own = process.env['PATH'] ?? '';
		const run = (directory: string) =>
			defaultPackageCommandRunner({
				label: 'probe',
				command: PROBE,
				args: [],
				cwd: first,
				env: { PATH: `${directory}${delimiter}${own}` },
				timeoutMs: null
			});
		const fromSecond = run(second);
		expect({ status: fromSecond.status, error: fromSecond.error?.message, stdout: fromSecond.stdout.trim() }).toEqual({
			status: 0,
			error: undefined,
			stdout: 'second'
		});
		expect(run(first).stdout.trim()).toBe('first');
	});
});
