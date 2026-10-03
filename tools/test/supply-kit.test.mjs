import { equal, deepStrictEqual, match } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TYPE_REGISTRY } from '../../packages/codkit/src/types/registry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

function isolated(run) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), 'codkit-supply-check-')));
	try {
		return run(directory);
	} finally {
		const fromTemporary = relative(realpathSync(tmpdir()), directory);
		if (!fromTemporary.startsWith('codkit-supply-check-') || fromTemporary.includes('/') || fromTemporary.includes('\\'))
			throw new Error('cleanup target is outside its temporary directory');
		rmSync(directory, { recursive: true, force: true });
	}
}

function build(out) {
	return spawnSync(process.execPath, [npmCli, 'run', 'kit', '--', '--out', out], {
		cwd: root,
		encoding: 'utf8',
		timeout: 60_000,
		windowsHide: true
	});
}

test('supply kit contains the complete registration unit with verified tarball hashes', () =>
	isolated((directory) => {
		equal(existsSync(npmCli), true, 'run through npm run supply:check or provide the installed npm CLI');
		const out = join(directory, 'kit');
		const built = build(out);
		equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
		const manifest = JSON.parse(readFileSync(join(out, 'kit-manifest.json'), 'utf8'));
		equal(manifest.codkitSupplyKit, 1);
		deepStrictEqual(
			manifest.packages.map((row) => row.role),
			['cli', 'contract', ...Array(TYPE_REGISTRY.size).fill('type')]
		);
		equal(manifest.packages[1].name, '@codkit/type-api');
		deepStrictEqual(
			manifest.packages
				.filter((row) => row.role === 'type')
				.map((row) => row.type)
				.sort(),
			[...TYPE_REGISTRY.keys()].sort()
		);
		for (const row of manifest.packages) {
			const bytes = readFileSync(join(out, row.file));
			equal(bytes.length, row.bytes);
			equal(createHash('sha256').update(bytes).digest('hex'), row.sha256);
			match(manifest.install.command, new RegExp(row.file.replaceAll('.', '\\.')));
		}
		equal(readdirSync(out).length, manifest.packages.length + 1);
	}));

test('kit preparation refuses a foreign file and preserves its exact bytes', () =>
	isolated((directory) => {
		const out = join(directory, 'foreign');
		mkdirSync(out);
		writeFileSync(join(out, 'customer.txt'), 'keep these bytes\n');
		const built = build(out);
		equal(built.status, 2);
		match(built.stderr, /refusing to write the kit/);
		equal(readFileSync(join(out, 'customer.txt'), 'utf8'), 'keep these bytes\n');
	}));
