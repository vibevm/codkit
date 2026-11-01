/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW */
// The fake host of the preview suite (FEAT-002 S88): one executable, written at
// test time for the platform the suite runs on, that starts
// `fixtures/fakeHost.mjs` on the node running the tests. The host of a preview
// is one executable - a path, or a name on PATH - so the wrapper is what a
// preview resolves and spawns; the script behind it writes its argv, its working
// directory and the stub's mode variable to the file the suite names, and exits.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRoot } from './tmp.ts';

/** The environment variable the fake host reads for the file it reports to. */
export const FAKE_HOST_OUT = 'CODKIT_TEST_FAKE_HOST_OUT';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fakeHost.mjs');

export type FakeHost = {
	/** The one executable a preview may be pointed at with `--host`. */
	readonly executable: string;
	/** The directory holding it, for a PATH lookup. */
	readonly directory: string;
	/** Its bare name, as PATH finds it with the platform's suffixes. */
	readonly name: string;
};

export function makeFakeHost(label: string): FakeHost {
	const directory = makeTempRoot(`${label}-fake-host`);
	const name = 'fake-host';
	if (process.platform === 'win32') {
		const executable = join(directory, `${name}.cmd`);
		writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
		return { executable, directory, name };
	}
	const executable = join(directory, name);
	writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, 'utf8');
	chmodSync(executable, 0o755);
	return { executable, directory, name };
}

/** What the fake host wrote: the whole argv of its node process, its cwd and the stub's mode variable. */
export type FakeHostReport = {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly mode: string | null;
};

/** The report of a detached host, waited for: a preview returns before the host has run. */
export async function readFakeHostReport(path: string, timeoutMs = 20_000): Promise<FakeHostReport> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (existsSync(path)) {
			try {
				return JSON.parse(readFileSync(path, 'utf8')) as FakeHostReport;
			} catch {
				// Written in two steps by the file system: read it again.
			}
		}
		if (Date.now() > deadline) {
			throw new Error(`the fake host did not report to ${path} within ${timeoutMs}ms`);
		}
		await new Promise((settle) => {
			setTimeout(settle, 50);
		});
	}
}
