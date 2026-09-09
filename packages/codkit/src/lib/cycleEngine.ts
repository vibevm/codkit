/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { createHash } from 'node:crypto';
import { applyCycleClassification, previewCycleApply } from './cycleClassify.ts';
import type { CycleApplyClassification, CycleClassifyResult } from './cycleClassify.ts';
import { commitCycleAtom } from './cycleCommit.ts';
import {
	CYCLE_APPLY_RECORD_PATH,
	clearCycleApplyRecord,
	makeCycleApplyRecord,
	readCycleApplyRecord,
	updateCycleApplyRecord,
	writeCycleApplyRecord
} from './cycleEngineRecord.ts';
import type { CycleApplyRecord } from './cycleEngineRecord.ts';
import { clearCycleTerminalRecord } from './cycleEngineTerminal.ts';
import { byteSorted, fileDigest, readText, renameReferencePaths, toJson } from './cycleEngineIo.ts';
import {
	pendingTerminal,
	pendingTransition,
	planStabilizationTransition,
	planTerminalTransaction,
	resumeCycleTerminal,
	resumeCycleTransition
} from './cycleEngineTransactions.ts';
import { readCycleJournal } from './cycleJournal.ts';
import type { CycleJournalEntry } from './cycleJournal.ts';
import { appendCycleJournalEntry } from './cycleJournal.ts';
import { materializeCycleApply } from './cycleMaterialize.ts';
import { planCycleRegeneration, regenerateCycle } from './cycleRegenerate.ts';
import { runCycleResolve } from './cycleResolve.ts';
import type { CycleResolveArtifact } from './cycleResolve.ts';
import { CYCLE_STATE_PATH, cycleStateSchema, readCycleState, writeCycleState } from './cycleState.ts';
import type { CycleState } from './cycleState.ts';
import type { CodkitConfig } from './configFile.ts';
import { treeId } from './fingerprint.ts';
import { runGit } from './gitx.ts';
import { buildInventory } from './inventory.ts';
import type { JsonValue, Output } from './jsonOut.ts';
import { acquireLock } from './lock.ts';
import { ckError } from './messages.ts';
import { ownedRootsOf } from './ownedRoots.ts';
import type { ForkDirResolution } from './paths.ts';
import { RESOURCE_MAP_PATH } from './layers/resource.ts';
import type { ProjectType } from '@codkit/type-api';

const GLOBAL_LOCK_ID = 'cycle-global';
const JOURNAL_ACTOR = 'agent:codkit';
const RESOLVE_OUTCOMES = ['conflict', 'target-deleted', 'rule-broken', 'contract-failed'] as const;
export type ContinueCycleOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	/** The project type of the patch set; the engines below are handed it. */
	readonly type: ProjectType;
	readonly ci: boolean;
	readonly out: Output;
	readonly acknowledgement?: string | null;
	readonly reviewedRenames?: boolean;
	readonly now?: () => Date;
	readonly dependencies?: CycleEngineDependencies;
};
export type ContinueCycleStatus = 'advanced' | 'stopped' | 'completed' | 'failed';
export type ContinueCycleResult = {
	readonly exitCode: 0 | 1 | 3;
	readonly status: ContinueCycleStatus;
	readonly state: CycleState | null;
	readonly stop: string | null;
	readonly commitShas: readonly string[];
	readonly data: JsonValue;
};
export type CycleEngineDependencies = {
	readonly now?: () => Date;
	readonly checkpoint?: (checkpoint: string) => void;
};
/** Advance at most one externally meaningful atom while owning both locks. */
export async function continueCycle(options: ContinueCycleOptions): Promise<ContinueCycleResult> {
	const commits: string[] = [];
	const cycleLock = acquireLock(options.patchesDir, GLOBAL_LOCK_ID, 'cycle continue');
	try {
		const treeLock = acquireLock(options.patchesDir, treeId(options.resolution.path), 'cycle continue');
		try {
			return await continueLocked(options, { cycle: cycleLock, tree: treeLock }, commits);
		} finally {
			treeLock.release();
		}
	} finally {
		cycleLock.release();
	}
}
async function continueLocked(
	options: ContinueCycleOptions,
	locks: { readonly cycle: ReturnType<typeof acquireLock>; readonly tree: ReturnType<typeof acquireLock> },
	commits: string[]
): Promise<ContinueCycleResult> {
	const transition = pendingTransition(options.patchesDir);
	if (transition !== null) return resumeCycleTransition(options, transition, commits);
	const observedState = readCycleState(options.patchesDir);
	let terminal = pendingTerminal(options.patchesDir);
	if (
		terminal?.checkpoint === 'committed' &&
		observedState !== null &&
		terminal.state.targetPin.sha !== observedState.targetPin.sha &&
		options.config.pin.sha === observedState.targetPin.sha &&
		runGit({ args: ['merge-base', '--is-ancestor', terminal.commitSha ?? '', 'HEAD'], cwd: options.patchesDir }).status === 0
	) {
		clearCycleTerminalRecord(options.patchesDir);
		const staleApply = readCycleApplyRecord(options.patchesDir);
		if (staleApply !== null && staleApply.targetPin.sha !== observedState.targetPin.sha) clearCycleApplyRecord(options.patchesDir);
		terminal = null;
	}
	if (terminal !== null) return resumeCycleTerminal(options, terminal, commits);
	let state = observedState;
	if (state === null) {
		throw ckError('CONFIG', 'cycle state is absent without a committed terminal receipt', 'run cycle status or start a new cycle');
	}
	const record = readCycleApplyRecord(options.patchesDir);
	state = reconcileClassifiedState(options.patchesDir, state, record);
	assertRecordIdentity(options.patchesDir, state, record);
	if (record?.checkpoint === 'regenerated' && record.regenerationCommit === null) {
		return finishRegenerationCommit(options, state, record, commits);
	}
	if (state.phase === 'apply') return applyPhase(options, state, record, locks, commits);
	if (state.phase === 'renames') return renamesPhase(options, state, requireRecord(record), commits);
	if (state.phase === 'regen') return regenerationPhase(options, state, requireRecord(record), commits);
	if (state.phase === 'resolve') return resolvePhase(options, state, requireRecord(record), locks, commits);
	if (state.phase === 'deps-advisory' || state.phase === 'stabilize') {
		return planStabilizationTransition(options, state, locks, commits);
	}
	if (state.phase === 'done') return planTerminalTransaction(options, state, commits);
	throw ckError('CONFIG', `cycle continue cannot advance phase ${state.phase}`, 'finish cycle start or restart its transaction');
}

function applyPhase(
	options: ContinueCycleOptions,
	state: CycleState,
	record: CycleApplyRecord | null,
	locks: { readonly cycle: ReturnType<typeof acquireLock>; readonly tree: ReturnType<typeof acquireLock> },
	commits: string[]
): ContinueCycleResult {
	const preview = previewCycleApply(baseClassifyOptions(options, state));
	const nextRecord = recordFromClassification(options, state, preview, record);
	const reviewToken = previewToken(preview);
	const resourceReview = preview.classifications.some((item) => item.kind === 'resource' && item.outcome !== 'clean');
	const reviewStop = resourceReview ? 'resource-rename-review' : preview.renameBatch.needsReview ? 'rename-review' : null;
	const expectedAction =
		reviewStop === 'resource-rename-review' ? 'review and update resource rename mappings' : 'review detected patch renames';
	const exactStoppedState = reviewStop !== null && matchesReviewState(state, preview, expectedAction);
	const implicitReview =
		reviewStop === 'rename-review' &&
		record?.checkpoint === 'preview' &&
		record.reviewToken === reviewToken &&
		record.reviewStop === reviewStop &&
		exactStoppedState;
	const reviewedRenames = options.reviewedRenames === true || implicitReview;
	const patchReview = preview.renameBatch.needsReview && !reviewedRenames;
	if (resourceReview || patchReview) {
		const stop = resourceReview ? 'resource-rename-review' : 'rename-review';
		const action = resourceReview ? 'review and update resource rename mappings' : 'review detected patch renames';
		const stopped = exactStoppedState
			? state
			: cycleStateSchema.parse({
					...transition(state, 'apply', action, now(options, state.updatedAt)),
					artifacts: preview.buckets,
					renames: preview.renames
				});
		writeCycleState(options.patchesDir, stopped);
		checkpoint(options, 'apply-review-state-written');
		writeCycleApplyRecord(options.patchesDir, updateCycleApplyRecord(nextRecord, { reviewToken, reviewStop: stop }));
		checkpoint(options, 'apply-preview-persisted');
		return result(3, 'stopped', stopped, stop, commits, {
			phase: 'apply',
			reviewRequired: true,
			renames: preview.renames
		});
	}
	writeCycleApplyRecord(options.patchesDir, nextRecord);
	const classified = applyCycleClassification({
		...baseClassifyOptions(options, state),
		locks,
		...(preview.renameBatch.needsReview ? { reviewedRenames: true } : {})
	});
	checkpoint(options, 'apply-classification-applied');
	const classifiedRecord = recordFromClassification(options, state, classified, nextRecord);
	const durableClassified = updateCycleApplyRecord(classifiedRecord, { checkpoint: 'classified', renameParent: head(options.patchesDir) });
	const classifiedState = classifiedStateFrom(state, durableClassified);
	writeCycleApplyRecord(options.patchesDir, durableClassified);
	checkpoint(options, 'apply-classified-record-written');
	writeCycleState(options.patchesDir, classifiedState);
	checkpoint(options, 'apply-classified');
	return renamesPhase(options, classifiedState, requireRecord(readCycleApplyRecord(options.patchesDir)), commits);
}
function renamesPhase(options: ContinueCycleOptions, state: CycleState, record: CycleApplyRecord, commits: string[]): ContinueCycleResult {
	let current = record;
	if (current.renamePaths.length > 0 && current.renameCommit === null) {
		const committed = commitCycleAtom({
			patchesDir: options.patchesDir,
			expectedBranch: state.branch,
			expectedParent: current.renameParent,
			targetTag: state.targetPin.tag,
			subject: `refactor(cycle): follow upstream renames for ${state.targetPin.tag}`,
			paths: [...current.renamePaths, CYCLE_STATE_PATH],
			timestamp: current.createdAt
		});
		if (committed.sha !== null) commits.push(committed.sha);
		current = updateCycleApplyRecord(current, { renameCommit: committed.sha });
		writeCycleApplyRecord(options.patchesDir, current);
		checkpoint(options, 'renames-committed');
	}
	if (current.checkpoint === 'classified') {
		materializeCycleApply({
			patchesDir: options.patchesDir,
			resolution: options.resolution,
			config: options.config,
			type: options.type,
			sourcePin: state.sourcePin,
			classifications: artifactClassifications(current.classifications),
			renames: current.renames,
			ownRenameAuthority: {
				parent: current.renameParent,
				commit: current.renameCommit,
				paths: current.renamePaths
			},
			out: options.out
		});
		current = updateCycleApplyRecord(current, {
			checkpoint: 'materialized',
			regenerationParent: head(options.patchesDir)
		});
		writeCycleApplyRecord(options.patchesDir, current);
		checkpoint(options, 'apply-materialized');
	}
	const next = transition(state, 'regen', 'regenerate classified artifacts against the target pin', now(options, state.updatedAt));
	writeCycleState(options.patchesDir, next);
	return regenerationPhase(options, next, current, commits);
}
function regenerationPhase(
	options: ContinueCycleOptions,
	state: CycleState,
	record: CycleApplyRecord,
	commits: string[]
): ContinueCycleResult {
	if (record.checkpoint !== 'materialized' && record.checkpoint !== 'regenerated') {
		throw ckError('ARTIFACT-BROKEN', `cycle apply record cannot regenerate from ${record.checkpoint}`);
	}
	let current = record;
	if (current.checkpoint === 'materialized') {
		const regenerationOptions = {
			patchesDir: options.patchesDir,
			type: options.type,
			state,
			classifications: current.classifications,
			causes: current.causes
		};
		if (current.regenerationPaths.length === 0) {
			const plan = planCycleRegeneration(regenerationOptions);
			current = updateCycleApplyRecord(current, {
				regenerationPaths: byteSorted(plan.operations.map((operation) => operation.path))
			});
			writeCycleApplyRecord(options.patchesDir, current);
			checkpoint(options, 'regeneration-planned');
		}
		regenerateCycle(regenerationOptions);
		current = updateCycleApplyRecord(current, {
			checkpoint: 'regenerated'
		});
		writeCycleApplyRecord(options.patchesDir, current);
		checkpoint(options, 'apply-regenerated');
	}
	const blockers = ['conflict', 'target-deleted', 'rule-broken', 'contract-failed'].flatMap(
		(outcome) => state.artifacts[outcome as keyof typeof state.artifacts]
	);
	appendAutomaticJournal(options.patchesDir, state, current);
	const next = transition(
		state,
		blockers.length === 0 ? 'deps-advisory' : 'resolve',
		blockers.length === 0 ? 'inspect dependency advisory' : `resolve ${blockers.length} classified blocker(s)`,
		now(options, state.updatedAt)
	);
	writeCycleState(options.patchesDir, next);
	return finishRegenerationCommit(options, next, current, commits);
}
function finishRegenerationCommit(
	options: ContinueCycleOptions,
	state: CycleState,
	record: CycleApplyRecord,
	commits: string[]
): ContinueCycleResult {
	const parent = record.regenerationParent;
	if (parent === null) throw ckError('ARTIFACT-BROKEN', 'regeneration record has no exact parent');
	const journal = journalRelativePath(state.targetPin.tag);
	const paths = byteSorted([
		...regenerationPaths(record),
		CYCLE_STATE_PATH,
		...(readText(options.patchesDir, journal) === null ? [] : [journal])
	]);
	const committed = commitCycleAtom({
		patchesDir: options.patchesDir,
		expectedBranch: state.branch,
		expectedParent: parent,
		targetTag: state.targetPin.tag,
		subject: `chore(cycle): regenerate delta for ${state.targetPin.tag}`,
		paths,
		timestamp: record.createdAt,
		allowNoop: true
	});
	if (committed.sha !== null) commits.push(committed.sha);
	writeCycleApplyRecord(options.patchesDir, updateCycleApplyRecord(record, { checkpoint: 'committed', regenerationCommit: committed.sha }));
	checkpoint(options, 'apply-committed');
	const stop = state.phase === 'resolve' ? 'resolve' : null;
	return result(stop === null ? 0 : 3, stop === null ? 'advanced' : 'stopped', state, stop, commits, {
		phase: state.phase,
		counts: state.artifacts
	});
}
function resolvePhase(
	options: ContinueCycleOptions,
	state: CycleState,
	record: CycleApplyRecord,
	locks: { readonly cycle: ReturnType<typeof acquireLock>; readonly tree: ReturnType<typeof acquireLock> },
	commits: string[]
): ContinueCycleResult {
	const journal = readCycleJournal(options.patchesDir, state.targetPin.tag);
	const resolved = runCycleResolve({
		patchesDir: options.patchesDir,
		resolution: options.resolution,
		config: options.config,
		type: options.type,
		state,
		journal,
		artifacts: resolveArtifacts(options, state, record, journal),
		locks,
		out: options.out
	});
	if (resolved.commit !== null) {
		const committed = commitCycleAtom(resolved.commit);
		if (committed.sha !== null) commits.push(committed.sha);
		checkpoint(options, 'resolve-commit-installed');
		return result(0, 'advanced', resolved.state, null, commits, { phase: 'resolve', plans: resolved.plans });
	}
	if (resolved.status !== 'complete') {
		return result(3, 'stopped', resolved.state, 'resolve', commits, { phase: 'resolve', plans: resolved.plans });
	}
	const next = transition(resolved.state, 'deps-advisory', 'inspect dependency advisory', now(options, resolved.state.updatedAt));
	writeCycleState(options.patchesDir, next);
	checkpoint(options, 'resolve-completed');
	return result(0, 'advanced', next, null, commits, { phase: next.phase });
}
function recordFromClassification(
	options: ContinueCycleOptions,
	state: CycleState,
	classification: CycleClassifyResult,
	previous: CycleApplyRecord | null
): CycleApplyRecord {
	const currentRenamePaths = renamePaths(classification);
	const retainedRenamePaths =
		currentRenamePaths.length === 0 &&
		previous?.checkpoint === 'preview' &&
		previous.renamePaths.length > 0 &&
		same(previous.renames, classification.renames)
			? previous.renamePaths
			: currentRenamePaths;
	return makeCycleApplyRecord({
		sourcePin: state.sourcePin,
		targetPin: state.targetPin,
		branch: state.branch,
		createdAt: previous?.createdAt ?? commitTimestamp(now(options, state.updatedAt)),
		classifications: classification.classifications,
		causes: classification.causes,
		buckets: classification.buckets,
		renames: classification.renames,
		renamePaths: retainedRenamePaths,
		regenerationPaths: [],
		reviewToken: null,
		reviewStop: null,
		checkpoint: 'preview',
		renameParent: previous?.renameParent ?? head(options.patchesDir),
		renameCommit: null,
		regenerationParent: null,
		regenerationCommit: null
	});
}

function baseClassifyOptions(options: ContinueCycleOptions, state: CycleState) {
	const references = renameReferencePaths(options.patchesDir, ownedRootsOf(options.type, options.config.typeConfig));
	return {
		patchesDir: options.patchesDir,
		treeDir: options.resolution.path,
		config: options.config,
		type: options.type,
		state,
		contractTestPaths: references.contractTests,
		ownPaths: references.own
	};
}

function renamePaths(resultValue: CycleClassifyResult): readonly string[] {
	const paths: string[] = [];
	for (const plan of resultValue.renameBatch.plans) {
		for (const operation of plan.operations) {
			if (operation.kind === 'replace') paths.push(operation.file);
			else paths.push(operation.from, operation.to);
		}
	}
	for (const item of resultValue.classifications) {
		if (item.kind === 'resource' && resultValue.renames.some((rename) => rename.to === item.targetPath)) {
			paths.push(RESOURCE_MAP_PATH);
		}
	}
	return byteSorted(paths);
}

function regenerationPaths(record: CycleApplyRecord): readonly string[] {
	return record.regenerationPaths;
}

function artifactClassifications(items: readonly CycleApplyClassification[]) {
	return items.filter((item): item is Exclude<CycleApplyClassification, { readonly kind: 'resource' }> => item.kind !== 'resource');
}

function appendAutomaticJournal(root: string, state: CycleState, record: CycleApplyRecord): void {
	const latest = new Map(readCycleJournal(root, state.targetPin.tag).map((entry) => [entry.artifact, entry]));
	for (const outcome of ['shifted', 'merged', 'target-renamed'] as const) {
		for (const artifact of state.artifacts[outcome]) {
			const cause = record.causes.find((item) => item.artifactPath === artifact)?.cause;
			if (cause === undefined) throw ckError('ARTIFACT-BROKEN', `${artifact}: automatic outcome has no immutable cause`);
			const existing = latest.get(artifact);
			if (existing !== undefined) {
				if (existing.outcome !== outcome || existing.cause.sha !== cause.sha || existing.cause.approx !== cause.approx)
					throw ckError('LOG-INCOMPLETE', `${artifact}: existing journal proof conflicts with automatic classification`);
				continue;
			}
			appendCycleJournalEntry(root, state.targetPin.tag, {
				codkitCycleJournal: 1,
				ts: record.createdAt,
				artifact,
				outcome,
				resolution: 'regenerated automatically from the complete three-way classification',
				cause,
				by: JOURNAL_ACTOR,
				verified: [{ command: 'codkit cycle continue (classification and regeneration)', exitCode: 0 }]
			});
		}
	}
}

function resolveArtifacts(
	options: ContinueCycleOptions,
	state: CycleState,
	record: CycleApplyRecord,
	journal: readonly CycleJournalEntry[]
): readonly CycleResolveArtifact[] {
	const classifications = new Map(record.classifications.map((item) => [item.artifactPath, item]));
	const causes = new Map(record.causes.map((item) => [item.artifactPath, item.cause]));
	const latest = new Map(journal.map((entry) => [entry.artifact, entry]));
	const inventory = buildInventory(options.patchesDir, options.type, { config: options.config });
	const entries = new Map(inventory.entries.map((entry) => [entry.artifact, entry]));
	return RESOLVE_OUTCOMES.flatMap((outcome): CycleResolveArtifact[] =>
		state.artifacts[outcome as keyof typeof state.artifacts].map((artifactPath): CycleResolveArtifact => {
			const item = classifications.get(artifactPath);
			const kind = outcome === 'contract-failed' ? 'contract' : (item?.kind ?? 'contract');
			const patchesPaths = byteSorted([artifactPath, ...(kind === 'resource' ? [RESOURCE_MAP_PATH] : [])]);
			const proof = latest.get(artifactPath);
			const snapshots =
				kind === 'patch' && outcome === 'conflict'
					? undefined
					: patchesPaths.map((path) => ({ path, sha256: fileDigest(options.patchesDir, path) }));
			return {
				artifactPath,
				artifactId: item?.artifactId ?? entries.get(artifactPath)?.id ?? artifactPath,
				kind,
				outcome,
				cause: causes.get(artifactPath) ?? proof?.cause ?? { sha: state.targetPin.sha, approx: true },
				...(item === undefined ? {} : { targetPath: item.targetPath }),
				patchesPaths,
				...(snapshots === undefined ? {} : { patchsetSnapshots: snapshots })
			};
		})
	);
}

function transition(state: CycleState, phase: CycleState['phase'], nextAction: string, updatedAt: string): CycleState {
	return cycleStateSchema.parse({ ...state, phase, nextAction, updatedAt });
}
function now(options: ContinueCycleOptions, minimum?: string): string {
	const source = options.now ?? options.dependencies?.now ?? (() => new Date());
	const observed = source().getTime();
	const floor = minimum === undefined ? Number.NEGATIVE_INFINITY : Date.parse(minimum) + 1;
	return new Date(Math.max(observed, floor)).toISOString();
}
function commitTimestamp(timestamp: string): string {
	return new Date(Math.ceil(Date.parse(timestamp) / 1000) * 1000).toISOString();
}
function head(root: string): string {
	const found = runGit({ args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: root });
	const sha = found.stdout.trim();
	if (found.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw ckError('CONFIG', 'cannot resolve exact cycle HEAD');
	return sha;
}
function assertRecordIdentity(root: string, state: CycleState, record: CycleApplyRecord | null): void {
	if (record === null) return;
	if (record.branch !== state.branch || !same(record.sourcePin, state.sourcePin) || !same(record.targetPin, state.targetPin))
		throw ckError('ARTIFACT-BROKEN', `${CYCLE_APPLY_RECORD_PATH}: identity differs from cycle state`);
	const phases: Readonly<Record<CycleApplyRecord['checkpoint'], readonly CycleState['phase'][]>> = {
		preview: ['apply'],
		classified: ['renames'],
		materialized: ['renames', 'regen'],
		regenerated: ['regen', 'resolve', 'deps-advisory'],
		committed: ['resolve', 'deps-advisory', 'stabilize', 'done']
	};
	if (!phases[record.checkpoint].includes(state.phase))
		throw ckError('ARTIFACT-BROKEN', `${CYCLE_APPLY_RECORD_PATH}: checkpoint differs from phase`);
	const expected =
		record.checkpoint === 'preview' || record.checkpoint === 'classified'
			? record.renameParent
			: record.checkpoint === 'committed'
				? (record.regenerationCommit ?? record.regenerationParent)
				: record.regenerationParent;
	if (expected === null) throw ckError('ARTIFACT-BROKEN', `${CYCLE_APPLY_RECORD_PATH}: checkpoint has no HEAD evidence`);
	const relation = runGit({ args: ['merge-base', '--is-ancestor', expected, 'HEAD'], cwd: root });
	if (relation.status !== 0) throw ckError('ARTIFACT-BROKEN', `${CYCLE_APPLY_RECORD_PATH}: recorded commit is not an ancestor of HEAD`);
}
function reconcileClassifiedState(root: string, state: CycleState, record: CycleApplyRecord | null): CycleState {
	if (record?.checkpoint !== 'classified') return state;
	if (record.branch !== state.branch || !same(record.sourcePin, state.sourcePin) || !same(record.targetPin, state.targetPin))
		throw ckError('ARTIFACT-BROKEN', `${CYCLE_APPLY_RECORD_PATH}: classified endpoint identity differs`);
	const expected = classifiedStateFrom(state, record);
	if (state.phase === 'apply') {
		writeCycleState(root, expected);
		return expected;
	}
	if (state.phase !== 'renames' || !same(state, expected))
		throw ckError('ARTIFACT-BROKEN', `${CYCLE_APPLY_RECORD_PATH}: classified state endpoint is inconsistent`);
	return state;
}
function classifiedStateFrom(state: CycleState, record: CycleApplyRecord): CycleState {
	return cycleStateSchema.parse({
		...state,
		phase: 'renames',
		nextAction: 'commit accepted renames and materialize the classified target tree',
		updatedAt: record.createdAt,
		artifacts: record.buckets,
		renames: record.renames
	});
}
function matchesReviewState(state: CycleState, preview: CycleClassifyResult, nextAction: string): boolean {
	return (
		state.phase === 'apply' &&
		state.transaction === null &&
		state.nextAction === nextAction &&
		same(state.artifacts, preview.buckets) &&
		same(state.renames, preview.renames)
	);
}
function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
function requireRecord(record: CycleApplyRecord | null): CycleApplyRecord {
	if (record === null) throw ckError('ARTIFACT-BROKEN', `cycle phase requires ${CYCLE_APPLY_RECORD_PATH}`);
	return record;
}
function journalRelativePath(tag: string): string {
	return `cycle/log/${tag}.jsonl`;
}
function checkpoint(options: ContinueCycleOptions, name: string): void {
	options.dependencies?.checkpoint?.(name);
}
function previewToken(preview: CycleClassifyResult): string {
	const json = JSON.stringify(preview, (_key, value: unknown) =>
		value instanceof Uint8Array ? { codkitBytesBase64: Buffer.from(value).toString('base64') } : value
	);
	return createHash('sha256').update(json).digest('hex');
}
function result(
	exitCode: 0 | 1 | 3,
	status: ContinueCycleStatus,
	state: CycleState | null,
	stop: string | null,
	commitShas: readonly string[],
	data: unknown
): ContinueCycleResult {
	return { exitCode, status, state, stop, commitShas: [...commitShas], data: toJson(data) };
}
