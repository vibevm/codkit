/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit publish - guarded publication of one immutable patchset commit, over
// the network into its remote or into a new local repository.
import { commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.js';
import { CI_PROFILES } from '../lib/ciEngine.js';
import { ckError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { runPublishReceipt } from '../lib/publishReceipt.js';
import { exportFlagsRefusal, exportRequestOf } from '../lib/publishExport.js';
import { parseAuthor, readMessageFile } from '../lib/publishRelease.js';
import { orphanRefusal } from '../lib/publishTip.js';
const PROFILE = '--profile';
const RELEASE = '--release';
const BRANCH = '--branch';
const SQUASH = '--squash';
const ORPHAN = '--orphan';
const AUTHOR = '--author';
const MESSAGE_FILE = '--message-file';
const SCRUB = '--scrub';
const NO_LFS = '--no-lfs';
const EXPORT_BARE = '--export-bare';
const EXPORT_REPO = '--export-repo';
const BOT_CONFIRMATION = '--yes-i-am-publish-bot';
async function run(ctx) {
    if (ctx.args.length !== 1 || ctx.args[0] === undefined) {
        throw ckError('CONFIG', 'publish needs exactly one immutable patchset ref', 'usage: codkit publish <patchset-ref> --yes-i-am-publish-bot');
    }
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    if (resolution.warning !== null)
        ctx.out.warn(resolution.warning);
    const config = requireConfig(ctx.config);
    const componentId = commandFlagValue(ctx.commandFlags, '--component-id');
    const result = await runPublishReceipt({
        ...(componentId === null ? {} : { componentId }),
        patchesDir: ctx.patchesDir,
        ...(ctx.typeDeclaration === undefined ? {} : { registration: ctx.typeDeclaration }),
        resolution,
        config,
        type: requireProjectType(ctx),
        out: ctx.out,
        patchSetRef: ctx.args[0],
        profile: requireProfile(commandFlagValue(ctx.commandFlags, PROFILE)),
        release: commandFlagValue(ctx.commandFlags, RELEASE),
        confirmed: commandFlagGiven(ctx.commandFlags, BOT_CONFIRMATION),
        ci: ctx.flags.ci,
        verbose: ctx.flags.verbose,
        branch: commandFlagValue(ctx.commandFlags, BRANCH),
        squash: squashRequest(ctx),
        orphan: commandFlagGiven(ctx.commandFlags, ORPHAN),
        scrub: commandFlagGiven(ctx.commandFlags, SCRUB),
        noLfs: commandFlagGiven(ctx.commandFlags, NO_LFS),
        export: exportRequest(ctx)
    });
    ctx.out.setData(dataOf(result));
    return result.exitCode;
}
/** ##PUBLISH-EXPORT: `--export-bare <dir>` or `--export-repo <dir>`, never both, relative to the current directory. */
function exportRequest(ctx) {
    const bare = commandFlagValue(ctx.commandFlags, EXPORT_BARE);
    const repository = commandFlagValue(ctx.commandFlags, EXPORT_REPO);
    if (bare !== null && repository !== null)
        throw exportFlagsRefusal();
    if (bare !== null)
        return exportRequestOf('bare', bare, process.cwd());
    return repository === null ? null : exportRequestOf('repository', repository, process.cwd());
}
/**
 * ##PUBLISH-SQUASH: `--squash` takes both `--author` and `--message-file`, and
 * they take it; ##PUBLISH-ORPHAN: `--orphan` takes `--squash` too.
 */
function squashRequest(ctx) {
    const author = commandFlagValue(ctx.commandFlags, AUTHOR);
    const messageFile = commandFlagValue(ctx.commandFlags, MESSAGE_FILE);
    if (!commandFlagGiven(ctx.commandFlags, SQUASH)) {
        if (commandFlagGiven(ctx.commandFlags, ORPHAN))
            throw orphanRefusal();
        if (author !== null || messageFile !== null) {
            throw ckError('CONFIG', `${AUTHOR} and ${MESSAGE_FILE} belong to ${SQUASH}`, `add ${SQUASH}, or drop them`);
        }
        return null;
    }
    if (author === null || messageFile === null) {
        throw ckError('CONFIG', `${SQUASH} needs ${AUTHOR} and ${MESSAGE_FILE}`, `example: ${SQUASH} ${AUTHOR} "Jane Doe <jane@example.org>" ${MESSAGE_FILE} release-message.txt`);
    }
    return { author: parseAuthor(author), message: readMessageFile(messageFile) };
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: publish needs pin and ref conventions');
    }
    return config;
}
function requireProfile(raw) {
    if (raw === null)
        return 'verify';
    const profile = CI_PROFILES.find((known) => known === raw);
    if (profile === undefined)
        throw ckError('CONFIG', `unknown publish profile: ${raw}`, `${PROFILE} takes ${CI_PROFILES.join(' or ')}`);
    return profile;
}
function dataOf(result) {
    return {
        status: result.status,
        release: result.release === null ? null : { ...result.release, missing: [...result.release.missing] },
        patchSetSha: result.patchSetSha,
        pinTag: result.pinTag,
        tip: result.tip,
        branch: result.branch,
        tag: result.tag,
        observedBranch: result.observedBranch,
        observedTag: result.observedTag,
        pushedBranch: result.pushedBranch,
        pushedTag: result.pushedTag,
        profile: result.checks?.profile ?? null,
        steps: result.checks?.steps.map((step) => ({ name: step.name, state: step.state, detail: step.detail })) ?? [],
        squash: result.squash === null ? null : { ...result.squash },
        scrub: result.scrub === null
            ? null
            : {
                files: result.scrub.files.map((file) => ({ ...file, groups: { ...file.groups } })),
                excluded: [...result.scrub.excluded],
                leftovers: result.scrub.leftovers.map((leftover) => ({ ...leftover, tokens: [...leftover.tokens] })),
                vocabulary: { ...result.scrub.vocabulary }
            },
        lfs: result.lfs === null ? null : { dropped: [...result.lfs.dropped], attributes: [...result.lfs.attributes] },
        export: result.export === null ? null : { ...result.export },
        inputs: result.inputs.map((input) => ({ ...input }))
    };
}
export const publishCommand = {
    name: 'publish',
    summary: 'publish one checked immutable patchset commit through a leased release ref, or into a new local repository',
    configMode: 'load',
    maxArgs: 1,
    commandFlags: [
        PROFILE,
        RELEASE,
        BRANCH,
        SQUASH,
        ORPHAN,
        AUTHOR,
        MESSAGE_FILE,
        SCRUB,
        NO_LFS,
        EXPORT_BARE,
        EXPORT_REPO,
        BOT_CONFIRMATION,
        '--component-id'
    ],
    run
};
