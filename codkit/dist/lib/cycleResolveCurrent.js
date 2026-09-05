/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Exact final fork proof kept separate from resolve orchestration.
import { deltaFingerprint, treeId } from './fingerprint.js';
import { ckError } from './messages.js';
import { runSync } from './syncEngine.js';
import { fastPathOk, readTreeCache, readTreeMark } from './treeCache.js';
export function cycleResolveTreeCurrent(patchesDir, resolution, config) {
    const fingerprint = deltaFingerprint(patchesDir, config.pin.sha);
    const mark = readTreeMark(resolution.path);
    const cache = readTreeCache(patchesDir, treeId(resolution.path));
    return (mark !== null &&
        cache !== null &&
        fastPathOk({
            treeDir: resolution.path,
            branch: `${config.generatedBranchPrefix}${config.pin.tag}`,
            cache,
            mark,
            pinSha: config.pin.sha,
            deltaFingerprint: fingerprint
        }).ok);
}
export function recoverCycleResolveTree(patchesDir, resolution, config, out) {
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
    if (result.exitCode !== 0)
        throw ckError('ARTIFACT-BROKEN', `forced resolve load failed with ${result.status}`);
}
