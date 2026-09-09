#!/usr/bin/env node

// Builds the air-gapped supply kit of the tool: `npm pack` of every published
// workspace package plus one manifest that names them with their versions and
// sha256 (PROP-016 ##TYPE-SUPPLY-KIT, PROP-011 §7). The kit is what a customer
// carries across the air gap; it is installed with a single offline `npm
// install` of every tarball it lists, so that the CLI package finds the type
// packages it depends on without a registry.
//
// The kit carries the tool's own packages only. The third-party closure of the
// shipped `npm-shrinkwrap.json` files is the other half of the delivery
// (PROP-011 ##SK-CODKIT-NPM): an internal registry or a pre-filled npm cache.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { TYPE_REGISTRY } from '../packages/codkit/src/types/registry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let out = join(root, 'target', 'supply-kit');
for (let index = 0; index < args.length; index += 1) {
	if (args[index] === '--out' && index + 1 < args.length) {
		out = resolve(args[index + 1]);
		index += 1;
		continue;
	}
	process.stderr.write('usage: node tools/build-supply-kit.mjs [--out <dir>]\n');
	process.exit(2);
}

const MANIFEST = 'kit-manifest.json';
// The order of the kit: the command first, then the contract every type is
// built against, then the types themselves.
const ROLE_ORDER = ['cli', 'contract', 'type'];

function main() {
	const packages = workspacePackages();
	const missing = [...TYPE_REGISTRY.values()].filter((name) => !packages.some((entry) => entry.name === name));
	if (missing.length > 0) {
		process.stderr.write(`the registry names a type package the workspace does not publish: ${missing.join(', ')}\n`);
		process.exit(1);
	}

	prepareOut();
	pack(packages.map((entry) => entry.name));

	const rows = packages
		.map((entry) => {
			const file = tarballName(entry.name, entry.version);
			const path = join(out, file);
			if (!existsSync(path)) {
				process.stderr.write(`npm pack did not produce ${file}\n`);
				process.exit(1);
			}
			const bytes = readFileSync(path);
			const typeId = [...TYPE_REGISTRY.entries()].find(([, name]) => name === entry.name)?.[0];
			return {
				name: entry.name,
				version: entry.version,
				...(typeId === undefined ? {} : { type: typeId }),
				role: entry.role,
				file,
				bytes: bytes.length,
				sha256: createHash('sha256').update(bytes).digest('hex')
			};
		})
		.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));

	const cli = rows.find((row) => row.role === 'cli');
	const manifest = {
		codkitSupplyKit: 1,
		version: cli.version,
		packages: rows,
		install: {
			// One `npm install` for the whole kit: the type tarballs stand in
			// for the registry the CLI package's dependencies would otherwise
			// be resolved from, so nothing reaches out of the circuit.
			command: `npm install --offline ${rows.map((row) => `./${row.file}`).join(' ')}`,
			requires: 'the third-party dependencies of the shipped npm-shrinkwrap files, from an internal registry or a pre-filled npm cache'
		}
	};
	writeFileSync(join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

	for (const row of rows) process.stdout.write(`${row.file}  ${row.bytes} bytes  sha256:${row.sha256}\n`);
	process.stdout.write(`wrote ${relative(root, join(out, MANIFEST))}\n`);
	process.stdout.write(`install: cd ${relative(root, out)} && ${manifest.install.command}\n`);
}

/** The published packages of the workspace, in the order the manifest wants. */
function workspacePackages() {
	const manifest = readJson(join(root, 'package.json'));
	const patterns = manifest.workspaces ?? [];
	const directories = new Set();
	for (const pattern of patterns) {
		if (pattern.endsWith('/*')) {
			const parent = join(root, pattern.slice(0, -2));
			for (const entry of readdirSync(parent, { withFileTypes: true }))
				if (entry.isDirectory() && existsSync(join(parent, entry.name, 'package.json'))) directories.add(join(parent, entry.name));
			continue;
		}
		directories.add(join(root, pattern));
	}
	return [...directories]
		.sort()
		.map((directory) => ({ directory, manifest: readJson(join(directory, 'package.json')) }))
		.filter((entry) => entry.manifest.private !== true)
		.map((entry) => ({ name: entry.manifest.name, version: entry.manifest.version, role: roleOf(entry.manifest) }));
}

function roleOf(manifest) {
	if (manifest.bin !== undefined) return 'cli';
	if ([...TYPE_REGISTRY.values()].includes(manifest.name)) return 'type';
	return 'contract';
}

/** `npm pack` names a scoped tarball by flattening the scope. */
function tarballName(name, version) {
	return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

function prepareOut() {
	if (existsSync(out)) {
		if (!statSync(out).isDirectory()) {
			process.stderr.write(`not a directory: ${out}\n`);
			process.exit(2);
		}
		const entries = readdirSync(out);
		const ours = entries.every((entry) => entry === MANIFEST || entry.endsWith('.tgz'));
		if (!ours) {
			process.stderr.write(`refusing to write the kit into a directory that holds other files: ${out}\n`);
			process.exit(2);
		}
		rmSync(out, { recursive: true, force: true });
	}
	mkdirSync(out, { recursive: true });
}

function pack(names) {
	const packed = spawnSync('npm', ['pack', ...names.flatMap((name) => ['-w', name]), '--pack-destination', out], {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	});
	if (packed.status !== 0) {
		process.stderr.write(packed.stdout ?? '');
		process.stderr.write(packed.stderr ?? '');
		process.stderr.write('npm pack failed\n');
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

main();
