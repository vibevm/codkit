#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = join(root, 'codkit', 'dist');
const temporary = mkdtempSync(join(tmpdir(), 'codkit-runtime-check-'));
try {
	const build = spawnSync(
		process.execPath,
		[join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'codkit', 'tsconfig.runtime.json'), '--outDir', temporary],
		{ cwd: root, encoding: 'utf8' }
	);
	if (build.status !== 0) {
		process.stderr.write(build.stdout);
		process.stderr.write(build.stderr);
		process.exit(1);
	}
	const wanted = files(temporary);
	const current = files(expected);
	const problems = [];
	for (const path of new Set([...wanted, ...current])) {
		if (!wanted.includes(path)) problems.push(`unexpected generated file: codkit/dist/${path}`);
		else if (!current.includes(path)) problems.push(`missing generated file: codkit/dist/${path}`);
		else if (!readFileSync(join(temporary, path)).equals(readFileSync(join(expected, path))))
			problems.push(`stale generated file: codkit/dist/${path}`);
	}
	if (problems.length > 0) {
		for (const problem of problems) process.stderr.write(`${problem}\n`);
		process.stderr.write('hint: run npm run runtime:build\n');
		process.exit(1);
	}
	process.stdout.write(`runtime build check: ${wanted.length} files match\n`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}

function files(directory) {
	const result = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...files(absolute).map((path) => join(entry.name, path)));
		else if (entry.isFile()) result.push(relative(directory, absolute));
	}
	return result.sort();
}
