#!/usr/bin/env node
// The fake host of the engine's preview suite (FEAT-002 S88): an executable that
// records what it was started with - its argv, its working directory and the one
// environment variable the stub's recipe sets - in the file named by
// CODKIT_TEST_FAKE_HOST_OUT, and exits 0. A preview spawns it through the
// platform wrapper `test/support/fakeHost.ts` writes at test time, so that the
// host of a preview is one executable the way a real host is.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const out = process.env.CODKIT_TEST_FAKE_HOST_OUT;
if (out === undefined || out === '') {
	process.stderr.write('fake host: CODKIT_TEST_FAKE_HOST_OUT names no file\n');
	process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });
const report = { argv: process.argv, cwd: process.cwd(), mode: process.env.CODKIT_STUB_PREVIEW_MODE ?? null };
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
