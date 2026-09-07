/** @scope spec://codkit/modules/codkit/PROP-014#STD-LOAD-STEP-SOURCE */
// Delivering the standards package into a product repository (PROP-014 sec. 5)
// and reporting on the copy that is already there (sec. 6).
//
// The order of the steps is the whole design: everything that can refuse runs
// before anything is written. The licence gate is first
// (##STD-LOAD-STEP-LICENSE-GATE) and has no bypass; the manifest and the scrape
// contract are classified next, and drift of the installed copy or of either
// notice file refuses outright (##STD-LOAD-STEP-DRIFT-REFUSAL). Only then does
// a byte reach the patch set.
//
// ##DECISION-STD-NO-VIBE-INVOCATION: codkit never runs `vibe`. The next command
// is printed instead - the tool does not execute foreign code, and `vibe` may
// not exist in a CI container at all.

import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { statIfPresent } from './containedPath.ts';
import { writeContainedFileAtomic } from './containedFile.ts';
import type { LicenseProblem } from './licenseCheck.ts';
import { checkLicenseCarriers } from './licenseCheck.ts';
import { loadLicensePolicy } from './licensePolicy.ts';
import { applyBlock, refuseCarriageReturn, scanBlock } from './managedBlock.ts';
import type { BlockMarkers } from './managedBlock.ts';
import { ckError } from './messages.ts';
import { loadSpdxLicenseIds } from './spdxIds.ts';
import { MANIFEST_MARKERS, MANIFEST_PATH, canonicalManifestBlock, requireProjectTable } from './standardsManifest.ts';
import {
	compareTrees,
	fileIsIdentical,
	listScratchDirs,
	shippedStandardsPackage,
	STANDARDS_PACKAGE_GROUP,
	STANDARDS_PACKAGE_NAME,
	STANDARDS_PACKAGE_PARENT,
	writeTreeViaScratch
} from './standardsPackage.ts';
import type { StandardsPackage, TreeComparison } from './standardsPackage.ts';
import { CANONICAL_SCRAPE_BLOCK, NOTICE_PATHS, SCRAPE_CONTRACT_PATH, SCRAPE_MARKERS } from './standardsScrape.ts';

/** The notice file codkit ships, relative to toolRoot. */
export const NOTICE_SOURCE = 'codkit/config/LICENSE-CODKIT.md';

/** ##STD-LOAD-STEP-SOURCE: the test seam that relocates the shipped package. */
export const STANDARDS_SOURCE_ENV = 'CODKIT_TEST_STANDARDS_SOURCE';

export type FileState = 'absent' | 'identical' | 'drift';
export type BlockAction = 'append' | 'update' | 'unchanged' | 'no-contract';
export type BlockState = 'absent' | 'current' | 'stale' | 'malformed' | 'entry-outside-block' | 'no-contract';

export type NoticeFile = { readonly path: string; readonly state: FileState };

export type LoadPlan = {
	readonly package: StandardsPackage;
	readonly target: string;
	readonly comparison: TreeComparison;
	readonly notices: readonly NoticeFile[];
	readonly manifest: { readonly path: string; readonly action: BlockAction };
	readonly scrape: { readonly path: string; readonly action: BlockAction };
	readonly otherVersions: readonly string[];
	readonly scratch: readonly string[];
	readonly licences: { readonly own: readonly string[]; readonly thirdParty: readonly string[]; readonly notices: string | null };
	readonly problems: readonly LicenseProblem[];
	/** Malformed blocks and entries outside them; a refusal, never a write. */
	readonly blockProblems: readonly BlockProblem[];
	/** The scrape contract exists but codkit may not touch it: tail warning line. */
	readonly tailWarningLine: number | null;
};

/** ##STD-LOAD-LICENCE-NOTE: printed after the summary on every successful run. */
export const LICENCE_NOTES: readonly string[] = [
	'licence note: the package under vibevm/vibepacks/org.vibevm.codkit/standards/ carries its own LICENSE and REUSE.toml; they describe the package only.',
	"licence note: this repository's own licence file is untouched and is never copied anywhere by codkit.",
	"licence note: the fork tree's licence files and the product.json licence fields are upstream files - change them with a delta artifact in this patch set, never by hand.",
	'licence note: a REUSE.toml for the fork tree is a delta artifact too.'
];

/** ##STD-LOAD-NOTICE-PRINT: what a person needs to know about the notice file. */
export const NOTICE_RECOMMENDATIONS: readonly string[] = [
	'licence notice file: LICENSE-CODKIT.md',
	'  placed in two roots of this repository: ./LICENSE-CODKIT.md and ./delta/own/LICENSE-CODKIT.md;',
	'  the second copy reaches the fork tree with the own code on the next `codkit load`.',
	'  It states the licence of codkit and of its standards package - and of nothing around it.',
	'  Do not edit either copy: `codkit standards load` refuses over an edited copy; to take a',
	'  newer file from a newer codkit, delete both copies and run `codkit standards load` again.',
	"  Linking to it is your own deliberate choice: from this repository's README, and - through",
	"  an ordinary patch-set intervention - from the fork's README. Codkit edits neither.",
	'  The release branch built by `codkit publish` leaves it out; the developer tree, the `ci`',
	'  branch and the upgrade-cycle branch carry it. Never delete it in the fork tree by hand.',
	'  A clean export made with `vibe scrape` removes it: codkit keeps the two contract rows in',
	'  vibevm/scrape/contract.toml itself (block `codkit:begin scrape`); without a contract, run',
	'  `vibe scrape contract init` and `codkit standards load` again; for a contract kept at another',
	'  path, paste the rows printed by `codkit standards license`.',
	"  Where the licences end: the package and this notice describe codkit's own content; this",
	"  repository's licence file governs this repository and is never copied; the fork's licence",
	'  files and product.json licence fields change only through a delta artifact.'
];

/** The shipped package, honouring the test seam when the build allows it. */
export function resolveSource(toolRoot: string, override: string | null): StandardsPackage {
	return shippedStandardsPackage(toolRoot, override);
}

function readIfPresent(path: string): string | null {
	return statIfPresent(path) === null ? null : readFileSync(path, 'utf8');
}

function noticeState(source: string, target: string): FileState {
	if (statIfPresent(target) === null) return 'absent';
	return fileIsIdentical(source, target) ? 'identical' : 'drift';
}

export type BlockVerdict = { readonly action: BlockAction; readonly problem: BlockProblem | null };

export type BlockProblem = { readonly path: string; readonly message: string; readonly hint: string; readonly line: number | null };

/**
 * Classify a managed block. A malformed block and an entry outside it are
 * verdicts about the file, not broken environments: they are reported and the
 * command exits 1 with nothing written (PROP-007 ##CMD-STANDARDS-LOAD). CR is
 * its own refusal, and the file's absence is the caller's business.
 */
function classifyBlock(text: string, canonical: string, markers: BlockMarkers, path: string): BlockVerdict {
	refuseCarriageReturn(text, path);
	const scan = scanBlock(text, markers);
	if (scan.state === 'malformed') {
		return {
			action: 'unchanged',
			problem: {
				path,
				message: `the codkit block is malformed: ${scan.reason ?? 'unknown shape'}`,
				hint: 'repair the markers by hand; codkit never auto-repairs a block',
				line: scan.beginLine
			}
		};
	}
	if (scan.outsideEntryLine !== null) {
		return {
			action: 'unchanged',
			problem: {
				path,
				message: 'an entry codkit maintains sits outside its block',
				hint:
					path === MANIFEST_PATH
						? 'remove your entry; the dependency is kept by the codkit block'
						: 'the scrape rows for the codkit licence notice are kept by codkit inside its block; remove your row',
				line: scan.outsideEntryLine
			}
		};
	}
	if (scan.state === 'absent') return { action: 'append', problem: null };
	return { action: scan.text === canonical ? 'unchanged' : 'update', problem: null };
}

export type PlanOptions = {
	readonly toolRoot: string;
	readonly patchesDir: string;
	/** Value of the test seam, or null outside a test build. */
	readonly sourceOverride: string | null;
};

/** Everything a run would do, computed without writing anything. */
export function planStandardsLoad(options: PlanOptions): LoadPlan {
	const shipped = resolveSource(options.toolRoot, options.sourceOverride);
	const policy = loadLicensePolicy();
	const check = checkLicenseCarriers(shipped.directory, policy, loadSpdxLicenseIds());

	const parent = join(options.patchesDir, ...STANDARDS_PACKAGE_PARENT.split('/'));
	const target = join(parent, `v${shipped.version}`);
	const scratch = listScratchDirs(parent);
	const comparison = check.problems.length > 0 ? ({ state: 'absent' } as const) : compareTrees(shipped.directory, target);

	const manifestPath = join(options.patchesDir, MANIFEST_PATH);
	const manifestText = readIfPresent(manifestPath);
	let manifestAction: BlockAction = 'append';
	const blockProblems: BlockProblem[] = [];
	if (check.problems.length === 0) {
		if (manifestText === null) {
			throw ckError(
				'CONFIG',
				`${MANIFEST_PATH} does not exist in the patch set`,
				'run vibe init in the patch set first; codkit does not create vibevm projects',
				MANIFEST_PATH
			);
		}
		refuseCarriageReturn(manifestText, MANIFEST_PATH);
		requireProjectTable(manifestText);
		const verdict = classifyBlock(manifestText, canonicalManifestBlock(shipped.version), MANIFEST_MARKERS, MANIFEST_PATH);
		manifestAction = verdict.action;
		if (verdict.problem !== null) blockProblems.push(verdict.problem);
	}

	const contractPath = join(options.patchesDir, ...SCRAPE_CONTRACT_PATH.split('/'));
	const contractText = readIfPresent(contractPath);
	let scrapeAction: BlockAction = 'no-contract';
	if (contractText !== null && check.problems.length === 0) {
		const verdict = classifyBlock(contractText, CANONICAL_SCRAPE_BLOCK, SCRAPE_MARKERS, SCRAPE_CONTRACT_PATH);
		scrapeAction = verdict.action;
		if (verdict.problem !== null) blockProblems.push(verdict.problem);
	}

	const noticeSource = join(options.toolRoot, ...NOTICE_SOURCE.split('/'));
	const notices = NOTICE_PATHS.map((relative) => ({
		path: relative,
		state: check.problems.length > 0 ? ('absent' as FileState) : noticeState(noticeSource, join(options.patchesDir, ...relative.split('/')))
	}));

	const otherVersions = statIfPresent(parent) === null ? [] : compareVersionDirs(parent, `v${shipped.version}`);

	return {
		package: shipped,
		target,
		comparison,
		notices,
		manifest: { path: MANIFEST_PATH, action: manifestAction },
		scrape: { path: SCRAPE_CONTRACT_PATH, action: scrapeAction },
		otherVersions,
		scratch,
		licences: { own: check.licences.own, thirdParty: check.licences.thirdParty, notices: check.licences.notices },
		problems: check.problems,
		blockProblems,
		tailWarningLine: contractText === null ? null : scanBlock(contractText, SCRAPE_MARKERS).tailWarningLine
	};
}

function compareVersionDirs(parent: string, own: string): readonly string[] {
	const shape = statIfPresent(parent);
	if (shape === null) return [];
	// Only version directories count; a scratch directory is reported separately.
	return listVersionDirs(parent).filter((name) => name !== own);
}

function listVersionDirs(parent: string): readonly string[] {
	return readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^v[0-9]/u.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

export type RunOptions = PlanOptions & { readonly dryRun: boolean };

export type LoadOutcome = {
	readonly plan: LoadPlan;
	readonly filesCreated: number;
	readonly filesUnchanged: number;
	readonly noticesWritten: readonly string[];
	readonly removedScratch: readonly string[];
};

/** ##STD-LOAD-STEP-DRIFT-REFUSAL: refuse before the first write. */
export function refuseOnDrift(plan: LoadPlan): void {
	const drifted: string[] = [];
	if (plan.comparison.state === 'drift') {
		for (const relative of plan.comparison.modified) drifted.push(`modified ${relative}`);
		for (const relative of plan.comparison.extra) drifted.push(`extra ${relative}`);
		for (const relative of plan.comparison.missing) drifted.push(`missing ${relative}`);
	}
	for (const notice of plan.notices) {
		if (notice.state === 'drift') drifted.push(`modified ${notice.path}`);
	}
	if (drifted.length === 0) return;
	throw ckError(
		'STANDARDS-DRIFT',
		`the installed standards package differs from the one codkit ships:\n  ${drifted.join('\n  ')}`,
		'the installed standards package and the LICENSE-CODKIT.md copies are codkit-owned: move local edits into your own specs, delete the directory or file and run codkit standards load again',
		`${STANDARDS_PACKAGE_PARENT}/v${plan.package.version}`
	);
}

/** Execute the plan. `dryRun` writes nothing, not even the scratch cleanup. */
export function runStandardsLoad(options: RunOptions): LoadOutcome {
	const plan = planStandardsLoad(options);
	if (plan.problems.length > 0 || plan.blockProblems.length > 0) {
		return { plan, filesCreated: 0, filesUnchanged: 0, noticesWritten: [], removedScratch: [] };
	}
	refuseOnDrift(plan);

	const parent = join(options.patchesDir, ...STANDARDS_PACKAGE_PARENT.split('/'));
	const fileCount = countFiles(plan.package.directory);
	const removedScratch: string[] = [];
	if (!options.dryRun) {
		for (const name of plan.scratch) {
			rmSync(join(parent, name), { recursive: true, force: true });
			removedScratch.push(name);
		}
	}

	let created = 0;
	let unchanged = 0;
	if (plan.comparison.state === 'identical') {
		unchanged = fileCount;
	} else {
		created = fileCount;
		if (!options.dryRun) {
			writeTreeViaScratch(plan.package.directory, options.patchesDir, STANDARDS_PACKAGE_PARENT.split('/'), `v${plan.package.version}`, {
				what: STANDARDS_PACKAGE_PARENT
			});
		}
	}

	const noticeSource = join(options.toolRoot, ...NOTICE_SOURCE.split('/'));
	const noticesWritten: string[] = [];
	for (const notice of plan.notices) {
		if (notice.state !== 'absent') continue;
		noticesWritten.push(notice.path);
		if (options.dryRun) continue;
		writeContainedFileAtomic(options.patchesDir, notice.path, { what: notice.path, bytes: readFileSync(noticeSource) });
	}

	if (!options.dryRun && plan.manifest.action !== 'unchanged') {
		const manifestPath = join(options.patchesDir, MANIFEST_PATH);
		const applied = applyBlock(readFileSync(manifestPath, 'utf8'), canonicalManifestBlock(plan.package.version), MANIFEST_MARKERS);
		if (applied.action !== 'unchanged') {
			writeContainedFileAtomic(options.patchesDir, MANIFEST_PATH, { what: MANIFEST_PATH, bytes: Buffer.from(applied.text, 'utf8') });
		}
	}

	if (!options.dryRun && plan.scrape.action !== 'unchanged' && plan.scrape.action !== 'no-contract') {
		const contractPath = join(options.patchesDir, ...SCRAPE_CONTRACT_PATH.split('/'));
		const applied = applyBlock(readFileSync(contractPath, 'utf8'), CANONICAL_SCRAPE_BLOCK, SCRAPE_MARKERS);
		if (applied.action !== 'unchanged') {
			writeContainedFileAtomic(options.patchesDir, SCRAPE_CONTRACT_PATH, {
				what: SCRAPE_CONTRACT_PATH,
				bytes: Buffer.from(applied.text, 'utf8')
			});
		}
	}

	return { plan, filesCreated: created, filesUnchanged: unchanged, noticesWritten, removedScratch };
}

function countFiles(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
	}
	return total;
}

export type CheckReport = {
	readonly plan: LoadPlan;
	readonly targetState: FileState;
	readonly manifestState: BlockState;
	readonly scrapeState: BlockState;
	readonly findings: readonly string[];
};

/** ##STD-CHECK-ALGORITHM: read-only, one line per finding. */
export function runStandardsCheck(options: PlanOptions): CheckReport {
	const plan = planStandardsLoad(options);
	const targetState: FileState = plan.comparison.state === 'drift' ? 'drift' : plan.comparison.state === 'absent' ? 'absent' : 'identical';
	const manifestState = blockStateOf(plan.manifest.action);
	const scrapeState = blockStateOf(plan.scrape.action);
	const findings: string[] = [];
	if (targetState === 'absent') findings.push('the standards package is not installed');
	if (targetState === 'drift' && plan.comparison.state === 'drift') {
		for (const relative of plan.comparison.modified) findings.push(`modified ${relative}`);
		for (const relative of plan.comparison.extra) findings.push(`extra ${relative}`);
		for (const relative of plan.comparison.missing) findings.push(`missing ${relative}`);
	}
	for (const notice of plan.notices) {
		if (notice.state !== 'identical') findings.push(`${notice.path}: ${notice.state}`);
	}
	for (const problem of plan.problems) findings.push(`${problem.file}: ${problem.message}`);
	for (const problem of plan.blockProblems) findings.push(`${problem.path}: ${problem.message}`);
	if (manifestState !== 'current' && !plan.blockProblems.some((problem) => problem.path === MANIFEST_PATH)) {
		findings.push(`${MANIFEST_PATH}: block ${manifestState}`);
	}
	if (scrapeState !== 'current' && scrapeState !== 'no-contract') findings.push(`${SCRAPE_CONTRACT_PATH}: block ${scrapeState}`);
	return { plan, targetState, manifestState, scrapeState, findings };
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

/** The verbatim text of the shipped notice file. */
export function noticeText(toolRoot: string): string {
	const path = join(toolRoot, ...NOTICE_SOURCE.split('/'));
	try {
		return readFileSync(path, 'utf8');
	} catch (error) {
		throw ckError(
			'INTERNAL',
			`cannot read the shipped licence notice: ${error instanceof Error ? error.message : String(error)}`,
			'restore the codkit installation from the approved supply',
			NOTICE_SOURCE
		);
	}
}

/** Where the notice would go, for the plan and the report. */
export function noticeTargets(patchesDir: string): readonly string[] {
	return NOTICE_PATHS.map((relative) => join(patchesDir, ...relative.split('/')));
}

/** The parent of the own-code notice copy, created on demand by the writer. */
export function noticeParent(patchesDir: string): string {
	return dirname(join(patchesDir, ...NOTICE_PATHS[1].split('/')));
}

export { STANDARDS_PACKAGE_GROUP, STANDARDS_PACKAGE_NAME };
