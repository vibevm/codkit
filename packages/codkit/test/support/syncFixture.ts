// A fixture pair plus a real fork tree, for the unit tests that need a tree in
// a known applied state (the fast-path rule and the drift guard).
//
// The tree is a clone of the pseudo-upstream detached at the pin - never the
// upstream fixture directory itself, and never a real tree (PROP-013
// ##TP-UNRELATED-PATHS). The sync runs in-process, so the tests are fast and can
// look at the engine's own result rather than at parsed output.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import type { ForkDirResolution } from '../../src/lib/paths.ts';
import { runSync } from '../../src/lib/syncEngine.ts';
import type { SyncResult } from '../../src/lib/syncEngine.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { makeTempRoot } from './tmp.ts';

export type SyncFixture = {
	readonly upstream: UpstreamFixture;
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly config: CodkitConfig;
	readonly resolution: ForkDirResolution;
	/** Run the engine once; output goes nowhere unless `collect` is passed. */
	readonly sync: (options?: {
		readonly fresh?: boolean;
		readonly dryRun?: boolean;
		/** Channel 2 of the config-overlay layer, as `ci` and `publish` run it. */
		readonly materializeOverlays?: boolean;
	}) => SyncResult;
	/** Everything the last sync printed, newest run last. */
	readonly messages: string[];
};

export function makeSyncFixture(label: string): SyncFixture {
	const upstream = makeUpstream(makeTempRoot(`${label}-upstream`));
	const patchesDir = makeTempRoot(`${label}-patchset`);
	makePatchSet(patchesDir, upstream);

	const treeDir = join(makeTempRoot(`${label}-tree`), 'fork-tree');
	mkdirSync(dirname(treeDir), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', upstream.dir, treeDir], cwd: dirname(treeDir), netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', upstream.t1.sha], cwd: treeDir });

	const config = loadConfig(patchesDir);
	if (config === null) {
		throw new Error('fixture patchset has no codkit.json');
	}
	const resolution: ForkDirResolution = { path: treeDir, source: 'flag', exists: true, warning: null };
	const messages: string[] = [];
	const out = new Output({
		command: 'load',
		version: '0.0.0',
		jsonMode: false,
		streams: {
			writeOut: (chunk) => messages.push(chunk.trimEnd()),
			writeErr: (chunk) => messages.push(chunk.trimEnd())
		}
	});

	return {
		upstream,
		patchesDir,
		treeDir,
		config,
		resolution,
		messages,
		sync: (options = {}) =>
			runSync({
				patchesDir,
				resolution,
				config,
				out,
				fresh: options.fresh ?? false,
				dryRun: options.dryRun ?? false,
				verbose: false,
				materializeOverlays: options.materializeOverlays ?? false
			})
	};
}
