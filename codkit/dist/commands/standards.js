/** @scope spec://codkit/modules/codkit/PROP-007#CMD-STANDARDS-LOAD */
// codkit standards - deliver the packages codkit ships into a product
// repository, report on the copies that are there, and print the licence
// notice.
// Contract: PROP-007 sec. 24, algorithm PROP-014 sec. 5-6.
//
// `load` and `check` need the patch-set root and nothing else: no fork tree, no
// codkit.json, no tree lock (##STD-LOAD-ROOTS). `license` needs no root at all -
// it only prints what codkit ships.
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, patchesRoot } from '../lib/command.js';
import { isCycleTestBuild } from '../lib/cycleTestCrash.js';
import { NOTICE_LEGACY_PATH, renderedNotice, reuseAnnotationRows } from '../lib/licenceNotice.js';
import { loadLicensePolicy } from '../lib/licensePolicy.js';
import { driftPaths, runStandardsCheck } from '../lib/standardsCheck.js';
import { LICENCE_NOTES, NOTICE_RECOMMENDATIONS, STANDARDS_SOURCE_ENV, nextSteps, noticeText, runStandardsLoad } from '../lib/standardsLoad.js';
import { SCRAPE_CONTRACT_ROWS, NO_CONTRACT_LINE } from '../lib/standardsScrape.js';
const DRY_RUN = '--dry-run';
const UPGRADE = '--upgrade';
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
/** ##STD-LOAD-ALL-PACKAGES: one summary per package, in the order they are delivered. */
function reportPackage(ctx, entry, outcome, upgrade, dryRun) {
    const done = outcome.packages.find((item) => item.name === entry.package.name);
    for (const name of done?.removedScratch ?? [])
        ctx.out.info(`${entry.package.name}: removed interrupted run ${name}`);
    ctx.out.info(`package: ${entry.package.name} ${entry.package.version} -> ${entry.targetPath}`);
    ctx.out.info(done === undefined || done.filesCreated === 0
        ? `files: ${done?.filesUnchanged ?? entry.fileCount} unchanged (up to date)`
        : `files: ${done.filesCreated} ${done.state === 'upgraded' ? 'replaced' : 'created'}`);
    if (upgrade) {
        for (const relative of entry.replace)
            ctx.out.info(`replace ${relative}`);
        for (const relative of entry.remove)
            ctx.out.info(`remove ${relative}`);
    }
    if (entry.otherVersions.length > 0 && (done?.removedVersions.length ?? 0) === 0) {
        ctx.out.info(`other versions kept: ${entry.otherVersions.join(', ')}`);
    }
    // A dry run plans the removal and removes nothing; its line says so (##STD-LOAD-UPGRADE).
    for (const name of done?.removedVersions ?? [])
        ctx.out.info(dryRun ? `would remove superseded version: ${name}` : `removed superseded version: ${name}`);
}
function packagesData(plan, outcome) {
    return plan.packages.map((entry) => {
        const done = outcome.packages.find((item) => item.name === entry.package.name);
        return {
            group: STANDARDS_GROUP,
            name: entry.package.name,
            version: entry.package.version,
            declaresSkills: entry.package.declaresSkills,
            source: entry.package.directory,
            target: entry.targetPath,
            state: done?.state ?? 'unchanged',
            files: { created: done?.filesCreated ?? 0, unchanged: done?.filesUnchanged ?? 0 },
            replace: [...entry.replace],
            remove: [...entry.remove],
            otherVersions: [...entry.otherVersions],
            removedVersions: [...(done?.removedVersions ?? [])],
            removedScratch: [...(done?.removedScratch ?? [])],
            licences: { own: [...entry.licences.own], thirdParty: [...entry.licences.thirdParty], notices: entry.licences.notices }
        };
    });
}
const STANDARDS_GROUP = 'org.vibevm.codkit';
async function runLoad(ctx) {
    const patchesDir = patchesRoot(ctx);
    const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);
    const upgrade = commandFlagGiven(ctx.commandFlags, UPGRADE);
    const outcome = runStandardsLoad({ toolRoot: ctx.toolRoot, patchesDir, sourceOverride: sourceOverride(ctx), dryRun, upgrade });
    const plan = outcome.plan;
    // ##STD-LOAD-STEP-LICENSE-GATE: a package that fails the check is never
    // copied, and there is no flag that changes that.
    if (plan.problems.length > 0 || plan.blockProblems.length > 0) {
        for (const problem of plan.problems) {
            ctx.out.addError({
                code: problem.code,
                message: `${problem.package}: ${problem.message}`,
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
        ctx.out.setData({ packages: packagesData(plan, outcome), problems: total });
        return EXIT_CHECK_FAILED;
    }
    for (const entry of plan.packages)
        reportPackage(ctx, entry, outcome, upgrade, dryRun);
    for (const notice of plan.notices) {
        ctx.out.info(`notice: ${notice.path} ${noticeAction(outcome, notice.path)}`);
    }
    if (outcome.legacyNoticeRemoved)
        ctx.out.info(`notice: ${NOTICE_LEGACY_PATH} moved`);
    ctx.out.info(`manifest: ${plan.manifest.path} ${plan.manifest.action}`);
    ctx.out.info(plan.scrape.action === 'no-contract' ? NO_CONTRACT_LINE : `scrape contract: ${plan.scrape.path} ${plan.scrape.action}`);
    reportLicences(ctx, plan);
    const next = nextSteps(plan, upgrade);
    for (const step of next)
        ctx.out.info(`next: ${step}`);
    for (const note of LICENCE_NOTES)
        ctx.out.info(note);
    for (const line of NOTICE_RECOMMENDATIONS)
        ctx.out.info(line);
    const created = outcome.noticesWritten.some((notice) => notice.action === 'created');
    if (created) {
        ctx.out.info('----- LICENSE-CODKIT.md (verbatim) -----');
        ctx.out.info(renderedNotice(ctx.toolRoot, patchesDir).replace(/\n$/u, ''));
        ctx.out.info('----- end of LICENSE-CODKIT.md -----');
    }
    ctx.out.setData({
        packages: packagesData(plan, outcome),
        files: { created: outcome.filesCreated, unchanged: outcome.filesUnchanged },
        noticeFiles: plan.notices.map((notice) => ({ path: notice.path, action: noticeAction(outcome, notice.path) })),
        legacyNoticeMoved: outcome.legacyNoticeRemoved,
        manifest: { path: plan.manifest.path, action: plan.manifest.action },
        scrape: { path: plan.scrape.path, action: plan.scrape.action },
        otherVersions: [...plan.otherVersions],
        removedScratch: [...outcome.removedScratch],
        licences: { own: [...plan.licences.own], thirdParty: [...plan.licences.thirdParty], notices: plan.licences.notices },
        next: next[0] ?? 'vibe install --offline',
        nextSteps: [...next],
        notes: [...LICENCE_NOTES],
        recommendations: [...NOTICE_RECOMMENDATIONS],
        ...(created ? { noticeText: renderedNotice(ctx.toolRoot, patchesDir) } : {})
    });
    return EXIT_OK;
}
function noticeAction(outcome, path) {
    return outcome.noticesWritten.find((notice) => notice.path === path)?.action ?? 'unchanged';
}
async function runCheck(ctx) {
    const patchesDir = patchesRoot(ctx);
    const report = runStandardsCheck({ toolRoot: ctx.toolRoot, patchesDir, sourceOverride: sourceOverride(ctx) });
    const plan = report.plan;
    for (const entry of report.packages)
        ctx.out.info(`package: ${entry.name} ${entry.version} ${entry.state}`);
    for (const notice of plan.notices)
        ctx.out.info(`notice: ${notice.path} ${notice.state}`);
    if (report.legacyNotice)
        ctx.out.warn(`notice: ${NOTICE_LEGACY_PATH} legacy-copy (moved by the next codkit standards load)`);
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
            hint: checkHint(finding)
        });
    }
    ctx.out.setData({
        packages: report.packages.map((entry) => ({
            name: entry.name,
            version: entry.version,
            target: { state: entry.state, paths: [...entry.paths] }
        })),
        target: { state: report.targetState, paths: [...standardsDriftPaths(plan)] },
        license: {
            problems: plan.problems.map((problem) => ({
                code: `CK-E-${problem.code}`,
                package: problem.package,
                file: problem.file,
                message: problem.message
            }))
        },
        noticeFiles: plan.notices.map((notice) => ({ path: notice.path, state: notice.state })),
        legacyNotice: report.legacyNotice,
        manifest: { state: report.manifestState, path: plan.manifest.path },
        scrape: { state: report.scrapeState, path: plan.scrape.path },
        otherVersions: [...plan.otherVersions]
    });
    return report.findings.length === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
/**
 * ##STD-LOAD-UPGRADE: a drifted package is now most often a tool that ships new
 * bytes under the same edition number, so the hint names `--upgrade`; an edited
 * notice copy is still recovered by deleting it.
 */
function checkHint(finding) {
    if (finding.includes('LICENSE-CODKIT.md: drift'))
        return 'delete the copy and run codkit standards load';
    if (finding.includes(': modified ') || finding.includes(': extra ') || finding.includes(': missing ')) {
        return 'run codkit standards load --upgrade to take the shipped copy, or move your edits out';
    }
    return 'run codkit standards load';
}
/** PROP-007 ##CMD-STANDARDS-CHECK names `data.target`: the standards package of the set. */
function standardsDriftPaths(plan) {
    const standards = plan.packages.find((entry) => entry.package.name === 'standards');
    return standards === undefined ? [] : driftPaths(standards);
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
    const policy = loadLicensePolicy();
    const reuseAnnotation = reuseAnnotationRows(policy.holders[0] ?? '', new Date().getUTCFullYear().toString());
    ctx.out.info('REUSE.toml annotation for this repository (optional; the notice describes the same paths):');
    ctx.out.info('');
    ctx.out.info(reuseAnnotation);
    ctx.out.info('components block: empty here; codkit standards load and codkit runtime load fill it for a repository.');
    ctx.out.setData({
        file: 'LICENSE-CODKIT.md',
        text,
        recommendations: [...NOTICE_RECOMMENDATIONS],
        scrapeContractRows: SCRAPE_CONTRACT_ROWS,
        reuseAnnotation
    });
    return EXIT_OK;
}
export const standardsCommand = {
    name: 'standards',
    summary: 'namespace of the shipped packages; run standards load, check or license',
    configMode: 'none',
    namespace: true,
    roots: 'none',
    maxArgs: 0,
    run: runNamespace
};
export const standardsLoadCommand = {
    name: 'standards load',
    summary: 'deliver the packages codkit ships into the patch-set repository',
    configMode: 'none',
    maxArgs: 0,
    commandFlags: [DRY_RUN, UPGRADE],
    run: runLoad
};
export const standardsCheckCommand = {
    name: 'standards check',
    summary: 'report on the installed packages, the notice files and both blocks',
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
