/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Exact final fork proof kept separate from resolve orchestration.

import type { CodkitConfig } from './configFile.ts';
import { deltaFingerprint, treeId } from './fingerprint.ts';
import type { ForkDirResolution } from './paths.ts';
import type { Output } from './jsonOut.ts';
import { ckError } from './messages.ts';
import { runSync } from './syncEngine.ts';
import { fastPathOk, readTreeCache, readTreeMark } from './treeCache.ts';

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

export function recoverCycleResolveTree(patchesDir: string, resolution: ForkDirResolution, config: CodkitConfig, out: Output): void {
	const result = runSync({
		patchesDir,
		resolution,
		config,
		out,
		fresh: false,
		dryRun: false,
		verbose: false,
		forceApply: true
	});
	if (result.exitCode !== 0) throw ckError('ARTIFACT-BROKEN', `forced resolve load failed with ${result.status}`);
}
