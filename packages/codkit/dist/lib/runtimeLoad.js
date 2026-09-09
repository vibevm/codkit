/** @scope spec://codkit/modules/codkit/PROP-015#RT-LOAD-STEPS */
// Delivering the codkit runtime library into a product repository (PROP-015
// sec. 4) and reporting on the copy that is there (##RT-CHECK).
//
// The order of the steps is the whole design, and it is the order
// `standardsLoad.ts` already follows: everything that can refuse runs before
// anything is written. The source is proven first (##RT-VERSION-LITERAL), then
// the licence gate over the version directory (##RT-EVERY-FILE-CARRIES-THE-BANNER),
// then the target is classified, and drift without `--upgrade` refuses outright
// (##RT-LOAD-UPGRADE). Only then does a byte reach the patch set.
//
// The library is a managed copy, not a scaffold: the product never edits it, so
// the only shape of an update is "replace the directory as a whole"
// (##DECISION-RT-UPGRADE-FLAG). The licence notice that lives inside the same
// directory belongs to PROP-014 sec. 4a and is carried across a replacement.
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadBaseConfig } from './configFile.js';
import { statIfPresent } from './containedPath.js';
import { checkLicenseCarriers } from './licenseCheck.js';
import { loadLicensePolicy } from './licensePolicy.js';
import { NOTICE_NAME, NOTICE_TARGET_PATHS, RUNTIME_PREFIX, surveyNotice, writeNoticeCopies } from './licenceNotice.js';
import { ckError } from './messages.js';
import { readVersionLiteral, shippedRuntime } from './runtimePackage.js';
import { loadSpdxLicenseIds } from './spdxIds.js';
import { compareTrees, listScratchDirs, listTreeFiles, writeTreeViaScratch } from './standardsPackage.js';
/** Where the library is installed inside the patch set (##RT-DIRECTORY-IS-CODKIT). */
export const RUNTIME_TARGET_PATH = RUNTIME_PREFIX;
/** The parent of the installed directory, and the directory's own name. */
const TARGET_PARENT_SEGMENTS = RUNTIME_TARGET_PATH.split('/').slice(0, -1);
const TARGET_DIR_NAME = RUNTIME_TARGET_PATH.split('/').at(-1) ?? 'codkit';
/**
 * ##RT-LOAD-STEPS step 3: the notice file lives inside the target directory but
 * is written by PROP-014 sec. 4a, so it is neither compared nor removed here.
 */
const NOT_PART_OF_THE_LIBRARY = [NOTICE_NAME];
/** ##RT-LOAD-STEPS step 7: the three lines a person needs after a successful load. */
export const RUNTIME_NEXT_STEPS = [
    "next: import the library once from the product's composition root: import '../codkit/browser/featureFlags.contribution.js';",
    `next: add the code-import-patterns block for src/vs/<ownDirName>/codkit/~ from the library's LAYERS.md`,
    'next: declare the first feature with codkit gen feature <id> --title <text>'
];
/** Everything a run would do, computed without writing anything. */
export function planRuntimeLoad(options) {
    // (1) The source: exactly one version directory whose literal agrees with it.
    const runtime = shippedRuntime(options.toolRoot, options.sourceOverride ?? null);
    // (2) The licence gate. `packageShape: false`: the library is a directory of
    // files, not a vibe package - it has no manifest, no LICENSE and no registry
    // (##RT-ONLY-TS-AND-MD).
    const check = checkLicenseCarriers(runtime.directory, loadLicensePolicy(), loadSpdxLicenseIds(), { packageShape: false });
    // (3) The target, with the notice file left out of the comparison.
    const target = join(options.patchesDir, ...RUNTIME_TARGET_PATH.split('/'));
    const parent = join(options.patchesDir, ...TARGET_PARENT_SEGMENTS);
    const shipped = listTreeFiles(runtime.directory);
    const comparison = check.problems.length > 0
        ? { state: 'absent' }
        : classifyTarget(compareTrees(runtime.directory, target, { ignoreInTarget: NOT_PART_OF_THE_LIBRARY }), shipped.length);
    const writes = comparison.state === 'identical' ? [] : comparison.state === 'absent' ? shipped : [...comparison.modified, ...comparison.missing];
    const removals = comparison.state === 'drift' ? comparison.extra : [];
    const survey = check.problems.length > 0 ? null : surveyNotice(options.toolRoot, options.patchesDir);
    const notices = survey === null ? NOTICE_TARGET_PATHS.map((path) => ({ path, state: 'absent' })) : survey.copies;
    const pinTag = productPinTag(options.patchesDir);
    return {
        runtime,
        target,
        targetPath: RUNTIME_TARGET_PATH,
        comparison,
        state: comparison.state,
        writes: [...writes].sort(),
        removals: [...removals].sort(),
        notices,
        legacyNotice: survey?.legacy ?? false,
        problems: check.problems,
        scratch: listScratchDirs(parent),
        verifiedUpstream: pinTag === null || runtime.verifiedUpstream.includes(pinTag),
        pinTag
    };
}
/**
 * ##RT-LOAD-STEPS step 3: a directory that holds the licence notice and nothing
 * else is not an installation. `standards load` creates `delta/own/codkit/` for
 * the notice alone (PROP-014 sec. 4a), and reading that as a library with every
 * file missing would turn a first `runtime load` into a refusal.
 */
function classifyTarget(comparison, shippedCount) {
    if (comparison.state !== 'drift')
        return comparison;
    const empty = comparison.modified.length === 0 && comparison.extra.length === 0 && comparison.missing.length === shippedCount;
    return empty ? { state: 'absent' } : comparison;
}
/**
 * ##RT-COMPAT-DECLARATION: the warning is about the product's pin, which lives
 * in codkit.json. The command itself needs no configuration (##RUNTIME-NAMESPACE),
 * so an absent or unreadable file is simply "nothing to compare against".
 */
function productPinTag(patchesDir) {
    try {
        return loadBaseConfig(patchesDir)?.pin.tag ?? null;
    }
    catch {
        return null;
    }
}
/** ##RT-LOAD-STEPS step 3: refuse before the first write, naming every path. */
export function refuseOnDrift(plan) {
    if (plan.comparison.state !== 'drift')
        return;
    const paths = [
        ...plan.comparison.modified.map((relative) => `modified ${relative}`),
        ...plan.comparison.extra.map((relative) => `extra ${relative}`),
        ...plan.comparison.missing.map((relative) => `missing ${relative}`)
    ];
    throw ckError('RUNTIME-DRIFT', `the installed runtime library differs from the one codkit ships:\n  ${paths.join('\n  ')}`, 'the library is codkit-owned: change it in codkit, then run codkit runtime load --upgrade to take the shipped version', RUNTIME_TARGET_PATH);
}
/** Execute the plan. `dryRun` writes nothing, not even the scratch cleanup. */
export function runRuntimeLoad(options) {
    const plan = planRuntimeLoad(options);
    if (plan.problems.length > 0) {
        return {
            plan,
            state: 'unchanged',
            filesWritten: 0,
            filesRemoved: 0,
            noticesWritten: [],
            legacyNoticeRemoved: false,
            removedScratch: []
        };
    }
    if (!options.upgrade)
        refuseOnDrift(plan);
    const state = plan.state === 'absent' ? 'created' : plan.state === 'drift' ? 'upgraded' : 'unchanged';
    const parent = join(options.patchesDir, ...TARGET_PARENT_SEGMENTS);
    const removedScratch = [];
    if (!options.dryRun) {
        for (const name of plan.scratch) {
            rmSync(join(parent, name), { recursive: true, force: true });
            removedScratch.push(name);
        }
    }
    // (5) The directory is written whole through a scratch directory and renamed
    // into place; the notice file already there is carried across.
    if (!options.dryRun && state !== 'unchanged') {
        writeTreeViaScratch(plan.runtime.directory, options.patchesDir, TARGET_PARENT_SEGMENTS, TARGET_DIR_NAME, {
            what: RUNTIME_TARGET_PATH,
            replace: true,
            preserve: NOT_PART_OF_THE_LIBRARY
        });
    }
    // (6) The notice, in both roots, with the components block recomputed now
    // that the library is installed (PROP-014 ##STD-LOAD-STEP-WRITE-NOTICE).
    const noticeOutcome = writeNoticeCopies(options.toolRoot, options.patchesDir, options.dryRun);
    return {
        plan,
        state,
        filesWritten: plan.writes.length,
        filesRemoved: plan.removals.length,
        noticesWritten: noticeOutcome.written,
        legacyNoticeRemoved: noticeOutcome.legacyRemoved,
        removedScratch
    };
}
/**
 * ##RT-CHECK: read-only. `absent` is information, not a finding - a product that
 * has not installed the library yet is in a legal state - and so is a notice
 * copy that is merely out of date; only an edited copy is a finding.
 */
export function runRuntimeCheck(options) {
    const plan = planRuntimeLoad(options);
    const findings = [];
    for (const line of driftLines(plan))
        findings.push({ code: 'RUNTIME-DRIFT', message: line });
    for (const notice of plan.notices) {
        if (notice.state === 'drift')
            findings.push({ code: 'STANDARDS-DRIFT', message: `${notice.path}: drift` });
    }
    return {
        plan,
        targetState: plan.state,
        installedVersion: installedVersion(plan.target),
        driftPaths: driftPaths(plan),
        findings,
        legacyNotice: plan.legacyNotice
    };
}
/** One line per disagreement, in the order `standards check` prints them. */
function driftLines(plan) {
    if (plan.comparison.state !== 'drift')
        return [];
    return [
        ...plan.comparison.modified.map((relative) => `modified ${relative}`),
        ...plan.comparison.extra.map((relative) => `extra ${relative}`),
        ...plan.comparison.missing.map((relative) => `missing ${relative}`)
    ];
}
/** Every path the two sides disagree about, for the `--json` data. */
export function driftPaths(plan) {
    if (plan.comparison.state !== 'drift')
        return [];
    return [...plan.comparison.modified, ...plan.comparison.extra, ...plan.comparison.missing].sort();
}
/**
 * The version the installed copy states, read from its own literal rather than
 * from the directory name - the directory is always called `codkit/`.
 */
function installedVersion(target) {
    if (statIfPresent(target) === null)
        return null;
    try {
        return readVersionLiteral(target).version;
    }
    catch {
        // A copy without a readable literal is drift, and drift is what the
        // comparison above already says; the version is simply unknown.
        return null;
    }
}
