#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Every package that emits a deterministic runtime declares it with a
// tsconfig.runtime.json; the check is the same for all of them.
const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'tsconfig.runtime.json')))
	.map((entry) => entry.name)
	.sort();

const problems = [];
let matched = 0;
for (const name of packages) {
	const expected = join(root, 'packages', name, 'dist');
	const shown = `packages/${name}/dist`;
	const temporary = mkdtempSync(join(tmpdir(), 'codkit-runtime-check-'));
	try {
		const build = spawnSync(
			process.execPath,
			[join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'packages', name, 'tsconfig.runtime.json'), '--outDir', temporary],
			{ cwd: root, encoding: 'utf8' }
		);
		if (build.status !== 0) {
			process.stderr.write(build.stdout);
			process.stderr.write(build.stderr);
			process.exit(1);
		}
		const wanted = files(temporary);
		const current = existsSync(expected) ? files(expected) : [];
		for (const path of new Set([...wanted, ...current])) {
			if (!wanted.includes(path)) problems.push(`unexpected generated file: ${shown}/${path}`);
			else if (!current.includes(path)) problems.push(`missing generated file: ${shown}/${path}`);
			else if (!readFileSync(join(temporary, path)).equals(readFileSync(join(expected, path))))
				problems.push(`stale generated file: ${shown}/${path}`);
		}
		matched += wanted.length;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (problems.length > 0) {
	for (const problem of problems) process.stderr.write(`${problem}\n`);
	process.stderr.write('hint: run npm run runtime:build\n');
	process.exit(1);
}
process.stdout.write(`runtime build check: ${matched} files match in ${packages.length} package(s)\n`);

function files(directory) {
	const result = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...files(absolute).map((path) => join(entry.name, path)));
		else if (entry.isFile()) result.push(relative(directory, absolute));
	}
	return result.sort();
}
