// The runnable half of the second polygon: the synthetic upstream, its patch
// set, a fork tree cloned from the upstream, and a runner for the real CLI
// (FEAT-001 ##POLYGON-GENERIC-IS-SYNTHETIC).
//
// It is the generic twin of `makeCliFixture`: the three roots live on unrelated
// temporary paths (PROP-013 ##TP-UNRELATED-PATHS) and the CLI is executed as a
// subprocess through the shipped launcher, so what runs is the real command
// with real argv parsing and real exit codes.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEPS_REQUIRED_RECEIPTS } from '../../src/lib/ciEngine.ts';
import { runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { makeGenericUpstream } from '../fixtures/makeGenericUpstream.ts';
import type { GenericUpstreamFixture } from '../fixtures/makeGenericUpstream.ts';
import { makeGenericPatchSet } from '../fixtures/makeGenericPatchSet.ts';
import { runCli } from './cliFixture.ts';
import type { Envelope, Run } from './cliFixture.ts';
import { makeTempRoot } from './tmp.ts';

export type GenericFixture = {
	readonly upstream: GenericUpstreamFixture;
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

export function makeGenericFixture(label: string): GenericFixture {
	const upstream = makeGenericUpstream(makeTempRoot(`${label}-upstream`));
	const patchesDir = makeTempRoot(`${label}-patchset`);
	makeGenericPatchSet(patchesDir, upstream);

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
 * Exclude codkit's runtime state from the pseudo-patchset repository. The
 * generated fixture intentionally has no tracked `.gitignore`; a real patch-set
 * repository excludes `.codkit/`, and the cycle refuses to build on a dirty
 * work tree without it.
 */
export function excludeGenericRuntimeState(fixture: GenericFixture): void {
	writeFileSync(join(fixture.patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
}

/** Materialize the npm receipts that stand in for an offline dependency cache. */
export function provideGenericTreeDependencies(fixture: GenericFixture): void {
	for (const relative of DEPS_REQUIRED_RECEIPTS) {
		const path = fixture.treePath(relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, '{"lockfileVersion":3}\n', 'utf8');
	}
}
