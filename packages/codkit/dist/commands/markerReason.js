import { commandFlagGiven, commandFlagValue, EXIT_CHECK_FAILED, EXIT_OK, forkResolution, requireProjectType } from '../lib/command.js';
import { loadConventions } from '../lib/conventionsFile.js';
import { treeId } from '../lib/fingerprint.js';
import { withLock } from '../lib/lock.js';
import { ckError, isCkError } from '../lib/messages.js';
import { authorPatchReason } from '../lib/patchReason.js';
import { formatForkTreeLine } from '../lib/paths.js';
async function run(ctx) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    const target = ctx.args[0];
    if (target === undefined)
        throw ckError('CONFIG', 'marker reason needs one target', 'supply the existing upstream target');
    const request = {
        target,
        expectedId: commandFlagValue(ctx.commandFlags, '--id'),
        expectedHash: commandFlagValue(ctx.commandFlags, '--expected-sha256'),
        reason: commandFlagValue(ctx.commandFlags, '--reason'),
        dryRun: commandFlagGiven(ctx.commandFlags, '--dry-run')
    };
    const conventions = loadConventions(requireProjectType(ctx), ctx.patchesDir);
    const author = () => authorPatchReason(ctx.patchesDir, request, conventions);
    try {
        const result = request.dryRun
            ? author()
            : withLock(ctx.patchesDir, treeId(resolution.path), 'marker reason', author, (text) => ctx.out.warn(text));
        ctx.out.setData(result);
        ctx.out.info(`${result.artifact}: reason ${result.status}`);
        return EXIT_OK;
    }
    catch (error) {
        if (!isCkError(error) || error.code !== 'ARTIFACT-BROKEN')
            throw error;
        ctx.out.addError(error.toPayload());
        return EXIT_CHECK_FAILED;
    }
}
export const markerReasonCommand = {
    name: 'marker reason',
    summary: 'author one existing patch reason without changing its body',
    configMode: 'load',
    maxArgs: 1,
    commandFlags: ['--id', '--expected-sha256', '--reason', '--dry-run'],
    run
};
