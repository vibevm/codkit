/** @scope spec://codkit/modules/codkit/PROP-014#STD-LOAD-STEP-SOURCE */
// Delivering the packages codkit ships into a product repository (PROP-014
// sec. 5) and reporting on the copies that are already there (sec. 6).
//
// The order of the steps is the whole design: everything that can refuse runs
// before anything is written. The licence gate is first
// (##STD-LOAD-STEP-LICENSE-GATE) and has no bypass; the manifest and the scrape
// contract are classified next, and drift of an installed copy or of either
// notice file refuses outright (##STD-LOAD-STEP-DRIFT-REFUSAL). Only then does
// a byte reach the patch set.
//
// ##STD-LOAD-ALL-PACKAGES: the steps run for every delivered package in one
// pass, and the refusal of any one of them stops the whole run before the first
// write. There is one managed block in the manifest, with one table per
// package, so the product has one place to look.
//
// ##STD-PACKAGES-OF-THE-TYPE: which packages those are is the universal set
// plus the ones the patch set's project type names, so the command needs the
// configuration to know what it delivers at all (##STD-LOAD-ROOTS).
//
// ##STD-LOAD-UPGRADE: an installed copy whose bytes differ is drift, and drift
// is a refusal - unless `--upgrade` says to take the shipped copy, which
// replaces the package directory as a whole the way `runtime load --upgrade`
// does (PROP-015 ##RT-LOAD-UPGRADE). The edition is mutable under the owner's
// ruling (##DECISION-STD-MUTABLE-EDITION): the same version number may carry
// new bytes, and codkit cannot tell that from a product's edit, so it asks.
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
import { MANIFEST_PATH, canonicalManifestBlock, manifestMarkers, requireProjectTable } from './standardsManifest.ts';
import {
	compareTrees,
	listScratchDirs,
	shippedPackages,
	shippedStandardsPackage,
	SHIPPED_PACKAGES_PARENT,
	STANDARDS_PACKAGE_GROUP,
	STANDARDS_PACKAGE_NAME,
	STANDARDS_PACKAGE_PARENT,
	writeTreeViaScratch
} from './standardsPackage.ts';
import type { ShippedPackage, StandardsPackage, TreeComparison } from './standardsPackage.ts';
import {
	NOTICE_OWN_PATH,
	NOTICE_TARGET_PATHS,
	noticeTemplate,
	renderNotice,
	surveyNotice,
	writeNoticeCopies,
	type NoticeComponent,
	type NoticeCopyState
} from './licenceNotice.ts';
import { CANONICAL_SCRAPE_BLOCK, SCRAPE_CONTRACT_PATH, SCRAPE_MARKERS } from './standardsScrape.ts';

export { NOTICE_SOURCE } from './licenceNotice.ts';

/** ##STD-LOAD-STEP-SOURCE: the test seam that relocates the shipped package. */
export const STANDARDS_SOURCE_ENV = 'CODKIT_TEST_STANDARDS_SOURCE';

export type FileState = 'absent' | 'identical' | 'drift';
/** A notice copy: `stale` differs from the rendered text only inside the components block (##STD-NOTICE-COMPONENTS-BLOCK). */
export type NoticeState = NoticeCopyState;
export type BlockAction = 'append' | 'update' | 'unchanged' | 'no-contract';
export type BlockState = 'absent' | 'current' | 'stale' | 'malformed' | 'entry-outside-block' | 'no-contract';

export type NoticeFile = { readonly path: string; readonly state: NoticeState };

/** Which package a licence problem belongs to, now that a run checks several. */
export type PackageLicenseProblem = LicenseProblem & { readonly package: string };

export type PackageLicences = {
	readonly own: readonly string[];
	readonly thirdParty: readonly string[];
	readonly notices: string | null;
};

/** What one shipped package would do to the patch set. */
export type PackagePlan = {
	readonly package: ShippedPackage;
	/** Absolute path of the installed version directory. */
	readonly target: string;
	/** The same path, relative to the patch set. */
	readonly targetPath: string;
	readonly comparison: TreeComparison;
	/**
	 * ##STD-LOAD-UPGRADE: what `--upgrade` would take from the shipped package,
	 * and what it would drop - the paths the copy has and the package does not,
	 * plus every superseded version directory of the same package.
	 */
	readonly replace: readonly string[];
	readonly remove: readonly string[];
	/** Version directories of the same package other than the shipped one. */
	readonly otherVersions: readonly string[];
	/** Directories an interrupted run left next to the target. */
	readonly scratch: readonly string[];
	readonly licences: PackageLicences;
	readonly problems: readonly PackageLicenseProblem[];
	/** How many files the shipped package has. */
	readonly fileCount: number;
};

export type LoadPlan = {
	/** ##STD-LOAD-ALL-PACKAGES: `standards` first, then the rest by name. */
	readonly packages: readonly PackagePlan[];
	readonly notices: readonly NoticeFile[];
	/** ##STD-NOTICE-LEGACY-COPY: the edition-2 copy is still there. */
	readonly legacyNotice: boolean;
	readonly manifest: { readonly path: string; readonly action: BlockAction };
	readonly scrape: { readonly path: string; readonly action: BlockAction };
	/** Every superseded version directory of the set, and every scratch directory. */
	readonly otherVersions: readonly string[];
	readonly scratch: readonly string[];
	/** The licences of the whole set, for the one summary line. */
	readonly licences: PackageLicences;
	readonly problems: readonly PackageLicenseProblem[];
	/** Malformed blocks and entries outside them; a refusal, never a write. */
	readonly blockProblems: readonly BlockProblem[];
	/** The scrape contract exists but codkit may not touch it: tail warning line. */
	readonly tailWarningLine: number | null;
};

/** ##STD-LOAD-LICENCE-NOTE: printed after the summary on every successful run. */
export const LICENCE_NOTES: readonly string[] = [
	'licence note: the package under vibevm/vibepacks/org.vibevm.codkit/standards/ carries its own LICENSE and REUSE.toml; they describe the package only.',
	"licence note: this repository's own licence file is untouched and is never copied anywhere by codkit.",
	"licence note: the fork tree's licence files and the licence fields of its product manifest are upstream files - change them with a delta artifact in this patch set, never by hand.",
	'licence note: a REUSE.toml for the fork tree is a delta artifact too.'
];

/** ##STD-LOAD-NOTICE-PRINT: what a person needs to know about the notice file. */
export const NOTICE_RECOMMENDATIONS: readonly string[] = [
	'licence notice file: LICENSE-CODKIT.md',
	'  placed in two roots of this repository: ./LICENSE-CODKIT.md and ./delta/own/codkit/LICENSE-CODKIT.md;',
	'  the second copy reaches the fork tree with the own code on the next `codkit load`.',
	'  It states its scope by path: everything under vibevm/vibepacks/org.vibevm.codkit/** (and its',
	'  vibevm/vibedeps/org.vibevm.codkit.*/** projection), under delta/own/codkit/**, and the file itself',
	"  is codkit's and licensed under UPL-1.0; nothing else is. A components block inside it lists what is",
	'  installed; codkit rewrites the block on every `standards load` and `runtime load`.',
	'  Do not edit either copy: a delivering command refuses over an edited copy; to recover, delete',
	'  the edited copy and run `codkit standards load` again.',
	"  Linking to it is your own deliberate choice: from this repository's README, and - through",
	"  an ordinary patch-set intervention - from the fork's README. Codkit edits neither.",
	'  The release branch built by `codkit publish` leaves it out; the developer tree, the `ci`',
	'  branch and the upgrade-cycle branch carry it. Never delete it in the fork tree by hand.',
	'  A clean export made with `vibe scrape` removes it: codkit keeps the contract rows in',
	'  vibevm/scrape/contract.toml itself (block `codkit:begin scrape`); without a contract, run',
	'  `vibe scrape contract init` and `codkit standards load` again; for a contract kept at another',
	'  path, paste the rows printed by `codkit standards license`.',
	'  Your own REUSE.toml may name the same paths: `codkit standards license` prints the annotation.',
	"  Where the licences end: the packages, the runtime and this notice describe codkit's own content;",
	"  this repository's licence file governs this repository and is never copied; the fork's licence",
	'  files and the licence fields of the product manifest change only through a delta artifact.'
];

/** The shipped standards package, honouring the test seam when the build allows it. */
export function resolveSource(toolRoot: string, override: string | null): StandardsPackage {
	return shippedStandardsPackage(toolRoot, override);
}

function readIfPresent(path: string): string | null {
	return statIfPresent(path) === null ? null : readFileSync(path, 'utf8');
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
						? 'remove your entry; the dependencies are kept by the codkit block'
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
	/**
	 * ##STD-PACKAGES-OF-THE-TYPE: the packages the patch set's project type
	 * names, delivered beside the universal ones. Empty for a type whose
	 * upstream family has no package of its own.
	 */
	readonly typePackages: readonly string[];
	/** Value of the test seam, or null outside a test build. */
	readonly sourceOverride: string | null;
};

/** Everything a run would do, computed without writing anything. */
export function planStandardsLoad(options: PlanOptions): LoadPlan {
	const shipped = shippedPackages(options.toolRoot, options.typePackages, options.sourceOverride);
	const policy = loadLicensePolicy();
	const spdx = loadSpdxLicenseIds();

	// ##STD-LOAD-STEP-LICENSE-GATE: every package is checked before the state of
	// the patch set is even read, so one failing package writes nothing anywhere.
	const checks = shipped.map((entry) => ({ entry, check: checkLicenseCarriers(entry.directory, policy, spdx) }));
	const problems: PackageLicenseProblem[] = checks.flatMap(({ entry, check }) =>
		check.problems.map((problem) => ({ ...problem, package: entry.name }))
	);
	const clean = problems.length === 0;

	const packages = checks.map(({ entry, check }) =>
		planPackage(
			options.patchesDir,
			entry,
			check.licences,
			problems.filter((problem) => problem.package === entry.name),
			clean
		)
	);

	const names = shipped.map((entry) => entry.name);
	const markers = manifestMarkers(names);
	const canonical = canonicalManifestBlock(shipped);
	const manifestPath = join(options.patchesDir, MANIFEST_PATH);
	const manifestText = readIfPresent(manifestPath);
	let manifestAction: BlockAction = 'append';
	const blockProblems: BlockProblem[] = [];
	if (clean) {
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
		const verdict = classifyBlock(manifestText, canonical, markers, MANIFEST_PATH);
		manifestAction = verdict.action;
		if (verdict.problem !== null) blockProblems.push(verdict.problem);
	}

	const contractPath = join(options.patchesDir, ...SCRAPE_CONTRACT_PATH.split('/'));
	const contractText = readIfPresent(contractPath);
	let scrapeAction: BlockAction = 'no-contract';
	if (contractText !== null && clean) {
		const verdict = classifyBlock(contractText, CANONICAL_SCRAPE_BLOCK, SCRAPE_MARKERS, SCRAPE_CONTRACT_PATH);
		scrapeAction = verdict.action;
		if (verdict.problem !== null) blockProblems.push(verdict.problem);
	}

	// The rendered text depends on what is installed, which this run may change;
	// the plan looks at the copies as they are, the writer renders again after
	// the packages landed (##STD-LOAD-STEP-WRITE-NOTICE).
	const survey = clean ? surveyNotice(options.toolRoot, options.patchesDir) : null;
	const notices = survey === null ? NOTICE_TARGET_PATHS.map((path) => ({ path, state: 'absent' as NoticeState })) : survey.copies;

	return {
		packages,
		notices,
		legacyNotice: survey?.legacy ?? false,
		manifest: { path: MANIFEST_PATH, action: manifestAction },
		scrape: { path: SCRAPE_CONTRACT_PATH, action: scrapeAction },
		otherVersions: unique(packages.flatMap((entry) => entry.otherVersions)),
		scratch: unique(packages.flatMap((entry) => entry.scratch)),
		licences: mergeLicences(packages.map((entry) => entry.licences)),
		problems,
		blockProblems,
		tailWarningLine: contractText === null ? null : scanBlock(contractText, SCRAPE_MARKERS).tailWarningLine
	};
}

/** One package against the patch set: where it goes, what is there, what an upgrade would do. */
function planPackage(
	patchesDir: string,
	entry: ShippedPackage,
	licences: PackageLicences,
	problems: readonly PackageLicenseProblem[],
	clean: boolean
): PackagePlan {
	const parentPath = `${SHIPPED_PACKAGES_PARENT}/${entry.name}`;
	const parent = join(patchesDir, ...parentPath.split('/'));
	const versionDir = `v${entry.version}`;
	const targetPath = `${parentPath}/${versionDir}`;
	const target = join(parent, versionDir);
	const comparison = clean ? compareTrees(entry.directory, target) : ({ state: 'absent' } as const);
	const otherVersions = listVersionDirs(parent).filter((name) => name !== versionDir);
	const replace = comparison.state === 'drift' ? [...comparison.modified, ...comparison.missing].sort() : [];
	const remove = [
		...(comparison.state === 'drift' ? comparison.extra : []),
		...otherVersions.map((name) => `${parentPath}/${name}/`)
	].sort();
	return {
		package: entry,
		target,
		targetPath,
		comparison,
		replace,
		remove,
		otherVersions,
		scratch: listScratchDirs(parent),
		licences,
		problems,
		fileCount: countFiles(entry.directory)
	};
}

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort();
}

/** The union of what the packages carry; the notices file of the first package that has one. */
function mergeLicences(all: readonly PackageLicences[]): PackageLicences {
	return {
		own: unique(all.flatMap((entry) => entry.own)),
		thirdParty: unique(all.flatMap((entry) => entry.thirdParty)),
		notices: all.map((entry) => entry.notices).find((value) => value !== null) ?? null
	};
}

function listVersionDirs(parent: string): readonly string[] {
	if (statIfPresent(parent) === null) return [];
	// Only version directories count; a scratch directory is reported separately.
	return readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^v[0-9]/u.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

export type RunOptions = PlanOptions & { readonly dryRun: boolean; readonly upgrade: boolean };

/** What a run did to one package. */
export type PackageOutcome = {
	readonly name: string;
	readonly version: string;
	readonly state: 'created' | 'upgraded' | 'unchanged';
	readonly filesCreated: number;
	readonly filesUnchanged: number;
	readonly removedVersions: readonly string[];
	readonly removedScratch: readonly string[];
};

export type LoadOutcome = {
	readonly plan: LoadPlan;
	readonly packages: readonly PackageOutcome[];
	readonly filesCreated: number;
	readonly filesUnchanged: number;
	readonly noticesWritten: readonly { readonly path: string; readonly action: 'created' | 'updated' }[];
	readonly legacyNoticeRemoved: boolean;
	readonly removedScratch: readonly string[];
};

/**
 * ##STD-LOAD-STEP-DRIFT-REFUSAL: refuse before the first write. With `--upgrade`
 * a drifted package copy is not a refusal but a replacement
 * (##STD-LOAD-UPGRADE); a drifted notice copy is always a refusal, because the
 * notice is written by two commands and neither owns the other's components.
 */
export function refuseOnDrift(plan: LoadPlan, upgrade: boolean): void {
	const drifted: string[] = [];
	let where: string | null = null;
	if (!upgrade) {
		for (const entry of plan.packages) {
			if (entry.comparison.state !== 'drift') continue;
			where ??= entry.targetPath;
			for (const relative of entry.comparison.modified) drifted.push(`${entry.package.name}: modified ${relative}`);
			for (const relative of entry.comparison.extra) drifted.push(`${entry.package.name}: extra ${relative}`);
			for (const relative of entry.comparison.missing) drifted.push(`${entry.package.name}: missing ${relative}`);
		}
	}
	for (const notice of plan.notices) {
		if (notice.state !== 'drift') continue;
		where ??= notice.path;
		drifted.push(`modified ${notice.path}`);
	}
	if (drifted.length === 0) return;
	throw ckError(
		'STANDARDS-DRIFT',
		`the installed copy differs from what codkit ships:\n  ${drifted.join('\n  ')}`,
		DRIFT_HINT,
		where ?? STANDARDS_PACKAGE_PARENT
	);
}

/**
 * ##STD-LOAD-UPGRADE: the hint names the flag first, because the edition is
 * mutable and the usual reason for drift is now a newer tool, not an edit.
 */
export const DRIFT_HINT =
	'the installed packages and the LICENSE-CODKIT.md copies are codkit-owned: run codkit standards load --upgrade to take the shipped copy, or move your edits out into your own specs and run codkit standards load again';

/** Execute the plan. `dryRun` writes nothing, not even the scratch cleanup. */
export function runStandardsLoad(options: RunOptions): LoadOutcome {
	const plan = planStandardsLoad(options);
	if (plan.problems.length > 0 || plan.blockProblems.length > 0) {
		return { plan, packages: [], filesCreated: 0, filesUnchanged: 0, noticesWritten: [], legacyNoticeRemoved: false, removedScratch: [] };
	}
	refuseOnDrift(plan, options.upgrade);

	const packages = plan.packages.map((entry) => deliver(options, entry));

	const noticeOutcome = writeNoticeCopies(options.toolRoot, options.patchesDir, options.dryRun);

	if (!options.dryRun && plan.manifest.action !== 'unchanged') {
		const manifestPath = join(options.patchesDir, MANIFEST_PATH);
		const applied = applyBlock(
			readFileSync(manifestPath, 'utf8'),
			canonicalManifestBlock(plan.packages.map((entry) => entry.package)),
			manifestMarkers(plan.packages.map((entry) => entry.package.name))
		);
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

	return {
		plan,
		packages,
		filesCreated: packages.reduce((total, entry) => total + entry.filesCreated, 0),
		filesUnchanged: packages.reduce((total, entry) => total + entry.filesUnchanged, 0),
		noticesWritten: noticeOutcome.written,
		legacyNoticeRemoved: noticeOutcome.legacyRemoved,
		removedScratch: unique(packages.flatMap((entry) => entry.removedScratch))
	};
}

/**
 * ##STD-LOAD-STEP-WRITE-FILES: one package into the patch set, through a
 * scratch directory and a rename. `--upgrade` replaces a drifted directory as a
 * whole and drops the version directories the shipped edition supersedes; a
 * run without the flag never reaches here with drift.
 */
function deliver(options: RunOptions, entry: PackagePlan): PackageOutcome {
	const parentSegments = `${SHIPPED_PACKAGES_PARENT}/${entry.package.name}`.split('/');
	const parent = join(options.patchesDir, ...parentSegments);
	const removedScratch: string[] = [];
	if (!options.dryRun) {
		for (const name of entry.scratch) {
			rmSync(join(parent, name), { recursive: true, force: true });
			removedScratch.push(name);
		}
	}

	const state = entry.comparison.state === 'identical' ? 'unchanged' : entry.comparison.state === 'drift' ? 'upgraded' : 'created';
	if (!options.dryRun && state !== 'unchanged') {
		writeTreeViaScratch(entry.package.directory, options.patchesDir, parentSegments, `v${entry.package.version}`, {
			what: entry.targetPath,
			replace: state === 'upgraded'
		});
	}

	// Superseded versions are kept by an ordinary run and listed as
	// `otherVersions`; `--upgrade` is the word that lets codkit drop them.
	const removedVersions = options.upgrade ? entry.otherVersions : [];
	if (!options.dryRun) {
		for (const name of removedVersions) rmSync(join(parent, name), { recursive: true, force: true });
	}

	return {
		name: entry.package.name,
		version: entry.package.version,
		state,
		filesCreated: state === 'unchanged' ? 0 : entry.fileCount,
		filesUnchanged: state === 'unchanged' ? entry.fileCount : 0,
		removedVersions,
		removedScratch
	};
}

function countFiles(dir: string): number {
	let total = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
	}
	return total;
}

/**
 * ##STD-LOAD-ALL-PACKAGES: `vibe install` first, and `vibe skill install` after
 * it when a delivered package declares skills - the projection needs the
 * materialised package. `--upgrade` rewrote bytes under a version number that
 * is already in `vibe.lock`, so the install has to be told to redo its work.
 */
export function nextSteps(plan: LoadPlan, upgrade: boolean): readonly string[] {
	const steps = [upgrade ? 'vibe install --offline --force' : 'vibe install --offline'];
	if (plan.packages.some((entry) => entry.package.declaresSkills)) steps.push('vibe skill install');
	return steps;
}

/** The shipped notice rendered with the given components (none: the template with an empty block). */
export function noticeText(toolRoot: string, components: readonly NoticeComponent[] = []): string {
	return renderNotice(noticeTemplate(toolRoot), components);
}

/** Where the notice goes, for the plan and the report. */
export function noticeTargets(patchesDir: string): readonly string[] {
	return NOTICE_TARGET_PATHS.map((relative) => join(patchesDir, ...relative.split('/')));
}

/** The parent of the own-code notice copy, created on demand by the writer. */
export function noticeParent(patchesDir: string): string {
	return dirname(join(patchesDir, ...NOTICE_OWN_PATH.split('/')));
}

export { STANDARDS_PACKAGE_GROUP, STANDARDS_PACKAGE_NAME };
