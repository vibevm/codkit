// Distribution contract: the npm tarball contains the runnable tool and its
// operator surfaces, while development-only tests/spec machinery stays out.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface PackedFile {
	readonly path: string;
	readonly mode: number;
}

interface PackReport {
	readonly entryCount: number;
	readonly size: number;
	readonly unpackedSize: number;
	readonly files: readonly PackedFile[];
}

describe('npm distribution', () => {
	it('keeps the npm and Vibe project versions aligned', () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
			version?: unknown;
			bin?: Readonly<Record<string, string>>;
			engines?: Readonly<Record<string, string>>;
		};
		const vibeToml = readFileSync(resolve(repoRoot, 'vibe.toml'), 'utf8');
		const projectBlock = vibeToml.split(/\n(?=\[)/, 1)[0] ?? '';
		const vibeVersion = /^version = "([^"]+)"$/m.exec(projectBlock)?.[1];

		expect(typeof manifest.version).toBe('string');
		expect(vibeVersion).toBe(manifest.version);
		expect(manifest.bin).toEqual({ codkit: 'codkit/bin/codkit.mjs' });
		expect(manifest.engines).toEqual({ node: '>=22.6.0' });
	});

	it('packs a bounded, cross-platform runtime payload', () => {
		const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
			cwd: repoRoot,
			encoding: 'utf8'
		});
		expect(result.status, result.stderr).toBe(0);

		const [report] = JSON.parse(result.stdout) as readonly PackReport[];
		expect(report).toBeDefined();
		const files = new Map(report?.files.map((file) => [file.path, file]) ?? []);

		for (const path of [
			'package.json',
			'npm-shrinkwrap.json',
			'README.md',
			'LICENSE.md',
			'AUDIT.md',
			'AGENTS.md',
			'CLAUDE.md',
			'codkit/bin/codkit.mjs',
			'codkit/dist/main.js',
			'codkit/src/main.ts',
			'codkit/config/conventions.json',
			'codkit/config/build-watch.json',
			'codkit/hooks/pretool.mjs',
			'bin/codkit',
			'bin/codkit.ps1',
			'codkit/claude/settings.json',
			'vibevm/vibespecs/common/PROP-000-foundations.xml',
			'vibevm/vibespecs/modules/codkit/PROP-003-config-and-data.xml',
			// The standards package ships in the tarball, licence carriers and all
			// (PROP-014 ##STD-PACKAGE-SHIPS-IN-THE-TARBALL); the policy and the SPDX
			// identifier list are the data its check reads.
			'codkit/config/license-policy.json',
			'codkit/config/spdx-license-ids.json',
			'vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/LICENSE',
			'vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/vibe.toml',
			'vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/THIRD-PARTY-NOTICES.md',
			'vibevm/vibepacks/org.vibevm.codkit/standards/v0.2.0/assets/codkit.png.license',
			// The agent skills ship as a package of their own (PROP-014 sec. 1a);
			// the resolver's journal helper travels inside it.
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v0.1.0/LICENSE',
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v0.1.0/vibe.toml',
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v0.1.0/vibevm/vibespecs/skills/ck-orient/SKILL.md',
			'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v0.1.0/vibevm/vibespecs/skills/ck-resolve/scripts/append-journal.mjs',
			'codkit/runtime/v0.1.1/README.md',
			'codkit/runtime/v0.1.1/common/version.ts',
			'codkit/runtime/v0.1.1/browser/featureFlags.contribution.ts'
		]) {
			expect(files.has(path), path).toBe(true);
		}

		expect((files.get('codkit/bin/codkit.mjs')?.mode ?? 0) & 0o111).not.toBe(0);
		expect(report?.entryCount).toBeLessThan(640);
		expect(report?.size).toBeLessThan(2_000_000);
		expect(report?.unpackedSize).toBeLessThan(50_000_000);

		const developmentOnly = ['codkit/test/', 'discipline/', 'tools/', 'vibevm/vibedeps/', 'vibevm/vibespecs/boot/'];
		for (const path of files.keys()) {
			expect(
				developmentOnly.some((prefix) => path.startsWith(prefix)),
				path
			).toBe(false);
		}

		for (const path of files.keys()) {
			if (!path.endsWith('.md')) continue;
			const markdown = readFileSync(resolve(repoRoot, path), 'utf8');
			for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
				const raw = match[1]?.trim() ?? '';
				const target = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
				if (target === '' || target.startsWith('#') || target.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) continue;
				const withoutFragment = decodeURIComponent(target.split('#', 1)[0]?.split('?', 1)[0] ?? '');
				const packedTarget = posix.normalize(posix.join(posix.dirname(path), withoutFragment)).replace(/\/$/, '');
				const existsAsFile = files.has(packedTarget);
				const existsAsDirectory = [...files.keys()].some((candidate) => candidate.startsWith(`${packedTarget}/`));
				expect(existsAsFile || existsAsDirectory, `${path} -> ${target}`).toBe(true);
			}
		}
	});
});
