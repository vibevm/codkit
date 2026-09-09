/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Exact final fork proof kept separate from resolve orchestration.

import type { CodkitConfig } from './configFile.ts';
import { deltaFingerprint, treeId } from './fingerprint.ts';
import type { ForkDirResolution } from './paths.ts';
import type { Output } from './jsonOut.ts';
import { ckError } from './messages.ts';
import { runSync } from './syncEngine.ts';
import { fastPathOk, readTreeCache, readTreeMark } from './treeCache.ts';
import type { ProjectType } from '@codkit/type-api';

export function cycleResolveTreeCurrent(patchesDir: string, resolution: ForkDirResolution, config: CodkitConfig): boolean {
	const fingerprint = deltaFingerprint(patchesDir, config.pin.sha);
	const mark = readTreeMark(resolution.path);
	const cache = readTreeCache(patchesDir, treeId(resolution.path));
	return (
		mark !== null &&
		cache !== null &&
		fastPathOk({
			treeDir: resolution.path,
			branch: `${config.generatedBranchPrefix}${config.pin.tag}`,
			cache,
			mark,
			pinSha: config.pin.sha,
			deltaFingerprint: fingerprint
		}).ok
	);
}

/** The forced load a clean-tree recovery performs (##PHASE-RESOLVE). */
export function recoverCycleResolveTree(input: {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	readonly type: ProjectType;
	readonly out: Output;
}): void {
	const result = runSync({
		patchesDir: input.patchesDir,
		resolution: input.resolution,
		config: input.config,
		type: input.type,
		out: input.out,
		fresh: false,
		dryRun: false,
		verbose: false,
		forceApply: true
	});
	if (result.exitCode !== 0) throw ckError('ARTIFACT-BROKEN', `forced resolve load failed with ${result.status}`);
}
