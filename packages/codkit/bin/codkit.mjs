#!/usr/bin/env node
// Codkit launcher for the checked-in compiled runtime.
//
// Responsibilities, in order:
//   1. locate the Codkit installation from this file's own location;
//   2. fail fast with a readable message when node_modules is not installed;
//   3. re-exec the same node binary on dist/main.js.
//
// Contract: PROP-002 sec. 1-2 (layout, compiled runtime, dependency error).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const binDir = dirname(fileURLToPath(import.meta.url));
const toolRoot = resolve(binDir, '..');

// The launcher cannot import anything from src/ before dependencies exist,
// so this one error code is spelled out literally here; it is also registered
// in src/lib/messages.ts so that the registry stays complete.
let runtimeReady = false;
try {
	import.meta.resolve('zod');
	runtimeReady = true;
} catch {
	// Report one stable launcher error below instead of exposing module-loader output.
}
if (!runtimeReady) {
	process.stderr.write('error CK-E-DEPS-MISSING: node_modules is not installed\n');
	process.stderr.write('hint: restore the Codkit installation from approved supply (source checkouts may run npm ci)\n');
	process.exit(2);
}

const mainJs = join(toolRoot, 'dist', 'main.js');
if (!existsSync(mainJs)) {
	process.stderr.write('error CK-E-DEPS-MISSING: compiled Codkit runtime is missing\n');
	process.stderr.write('hint: restore the Codkit installation from approved supply (source checkouts may run npm run runtime:build)\n');
	process.exit(2);
}
const testBuildCondition = '--conditions=codkit-test';
const testBuildArgs = process.execArgv.includes(testBuildCondition) ? [testBuildCondition] : [];
const testTimeoutEnv = 'CODKIT_E2E_TIMEOUT_MS';
const childEnv = { ...process.env };
delete childEnv[testTimeoutEnv];
const timeoutText = testBuildArgs.length === 0 ? undefined : process.env[testTimeoutEnv];
const timeout = timeoutText === undefined || timeoutText === '' ? undefined : Number.parseInt(timeoutText, 10);
if (timeout !== undefined && (!/^\d+$/.test(timeoutText ?? '') || timeout <= 0)) {
	process.stderr.write(`error CK-E-CONFIG: ${testTimeoutEnv} must be a positive integer in a test build\n`);
	process.exit(2);
}

const result = spawnSync(process.execPath, [...testBuildArgs, mainJs, ...process.argv.slice(2)], {
	stdio: 'inherit',
	env: childEnv,
	...(timeout === undefined ? {} : { timeout, killSignal: 'SIGKILL' })
});

if (result.error) {
	if (result.error.code === 'ETIMEDOUT') {
		process.stderr.write(`error CK-E-INTERNAL: codkit test process exceeded ${timeout ?? 0} ms\n`);
		process.exit(2);
	}
	process.stderr.write(`error CK-E-INTERNAL: failed to start codkit: ${result.error.message}\n`);
	process.stderr.write('hint: re-run with --verbose and attach the output\n');
	process.exit(2);
}

if (typeof result.status === 'number') {
	process.exit(result.status);
}

// Killed by a signal: no exit status to forward, report an environment failure.
process.exit(2);
