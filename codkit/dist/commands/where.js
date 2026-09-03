/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit where - print the resolved fork-tree path and where it came from.
// Contract: PROP-007 sec. 2 (##CMD-WHERE). No preconditions, no side effects.
import { EXIT_OK } from '../lib/command.js';
import { formatForkTreeLine, formatPatchesLine } from '../lib/paths.js';
async function run(ctx) {
    const patches = ctx.locations.patchesDir;
    const fork = ctx.locations.forkDir;
    if (patches === null)
        ctx.out.info('patches: not configured');
    else {
        ctx.out.info(formatPatchesLine(patches));
        ctx.out.info(`patches exist: ${patches.exists ? 'yes' : 'no'}`);
    }
    if (fork === null)
        ctx.out.info('fork tree: not configured');
    else {
        ctx.out.info(formatForkTreeLine(fork));
        if (fork.warning !== null)
            ctx.out.warn(fork.warning);
        ctx.out.info(`fork exists: ${fork.exists ? 'yes' : 'no'}`);
    }
    ctx.out.setData({
        patches: patches === null ? null : { path: patches.path, source: patches.source, exists: patches.exists },
        fork: fork === null ? null : { path: fork.path, source: fork.source, exists: fork.exists }
    });
    // Always 0: an absent tree is a legitimate answer here. The only non-zero
    // path is a broken codkit.json, which fails before the command runs.
    return EXIT_OK;
}
export const whereCommand = {
    name: 'where',
    summary: 'print the resolved fork tree path and the source of that path',
    // A broken codkit.json is fatal (exit 2); an absent one is not an error.
    configMode: 'none',
    maxArgs: 0,
    run
};
