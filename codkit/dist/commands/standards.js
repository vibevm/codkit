/** @scope spec://codkit/modules/codkit/PROP-007#CMD-STANDARDS-LOAD */
// codkit standards - deliver the standards package into a product repository,
// report on the copy that is there, and print the licence notice.
// Contract: PROP-007 sec. 24, algorithm PROP-014 sec. 5-6.
//
// `load` and `check` need the patch-set root and nothing else: no fork tree, no
// codkit.json, no tree lock (##STD-LOAD-ROOTS). `license` needs no root at all -
// it only prints what codkit ships.
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, patchesRoot } from '../lib/command.js';
import { isCycleTestBuild } from '../lib/cycleTestCrash.js';
import { LICENCE_NOTES, NOTICE_RECOMMENDATIONS, STANDARDS_SOURCE_ENV, noticeText, runStandardsCheck, runStandardsLoad } from '../lib/standardsLoad.js';
import { SCRAPE_CONTRACT_ROWS, NO_CONTRACT_LINE } from '../lib/standardsScrape.js';
const DRY_RUN = '--dry-run';
/**
 * ##STD-LOAD-STEP-SOURCE: the seam that relocates the shipped package exists
 * only in the test build, exactly as `CODKIT_TEST_SAVE_REPLAY_CRASH_AT` does.
 * Outside it the variable is ignored, so no environment can redirect a real run.
 */
function sourceOverride(ctx) {
    const value = ctx.env[STANDARDS_SOURCE_ENV];
    if (value === undefined || value === '')
        return null;
    return isCycleTestBuild(process.execArgv) ? value : null;
}
/** main.ts answers a bare namespace before this runs (##STANDARDS-NAMESPACE). */
async function runNamespace() {
    return EXIT_ENVIRONMENT;
}
function reportLicences(ctx, plan) {
    const own = plan.licences.own.map((id) => `${id} (own)`);
    const third = plan.licences.thirdParty.map((id) => `${id} (third-party)`);
    const notices = plan.licences.notices === null ? '' : `; notices: ${plan.licences.notices}`;
    ctx.out.info(`licences loaded: ${[...own, ...third].join('; ')}${notices}`);
}
async function runLoad(ctx) {
    const patchesDir = patchesRoot(ctx);
    const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);
    const outcome = runStandardsLoad({ toolRoot: ctx.toolRoot, patchesDir, sourceOverride: sourceOverride(ctx), dryRun });
    const plan = outcome.plan;
    // ##STD-LOAD-STEP-LICENSE-GATE: a package that fails the check is never
    // copied, and there is no flag that changes that.
    if (plan.problems.length > 0 || plan.blockProblems.length > 0) {
        for (const problem of plan.problems) {
            ctx.out.addError({
                code: problem.code,
                message: problem.message,
                hint: 'fix the shipped package before delivering it',
                file: problem.file
            });
        }
        for (const problem of plan.blockProblems) {
            ctx.out.addError({
                code: 'CONFIG',
                message: problem.message,
                hint: problem.hint,
                file: problem.path,
                ...(problem.line === null ? {} : { line: problem.line })
            });
        }
        const total = plan.problems.length + plan.blockProblems.length;
        ctx.out.info(`${total} problems; nothing was written`);
        ctx.out.setData({ package: packageData(plan), problems: total });
        return EXIT_CHECK_FAILED;
    }
    for (const name of outcome.removedScratch)
        ctx.out.info(`removed interrupted run ${name}`);
    ctx.out.info(`package: ${plan.package.version} -> ${plan.target}`);
    ctx.out.info(outcome.filesCreated > 0 ? `files: ${outcome.filesCreated} created` : `files: ${outcome.filesUnchanged} unchanged (up to date)`);
    for (const notice of plan.notices) {
        ctx.out.info(`notice: ${notice.path} ${outcome.noticesWritten.includes(notice.path) ? 'created' : 'unchanged'}`);
    }
    ctx.out.info(`manifest: ${plan.manifest.path} ${plan.manifest.action}`);
    ctx.out.info(plan.scrape.action === 'no-contract' ? NO_CONTRACT_LINE : `scrape contract: ${plan.scrape.path} ${plan.scrape.action}`);
    if (plan.otherVersions.length > 0)
        ctx.out.info(`other versions kept: ${plan.otherVersions.join(', ')}`);
    reportLicences(ctx, plan);
    ctx.out.info('next: vibe install --offline');
    for (const note of LICENCE_NOTES)
        ctx.out.info(note);
    for (const line of NOTICE_RECOMMENDATIONS)
        ctx.out.info(line);
    const created = outcome.noticesWritten.length > 0;
    if (created) {
        ctx.out.info('----- LICENSE-CODKIT.md (verbatim) -----');
        ctx.out.info(noticeText(ctx.toolRoot).replace(/\n$/u, ''));
        ctx.out.info('----- end of LICENSE-CODKIT.md -----');
    }
    ctx.out.setData({
        package: packageData(plan),
        source: plan.package.directory,
        target: plan.target,
        files: { created: outcome.filesCreated, unchanged: outcome.filesUnchanged },
        noticeFiles: plan.notices.map((notice) => ({
            path: notice.path,
            action: outcome.noticesWritten.includes(notice.path) ? 'created' : 'unchanged'
        })),
        manifest: { path: plan.manifest.path, action: plan.manifest.action },
        scrape: { path: plan.scrape.path, action: plan.scrape.action },
        otherVersions: [...plan.otherVersions],
        removedScratch: [...outcome.removedScratch],
        licences: { own: [...plan.licences.own], thirdParty: [...plan.licences.thirdParty], notices: plan.licences.notices },
        next: 'vibe install --offline',
        notes: [...LICENCE_NOTES],
        recommendations: [...NOTICE_RECOMMENDATIONS],
        ...(created ? { noticeText: noticeText(ctx.toolRoot) } : {})
    });
    return EXIT_OK;
}
function packageData(plan) {
    return { group: 'org.vibevm.codkit', name: 'standards', version: plan.package.version };
}
async function runCheck(ctx) {
    const patchesDir = patchesRoot(ctx);
    const report = runStandardsCheck({ toolRoot: ctx.toolRoot, patchesDir, sourceOverride: sourceOverride(ctx) });
    const plan = report.plan;
    ctx.out.info(`package: ${report.targetState}`);
    for (const notice of plan.notices)
        ctx.out.info(`notice: ${notice.path} ${notice.state}`);
    ctx.out.info(`manifest: ${report.manifestState}`);
    ctx.out.info(`scrape contract: ${report.scrapeState}`);
    if (plan.tailWarningLine !== null) {
        ctx.out.warn(`${plan.scrape.path}:${plan.tailWarningLine}: a key after the codkit block would land inside its table`);
    }
    if (plan.otherVersions.length > 0)
        ctx.out.info(`other versions kept: ${plan.otherVersions.join(', ')}`);
    for (const finding of report.findings) {
        ctx.out.addError({
            code: finding.includes(': block ') ? 'CONFIG' : 'STANDARDS-DRIFT',
            message: finding,
            hint: finding.includes('LICENSE-CODKIT.md')
                ? 'delete both LICENSE-CODKIT.md copies and run codkit standards load'
                : 'run codkit standards load'
        });
    }
    ctx.out.setData({
        target: { state: report.targetState, paths: [...driftPaths(plan)] },
        license: { problems: plan.problems.map((problem) => ({ code: `CK-E-${problem.code}`, file: problem.file, message: problem.message })) },
        noticeFiles: plan.notices.map((notice) => ({ path: notice.path, state: notice.state })),
        manifest: { state: report.manifestState, path: plan.manifest.path },
        scrape: { state: report.scrapeState, path: plan.scrape.path },
        otherVersions: [...plan.otherVersions]
    });
    return report.findings.length === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
function driftPaths(plan) {
    if (plan.comparison.state !== 'drift')
        return [];
    return [...plan.comparison.modified, ...plan.comparison.extra, ...plan.comparison.missing];
}
/** ##CMD-STANDARDS-LICENSE: print only, and needing no root of any kind. */
async function runLicense(ctx) {
    const text = noticeText(ctx.toolRoot);
    ctx.out.info('----- LICENSE-CODKIT.md (verbatim) -----');
    ctx.out.info(text.replace(/\n$/u, ''));
    ctx.out.info('----- end of LICENSE-CODKIT.md -----');
    for (const line of NOTICE_RECOMMENDATIONS)
        ctx.out.info(line);
    ctx.out.info('scrape contract rows (kept by `codkit standards load` in vibevm/scrape/contract.toml; paste only into a contract kept elsewhere; PROP-056 schema 1):');
    ctx.out.info('');
    ctx.out.info('# Codkit licence notice: removed from a scraped export together with the Vibe layer.');
    ctx.out.info(SCRAPE_CONTRACT_ROWS);
    ctx.out.setData({
        file: 'LICENSE-CODKIT.md',
        text,
        recommendations: [...NOTICE_RECOMMENDATIONS],
        scrapeContractRows: SCRAPE_CONTRACT_ROWS
    });
    return EXIT_OK;
}
export const standardsCommand = {
    name: 'standards',
    summary: 'namespace of the standards package; run standards load, check or license',
    configMode: 'none',
    namespace: true,
    roots: 'none',
    maxArgs: 0,
    run: runNamespace
};
export const standardsLoadCommand = {
    name: 'standards load',
    summary: 'deliver the standards package codkit ships into the patch-set repository',
    configMode: 'none',
    maxArgs: 0,
    commandFlags: [DRY_RUN],
    run: runLoad
};
export const standardsCheckCommand = {
    name: 'standards check',
    summary: 'report on the installed standards package, its notice files and both blocks',
    configMode: 'none',
    maxArgs: 0,
    run: runCheck
};
export const standardsLicenseCommand = {
    name: 'standards license',
    summary: 'print the codkit licence notice, the recommendations and the scrape rows',
    configMode: 'none',
    roots: 'none',
    maxArgs: 0,
    run: runLicense
};
