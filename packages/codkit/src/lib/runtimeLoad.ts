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
import { loadBaseConfig } from './configFile.ts';
import { statIfPresent } from './containedPath.ts';
import type { LicenseProblem } from './licenseCheck.ts';
import { checkLicenseCarriers } from './licenseCheck.ts';
import { loadLicensePolicy } from './licensePolicy.ts';
import { NOTICE_NAME, NOTICE_TARGET_PATHS, RUNTIME_PREFIX, surveyNotice, writeNoticeCopies } from './licenceNotice.ts';
import type { NoticeCopy } from './licenceNotice.ts';
import { ckError } from './messages.ts';
import { readVersionLiteral, shippedRuntime } from './runtimePackage.ts';
import type { RuntimePackage } from './runtimePackage.ts';
import { loadSpdxLicenseIds } from './spdxIds.ts';
import { compareTrees, listScratchDirs, listTreeFiles, writeTreeViaScratch } from './standardsPackage.ts';
import type { TreeComparison } from './standardsPackage.ts';
import type { ProjectType } from '@codkit/type-api';

/** Where the library is installed inside the patch set (##RT-DIRECTORY-IS-CODKIT). */
export const RUNTIME_TARGET_PATH = RUNTIME_PREFIX;

/** The parent of the installed directory, and the directory's own name. */
const TARGET_PARENT_SEGMENTS = RUNTIME_TARGET_PATH.split('/').slice(0, -1);
const TARGET_DIR_NAME = RUNTIME_TARGET_PATH.split('/').at(-1) ?? 'codkit';

/**
 * ##RT-LOAD-STEPS step 3: the notice file lives inside the target directory but
 * is written by PROP-014 sec. 4a, so it is neither compared nor removed here.
 */
const NOT_PART_OF_THE_LIBRARY: readonly string[] = [NOTICE_NAME];

/** ##RT-LOAD-STEPS step 7 and ##RT-CHECK: what the copy is. */
export type RuntimeTargetState = 'absent' | 'identical' | 'drift';

/** ##RT-LOAD-STEPS step 7: what a run of `runtime load` did. */
export type RuntimeLoadState = 'created' | 'upgraded' | 'unchanged';

export type PlanOptions = {
	readonly toolRoot: string;
	readonly patchesDir: string;
	/**
	 * ##RT-SHIPPED-LOCATION: the runtime package the project type delivers. The
	 * engine never picks a library by looking at the installation; it asks the
	 * type for the identifier and reads that directory (PROP-016
	 * ##TYPE-AREA-RUNTIME).
	 */
	readonly packageId: string;
	/** Relocates the shipped library; the unit tests are its only caller. */
	readonly sourceOverride?: string | null;
};

export type RuntimePlan = {
	readonly runtime: RuntimePackage;
	/** Absolute path of the installed directory. */
	readonly target: string;
	/** The same path, relative to the patch set. */
	readonly targetPath: string;
	readonly comparison: TreeComparison;
	readonly state: RuntimeTargetState;
	/** Paths inside the directory that would receive bytes. */
	readonly writes: readonly string[];
	/** Paths inside the directory the shipped library does not have. */
	readonly removals: readonly string[];
	readonly notices: readonly NoticeCopy[];
	/** ##STD-NOTICE-LEGACY-COPY: the edition-2 copy is still there. */
	readonly legacyNotice: boolean;
	readonly problems: readonly LicenseProblem[];
	/** Directories an interrupted run left behind next to the target. */
	readonly scratch: readonly string[];
	/** ##RT-COMPAT-DECLARATION: the product's pin is a tag the library was verified on. */
	readonly verifiedUpstream: boolean;
	/** The pin tag the verdict above was taken on; null when the product has no config. */
	readonly pinTag: string | null;
};

/**
 * ##RT-LOAD-STEPS step 7: what a person does in the tree after a delivery. The
 * lines are the type's - they name imports and lint targets of that family -
 * and the engine only prints them.
 */
export function runtimeNextSteps(type: ProjectType, ownRoot: string): readonly string[] {
	return type.runtime?.nextSteps(ownRoot) ?? [];
}

/** Everything a run would do, computed without writing anything. */
export function planRuntimeLoad(options: PlanOptions): RuntimePlan {
	// (1) The source: exactly one version directory whose literal agrees with it.
	const runtime = shippedRuntime(options.toolRoot, options.packageId, options.sourceOverride ?? null);

	// (2) The licence gate. `packageShape: false`: the library is a directory of
	// files, not a vibe package - it has no manifest, no LICENSE and no registry
	// (##RT-ONLY-TS-AND-MD).
	const check = checkLicenseCarriers(runtime.directory, loadLicensePolicy(), loadSpdxLicenseIds(), { packageShape: false });

	// (3) The target, with the notice file left out of the comparison.
	const target = join(options.patchesDir, ...RUNTIME_TARGET_PATH.split('/'));
	const parent = join(options.patchesDir, ...TARGET_PARENT_SEGMENTS);
	const shipped = listTreeFiles(runtime.directory);
	const comparison =
		check.problems.length > 0
			? ({ state: 'absent' } as const)
			: classifyTarget(compareTrees(runtime.directory, target, { ignoreInTarget: NOT_PART_OF_THE_LIBRARY }), shipped.length);
	const writes =
		comparison.state === 'identical' ? [] : comparison.state === 'absent' ? shipped : [...comparison.modified, ...comparison.missing];
	const removals = comparison.state === 'drift' ? comparison.extra : [];

	const survey = check.problems.length > 0 ? null : surveyNotice(options.toolRoot, options.patchesDir, options.packageId);
	const notices = survey === null ? NOTICE_TARGET_PATHS.map((path) => ({ path, state: 'absent' as const })) : survey.copies;

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
function classifyTarget(comparison: TreeComparison, shippedCount: number): TreeComparison {
	if (comparison.state !== 'drift') return comparison;
	const empty = comparison.modified.length === 0 && comparison.extra.length === 0 && comparison.missing.length === shippedCount;
	return empty ? { state: 'absent' } : comparison;
}

/**
 * ##RT-COMPAT-DECLARATION: the warning is about the product's pin, which lives
 * in codkit.json. The command itself needs no configuration (##RUNTIME-NAMESPACE),
 * so an absent or unreadable file is simply "nothing to compare against".
 */
function productPinTag(patchesDir: string): string | null {
	try {
		return loadBaseConfig(patchesDir)?.pin.tag ?? null;
	} catch {
		return null;
	}
}

export type RunOptions = PlanOptions & { readonly dryRun: boolean; readonly upgrade: boolean };

export type RuntimeLoadOutcome = {
	readonly plan: RuntimePlan;
	readonly state: RuntimeLoadState;
	readonly filesWritten: number;
	readonly filesRemoved: number;
	readonly noticesWritten: readonly { readonly path: string; readonly action: 'created' | 'updated' }[];
	readonly legacyNoticeRemoved: boolean;
	readonly removedScratch: readonly string[];
};

/** ##RT-LOAD-STEPS step 3: refuse before the first write, naming every path. */
export function refuseOnDrift(plan: RuntimePlan): void {
	if (plan.comparison.state !== 'drift') return;
	const paths = [
		...plan.comparison.modified.map((relative) => `modified ${relative}`),
		...plan.comparison.extra.map((relative) => `extra ${relative}`),
		...plan.comparison.missing.map((relative) => `missing ${relative}`)
	];
	throw ckError(
		'RUNTIME-DRIFT',
		`the installed runtime library differs from the one codkit ships:\n  ${paths.join('\n  ')}`,
		'the library is codkit-owned: change it in codkit, then run codkit runtime load --upgrade to take the shipped version',
		RUNTIME_TARGET_PATH
	);
}

/** Execute the plan. `dryRun` writes nothing, not even the scratch cleanup. */
export function runRuntimeLoad(options: RunOptions): RuntimeLoadOutcome {
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
	if (!options.upgrade) refuseOnDrift(plan);

	const state: RuntimeLoadState = plan.state === 'absent' ? 'created' : plan.state === 'drift' ? 'upgraded' : 'unchanged';
	const parent = join(options.patchesDir, ...TARGET_PARENT_SEGMENTS);
	const removedScratch: string[] = [];
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
	const noticeOutcome = writeNoticeCopies(options.toolRoot, options.patchesDir, options.packageId, options.dryRun);

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

export type RuntimeFinding = { readonly code: 'RUNTIME-DRIFT' | 'STANDARDS-DRIFT'; readonly message: string };

export type RuntimeCheckReport = {
	readonly plan: RuntimePlan;
	readonly targetState: RuntimeTargetState;
	/** The version the installed copy states; null when it is absent or unreadable. */
	readonly installedVersion: string | null;
	readonly driftPaths: readonly string[];
	readonly findings: readonly RuntimeFinding[];
	readonly legacyNotice: boolean;
};

/**
 * ##RT-CHECK: read-only. `absent` is information, not a finding - a product that
 * has not installed the library yet is in a legal state - and so is a notice
 * copy that is merely out of date; only an edited copy is a finding.
 */
export function runRuntimeCheck(options: PlanOptions): RuntimeCheckReport {
	const plan = planRuntimeLoad(options);
	const findings: RuntimeFinding[] = [];
	for (const line of driftLines(plan)) findings.push({ code: 'RUNTIME-DRIFT', message: line });
	for (const notice of plan.notices) {
		if (notice.state === 'drift') findings.push({ code: 'STANDARDS-DRIFT', message: `${notice.path}: drift` });
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
function driftLines(plan: RuntimePlan): readonly string[] {
	if (plan.comparison.state !== 'drift') return [];
	return [
		...plan.comparison.modified.map((relative) => `modified ${relative}`),
		...plan.comparison.extra.map((relative) => `extra ${relative}`),
		...plan.comparison.missing.map((relative) => `missing ${relative}`)
	];
}

/** Every path the two sides disagree about, for the `--json` data. */
export function driftPaths(plan: RuntimePlan): readonly string[] {
	if (plan.comparison.state !== 'drift') return [];
	return [...plan.comparison.modified, ...plan.comparison.extra, ...plan.comparison.missing].sort();
}

/**
 * The version the installed copy states, read from its own literal rather than
 * from the directory name - the directory is always called `codkit/`.
 */
function installedVersion(target: string): string | null {
	if (statIfPresent(target) === null) return null;
	try {
		return readVersionLiteral(target).version;
	} catch {
		// A copy without a readable literal is drift, and drift is what the
		// comparison above already says; the version is simply unknown.
		return null;
	}
}
