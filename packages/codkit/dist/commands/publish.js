/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit publish - guarded network publication of one immutable patchset commit.
import { commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.js';
import { CI_PROFILES } from '../lib/ciEngine.js';
import { ckError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { runPublish } from '../lib/publish.js';
const PROFILE = '--profile';
const RELEASE = '--release';
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
    const result = await runPublish({
        patchesDir: ctx.patchesDir,
        resolution,
        config,
        type: requireProjectType(ctx),
        out: ctx.out,
        patchSetRef: ctx.args[0],
        profile: requireProfile(commandFlagValue(ctx.commandFlags, PROFILE)),
        release: commandFlagValue(ctx.commandFlags, RELEASE),
        confirmed: commandFlagGiven(ctx.commandFlags, BOT_CONFIRMATION),
        ci: ctx.flags.ci,
        verbose: ctx.flags.verbose
    });
    ctx.out.setData(dataOf(result));
    return result.exitCode;
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
        steps: result.checks?.steps.map((step) => ({ name: step.name, state: step.state, detail: step.detail })) ?? []
    };
}
export const publishCommand = {
    name: 'publish',
    summary: 'publish one checked immutable patchset commit through a leased release ref',
    configMode: 'load',
    maxArgs: 1,
    commandFlags: [PROFILE, RELEASE, BOT_CONFIRMATION],
    run
};
