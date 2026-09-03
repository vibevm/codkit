// A full fixture triple for the e2e tests: a pseudo-upstream, a pseudo-patchset
// and a fork tree cloned from the former, plus a runner for the real CLI.
//
// PROP-013 ##TP-UNRELATED-PATHS: the three live on unrelated temporary paths, so
// nothing can quietly rely on them being neighbours, and no test ever touches a
// real fork tree. The CLI is executed as a subprocess through the shipped
// launcher, with CODKIT_PATCHES_DIR pointing at the fixture, so what runs is the
// real command with real argv parsing and real exit codes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPS_REQUIRED_RECEIPTS } from '../../src/lib/ciEngine.ts';
import { runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import type { PublicErrorPayload } from '../../src/lib/messages.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { makeTempRoot } from './tmp.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const launcher = join(repoRoot, 'codkit', 'bin', 'codkit.mjs');
export const CODKIT_E2E_TEST_BUILD = 'CODKIT_E2E_TEST_BUILD';
export const CODKIT_E2E_TIMEOUT_MS = 'CODKIT_E2E_TIMEOUT_MS';

export type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

/** The `--json` envelope of PROP-012 sec. 1, as the tests read it. */
export type Envelope = {
	ok: boolean;
	exitCode: number;
	roots: {
		tool: { path: string; source: string; exists: boolean };
		patches: { path: string; source: string; exists: boolean } | null;
		fork: { path: string; source: string; exists: boolean } | null;
	};
	data: Record<string, unknown>;
	messages: { level: string; code?: string; text: string }[];
	errors: PublicErrorPayload[];
};

export type CliFixture = {
	readonly upstream: UpstreamFixture;
	readonly patchesDir: string;
	readonly treeDir: string;
	/** Full branch name of the generated branch at the fixture pin. */
	readonly branch: string;
	/**
	 * Run the CLI in human mode; --fork-dir is added for you. `env` adds
	 * variables to the run - the build tests use it to tell the stub watcher of
	 * the fixture tree which kind of pass to print, the way a real tree's
	 * daemons are configured by their environment.
	 */
	readonly run: (args: readonly string[], env?: Readonly<Record<string, string>>) => Run;
	/** Run the CLI with --json and parse the envelope. */
	readonly json: (args: readonly string[], env?: Readonly<Record<string, string>>) => { run: Run; envelope: Envelope };
	/** git in the fork tree. */
	readonly git: (args: readonly string[], env?: GitEnv) => { status: number; stdout: string; stderr: string };
	/** git in the pseudo-patchset repository. */
	readonly patchGit: (args: readonly string[]) => { status: number; stdout: string; stderr: string };
	/** Absolute path of a tree-relative path. */
	readonly treePath: (relative: string) => string;
	/** Absolute path of a patchset-relative path. */
	readonly patchesPath: (relative: string) => string;
};

export function makeCliFixture(label: string): CliFixture {
	const upstream = makeUpstream(makeTempRoot(`${label}-upstream`));
	const patchesDir = makeTempRoot(`${label}-patchset`);
	makePatchSet(patchesDir, upstream);

	const treeDir = join(makeTempRoot(`${label}-tree`), 'fork-tree');
	mkdirSync(dirname(treeDir), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', upstream.dir, treeDir], cwd: dirname(treeDir), netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', upstream.t1.sha], cwd: treeDir });

	const run = (args: readonly string[], env?: Readonly<Record<string, string>>): Run =>
		runCli(patchesDir, ['--patches-dir', patchesDir, '--fork-dir', treeDir, ...args], env);

	return {
		upstream,
		patchesDir,
		treeDir,
		branch: `codkit/applied/${upstream.t1.tag}`,
		run,
		json: (args: readonly string[], env?: Readonly<Record<string, string>>) => {
			const outcome = run(['--json', ...args], env);
			return { run: outcome, envelope: JSON.parse(outcome.stdout) as Envelope };
		},
		git: (args, env) => runGit(env === undefined ? { args, cwd: treeDir } : { args, cwd: treeDir, env }),
		patchGit: (args) => runGit({ args, cwd: patchesDir }),
		treePath: (relative) => join(treeDir, ...relative.split('/')),
		patchesPath: (relative) => join(patchesDir, ...relative.split('/'))
	};
}

/** Materialize the npm receipts that stand in for an offline dependency cache. */
export function provideTreeDependencies(fixture: CliFixture): void {
	for (const relative of DEPS_REQUIRED_RECEIPTS) {
		const path = fixture.treePath(relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, '{"lockfileVersion":3}\n', 'utf8');
	}
}

/** The launcher, with the environment an e2e run needs and nothing else. */
export function runCli(patchesDir: string, args: readonly string[], extra?: Readonly<Record<string, string>>): Run {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	// Ambient root variables inherited from the developer's shell would silently
	// redirect every test at a real tree.
	delete env['CODKIT_FORK_DIR'];
	delete env['CODKIT_PATCHES_DIR'];
	delete env['CODKIT_PATCHES_DIR'];
	Object.assign(env, extra ?? {});
	const testBuild = env[CODKIT_E2E_TEST_BUILD] === '1';
	delete env[CODKIT_E2E_TEST_BUILD];
	const timeoutText = env[CODKIT_E2E_TIMEOUT_MS];
	const timeoutMs = timeoutText === undefined || timeoutText === '' ? undefined : Number.parseInt(timeoutText, 10);
	const result = spawnSync(process.execPath, [...(testBuild ? ['--conditions=codkit-test'] : []), launcher, ...args], {
		cwd: patchesDir,
		env,
		encoding: 'utf8',
		...(timeoutMs === undefined || !Number.isInteger(timeoutMs) || timeoutMs <= 0
			? {}
			: { timeout: timeoutMs + 5_000, killSignal: 'SIGKILL' })
	});
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
