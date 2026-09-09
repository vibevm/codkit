/** @scope spec://codkit/modules/codkit/PROP-007#cmd-reresolve */
// `codkit reresolve`: one locked replay of an old feature patch over the current
// fork-tree file. All merge/ref decisions live in lib/reresolve.ts.
import { commandFlagValue, EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, forkResolution, requireProjectType } from '../lib/command.js';
import { loadConventions } from '../lib/conventionsFile.js';
import { treeId } from '../lib/fingerprint.js';
import { withLock } from '../lib/lock.js';
import { ckError, isCkError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { runReresolve } from '../lib/reresolve.js';
import { checkTree } from '../lib/treeIdentity.js';
const PATCH = '--patch';
const CHECK_FAILURES = new Set(['ARTIFACT-BROKEN', 'CRLF', 'ENCODING', 'EOF-NEWLINE', 'MARKER-ARTIFACT-MISMATCH', 'STALE-ARTIFACT']);
async function run(ctx) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    const config = requireConfig(ctx.config);
    const target = ctx.args[0];
    if (target === undefined || target === '') {
        throw ckError('CONFIG', 'reresolve needs the fork-tree file to replay into', 'usage: codkit reresolve <file> [--patch <contained-old-patch>]');
    }
    const identity = checkTree(resolution, config, { mode: 'write', type: requireProjectType(ctx) });
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    return withLock(ctx.patchesDir, treeId(resolution.path), 'reresolve', () => runLocked(ctx, resolution.path, target), (text) => ctx.out.warn(text));
}
function runLocked(ctx, treeDir, target) {
    try {
        const result = runReresolve({
            patchesDir: ctx.patchesDir,
            treeDir,
            target,
            explicitPatch: commandFlagValue(ctx.commandFlags, PATCH),
            conventions: loadConventions(requireProjectType(ctx), ctx.patchesDir)
        });
        ctx.out.setData(dataOf(result));
        ctx.out.info(`${result.target}: ${result.outcome} from ${result.patchSource}`);
        ctx.out.info(`next: ${result.nextAction}`);
        if (result.outcome === 'target-deleted') {
            ctx.out.addError(ckError('STALE-ARTIFACT', `${result.target} was deleted from the current tree`, `${result.nextAction}; checked sources: ${result.checkedSources.join(' -> ')}`, result.patchArtifact).toPayload());
            return EXIT_CHECK_FAILED;
        }
        return result.outcome === 'conflict' ? EXIT_CHECK_FAILED : EXIT_OK;
    }
    catch (error) {
        if (!isCkError(error))
            throw error;
        ctx.out.addError(error.toPayload());
        return CHECK_FAILURES.has(error.code) ? EXIT_CHECK_FAILED : EXIT_ENVIRONMENT;
    }
}
function dataOf(result) {
    return {
        target: result.target,
        patch: { artifact: result.patchArtifact, source: result.patchSource },
        checkedSources: [...result.checkedSources],
        replay: { outcome: result.outcome, conflictCount: result.conflictCount },
        nextAction: result.nextAction
    };
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found: reresolve needs the fork tree and patch conventions', 'run reresolve from a patchset checkout');
    }
    return config;
}
export const reresolveCommand = {
    name: 'reresolve',
    summary: 'replay an old feature patch over the current fork-tree file',
    configMode: 'load',
    maxArgs: 1,
    commandFlags: [PATCH],
    run
};
