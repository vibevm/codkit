/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit verify - every integrity check of the delta, without a build.
// Contract: PROP-007 sec. 11 (##CMD-VERIFY).
//
// This is the threshold of a pull request and the first phase of `ci`. It reads
// and never writes, takes no lock, and reads the pin from git objects rather
// than from working files, so it gives the same verdict on a dirty tree as on a
// clean one - a reviewer must be able to run it while somebody is mid-edit.
//
// Every violation is printed on its own line, with its code, its artifact and a
// hint. One run tells the whole story: an upgrade that broke five artifacts is
// one report, not five runs.
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, forkResolution, requireProjectType } from '../lib/command.js';
import { ckError, serializeErrorPayload } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { checkTree } from '../lib/treeIdentity.js';
import { runStagedFast, runVerify } from '../lib/verifyEngine.js';
const STAGED_FAST = '--staged-fast';
async function run(ctx) {
    const config = requireConfig(ctx.config);
    if (commandFlagGiven(ctx.commandFlags, STAGED_FAST)) {
        const optionalResolution = ctx.locations.forkDir;
        if (optionalResolution !== null) {
            ctx.out.setForkTree(optionalResolution.path, optionalResolution.source);
            ctx.out.info(formatForkTreeLine(optionalResolution));
        }
        return stagedFast(ctx, config, optionalResolution);
    }
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    // Read-only, and deliberately not `requireClean`: verify works on a dirty
    // tree because everything it compares against comes from git objects.
    const identity = checkTree(resolution, config, { mode: 'read' });
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    const result = runVerify({ patchesDir: ctx.patchesDir, resolution, config, type: requireProjectType(ctx) });
    report(ctx, result);
    ctx.out.setData(dataOf(result, { staged: null }));
    if (result.findings.length === 0) {
        ctx.out.info(`verify: ${result.checked} intervention(s) checked, no violations`);
        return EXIT_OK;
    }
    ctx.out.info(`verify: ${result.findings.length} violation(s) in ${result.checked} intervention(s)`);
    return EXIT_CHECK_FAILED;
}
/**
 * The pre-commit path (PROP-007 sec. 19): only what is staged, and only the
 * checks that cost milliseconds. A fork tree that cannot be used is reported and
 * forgiven - the hook must never make a repository uncommittable.
 */
function stagedFast(ctx, config, resolution) {
    const result = runStagedFast({ patchesDir: ctx.patchesDir, resolution, config, type: requireProjectType(ctx) });
    report(ctx, result);
    ctx.out.setData(dataOf(result, { staged: result.staged }));
    if (result.findings.length === 0) {
        ctx.out.info(`verify --staged-fast: ${result.staged.length} staged delta file(s), no violations`);
        return EXIT_OK;
    }
    return EXIT_CHECK_FAILED;
}
function report(ctx, result) {
    for (const warning of result.warnings) {
        ctx.out.warn(warning);
    }
    for (const item of result.findings) {
        ctx.out.addError(item);
    }
}
function dataOf(result, extra) {
    const data = {
        findings: result.findings.map((item) => findingData(item)),
        counts: { ...result.counts },
        checked: result.checked,
        warnings: [...result.warnings]
    };
    if (extra.staged !== null) {
        data['staged'] = [...extra.staged];
    }
    return data;
}
function findingData(item) {
    return serializeErrorPayload(item);
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: verify needs the pin and the delta of this repository', 'run verify from a patchset checkout that carries codkit.json');
    }
    return config;
}
export const verifyCommand = {
    name: 'verify',
    summary: 'run every integrity check of the delta against the pin and the generated branch',
    configMode: 'load',
    maxArgs: 0,
    hiddenFlags: [STAGED_FAST],
    run
};
