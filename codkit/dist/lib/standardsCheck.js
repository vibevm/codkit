/** @scope spec://codkit/modules/codkit/PROP-014#STD-CHECK-ALGORITHM */
// Reporting on the packages a product has installed (PROP-014 sec. 6).
//
// ##STD-CHECK-ALGORITHM: read-only, over every shipped package. The report is
// the same plan `standards load` computes - one classification, two readers -
// so what `check` calls a finding is exactly what `load` would refuse over.
import { MANIFEST_PATH } from './standardsManifest.js';
import { STANDARDS_PACKAGE_NAME } from './standardsPackage.js';
import { planStandardsLoad } from './standardsLoad.js';
import { SCRAPE_CONTRACT_PATH } from './standardsScrape.js';
/** ##STD-CHECK-ALGORITHM: read-only, one line per finding, over every package. */
export function runStandardsCheck(options) {
    const plan = planStandardsLoad(options);
    const packages = plan.packages.map((entry) => ({
        name: entry.package.name,
        version: entry.package.version,
        state: entry.comparison.state,
        paths: driftPaths(entry)
    }));
    const manifestState = blockStateOf(plan.manifest.action);
    const scrapeState = blockStateOf(plan.scrape.action);
    const findings = [];
    for (const entry of plan.packages) {
        if (entry.comparison.state === 'absent')
            findings.push(`the ${entry.package.name} package is not installed`);
        if (entry.comparison.state !== 'drift')
            continue;
        for (const relative of entry.comparison.modified)
            findings.push(`${entry.package.name}: modified ${relative}`);
        for (const relative of entry.comparison.extra)
            findings.push(`${entry.package.name}: extra ${relative}`);
        for (const relative of entry.comparison.missing)
            findings.push(`${entry.package.name}: missing ${relative}`);
    }
    for (const notice of plan.notices) {
        if (notice.state !== 'identical')
            findings.push(`${notice.path}: ${notice.state}`);
    }
    for (const problem of plan.problems)
        findings.push(`${problem.package}: ${problem.file}: ${problem.message}`);
    for (const problem of plan.blockProblems)
        findings.push(`${problem.path}: ${problem.message}`);
    if (manifestState !== 'current' && !plan.blockProblems.some((problem) => problem.path === MANIFEST_PATH)) {
        findings.push(`${MANIFEST_PATH}: block ${manifestState}`);
    }
    if (scrapeState !== 'current' && scrapeState !== 'no-contract')
        findings.push(`${SCRAPE_CONTRACT_PATH}: block ${scrapeState}`);
    return {
        plan,
        packages,
        targetState: packages.find((entry) => entry.name === STANDARDS_PACKAGE_NAME)?.state ?? 'absent',
        manifestState,
        scrapeState,
        findings,
        legacyNotice: plan.legacyNotice
    };
}
/** Every path one package's copy and the shipped one disagree about. */
export function driftPaths(entry) {
    if (entry.comparison.state !== 'drift')
        return [];
    return [...entry.comparison.modified, ...entry.comparison.extra, ...entry.comparison.missing];
}
function blockStateOf(action) {
    switch (action) {
        case 'append':
            return 'absent';
        case 'update':
            return 'stale';
        case 'no-contract':
            return 'no-contract';
        default:
            return 'current';
    }
}
