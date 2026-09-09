/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
// Thin command surface for the library transaction.
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, forkResolution, requireProjectType } from '../lib/command.js';
import { ckError, isCkError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { rebaseOntoPin } from '../lib/rebaseOntoPin.js';
import { treeId } from '../lib/fingerprint.js';
import { withLock } from '../lib/lock.js';
import { checkTree, formatCheckLine } from '../lib/treeIdentity.js';
const FEATURE_FAILURE_CODES = new Set([
    'ARTIFACT-BROKEN',
    'ENCODING',
    'CRLF',
    'EOF-NEWLINE',
    'MARKER-MALFORMED',
    'MARKER-NESTED',
    'MARKER-UNBALANCED',
    'MARKER-UNCLOSED',
    'MARKER-DUP-ID',
    'MARKER-BAD-ID',
    'HUNK-OUTSIDE-MARKER',
    'DIRTY-TREE'
]);
async function run(ctx) {
    const config = requireConfig(ctx.config);
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    if (resolution.warning !== null)
        ctx.out.warn(resolution.warning);
    const identity = checkTree(resolution, config, { mode: 'write' });
    if (ctx.flags.verbose) {
        for (const check of identity.checks)
            ctx.out.diag(formatCheckLine(check));
    }
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    return withLock(ctx.patchesDir, treeId(resolution.path), 'rebase-onto-pin', () => {
        let result;
        try {
            result = rebaseOntoPin({
                patchesDir: ctx.patchesDir,
                resolution,
                config,
                type: requireProjectType(ctx),
                out: ctx.out,
                verbose: ctx.flags.verbose
            });
        }
        catch (error) {
            if (!isCkError(error) || !FEATURE_FAILURE_CODES.has(error.code))
                throw error;
            ctx.out.addError(error.toPayload());
            return EXIT_CHECK_FAILED;
        }
        for (const patch of result.patches) {
            const cause = patch.cause.sha === null ? 'none' : `${patch.cause.approx ? '~' : ''}${patch.cause.sha.slice(0, 8)}`;
            ctx.out.info(`${patch.outcome}: ${patch.artifactId} ${patch.sourceTarget} -> ${patch.targetPath} cause ${cause}`);
        }
        if (result.blockers.length > 0)
            ctx.out.info(`rebase blocked by ${result.blockers.length} conflict/deleted target(s)`);
        else
            ctx.out.info(`rebase saved ${result.patches.length} feature patch(es) onto ${result.targetPin.tag}`);
        ctx.out.setData(dataOf(result));
        return result.exitCode;
    }, (text) => ctx.out.warn(text));
}
function dataOf(result) {
    return {
        sourcePin: { ...result.sourcePin },
        targetPin: { ...result.targetPin },
        mergeBase: result.mergeBase,
        patches: result.patches.map((patch) => ({
            artifact: patch.artifactPath,
            id: patch.artifactId,
            sourceTarget: patch.sourceTarget,
            target: patch.targetPath,
            outcome: patch.outcome,
            cause: { ...patch.cause }
        })),
        blockers: result.blockers.map((patch) => patch.artifactPath),
        save: result.save === null ? null : { status: result.save.status, files: result.save.files.map((file) => ({ ...file })) }
    };
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: rebase-onto-pin needs the merged target pin', 'complete the target merge in a patchset checkout that carries codkit.json');
    }
    return config;
}
export const rebaseOntoPinCommand = {
    name: 'rebase-onto-pin',
    summary: 'replay feature-only patches after merging a target patchset branch',
    configMode: 'load',
    maxArgs: 0,
    run
};
