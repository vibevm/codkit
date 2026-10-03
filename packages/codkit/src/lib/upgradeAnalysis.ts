/** @scope spec://codkit/modules/codkit/PROP-008#classify */
import { pinKey } from './pinIdentity.ts';
// Generic, read-only upgrade analysis. The caller supplies one immutable target
// commit; no cycle state, branch, journal, recovery record, or work-tree target
// participates in the result.

import { CLASSIFICATION_OUTCOMES } from './classifyEngine.ts';
import type { ClassificationOutcome, MergeFileRunner } from './classifyEngine.ts';
import type { Cause } from './cause.ts';
import { classifyUpgradeInventory } from './cycleClassify.ts';
import type { CycleApplyClassification } from './cycleClassify.ts';
import type { CycleLayerReadRuntime, ValidatedCycleRecord } from './cycleClassifyLayers.ts';
import type { CodkitConfig, PinConfig } from './configFile.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import type { CycleRename } from './cycleState.ts';
import type { ProjectType } from '@codkit/type-api';

export type UpgradeAnalysisOptions = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly config: CodkitConfig;
	/** The project type of the patch set; the engines below are handed it. */
	readonly type: ProjectType;
	/** Exact 40-hex commit, never a movable branch or tag. */
	readonly newRef: string;
	readonly similarity?: number;
	readonly layerRuntime?: CycleLayerReadRuntime;
	readonly mergeFile?: MergeFileRunner;
};

export type UpgradeArtifactAnalysis = {
	readonly artifactPath: string;
	readonly artifactId: string;
	readonly targetPath: string;
	readonly kind: CycleApplyClassification['kind'];
	readonly layer: CycleApplyClassification['layer'];
	readonly owner: string;
	/** Effective forecast outcome; a clean replay through a rename is target-renamed. */
	readonly outcome: ClassificationOutcome;
	readonly cause: Cause | null;
	/** Full classifier value, including exact patch bytes/materials where applicable. */
	readonly classification: CycleApplyClassification;
};

export type UpgradeAnalysisCounts = {
	readonly total: number;
	readonly nonClean: number;
	readonly byOutcome: Readonly<Record<ClassificationOutcome, number>>;
};

export type UpgradeOwnerAnalysis = {
	readonly owner: string;
	readonly artifacts: readonly string[];
	readonly outcomes: Readonly<Record<ClassificationOutcome, readonly string[]>>;
	readonly counts: UpgradeAnalysisCounts;
};

export type UpgradeAnalysis = {
	readonly sourcePin: PinConfig;
	readonly newRef: string;
	readonly renames: readonly CycleRename[];
	readonly artifacts: readonly UpgradeArtifactAnalysis[];
	readonly outcomes: Readonly<Record<ClassificationOutcome, readonly string[]>>;
	readonly counts: UpgradeAnalysisCounts;
	readonly owners: readonly UpgradeOwnerAnalysis[];
	/** Pin-bearing own/service-override/removed records validated with the frozen inventory. */
	readonly validated: readonly ValidatedCycleRecord[];
};

/** Analyze every classifiable D5 artifact against one exact descendant commit. */
export function analyzeUpgrade(options: UpgradeAnalysisOptions): UpgradeAnalysis {
	assertCommit(options.treeDir, options.config.pin.sha, 'current pin');
	assertPinDate(options.treeDir, options.config.pin);
	assertCommit(options.treeDir, options.newRef, 'newRef');
	assertAncestor(options.treeDir, options.config.pin.sha, options.newRef);

	const expectedPin = `${pinKey(options.config.pin)}@${options.config.pin.sha}`;
	const classified = classifyUpgradeInventory({
		patchesDir: options.patchesDir,
		treeDir: options.treeDir,
		type: options.type,
		expectedPin,
		oldPin: options.config.pin.sha,
		newRef: options.newRef,
		...(options.similarity === undefined ? {} : { similarity: options.similarity }),
		...(options.layerRuntime === undefined ? {} : { layerRuntime: options.layerRuntime }),
		...(options.mergeFile === undefined ? {} : { mergeFile: options.mergeFile })
	});
	if (classified.buckets['contract-failed'].length !== 0) {
		throw internal('read-only classification produced contract-failed without running contracts');
	}

	const ownersByArtifact = inventoryOwners(classified.inventory);
	const outcomeByArtifact = bucketValues(classified.buckets);
	const causeByArtifact = new Map(classified.causes.map((entry) => [entry.artifactPath, entry.cause] as const));
	const artifacts = classified.classifications.map((classification): UpgradeArtifactAnalysis => {
		const owner = ownersByArtifact.get(classification.artifactPath);
		const outcome = outcomeByArtifact.get(classification.artifactPath);
		if (owner === undefined) throw internal(`${classification.artifactPath}: classification has no owner`);
		if (outcome === undefined) throw internal(`${classification.artifactPath}: classification has no outcome bucket`);
		const cause = causeByArtifact.get(classification.artifactPath) ?? null;
		if ((outcome === 'clean') !== (cause === null)) {
			throw internal(`${classification.artifactPath}: cause presence does not match outcome ${outcome}`);
		}
		return {
			artifactPath: classification.artifactPath,
			artifactId: classification.artifactId,
			targetPath: classification.targetPath,
			kind: classification.kind,
			layer: classification.layer,
			owner,
			outcome,
			cause,
			classification
		};
	});
	const outcomes = readonlyBuckets(classified.buckets);
	return {
		sourcePin: { ...options.config.pin },
		newRef: options.newRef,
		renames: classified.renames,
		artifacts,
		outcomes,
		counts: countsOf(outcomes),
		owners: groupByOwner(artifacts),
		validated: classified.inventory.validated
	};
}

function inventoryOwners(inventory: ReturnType<typeof classifyUpgradeInventory>['inventory']): ReadonlyMap<string, string> {
	const owners = new Map<string, string>();
	for (const artifact of inventory.artifacts) {
		const path =
			artifact.kind === 'patch'
				? artifact.artifactPath
				: artifact.kind === 'rule'
					? artifact.rule.artifactPath
					: artifact.overlay.artifactPath;
		const owner =
			artifact.kind === 'patch' ? artifact.patch.header.owner : artifact.kind === 'rule' ? artifact.rule.owner : artifact.overlay.owner;
		owners.set(path, owner);
	}
	for (const resource of inventory.resources) owners.set(resource.source, resource.owner);
	return owners;
}

function bucketValues(buckets: Readonly<Record<ClassificationOutcome, readonly string[]>>): ReadonlyMap<string, ClassificationOutcome> {
	const values = new Map<string, ClassificationOutcome>();
	for (const outcome of CLASSIFICATION_OUTCOMES) {
		for (const artifact of buckets[outcome]) {
			if (values.has(artifact)) throw internal(`${artifact}: appears in more than one outcome bucket`);
			values.set(artifact, outcome);
		}
	}
	return values;
}

function readonlyBuckets(
	buckets: Readonly<Record<ClassificationOutcome, readonly string[]>>
): Readonly<Record<ClassificationOutcome, readonly string[]>> {
	return Object.fromEntries(
		CLASSIFICATION_OUTCOMES.map((outcome) => [outcome, [...buckets[outcome]].sort(compareText)])
	) as unknown as Record<ClassificationOutcome, readonly string[]>;
}

function countsOf(outcomes: Readonly<Record<ClassificationOutcome, readonly string[]>>): UpgradeAnalysisCounts {
	const byOutcome = Object.fromEntries(CLASSIFICATION_OUTCOMES.map((outcome) => [outcome, outcomes[outcome].length])) as Record<
		ClassificationOutcome,
		number
	>;
	const total = CLASSIFICATION_OUTCOMES.reduce((sum, outcome) => sum + byOutcome[outcome], 0);
	return { total, nonClean: total - byOutcome.clean, byOutcome };
}

function groupByOwner(artifacts: readonly UpgradeArtifactAnalysis[]): readonly UpgradeOwnerAnalysis[] {
	const byOwner = new Map<string, UpgradeArtifactAnalysis[]>();
	for (const artifact of artifacts) {
		const group = byOwner.get(artifact.owner) ?? [];
		group.push(artifact);
		byOwner.set(artifact.owner, group);
	}
	return [...byOwner.entries()]
		.sort(([left], [right]) => compareText(left, right))
		.map(([owner, owned]) => {
			const outcomes = emptyBuckets();
			for (const artifact of owned) outcomes[artifact.outcome].push(artifact.artifactPath);
			const readonly = readonlyBuckets(outcomes);
			return { owner, artifacts: owned.map((artifact) => artifact.artifactPath), outcomes: readonly, counts: countsOf(readonly) };
		});
}

function emptyBuckets(): Record<ClassificationOutcome, string[]> {
	return Object.fromEntries(CLASSIFICATION_OUTCOMES.map((outcome) => [outcome, []])) as unknown as Record<ClassificationOutcome, string[]>;
}

function assertCommit(treeDir: string, ref: string, label: string): void {
	if (!/^[0-9a-f]{40}$/.test(ref)) throw unreachable(`${label} must be one exact immutable 40-hex commit sha`);
	const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd: treeDir });
	if (resolved.status !== 0 || resolved.stdout.trim() !== ref) throw unreachable(`${label} ${ref} is not one reachable commit`);
}

function assertPinDate(treeDir: string, pin: PinConfig): void {
	const date = runGit({ args: ['show', '-s', '--format=%cs', pin.sha], cwd: treeDir });
	if (date.status !== 0 || date.stdout.trim() !== pin.date) throw unreachable(`current pin date does not match commit ${pin.sha}`);
}

function assertAncestor(treeDir: string, oldPin: string, newRef: string): void {
	if (runGit({ args: ['merge-base', '--is-ancestor', oldPin, newRef], cwd: treeDir }).status !== 0) {
		throw unreachable(`newRef ${newRef} is not a descendant of current pin ${oldPin}`);
	}
}

function compareText(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

function unreachable(reason: string): Error {
	return ckError('PIN-UNREACHABLE', `cannot analyze upgrade: ${reason}`, 'fetch one exact descendant commit outside codkit, then retry');
}

function internal(reason: string): Error {
	return ckError('INTERNAL', `cannot analyze upgrade: ${reason}`, 'repair the complete frozen inventory and retry');
}
