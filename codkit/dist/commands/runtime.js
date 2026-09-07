/** @scope spec://codkit/modules/codkit/PROP-015#RT-LOAD-STEPS */
// codkit runtime - deliver the codkit runtime library into a product repository
// and report on the copy that is there.
// Contract: PROP-007 sec. 25, algorithm PROP-015 sec. 4.
//
// Both subcommands need the patch-set root and nothing else: no fork tree, no
// codkit.json to run, no tree lock (##RUNTIME-NAMESPACE). The pin is read when
// it happens to be there, for the compatibility warning alone.
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, patchesRoot } from '../lib/command.js';
import { NOTICE_LEGACY_PATH } from '../lib/licenceNotice.js';
import { RUNTIME_NEXT_STEPS, driftPaths, runRuntimeCheck, runRuntimeLoad } from '../lib/runtimeLoad.js';
const DRY_RUN = '--dry-run';
const UPGRADE = '--upgrade';
/** main.ts answers a bare namespace before this runs (##RUNTIME-NAMESPACE). */
async function runNamespace() {
    return EXIT_ENVIRONMENT;
}
function noticeAction(outcome, path) {
    return outcome.noticesWritten.find((notice) => notice.path === path)?.action ?? 'unchanged';
}
async function runLoad(ctx) {
    const patchesDir = patchesRoot(ctx);
    const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);
    const upgrade = commandFlagGiven(ctx.commandFlags, UPGRADE);
    const outcome = runRuntimeLoad({ toolRoot: ctx.toolRoot, patchesDir, dryRun, upgrade });
    const plan = outcome.plan;
    // ##RT-LOAD-STEPS step 2: a library that fails its own licence check is never
    // copied, and there is no flag that changes that.
    if (plan.problems.length > 0) {
        for (const problem of plan.problems) {
            ctx.out.addError({
                code: problem.code,
                message: problem.message,
                hint: 'fix the shipped runtime library before delivering it',
                file: problem.file
            });
        }
        ctx.out.info(`${plan.problems.length} problems; nothing was written`);
        ctx.out.setData({ version: plan.runtime.version, target: plan.targetPath, problems: plan.problems.length });
        return EXIT_ENVIRONMENT;
    }
    for (const name of outcome.removedScratch)
        ctx.out.info(`removed interrupted run ${name}`);
    ctx.out.info(`runtime: ${plan.runtime.version} -> ${plan.targetPath}`);
    ctx.out.info(`state: ${outcome.state}${dryRun ? ' (dry run: nothing written)' : ''}`);
    ctx.out.info(`files: ${outcome.filesWritten} written, ${outcome.filesRemoved} removed`);
    // ##RT-LOAD-UPGRADE: a replacement says which paths it takes over and which
    // it drops, so the loss of a local edit is never silent.
    for (const relative of plan.writes)
        ctx.out.info(`  replace ${plan.targetPath}/${relative}`);
    for (const relative of plan.removals)
        ctx.out.info(`  remove ${plan.targetPath}/${relative}`);
    for (const notice of plan.notices)
        ctx.out.info(`notice: ${notice.path} ${noticeAction(outcome, notice.path)}`);
    if (outcome.legacyNoticeRemoved)
        ctx.out.info(`notice: ${NOTICE_LEGACY_PATH} moved`);
    // ##RT-COMPAT-DECLARATION: the library states the upstream tags it was
    // typechecked and tested on; a pin outside that list is a warning, not a stop.
    if (!plan.verifiedUpstream) {
        ctx.out.warn(`the pin ${plan.pinTag ?? 'unknown'} is not among the upstream tags this runtime was verified on (${plan.runtime.verifiedUpstream.join(', ')})`);
    }
    for (const line of RUNTIME_NEXT_STEPS)
        ctx.out.info(line);
    ctx.out.setData({
        version: plan.runtime.version,
        target: plan.targetPath,
        state: outcome.state,
        files: { written: outcome.filesWritten, removed: outcome.filesRemoved },
        notice: {
            files: plan.notices.map((notice) => ({ path: notice.path, action: noticeAction(outcome, notice.path) })),
            legacyMoved: outcome.legacyNoticeRemoved
        },
        verifiedUpstream: plan.verifiedUpstream,
        writes: [...plan.writes],
        removals: [...plan.removals],
        nextSteps: [...RUNTIME_NEXT_STEPS]
    });
    return EXIT_OK;
}
async function runCheck(ctx) {
    const patchesDir = patchesRoot(ctx);
    const report = runRuntimeCheck({ toolRoot: ctx.toolRoot, patchesDir });
    const plan = report.plan;
    // ##RT-CHECK: an absent library is a state, not a failure - the product may
    // simply not have asked for it yet.
    ctx.out.info(report.targetState === 'absent' ? 'runtime not installed' : `runtime: ${report.targetState}`);
    for (const notice of plan.notices)
        ctx.out.info(`notice: ${notice.path} ${notice.state}`);
    if (report.legacyNotice)
        ctx.out.warn(`notice: ${NOTICE_LEGACY_PATH} legacy-copy (moved by the next codkit runtime load)`);
    for (const finding of report.findings) {
        const drift = finding.code === 'RUNTIME-DRIFT';
        ctx.out.addError({
            code: finding.code,
            message: finding.message,
            hint: drift ? 'run codkit runtime load --upgrade' : 'delete the edited copy and run codkit standards load',
            ...(drift ? { file: plan.targetPath } : {})
        });
    }
    // REVIEW: PROP-015 ##RT-CHECK calls this field `notice`, PROP-007
    // ##CMD-RUNTIME-CHECK calls it `noticeFiles`. The CLI contract wins here and
    // `standards check` already ships `noticeFiles`, so the two commands answer
    // the same question with the same key; the specs should be reconciled.
    ctx.out.setData({
        target: {
            state: report.targetState,
            version: report.installedVersion,
            shipped: plan.runtime.version,
            paths: [...driftPaths(plan)]
        },
        noticeFiles: plan.notices.map((notice) => ({ path: notice.path, state: notice.state })),
        legacyNotice: report.legacyNotice
    });
    return report.findings.length === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
export const runtimeCommand = {
    name: 'runtime',
    summary: 'namespace of the codkit runtime library; run runtime load or check',
    configMode: 'none',
    namespace: true,
    roots: 'none',
    maxArgs: 0,
    run: runNamespace
};
export const runtimeLoadCommand = {
    name: 'runtime load',
    summary: 'deliver the codkit runtime library codkit ships into delta/own/codkit/',
    configMode: 'none',
    roots: 'patches',
    maxArgs: 0,
    commandFlags: [DRY_RUN, UPGRADE],
    run: runLoad
};
export const runtimeCheckCommand = {
    name: 'runtime check',
    summary: 'report on the installed runtime library and the licence notice copies',
    configMode: 'none',
    roots: 'patches',
    maxArgs: 0,
    run: runCheck
};
