/** @scope spec://codkit/modules/codkit/PROP-009#state */
import { pinKey } from './pinIdentity.ts';
import { assertSourceToTargetAncestry } from './cycleControlGit.ts';
// Complete deterministic classification for cycle phase apply. Preview is
// read-only. The separate apply entry point requires both live orchestrator
// locks and recovers a durable rename transaction before parsing inventory.

import { lstatSync } from 'node:fs';
import { classifyArtifacts } from './classifyEngine.ts';
import type { ArtifactClassification, ClassificationArtifact, ClassificationOutcome, MergeFileRunner } from './classifyEngine.ts';
import type { Cause } from './cause.ts';
import { findCause } from './cause.ts';
import {
	classifyCycleResources,
	loadCycleClassificationInventory,
	resourceUpstreamChanges,
	type CycleLayerReadRuntime,
	type LoadedCycleInventory,
	type ResourceCycleClassification,
	type ResourceUpstreamChange,
	type ValidatedCycleRecord
} from './cycleClassifyLayers.ts';
import {
	clearCycleClassifyRecovery,
	makeCycleClassifyRecovery,
	readCycleClassifyRecovery,
	writeCycleClassifyRecovery,
	type CycleClassifyRecovery
} from './cycleClassifyRecovery.ts';
import type { CodkitConfig } from './configFile.ts';
import { treeId } from './fingerprint.ts';
import { runGit } from './gitx.ts';
import { assertOwnedLockHandle, lockPath, readLock } from './lock.ts';
import type { LockHandle, LockInfo } from './lock.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';
import {
	applyPatchRenameBatch,
	buildPatchRenameBatch,
	RENAME_TRANSACTION_PATH,
	resumePatchRenameTransaction,
	type ExplicitRenameReference,
	type PatchRenameBatchPlan,
	type RenameApplyRuntime
} from './renameApply.ts';
import { detectRenames } from './renames.ts';
import type { UpstreamRename } from './renames.ts';
import type { CycleArtifacts, CycleRename, CycleState } from './cycleState.ts';
import { CYCLE_ARTIFACT_OUTCOMES } from './cycleState.ts';
import type { ParsedPatch } from './patchFormat.ts';
import { encodePatchName } from './patchFormat.ts';
import { planPatchArtifactRename } from './renames.ts';
import type { RenameReferenceReplacement } from './renames.ts';
import type { ProjectType } from '@codkit/type-api';

const CYCLE_LOCK_ID = 'cycle-global';

export type CycleApplyClassification = ArtifactClassification | ResourceCycleClassification;

export type CycleClassificationCause = {
	readonly artifactPath: string;
	readonly artifactId: string;
	readonly targetPath: string;
	readonly outcome: ClassificationOutcome;
	readonly cause: Cause;
};

export type CycleClassifyResult = {
	readonly renames: readonly CycleRename[];
	readonly classifications: readonly CycleApplyClassification[];
	readonly buckets: CycleArtifacts;
	readonly causes: readonly CycleClassificationCause[];
	readonly renameBatch: PatchRenameBatchPlan;
	readonly reviewRequired: boolean;
	/** Pin-bearing records with no upstream target to classify. */
	readonly validated: readonly ValidatedCycleRecord[];
	/** The clean resource entries whose target the upstream changed between the pins. */
	readonly upstreamResourceChanges: readonly ResourceUpstreamChange[];
};

export type CycleClassifyPreviewOptions = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly config: CodkitConfig;
	/** The project type of the patch set; the overlay half of a classification asks it. */
	readonly type: ProjectType;
	readonly state: CycleState;
	readonly similarity?: number;
	readonly contractTestPaths?: readonly string[];
	readonly ownPaths?: readonly string[];
	readonly explicitReferenceReplacements?: readonly ExplicitRenameReference[];
	readonly layerRuntime?: CycleLayerReadRuntime;
};

export type CycleClassifyLocks = { readonly cycle: LockHandle; readonly tree: LockHandle };

export type CycleClassifyApplyRuntime = {
	readonly rename?: RenameApplyRuntime;
	/** Test seam immediately before the final live-lock recheck. */
	readonly beforeRenameMutation?: () => void;
	readonly afterRecoveryWrite?: () => void;
};

export type CycleClassifyApplyOptions = CycleClassifyPreviewOptions & {
	readonly locks: CycleClassifyLocks;
	readonly reviewedRenames?: boolean;
	readonly runtime?: CycleClassifyApplyRuntime;
};

export type UpgradeInventoryClassifyOptions = Pick<
	CycleClassifyPreviewOptions,
	'patchesDir' | 'treeDir' | 'type' | 'similarity' | 'layerRuntime'
> & {
	readonly expectedPin: string;
	readonly oldPin: string;
	readonly newRef: string;
	readonly mergeFile?: MergeFileRunner;
};

export type UpgradeInventoryClassifyResult = Pick<CycleClassifyResult, 'classifications' | 'buckets' | 'causes'> & {
	readonly inventory: LoadedCycleInventory;
	readonly renames: readonly CycleRename[];
};

/** Read-only proposal. A pending durable rename must be resumed by apply first. */
export function previewCycleApply(options: CycleClassifyPreviewOptions): CycleClassifyResult {
	assertCycleInput(options);
	if (renameTransactionExists(options.patchesDir) || readCycleClassifyRecovery(options.patchesDir) !== null) {
		throw broken(`pending durable rename requires locked apply recovery before inventory can be read`);
	}
	return classifyPrepared(options, false);
}

/** Backward-compatible read-only name; it can no longer authorize writes. */
export const classifyCycleApply = previewCycleApply;

/** Mutating rename path, callable only with both currently live cycle locks. */
export function applyCycleClassification(options: CycleClassifyApplyOptions): CycleClassifyResult {
	assertCycleInput(options);
	assertLiveLocks(options);
	recoverRenameBeforeInventory(options);
	return classifyPrepared(options, true);
}

export function classifyUpgradeInventory(options: UpgradeInventoryClassifyOptions): UpgradeInventoryClassifyResult {
	const { treeDir, oldPin, newRef, mergeFile } = options;
	const inventory = loadCycleClassificationInventory(options.patchesDir, options.type, options.expectedPin, options.layerRuntime);
	const detected = detectRenames({
		cwd: treeDir,
		oldPin,
		newPin: newRef,
		...(options.similarity === undefined ? {} : { threshold: options.similarity })
	});
	const patchRenames = relevantPatchRenames(inventory, detected);
	const classified = classifyLoadedUpgrade(options.type, treeDir, oldPin, newRef, inventory, detected, patchRenames, mergeFile);
	return {
		inventory,
		renames: relevantCycleRenames(inventory, detected).map(({ from, to, similarity }) => ({ from, to, similarity })),
		...classified
	};
}

function classifyPrepared(options: CycleClassifyPreviewOptions | CycleClassifyApplyOptions, apply: boolean): CycleClassifyResult {
	const expectedPin = `${pinKey(options.state.sourcePin)}@${options.state.sourcePin.sha}`;
	const before = loadCycleClassificationInventory(options.patchesDir, options.type, expectedPin, options.layerRuntime);
	const detected = detectRenames({
		cwd: options.treeDir,
		oldPin: options.state.sourcePin.sha,
		newPin: options.state.targetPin.sha,
		...(options.similarity === undefined ? {} : { threshold: options.similarity })
	});
	const patchRenames = relevantPatchRenames(before, detected);
	const relevantRenames = relevantCycleRenames(before, detected);
	assertRecordedRenames(options.state.renames, relevantRenames);
	const pending = patchRenames.filter((rename) => before.patches.some((artifact) => artifact.patch.targetPath === rename.from));
	const renameBatch = buildRenameBatch(options, before, pending);
	if (apply && renameBatch.plans.length > 0) {
		const writeOptions = options as CycleClassifyApplyOptions;
		if (renameBatch.needsReview && writeOptions.reviewedRenames !== true) {
			throw broken('rename batch needs explicit review before durable mutation');
		}
		writeOptions.runtime?.beforeRenameMutation?.();
		assertLiveLocks(writeOptions);
		const recovery = makeCycleClassifyRecovery({
			sourcePin: writeOptions.state.sourcePin,
			targetPin: writeOptions.state.targetPin,
			branch: writeOptions.state.branch,
			similarity: writeOptions.similarity ?? 50,
			detectedRenames: canonicalRenames(detected),
			batch: renameBatch
		});
		writeCycleClassifyRecovery(writeOptions.patchesDir, recovery);
		writeOptions.runtime?.afterRecoveryWrite?.();
		const applied = applyPatchRenameBatch(
			{
				patchesDir: writeOptions.patchesDir,
				batch: renameBatch,
				...(writeOptions.reviewedRenames === undefined ? {} : { reviewed: writeOptions.reviewedRenames })
			},
			writeOptions.runtime?.rename
		);
		if (!applied.completed) throw broken('rename apply returned without exact completion');
		clearCycleClassifyRecovery(writeOptions.patchesDir, recovery);
	}
	const loaded = apply ? loadCycleClassificationInventory(options.patchesDir, options.type, expectedPin, options.layerRuntime) : before;
	return completeResult(options, loaded, detected, relevantRenames, patchRenames, renameBatch);
}

function completeResult(
	options: CycleClassifyPreviewOptions,
	loaded: LoadedCycleInventory,
	detected: readonly UpstreamRename[],
	relevantRenames: readonly UpstreamRename[],
	patchRenames: readonly UpstreamRename[],
	renameBatch: PatchRenameBatchPlan
): CycleClassifyResult {
	const { sourcePin, targetPin } = options.state;
	const classified = classifyLoadedUpgrade(options.type, options.treeDir, sourcePin.sha, targetPin.sha, loaded, detected, patchRenames);
	return {
		renames: relevantRenames.map(({ from, to, similarity }) => ({ from, to, similarity })),
		...classified,
		renameBatch,
		reviewRequired:
			renameBatch.needsReview || classified.classifications.some((item) => item.kind === 'resource' && item.outcome !== 'clean'),
		validated: loaded.validated,
		upstreamResourceChanges: resourceUpstreamChanges(
			options.treeDir,
			sourcePin.sha,
			targetPin.sha,
			classified.classifications.filter((item): item is ResourceCycleClassification => item.kind === 'resource')
		)
	};
}

function classifyLoadedUpgrade(
	type: ProjectType,
	treeDir: string,
	oldPin: string,
	newRef: string,
	loaded: LoadedCycleInventory,
	detected: readonly UpstreamRename[],
	patchRenames: readonly UpstreamRename[],
	mergeFile?: MergeFileRunner
): Pick<UpgradeInventoryClassifyResult, 'classifications' | 'buckets' | 'causes'> {
	const mapped = mapPatchTargets(loaded.artifacts, patchRenames);
	const artifactClassifications = classifyArtifacts({
		type,
		treeDir,
		artifacts: mapped,
		oldPin,
		newRef,
		...(mergeFile === undefined ? {} : { mergeFile })
	});
	const renameByOld = new Map(detected.map((rename) => [rename.from, rename]));
	const resources = classifyCycleResources(treeDir, oldPin, newRef, loaded.resources, renameByOld);
	const classifications = canonicalClassifications([...artifactClassifications, ...resources]);
	assertComplete(loaded, classifications);
	const targets = renameTargets(patchRenames);
	const buckets = buildBuckets(classifications, targets);
	const ranges = new Map(loaded.patches.map((artifact) => [artifact.artifactPath, patchRanges(artifact.patch)] as const));
	const causes = findClassificationCauses(treeDir, oldPin, newRef, classifications, buckets, targets, renameByOld, ranges);
	return { classifications, buckets, causes };
}

function buildRenameBatch(
	options: CycleClassifyPreviewOptions,
	loaded: LoadedCycleInventory,
	pending: readonly UpstreamRename[]
): PatchRenameBatchPlan {
	return buildPatchRenameBatch({
		patchesDir: options.patchesDir,
		renames: pending,
		artifacts: loaded.patches,
		...(options.contractTestPaths === undefined ? {} : { contractTestPaths: options.contractTestPaths }),
		...(options.ownPaths === undefined ? {} : { ownPaths: options.ownPaths }),
		...(options.explicitReferenceReplacements === undefined ? {} : { explicitReferenceReplacements: options.explicitReferenceReplacements })
	});
}

function relevantPatchRenames(inventory: LoadedCycleInventory, detected: readonly UpstreamRename[]): readonly UpstreamRename[] {
	const targets = new Set(inventory.patches.map((artifact) => artifact.patch.targetPath));
	const relevant = detected.filter((rename) => targets.has(rename.from) || targets.has(rename.to));
	const sources = new Set<string>();
	const destinations = new Set<string>();
	for (const rename of relevant) {
		if (sources.has(rename.from)) throw broken(`duplicate relevant rename source ${rename.from}`);
		if (destinations.has(rename.to)) throw broken(`duplicate relevant rename destination ${rename.to}`);
		sources.add(rename.from);
		destinations.add(rename.to);
	}
	return [...relevant].sort((left, right) => compareText(left.from, right.from));
}

function relevantCycleRenames(inventory: LoadedCycleInventory, detected: readonly UpstreamRename[]): readonly UpstreamRename[] {
	const targets = new Set([
		...inventory.patches.flatMap((artifact) => [artifact.patch.targetPath]),
		...inventory.resources.map((entry) => entry.target)
	]);
	return canonicalRenames(detected.filter((rename) => targets.has(rename.from) || targets.has(rename.to)));
}

function canonicalRenames(renames: readonly UpstreamRename[]): readonly UpstreamRename[] {
	return [...renames].sort((left, right) => compareText(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`));
}

function assertRecordedRenames(recorded: readonly CycleRename[], relevant: readonly UpstreamRename[]): void {
	const expected = new Map(relevant.map((rename) => [rename.from, rename]));
	for (const rename of recorded) {
		const actual = expected.get(rename.from);
		if (actual === undefined || actual.to !== rename.to || actual.similarity !== rename.similarity) {
			throw broken(`state rename ${rename.from} -> ${rename.to} is stale or not present in the current pin diff`);
		}
	}
}

function mapPatchTargets(
	artifacts: readonly ClassificationArtifact[],
	renames: readonly UpstreamRename[]
): readonly ClassificationArtifact[] {
	const byOld = new Map(renames.map((rename) => [rename.from, rename]));
	const byNew = new Map(renames.map((rename) => [rename.to, rename]));
	return artifacts.map((artifact) => {
		if (artifact.kind !== 'patch') return artifact;
		const rename = byOld.get(artifact.patch.targetPath) ?? byNew.get(artifact.patch.targetPath);
		return rename === undefined ? artifact : { ...artifact, baseTargetPath: rename.from, newTargetPath: rename.to };
	});
}

function canonicalClassifications(items: readonly CycleApplyClassification[]): readonly CycleApplyClassification[] {
	return [...items].sort((left, right) => compareText(left.artifactPath, right.artifactPath));
}

function assertComplete(inventory: LoadedCycleInventory, classifications: readonly CycleApplyClassification[]): void {
	const expected = [...inventory.artifacts.map(classificationArtifactPath), ...inventory.resources.map((entry) => entry.source)].sort(
		compareText
	);
	const actual = classifications.map((item) => item.artifactPath).sort(compareText);
	if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
		throw broken(`classification is incomplete (expected ${expected.length} artifacts, got ${actual.length})`);
	}
}

function renameTargets(renames: readonly UpstreamRename[]): ReadonlyMap<string, UpstreamRename> {
	const targets = new Map<string, UpstreamRename>();
	for (const rename of renames) {
		targets.set(rename.from, rename);
		targets.set(rename.to, rename);
	}
	return targets;
}

function buildBuckets(
	classifications: readonly CycleApplyClassification[],
	patchRenameByTarget: ReadonlyMap<string, UpstreamRename>
): CycleArtifacts {
	const buckets = Object.fromEntries(CYCLE_ARTIFACT_OUTCOMES.map((outcome) => [outcome, []])) as unknown as Record<
		ClassificationOutcome,
		string[]
	>;
	for (const item of classifications) {
		const renamed = item.kind === 'patch' && patchRenameByTarget.has(item.targetPath);
		const outcome: ClassificationOutcome = renamed && item.outcome === 'clean' ? 'target-renamed' : item.outcome;
		buckets[outcome].push(item.artifactPath);
	}
	for (const outcome of CYCLE_ARTIFACT_OUTCOMES) buckets[outcome].sort(compareText);
	return buckets;
}

function findClassificationCauses(
	treeDir: string,
	oldPin: string,
	newRef: string,
	classifications: readonly CycleApplyClassification[],
	buckets: CycleArtifacts,
	patchRenameByTarget: ReadonlyMap<string, UpstreamRename>,
	resourceRenameByOld: ReadonlyMap<string, UpstreamRename>,
	rangesByArtifact: ReadonlyMap<string, readonly { readonly start: number; readonly end: number }[]>
): readonly CycleClassificationCause[] {
	const outcomeByPath = new Map<string, ClassificationOutcome>(
		CYCLE_ARTIFACT_OUTCOMES.flatMap((outcome) => buckets[outcome].map((path) => [path, outcome] as const))
	);
	return classifications.flatMap((item): readonly CycleClassificationCause[] => {
		const outcome = outcomeByPath.get(item.artifactPath);
		if (outcome === undefined) throw broken(`${item.artifactPath}: classification has no state bucket`);
		if (outcome === 'clean') return [];
		const patchRename = item.kind === 'patch' ? patchRenameByTarget.get(item.targetPath) : undefined;
		const resourceRename =
			item.kind === 'resource' ? [...resourceRenameByOld.values()].find((entry) => entry.to === item.targetPath) : undefined;
		const rename = patchRename ?? resourceRename;
		const target = rename?.from ?? item.targetPath;
		const lifecycle =
			rename === undefined
				? item.outcome === 'target-deleted'
					? ({ outcome: 'target-deleted' } as const)
					: undefined
				: ({ outcome: 'target-renamed', newTarget: rename.to } as const);
		const cause = findCause({
			cwd: treeDir,
			oldPin,
			newPin: newRef,
			target,
			ranges: item.kind === 'patch' ? (rangesByArtifact.get(item.artifactPath) ?? []) : [],
			...(lifecycle === undefined ? {} : { lifecycle })
		});
		return [{ artifactPath: item.artifactPath, artifactId: item.artifactId, targetPath: item.targetPath, outcome, cause }];
	});
}

function patchRanges(patch: ParsedPatch): readonly { start: number; end: number }[] {
	return patch.hunks
		.filter((hunk) => hunk.countOld > 0)
		.map((hunk) => ({ start: Math.max(1, hunk.startOld), end: Math.max(1, hunk.startOld) + hunk.countOld - 1 }));
}

function assertCycleInput(options: CycleClassifyPreviewOptions): void {
	if (options.state.phase !== 'apply') throw broken(`cycle phase must be apply, got ${options.state.phase}`);
	if (options.state.transaction !== null) throw broken('cycle phase apply requires transaction null');
	if (!samePin(options.config.pin, options.state.targetPin)) throw broken('codkit.json pin does not exactly match cycle targetPin');
	const expectedBranch = `${options.config.cycleBranchPrefix}${pinKey(options.state.targetPin)}`;
	if (options.state.branch !== expectedBranch) throw broken(`cycle branch must be exactly ${expectedBranch}`);
	const branch = runGit({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: options.patchesDir });
	if (branch.status !== 0 || branch.stdout.trim() !== expectedBranch)
		throw broken(`patchset checkout must be on cycle branch ${expectedBranch}`);
	assertPin(options.treeDir, options.state.sourcePin, 'sourcePin');
	assertPin(options.treeDir, options.state.targetPin, 'targetPin');
	if (options.state.branchTransitionAnchor !== undefined) {
		if (options.state.codkitCycleState !== 4 || options.state.branchTransitionAnchor !== options.config.upstreamAnchorCommit)
			throw broken('cycle branch transition authorization does not match schema/configuration');
		assertSourceToTargetAncestry(
			options.treeDir,
			options.state.sourcePin,
			options.state.targetPin,
			runGit,
			options.state.branchTransitionAnchor
		);
		return;
	}
	if (
		runGit({ args: ['merge-base', '--is-ancestor', options.state.sourcePin.sha, options.state.targetPin.sha], cwd: options.treeDir })
			.status !== 0
	) {
		throw broken('cycle sourcePin is not an ancestor of targetPin');
	}
}

function assertPin(treeDir: string, pin: CycleState['sourcePin'], label: string): void {
	const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', `${pin.sha}^{commit}`], cwd: treeDir });
	if (resolved.status !== 0 || resolved.stdout.trim() !== pin.sha) throw broken(`${label} sha is not one exact reachable commit`);
	const date = runGit({ args: ['show', '-s', '--format=%cs', pin.sha], cwd: treeDir });
	if (date.status !== 0 || date.stdout.trim() !== pin.date) throw broken(`${label} date does not match commit ${pin.sha}`);
}

function assertLiveLocks(options: CycleClassifyApplyOptions): void {
	assertLiveLock(options.locks.cycle, lockPath(options.patchesDir, CYCLE_LOCK_ID), 'cycle');
	assertLiveLock(options.locks.tree, lockPath(options.patchesDir, treeId(options.treeDir)), 'tree');
}

function assertLiveLock(handle: LockHandle, expectedPath: string, label: string): void {
	assertOwnedLockHandle(handle, `cycle classification ${label} lock`);
	if (handle.path !== expectedPath || handle.info.nonce === undefined) throw broken(`${label} lock capability is not for this cycle`);
	const current = readLock(expectedPath);
	if (current === null || !sameLock(current, handle.info)) throw broken(`${label} lock capability is no longer live`);
}

function recoverRenameBeforeInventory(options: CycleClassifyApplyOptions): void {
	const transaction = renameTransactionExists(options.patchesDir);
	const recovery = readCycleClassifyRecovery(options.patchesDir);
	if (transaction && recovery === null) throw broken(`${RENAME_TRANSACTION_PATH} exists without ${'.codkit/cycle-classify.json'}`);
	if (recovery === null) return;
	assertRecoveryEvidence(options, recovery);
	options.runtime?.beforeRenameMutation?.();
	assertLiveLocks(options);
	let result;
	if (transaction) {
		assertRecoveryPlanEvidence(options, recovery);
		result = resumePatchRenameTransaction(options.patchesDir, recovery.batch, options.runtime?.rename);
	} else {
		const expected = rebuildRecoveryBatch(options, recovery);
		if (JSON.stringify(expected) !== JSON.stringify(recovery.batch)) {
			throw broken('durable recovery batch does not match the pristine inventory and current review inputs');
		}
		if (expected.needsReview && options.reviewedRenames !== true) {
			throw broken('recovered rename batch needs explicit review before durable mutation');
		}
		result = applyPatchRenameBatch(
			{
				patchesDir: options.patchesDir,
				batch: expected,
				...(options.reviewedRenames === undefined ? {} : { reviewed: options.reviewedRenames })
			},
			options.runtime?.rename
		);
	}
	if (!result.completed) throw broken('durable rename recovery returned without exact completion');
	clearCycleClassifyRecovery(options.patchesDir, recovery);
}

function rebuildRecoveryBatch(options: CycleClassifyApplyOptions, recovery: CycleClassifyRecovery): PatchRenameBatchPlan {
	const expectedPin = `${pinKey(options.state.sourcePin)}@${options.state.sourcePin.sha}`;
	const pristine = loadCycleClassificationInventory(options.patchesDir, options.type, expectedPin, options.layerRuntime);
	const patchRenames = relevantPatchRenames(pristine, recovery.detectedRenames);
	const pending = patchRenames.filter((rename) => pristine.patches.some((artifact) => artifact.patch.targetPath === rename.from));
	return buildRenameBatch(options, pristine, pending);
}

function assertRecoveryPlanEvidence(options: CycleClassifyApplyOptions, recovery: CycleClassifyRecovery): void {
	const detected = new Map(recovery.detectedRenames.map((rename) => [rename.from, rename]));
	const explicit = options.explicitReferenceReplacements ?? [];
	for (const plan of recovery.batch.plans) {
		const rename = detected.get(plan.fromTarget);
		if (
			rename === undefined ||
			rename.to !== plan.toTarget ||
			rename.similarity !== plan.similarity ||
			plan.oldArtifactPath !== `delta/patches/${encodePatchName(rename.from)}` ||
			plan.newArtifactPath !== `delta/patches/${encodePatchName(rename.to)}`
		) {
			throw broken('durable recovery plan is not derived from current rename-detection evidence');
		}
		const references = plan.operations.flatMap((operation): readonly RenameReferenceReplacement[] => {
			if (operation.kind !== 'replace' || operation.area === 'patch-header') return [];
			const replacement = { area: operation.area, file: operation.file, from: operation.from, to: operation.to };
			const automatic = operation.from === rename.from && operation.to === rename.to;
			const authorized = explicit.some(
				(entry) =>
					entry.renameFrom === rename.from &&
					entry.area === replacement.area &&
					entry.file === replacement.file &&
					entry.from === replacement.from &&
					entry.to === replacement.to
			);
			if (!automatic && !authorized) throw broken('durable recovery contains an unapproved reference replacement');
			return [replacement];
		});
		const canonical = planPatchArtifactRename({ rename, referenceReplacements: references });
		if (JSON.stringify(canonical) !== JSON.stringify(plan)) {
			throw broken('durable recovery plan operations are not canonical for the detected rename');
		}
	}
}

function assertRecoveryEvidence(options: CycleClassifyApplyOptions, recovery: CycleClassifyRecovery): void {
	if (
		JSON.stringify(recovery.sourcePin) !== JSON.stringify(options.state.sourcePin) ||
		JSON.stringify(recovery.targetPin) !== JSON.stringify(options.state.targetPin) ||
		recovery.branch !== options.state.branch
	) {
		throw broken('durable rename recovery does not match current cycle state');
	}
	const detected = canonicalRenames(
		detectRenames({
			cwd: options.treeDir,
			oldPin: recovery.sourcePin.sha,
			newPin: recovery.targetPin.sha,
			threshold: recovery.similarity
		})
	);
	if (JSON.stringify(detected) !== JSON.stringify(recovery.detectedRenames)) {
		throw broken('durable rename recovery does not match current rename-detection evidence');
	}
}

function sameLock(left: LockInfo, right: LockInfo): boolean {
	return (
		left.pid === right.pid &&
		left.startedAt === right.startedAt &&
		left.command === right.command &&
		left.nonce !== undefined &&
		left.nonce === right.nonce
	);
}

function renameTransactionExists(patchesDir: string): boolean {
	const resolved = resolveContainedPath(patchesDir, RENAME_TRANSACTION_PATH, { allowMissing: true });
	if (!resolved.ok) throw broken(`${RENAME_TRANSACTION_PATH}: unsafe transaction path: ${resolved.reason}`);
	const path = resolved.absolute;
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) throw broken(`${RENAME_TRANSACTION_PATH} is not a real file`);
		return true;
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return false;
		if (error instanceof Error && error.message.includes('cannot classify cycle apply:')) throw error;
		throw broken(`cannot inspect ${RENAME_TRANSACTION_PATH}: ${messageOf(error)}`);
	}
}

function classificationArtifactPath(artifact: ClassificationArtifact): string {
	return artifact.kind === 'patch'
		? artifact.artifactPath
		: artifact.kind === 'rule'
			? artifact.rule.artifactPath
			: artifact.overlay.artifactPath;
}

function samePin(left: CodkitConfig['pin'], right: CycleState['targetPin']): boolean {
	return left.tag === right.tag && left.sha === right.sha && left.date === right.date;
}

function compareText(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

function broken(reason: string): Error {
	return ckError(
		'ARTIFACT-BROKEN',
		`cannot classify cycle apply: ${reason}`,
		'repair the complete cycle inventory or restart the cycle before retrying'
	);
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
