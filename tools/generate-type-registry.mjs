#!/usr/bin/env node
// Refresh receipts for the installation's explicitly approved package set.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTypeManifest } from '../packages/type-api/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'packages/codkit/config/type-registry.json');
const check = process.argv.slice(2).join(' ') === '--check';
if (process.argv.length > 2 && !check) throw new Error('usage: generate-type-registry.mjs [--check]');
const previous = JSON.parse(readFileSync(file, 'utf8'));
if (previous.codkitTypeRegistry !== 1 || !Array.isArray(previous.entries)) throw new Error('registry version/entries are invalid');
const engineVersion = JSON.parse(readFileSync(join(root, 'packages/codkit/package.json'), 'utf8')).version;
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (!existsSync(npmCli)) throw new Error('run through npm so the installed npm CLI is known');
const ids = new Set();
const packages = new Set();
const entries = previous.entries.map((entry) => {
	if (typeof entry.id !== 'string' || typeof entry.package !== 'string' || ids.has(entry.id) || packages.has(entry.package))
		throw new Error('approved registration identities must be unique');
	ids.add(entry.id);
	packages.add(entry.package);
	const candidates = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces;
	if (JSON.stringify(candidates) !== '["packages/*"]') throw new Error('registry refresh requires the declared packages/* workspace');
	const packageRoot = realpathSync(join(root, 'node_modules', ...entry.package.split('/')));
	const fromRoot = relative(root, packageRoot);
	if (!fromRoot.startsWith(`packages${process.platform === 'win32' ? '\\' : '/'}`))
		throw new Error(`approved package ${entry.package} is not a source workspace package`);
	const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
	const manifestBytes = readFileSync(join(packageRoot, 'type-manifest.json'));
	const checked = validateTypeManifest(JSON.parse(manifestBytes.toString('utf8')), {
		id: entry.id,
		package: entry.package,
		version: pkg.version,
		engineVersion
	});
	if (!checked.ok) throw new Error(checked.problem.message);
	if (pkg.name !== entry.package) throw new Error(`package identity mismatch: ${entry.package}`);
	if (
		!Array.isArray(pkg.files) ||
		pkg.files.some(
			(path) =>
				typeof path !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some((part) => part === '..' || part === '.')
		)
	)
		throw new Error('type packages must explicitly list contained literal publication roots');
	const integrityRoots = [...new Set(['package.json', ...pkg.files])].sort();
	const packed = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: packageRoot,
		encoding: 'utf8',
		windowsHide: true
	});
	if (packed.status !== 0) throw new Error(`cannot inspect shipped files for ${entry.package}: ${packed.stderr}`);
	const report = JSON.parse(packed.stdout)[0];
	const files = report.files
		.map((item) => {
			const path = item.path;
			const absolute = realpathSync(join(packageRoot, path));
			const inside = relative(packageRoot, absolute);
			if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || path.includes('\\'))
				throw new Error('package receipt leaves its root');
			return { path, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
		})
		.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
	return {
		id: entry.id,
		package: entry.package,
		version: pkg.version,
		contractVersion: checked.manifest.contractVersion,
		manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
		integrityRoots,
		files
	};
});
const bytes = `${JSON.stringify({ codkitTypeRegistry: 1, entries }, null, 2)}\n`;
if (check && readFileSync(file, 'utf8') !== bytes) {
	process.stderr.write('type registry receipts are stale; run npm run types:refresh\n');
	process.exitCode = 1;
} else if (!check) writeFileSync(file, bytes, 'utf8');
if (!process.exitCode)
	process.stdout.write(
		`installation type registry: ${entries.length} approved packages, ${entries.reduce((total, entry) => total + entry.files.length, 0)} file receipts${check ? ' match' : ' refreshed'}\n`
	);
