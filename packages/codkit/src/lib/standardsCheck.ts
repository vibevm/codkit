/** @scope spec://codkit/modules/codkit/PROP-014#STD-CHECK-ALGORITHM */
// Reporting on the packages a product has installed (PROP-014 sec. 6).
//
// ##STD-CHECK-ALGORITHM: read-only, over every shipped package. The report is
// the same plan `standards load` computes - one classification, two readers -
// so what `check` calls a finding is exactly what `load` would refuse over.

import { MANIFEST_PATH } from './standardsManifest.ts';
import { STANDARDS_PACKAGE_NAME } from './standardsPackage.ts';
import { planStandardsLoad } from './standardsLoad.ts';
import type { BlockAction, BlockState, FileState, LoadPlan, PackagePlan, PlanOptions } from './standardsLoad.ts';
import { SCRAPE_CONTRACT_PATH } from './standardsScrape.ts';

/** ##STD-CHECK-ALGORITHM: the state of one installed package. */
export type PackageReport = {
	readonly name: string;
	readonly version: string;
	readonly state: FileState;
	readonly paths: readonly string[];
};

export type CheckReport = {
	readonly plan: LoadPlan;
	readonly packages: readonly PackageReport[];
	/**
	 * The state of the standards package, which PROP-007 ##CMD-STANDARDS-CHECK
	 * names as `data.target`; `packages` carries every package of the set.
	 */
	readonly targetState: FileState;
	readonly manifestState: BlockState;
	readonly scrapeState: BlockState;
	readonly findings: readonly string[];
	/** ##STD-NOTICE-LEGACY-COPY: a warning, not a finding. */
	readonly legacyNotice: boolean;
};

/** ##STD-CHECK-ALGORITHM: read-only, one line per finding, over every package. */
export function runStandardsCheck(options: PlanOptions): CheckReport {
	const plan = planStandardsLoad(options);
	const packages = plan.packages.map((entry) => ({
		name: entry.package.name,
		version: entry.package.version,
		state: entry.comparison.state,
		paths: driftPaths(entry)
	}));
	const manifestState = blockStateOf(plan.manifest.action);
	const scrapeState = blockStateOf(plan.scrape.action);
	const findings: string[] = [];
	for (const entry of plan.packages) {
		if (entry.comparison.state === 'absent') findings.push(`the ${entry.package.name} package is not installed`);
		if (entry.comparison.state !== 'drift') continue;
		for (const relative of entry.comparison.modified) findings.push(`${entry.package.name}: modified ${relative}`);
		for (const relative of entry.comparison.extra) findings.push(`${entry.package.name}: extra ${relative}`);
		for (const relative of entry.comparison.missing) findings.push(`${entry.package.name}: missing ${relative}`);
	}
	for (const notice of plan.notices) {
		if (notice.state !== 'identical') findings.push(`${notice.path}: ${notice.state}`);
	}
	for (const problem of plan.problems) findings.push(`${problem.package}: ${problem.file}: ${problem.message}`);
	for (const problem of plan.blockProblems) findings.push(`${problem.path}: ${problem.message}`);
	if (manifestState !== 'current' && !plan.blockProblems.some((problem) => problem.path === MANIFEST_PATH)) {
		findings.push(`${MANIFEST_PATH}: block ${manifestState}`);
	}
	if (scrapeState !== 'current' && scrapeState !== 'no-contract') findings.push(`${SCRAPE_CONTRACT_PATH}: block ${scrapeState}`);
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
export function driftPaths(entry: PackagePlan): readonly string[] {
	if (entry.comparison.state !== 'drift') return [];
	return [...entry.comparison.modified, ...entry.comparison.extra, ...entry.comparison.missing];
}

function blockStateOf(action: BlockAction): BlockState {
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
