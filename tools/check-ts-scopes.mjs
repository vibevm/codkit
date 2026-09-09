#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packagesRoot = join(root, 'packages');
const indexPath = join(root, 'specmap.json');
const markerPattern = /^\/\*\* @scope (spec:\/\/codkit\/\S+) \*\/$/;

const index = JSON.parse(readFileSync(indexPath, 'utf8'));
const knownUris = new Set(index.spec_units.map((unit) => unit.uri));
const files = packageSourceRoots()
	.flatMap((sourceRoot) => walk(sourceRoot))
	.filter((path) => path.endsWith('.ts'))
	.sort();
const errors = [];
const used = new Set();

for (const path of files) {
	const firstLine = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0] ?? '';
	const match = markerPattern.exec(firstLine);
	const shown = relative(root, path).replaceAll('\\', '/');
	if (match === null) {
		errors.push(`${shown}: first line must be /** @scope spec://codkit/<doc>#<anchor> */`);
		continue;
	}
	const uri = match[1];
	if (!knownUris.has(uri)) {
		errors.push(`${shown}: scope URI does not resolve: ${uri}`);
		continue;
	}
	used.add(uri);
}

if (errors.length > 0) {
	for (const error of errors) {
		process.stderr.write(`trace scope error: ${error}\n`);
	}
	process.exit(1);
}

process.stdout.write(`trace scopes: ${files.length}/${files.length} files, ${used.size} resolved spec units\n`);

/** Every `packages/<name>/src` of the workspace, in name order. */
function packageSourceRoots() {
	return readdirSync(packagesRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(packagesRoot, entry.name, 'src'))
		.filter((path) => existsSync(path))
		.sort();
}

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(path));
		} else if (entry.isFile()) {
			out.push(path);
		}
	}
	return out;
}
