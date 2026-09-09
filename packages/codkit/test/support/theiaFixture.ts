// The runnable half of the third polygon: the synthetic Theia monorepo, its
// patch set, a fork tree cloned from it, and a runner for the real CLI
// (FEAT-001 ##POLYGON-THEIA-IS-SYNTHETIC).
//
// It is the Theia twin of `makeGenericFixture`: the three roots live on
// unrelated temporary paths (PROP-013 ##TP-UNRELATED-PATHS) and the CLI is
// executed as a subprocess through the shipped launcher, so what runs is the
// real command with real argv parsing and real exit codes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectType as theiaType } from '@codkit/type-theia';
import { depsReceiptsOf } from '../../src/lib/ciEngine.ts';
import { runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { makeTheiaUpstream } from '../fixtures/makeTheiaUpstream.ts';
import type { TheiaUpstreamFixture } from '../fixtures/makeTheiaUpstream.ts';
import { makeTheiaPatchSet } from '../fixtures/makeTheiaPatchSet.ts';
import { runCli } from './cliFixture.ts';
import type { Envelope, Run } from './cliFixture.ts';
import { makeTempRoot } from './tmp.ts';

export type TheiaFixture = {
	readonly upstream: TheiaUpstreamFixture;
	readonly patchesDir: string;
	readonly treeDir: string;
	/** Full branch name of the generated branch at the fixture pin. */
	readonly branch: string;
	readonly run: (args: readonly string[], env?: Readonly<Record<string, string>>) => Run;
	readonly json: (args: readonly string[], env?: Readonly<Record<string, string>>) => { run: Run; envelope: Envelope };
	readonly git: (args: readonly string[], env?: GitEnv) => { status: number; stdout: string; stderr: string };
	readonly patchGit: (args: readonly string[]) => { status: number; stdout: string; stderr: string };
	readonly treePath: (relative: string) => string;
	readonly patchesPath: (relative: string) => string;
};

export function makeTheiaFixture(label: string): TheiaFixture {
	const upstream = makeTheiaUpstream(makeTempRoot(`${label}-upstream`));
	const patchesDir = makeTempRoot(`${label}-patchset`);
	makeTheiaPatchSet(patchesDir, upstream);

	const treeDir = join(makeTempRoot(`${label}-tree`), 'fork-tree');
	mkdirSync(dirname(treeDir), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', upstream.dir, treeDir], cwd: dirname(treeDir), netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', upstream.v1.sha], cwd: treeDir });

	const run = (args: readonly string[], env?: Readonly<Record<string, string>>): Run =>
		runCli(patchesDir, ['--patches-dir', patchesDir, '--fork-dir', treeDir, ...args], env);

	return {
		upstream,
		patchesDir,
		treeDir,
		branch: `codkit/applied/${upstream.v1.tag}`,
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

/**
 * Exclude codkit's runtime state from the pseudo-patchset repository, the way a
 * real patch-set repository does; without it the cycle refuses to build on a
 * dirty work tree.
 */
export function excludeTheiaRuntimeState(fixture: TheiaFixture): void {
	writeFileSync(join(fixture.patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
}

/**
 * What the tree needs before a build profile runs over it: the npm receipts that
 * stand in for an offline dependency cache. They live under `node_modules/`,
 * which is in the cleanup whitelist of the type, so a fresh pass leaves them
 * where they are (##THEIA-CLEANUP-WHITELIST). Nothing here installs a `lerna`:
 * the type runs the scripts of the own package by workspace, because a package
 * the tool excludes from git is invisible to `lerna --scope` (##THEIA-LINT).
 */
export function provideTheiaTreeDependencies(fixture: TheiaFixture): void {
	for (const relative of depsReceiptsOf(theiaType.build.dependencyRoots)) {
		const path = fixture.treePath(relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, '{"lockfileVersion":3}\n', 'utf8');
	}
}
