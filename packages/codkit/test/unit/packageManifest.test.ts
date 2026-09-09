// Distribution contract, per workspace package: every published package's npm
// tarball contains the runnable half and its operator surfaces, while
// development-only tests and spec machinery stay out. The workspace root is
// private and publishes nothing; the supply kit is the set of these tarballs
// (PROP-016 ##TYPE-SUPPLY-KIT).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(packageRoot, '..', '..');
const packagesDir = join(repoRoot, 'packages');

interface PackedFile {
	readonly path: string;
	readonly mode: number;
}

interface PackReport {
	readonly name: string;
	readonly files: readonly PackedFile[];
	readonly entryCount: number;
	readonly size: number;
	readonly unpackedSize: number;
}

interface Manifest {
	readonly name?: unknown;
	readonly version?: unknown;
	readonly private?: unknown;
	readonly bin?: Readonly<Record<string, string>>;
	readonly engines?: Readonly<Record<string, string>>;
}

/** Paths no published package may carry, whichever package it is. */
const DEVELOPMENT_ONLY = ['test/', 'discipline/', 'tools/', 'vibevm/vibedeps/', 'vibevm/vibespecs/boot/'];

/** The files each package must carry, keyed by package name. */
const REQUIRED: ReadonlyMap<string, readonly string[]> = new Map([
	[
		'codkit',
		[
			'package.json',
			'npm-shrinkwrap.json',
			'README.md',
			'LICENSE.md',
			'bin/codkit',
			'bin/codkit.ps1',
			'bin/codkit.mjs',
			'dist/main.js',
			'src/main.ts',
			'config/conventions.json',
			'config/build-watch.json',
			'config/license-policy.json',
			'config/spdx-license-ids.json',
			'hooks/pretool.mjs',
			'claude/settings.json',
			// The standards package ships in the tarball, licence carriers and all
			// (PROP-014 ##STD-PACKAGE-SHIPS-IN-THE-TARBALL); the policy and the SPDX
			// identifier list are the data its check reads.
			'vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/LICENSE',
			'vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/vibe.toml',
			'vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/THIRD-PARTY-NOTICES.md',
			'vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/assets/codkit.png.license',
			// The agent skills ship as a package of their own (PROP-014 sec. 1a);
			// the resolver's journal helper travels inside it.
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v1.0.0/LICENSE',
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v1.0.0/vibe.toml',
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v1.0.0/vibevm/vibespecs/skills/ck-orient/SKILL.md',
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v1.0.0/vibevm/vibespecs/skills/ck-resolve/scripts/append-journal.mjs',
			'runtime/v1.0.0/README.md',
			'runtime/v1.0.0/common/version.ts',
			'runtime/v1.0.0/browser/featureFlags.contribution.ts'
		]
	]
]);

/** The executables each package must keep executable in the tarball. */
const EXECUTABLE: ReadonlyMap<string, readonly string[]> = new Map([['codkit', ['bin/codkit.mjs', 'bin/codkit']]]);

/** Every workspace package directory, in name order. */
function workspacePackages(): readonly { readonly directory: string; readonly manifest: Manifest }[] {
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
		.map((entry) => join(packagesDir, entry.name))
		.sort()
		.map((directory) => ({ directory, manifest: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest }));
}

function packReport(name: string): PackReport {
	const result = spawnSync('npm', ['pack', '--dry-run', '--json', '-w', name], { cwd: repoRoot, encoding: 'utf8' });
	expect(result.status, result.stderr).toBe(0);
	const [report] = JSON.parse(result.stdout) as readonly PackReport[];
	expect(report, name).toBeDefined();
	if (report === undefined) throw new Error(`npm pack reported nothing for ${name}`);
	return report;
}

function vibeProjectVersion(): string {
	const vibeToml = readFileSync(join(repoRoot, 'vibe.toml'), 'utf8');
	const projectBlock = vibeToml.split(/\n(?=\[)/, 1)[0] ?? '';
	return /^version = "([^"]+)"$/m.exec(projectBlock)?.[1] ?? '';
}

const packages = workspacePackages();

describe('the npm workspace', () => {
	it('has a private root that publishes nothing and holds every package under packages/', () => {
		const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Manifest & { workspaces?: unknown };
		expect(root.private).toBe(true);
		expect(root.workspaces).toEqual(['packages/*']);
		expect(packages.length).toBeGreaterThan(0);
	});

	it('carries every package at the one development version, aligned with the Vibe project', () => {
		const version = vibeProjectVersion();
		expect(version.length).toBeGreaterThan(0);
		for (const entry of packages) {
			expect(entry.manifest.version, entry.directory).toBe(version);
			expect(entry.manifest.engines, entry.directory).toEqual({ node: '>=22.6.0' });
		}
	});

	it('names the CLI binary relative to the CLI package root', () => {
		const cli = packages.find((entry) => entry.manifest.name === 'codkit');
		expect(cli).toBeDefined();
		expect(cli?.manifest.bin).toEqual({ codkit: 'bin/codkit.mjs' });
	});
});

describe.each(packages.map((entry) => [String(entry.manifest.name), entry.directory] as const))(
	'npm distribution of %s',
	(name, directory) => {
		const report = packReport(name);
		const files = new Map(report.files.map((file) => [file.path, file]));

		it('packs the files the package is required to ship', () => {
			for (const path of REQUIRED.get(name) ?? ['package.json', 'LICENSE.md']) {
				expect(files.has(path), `${name}: ${path}`).toBe(true);
			}
		});

		it('keeps its executables executable', () => {
			for (const path of EXECUTABLE.get(name) ?? []) {
				expect((files.get(path)?.mode ?? 0) & 0o111, `${name}: ${path}`).not.toBe(0);
			}
		});

		it('stays a bounded, cross-platform payload with no development-only path', () => {
			expect(report.entryCount).toBeLessThan(640);
			expect(report.size).toBeLessThan(2_000_000);
			expect(report.unpackedSize).toBeLessThan(50_000_000);
			for (const path of files.keys()) {
				expect(
					DEVELOPMENT_ONLY.some((prefix) => path.startsWith(prefix)),
					`${name}: ${path}`
				).toBe(false);
			}
		});

		it('has no broken relative link in the markdown it ships', () => {
			for (const path of files.keys()) {
				if (!path.endsWith('.md')) continue;
				const markdown = readFileSync(resolve(directory, path), 'utf8');
				for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
					const raw = match[1]?.trim() ?? '';
					const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
					if (target === '' || target.startsWith('#') || target.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) continue;
					const withoutFragment = decodeURIComponent(target.split('#', 1)[0]?.split('?', 1)[0] ?? '');
					const packedTarget = posix.normalize(posix.join(posix.dirname(path), withoutFragment)).replace(/\/$/, '');
					// A link that leaves the package points at the repository the
					// package is developed in; it is checked there instead.
					const escapes = packedTarget.startsWith('..');
					const found = escapes
						? existsSync(resolve(directory, packedTarget))
						: files.has(packedTarget) || [...files.keys()].some((candidate) => candidate.startsWith(`${packedTarget}/`));
					expect(found, `${name}: ${path} -> ${target}`).toBe(true);
				}
			}
		});
	}
);
