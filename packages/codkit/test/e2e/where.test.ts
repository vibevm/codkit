import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = join(toolRoot, 'bin', 'codkit.mjs');

type Run = { status: number; stdout: string; stderr: string };
type Root = { path: string; source: string; exists: boolean };
type Envelope = {
	codkit: { schema: number; command: string; version: string };
	ok: boolean;
	exitCode: number;
	roots: { tool: Root; patches: Root | null; fork: Root | null };
	data: { patches: Root | null; fork: Root | null };
	errors: unknown[];
};

function runCli(args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Run {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	delete env['CODKIT_FORK_DIR'];
	delete env['CODKIT_PATCHES_DIR'];
	delete env['CODKIT_PATCHES_DIR'];
	env['HOME'] = makeTempRoot('home');
	Object.assign(env, extraEnv);
	const result = spawnSync(process.execPath, [launcher, ...args], { cwd: toolRoot, env, encoding: 'utf8' });
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseEnvelope(stdout: string): Envelope {
	return JSON.parse(stdout) as Envelope;
}

afterEach(cleanupTempRoots);

describe('codkit where', () => {
	it('reports both independently resolved roots and schema 2', () => {
		const fork = makeTempRoot('fork');
		const patches = makeTempRoot('patches');
		const run = runCli(['where', '--json'], { CODKIT_FORK_DIR: fork, CODKIT_PATCHES_DIR: patches });
		expect(run.status).toBe(0);
		const envelope = parseEnvelope(run.stdout);
		expect(envelope.codkit).toMatchObject({ schema: 2, command: 'where' });
		expect(envelope.roots.tool).toEqual({ path: toolRoot, source: 'install', exists: true });
		expect(envelope.data).toEqual({
			patches: { path: patches, source: 'env', exists: true },
			fork: { path: fork, source: 'env', exists: true }
		});
		expect(envelope.errors).toEqual([]);
	});

	it('applies CLI > env > settings independently', () => {
		const home = makeTempRoot('settings-home');
		const settingsPath = join(home, '.codkit', 'settings.json');
		mkdirSync(dirname(settingsPath), { recursive: true });
		const settingsFork = makeTempRoot('settings-fork');
		const settingsPatches = makeTempRoot('settings-patches');
		writeFileSync(settingsPath, JSON.stringify({ codkitSettings: 1, forkDir: settingsFork, patchesDir: settingsPatches }));
		const envFork = makeTempRoot('env-fork');
		const flagPatches = makeTempRoot('flag-patches');
		const run = runCli(['where', '--json', '--patches-dir', flagPatches], { HOME: home, CODKIT_FORK_DIR: envFork });
		const data = parseEnvelope(run.stdout).data;
		expect(data.patches).toMatchObject({ path: flagPatches, source: 'flag' });
		expect(data.fork).toMatchObject({ path: envFork, source: 'env' });
	});

	it('reports unconfigured roots without inventing defaults', () => {
		const run = runCli(['where', '--json']);
		expect(run.status).toBe(0);
		expect(parseEnvelope(run.stdout).data).toEqual({ patches: null, fork: null });
	});

	it('resolves relative CLI roots from cwd', () => {
		const patches = makeTempRoot('relative-patches');
		const fork = makeTempRoot('relative-fork');
		const run = runCli(['where', '--json', '--patches-dir', relative(toolRoot, patches), '--fork-dir', relative(toolRoot, fork)]);
		expect(parseEnvelope(run.stdout).data).toEqual({
			patches: { path: patches, source: 'flag', exists: true },
			fork: { path: fork, source: 'flag', exists: true }
		});
	});

	it('rejects equal or nested patch-set and fork roots', () => {
		const parent = makeTempRoot('overlap-parent');
		const child = join(parent, 'child');
		mkdirSync(child);
		for (const [patches, fork] of [
			[parent, parent],
			[parent, child],
			[child, parent]
		] as const) {
			const run = runCli(['where', '--json', '--patches-dir', patches, '--fork-dir', fork]);
			expect(run.status).toBe(2);
			expect(run.stderr).toContain('must not be the same or nested');
			expect(parseEnvelope(run.stdout).roots).toMatchObject({
				tool: { path: toolRoot },
				patches: { path: patches },
				fork: { path: fork }
			});
		}
	});

	it('rejects either external root nested with the installed tool', () => {
		const outside = makeTempRoot('tool-overlap-other');
		for (const [patches, fork] of [
			[join(toolRoot, 'nested-patch-set'), outside],
			[outside, dirname(toolRoot)]
		] as const) {
			const run = runCli(['where', '--json', '--patches-dir', patches, '--fork-dir', fork]);
			expect(run.status).toBe(2);
			expect(run.stderr).toContain('must not be the same or nested');
		}
	});

	it('ignores malformed settings when both roots have higher-priority flags', () => {
		const home = makeTempRoot('shadowed-settings-home');
		mkdirSync(join(home, '.codkit'), { recursive: true });
		writeFileSync(join(home, '.codkit', 'settings.json'), '{broken');
		const patches = makeTempRoot('shadowed-settings-patches');
		const fork = makeTempRoot('shadowed-settings-fork');
		const run = runCli(['where', '--json', '--patches-dir', patches, '--fork-dir', fork], { HOME: home });
		expect(run.status).toBe(0);
		expect(parseEnvelope(run.stdout).data).toMatchObject({ patches: { path: patches }, fork: { path: fork } });
	});

	it('ignores only the malformed settings field shadowed by a higher-priority root', () => {
		const home = makeTempRoot('partly-shadowed-settings-home');
		mkdirSync(join(home, '.codkit'), { recursive: true });
		const fork = makeTempRoot('partly-shadowed-settings-fork');
		const patches = makeTempRoot('partly-shadowed-settings-patches');
		writeFileSync(
			join(home, '.codkit', 'settings.json'),
			`${JSON.stringify({ codkitSettings: 1, forkDir: fork, patchesDir: 'shadowed-relative' })}\n`
		);
		const run = runCli(['where', '--json', '--patches-dir', patches], { HOME: home });
		expect(run.status).toBe(0);
		expect(parseEnvelope(run.stdout).data).toMatchObject({ patches: { path: patches }, fork: { path: fork } });
	});

	it('keeps the installed tool root in JSON when settings fail before resolution', () => {
		const home = makeTempRoot('broken-settings-home');
		mkdirSync(join(home, '.codkit'), { recursive: true });
		writeFileSync(join(home, '.codkit', 'settings.json'), '{broken');
		const run = runCli(['where', '--json'], { HOME: home });
		expect(run.status).toBe(2);
		expect(parseEnvelope(run.stdout).roots).toEqual({
			tool: { path: toolRoot, source: 'install', exists: true },
			patches: null,
			fork: null
		});
	});
});

describe('codkit dispatch', () => {
	it('lists both location flags in help', () => {
		const run = runCli([]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain('--fork-dir');
		expect(run.stdout).toContain('--patches-dir');
	});

	it('rejects a missing patches-dir value', () => {
		const run = runCli(['where', '--patches-dir']);
		expect(run.status).toBe(2);
		expect(run.stderr).toContain('flag --patches-dir needs a path');
	});

	it('prints the external patch-set root before a tree-aware command fails', () => {
		const patches = makeTempRoot('human-preamble-patches');
		const fork = makeTempRoot('human-preamble-fork');
		const run = runCli(['check-tree', '--patches-dir', patches, '--fork-dir', fork]);
		expect(run.status).toBe(2);
		expect(run.stdout).toContain(`patches: ${patches} (source: flag)`);
		expect(run.stdout).toContain(`fork tree: ${fork} (source: flag)`);
	});
});
