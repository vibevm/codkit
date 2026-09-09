/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Deterministic regeneration of cycle artifacts. Planning is read-only; apply
// is a byte-CAS transaction with a durable recovery record owned by the caller's
// cycle lock.

import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import type { CycleApplyClassification, CycleClassificationCause } from './cycleClassify.ts';
import type { CycleState } from './cycleState.ts';
import { cycleStateSchema } from './cycleState.ts';
import { updateCycleMetadata } from './cycleRegenerateMetadata.ts';
import {
	atomicWrite,
	base64,
	CYCLE_REGENERATE_RECOVERY_PATH,
	digest,
	fromBase64,
	hash,
	operationAfter,
	parseRegenerationPlan,
	preflightBasis,
	readFileState,
	readRecovery,
	removeContained,
	sameState,
	writeRecovery
} from './cycleRegenerateTransaction.ts';
import type {
	CycleRegenerationPlan,
	FileState,
	RegenerationAction,
	RegenerationBasis,
	RegenerationOperation
} from './cycleRegenerateTransaction.ts';
import { loadConventions } from './conventionsFile.ts';
import { parseOverlay, OVERLAYS_DIR, OVERLAY_FILE_SUFFIX, serializeOverlay } from './layers/overlay.ts';
import type { Overlay } from './layers/overlay.ts';
import { OWN_MANIFEST_PATH, parseOwnManifest, serializeOwnManifest } from './layers/ownManifest.ts';
import type { OwnExtension, OwnUnit, ServiceOverride } from './layers/ownManifest.ts';
import { REMOVED_PATH, parseRemoved, serializeRemoved } from './layers/removed.ts';
import type { RemovedEntry } from './layers/removed.ts';
import { parseResourceMap, RESOURCE_FILES_PREFIX, RESOURCE_MAP_PATH, serializeResourceMap } from './layers/resource.ts';
import type { ResourceEntry } from './layers/resource.ts';
import { parseRule, RULES_DIR, RULE_FILE_SUFFIX, serializeRule } from './layers/rule.ts';
import type { Rule } from './layers/rule.ts';
import { ckError } from './messages.ts';
import { encodePatchName, parseCkpatch, PATCH_FILE_SUFFIX } from './patchFormat.ts';
import type { ParsedPatch } from './patchFormat.ts';
import { regeneratePatch } from './patchGenerate.ts';
import { resolveContainedPath } from './pathSafety.ts';
import { PATCHES_DIR } from './syncEngine.ts';
import type { ProjectType } from '@codkit/type-api';

export { CYCLE_REGENERATE_RECOVERY_PATH } from './cycleRegenerateTransaction.ts';
export type { CycleRegenerationPlan } from './cycleRegenerateTransaction.ts';
export type CycleRegenerationAction = RegenerationAction;

export type CycleRegenerationResult = {
	readonly changedPaths: readonly string[];
	readonly actions: readonly CycleRegenerationAction[];
	readonly resumed: boolean;
};

export type CycleRegenerationOptions = {
	readonly patchesDir: string;
	/** The project type of the patch set. */
	readonly type: ProjectType;
	readonly state: CycleState;
	readonly classifications: readonly CycleApplyClassification[];
	readonly causes: readonly CycleClassificationCause[];
};

export type CycleRegenerationRuntime = {
	readonly beforeMutation?: (path: string) => void;
	readonly checkpoint?: (path: string) => void;
};

type Snapshot = { readonly path: string; readonly bytes: Uint8Array; readonly mode: FileState['mode'] };
type Inventory = {
	readonly snapshots: readonly Snapshot[];
	readonly patches: ReadonlyMap<string, ParsedPatch>;
	readonly rules: ReadonlyMap<string, Rule>;
	readonly overlays: ReadonlyMap<string, Overlay>;
	readonly resources: readonly ResourceEntry[];
	readonly own: {
		readonly units: readonly OwnUnit[];
		readonly serviceOverrides: readonly ServiceOverride[];
		readonly extensions: readonly OwnExtension[];
	} | null;
	readonly removed: readonly RemovedEntry[] | null;
};

/** Build the exact write/delete set without mutating patchset. */
export function planCycleRegeneration(options: CycleRegenerationOptions): CycleRegenerationPlan {
	return deriveCycleRegenerationPlan(options);
}

function deriveCycleRegenerationPlan(
	options: CycleRegenerationOptions,
	recoveryBasis: readonly RegenerationBasis[] = []
): CycleRegenerationPlan {
	const state = validState(options.state);
	assertCanonicalInput(options.classifications, options.causes);
	const sourcePin = pinValue(state.sourcePin);
	const targetPin = pinValue(state.targetPin);
	const inventory = loadInventory(options.patchesDir, options.type, recoveryBasis);
	const classifications = classificationMap(options.classifications);
	assertComplete(inventory, classifications);
	const causes = causeMap(options.causes, classifications);
	const desired = new Map(inventory.snapshots.map((item) => [item.path, item.bytes]));
	const actions: CycleRegenerationAction[] = [];
	const scratch = join(tmpdir(), `codkit-cycle-regenerate-${randomUUID()}`);
	try {
		for (const [path, patch] of inventory.patches) {
			const item = classifications.get(path);
			if (item?.kind !== 'patch') throw broken(`${path}: missing patch classification`);
			assertIdentity(item, patch.header.id, patch.targetPath);
			const selected = causes.get(causeKey(path, patch.header.id)) ?? null;
			if (!['clean', 'shifted', 'merged'].includes(item.outcome)) {
				assertPin(patch.header.pin, sourcePin, path);
				actions.push(action(item, 'untouched', selected));
				continue;
			}
			if (item.bytes === null || item.materials === null) throw broken(`${path}: regenerable patch has no merge materials`);
			assertTransitionPin(patch.header.pin, sourcePin, targetPin, path);
			const header = updatedPatchHeader(patch, selected?.sha ?? patch.header.cause, targetPin);
			const current = requiredDesired(desired, path);
			const generated = regeneratePatch({
				targetPath: item.targetPath,
				pinBytes: item.materials.ours,
				pinExists: item.materials.oursExists,
				curBytes: item.bytes,
				header,
				existingBytes: current,
				tmpDir: scratch
			});
			if (generated.empty) {
				desired.delete(path);
				actions.push(action(item, 'delete', selected));
			} else if (generated.unchanged) {
				actions.push(action(item, 'noop', selected));
			} else {
				desired.set(path, generated.bytes);
				actions.push(action(item, 'write', selected));
			}
		}
		for (const item of options.classifications) {
			if (inventory.patches.has(item.artifactPath) || item.kind !== 'patch') continue;
			if (
				!['clean', 'shifted', 'merged'].includes(item.outcome) ||
				item.bytes === null ||
				item.materials === null ||
				!item.materials.oursExists ||
				!bytesEqual(item.bytes, item.materials.ours)
			)
				throw broken(`${item.artifactPath}: classified patch artifact is missing`);
			actions.push(action(item, 'noop', causes.get(causeKey(item.artifactPath, item.artifactId)) ?? null));
		}
		updateCycleMetadata({ inventory, classifications, causes, sourcePin, targetPin, desired, actions });
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	const basis = inventory.snapshots.map((item) => ({
		path: item.path,
		before: base64(item.bytes),
		hash: hash(item.bytes),
		mode: item.mode
	}));
	const operations = inventory.snapshots.flatMap((item): readonly RegenerationOperation[] => {
		const after = desired.get(item.path);
		if (after === undefined)
			return [{ path: item.path, action: 'delete', before: base64(item.bytes), beforeMode: item.mode, after: null, afterMode: null }];
		return bytesEqual(after, item.bytes)
			? []
			: [
					{
						path: item.path,
						action: 'write',
						before: base64(item.bytes),
						beforeMode: item.mode,
						after: base64(after),
						afterMode: item.mode
					}
				];
	});
	const body = {
		codkitCycleRegeneration: 1 as const,
		authorityDigest: authorityDigest(options),
		sourcePin,
		targetPin,
		basis,
		operations: [...operations].sort(byPath),
		actions: [...actions].sort(actionOrder)
	};
	return {
		codkitCycleRegeneration: body.codkitCycleRegeneration,
		digest: digest(body),
		authorityDigest: body.authorityDigest,
		sourcePin: body.sourcePin,
		targetPin: body.targetPin,
		basis: body.basis,
		operations: body.operations,
		actions: body.actions
	};
}

/** Apply an already planned transaction. Current bytes must be before or after. */
export function applyCycleRegenerationPlan(
	options: CycleRegenerationOptions,
	plan: CycleRegenerationPlan,
	runtime: CycleRegenerationRuntime = {},
	resumed = false
): CycleRegenerationResult {
	const validated = parseRegenerationPlan(plan);
	const expected = deriveCycleRegenerationPlan(options, validated.basis);
	if (JSON.stringify(validated) !== JSON.stringify(expected))
		throw broken('regeneration plan is not the exact plan derived from authoritative inputs and inventory');
	preflightBasis(options.patchesDir, validated);
	writeRecovery(options.patchesDir, validated);
	for (const operation of validated.operations) {
		const before: FileState = { bytes: fromBase64(operation.before), mode: operation.beforeMode };
		const after = operationAfter(operation);
		const current = readFileState(options.patchesDir, operation.path);
		if (sameState(current, after)) continue;
		if (!sameState(current, before)) throw broken(`${operation.path}: bytes or mode changed after regeneration preflight`);
		runtime.beforeMutation?.(operation.path);
		const checked = readFileState(options.patchesDir, operation.path);
		if (!sameState(checked, before)) throw broken(`${operation.path}: stale byte race or mode race before regeneration write`);
		if (operation.action === 'delete') removeContained(options.patchesDir, operation.path);
		else atomicWrite(options.patchesDir, operation.path, requiredAfter(after));
		runtime.checkpoint?.(operation.path);
	}
	removeContained(options.patchesDir, CYCLE_REGENERATE_RECOVERY_PATH);
	return { changedPaths: validated.operations.map((item) => item.path), actions: validated.actions, resumed };
}

/** Resume a durable partial apply, or plan and perform a new regeneration. */
export function regenerateCycle(options: CycleRegenerationOptions, runtime: CycleRegenerationRuntime = {}): CycleRegenerationResult {
	const pending = readRecovery(options.patchesDir);
	if (pending !== null) {
		return applyCycleRegenerationPlan(options, pending, runtime, true);
	}
	return applyCycleRegenerationPlan(options, planCycleRegeneration(options), runtime, false);
}

function loadInventory(root: string, type: ProjectType, recoveryBasis: readonly RegenerationBasis[]): Inventory {
	const override = new Map(recoveryBasis.map((item) => [item.path, item]));
	const snapshots: Snapshot[] = [];
	const patches = new Map<string, ParsedPatch>();
	const patchFiles = files(root, PATCHES_DIR, PATCH_FILE_SUFFIX, override);
	const conventions = patchFiles.length === 0 ? null : loadConventions(type, root);
	for (const path of patchFiles) {
		const snap = snapshot(root, path, override);
		if (conventions === null) throw broken('patch conventions disappeared');
		const parsed = parseCkpatch(snap.bytes, conventions, path);
		if (path !== `${PATCHES_DIR}/${encodePatchName(parsed.targetPath)}`) throw broken(`${path}: patch file name does not match its target`);
		patches.set(path, parsed);
		snapshots.push(snap);
	}
	const rules = new Map<string, Rule>();
	for (const path of files(root, RULES_DIR, RULE_FILE_SUFFIX, override)) {
		const snap = snapshot(root, path, override);
		const parsed = parseRule(parseJson(snap), path);
		assertCanonicalJson(snap, serializeRule(parsed));
		rules.set(path, parsed);
		snapshots.push(snap);
	}
	const overlays = new Map<string, Overlay>();
	for (const path of files(root, OVERLAYS_DIR, OVERLAY_FILE_SUFFIX, override)) {
		const snap = snapshot(root, path, override);
		const parsed = parseOverlay(parseJson(snap), path);
		assertCanonicalJson(snap, serializeOverlay(parsed));
		overlays.set(path, parsed);
		snapshots.push(snap);
	}
	const resourceSnap = optionalSnapshot(root, RESOURCE_MAP_PATH, override);
	const resources = resourceSnap === null ? [] : parseResourceMap(parseJson(resourceSnap)).entries;
	if (resourceSnap !== null) assertCanonicalJson(resourceSnap, serializeResourceMap({ entries: resources }));
	if (resourceSnap !== null) snapshots.push(resourceSnap);
	const resourceSources = new Set<string>();
	for (const entry of resources) {
		if (!entry.source.startsWith(RESOURCE_FILES_PREFIX)) throw broken(`${entry.source}: resource source is outside resource files`);
		if (resourceSources.has(entry.source)) throw broken(`${entry.source}: duplicate resource source`);
		resourceSources.add(entry.source);
		snapshots.push(snapshot(root, entry.source, override));
	}
	const ownSnap = optionalSnapshot(root, OWN_MANIFEST_PATH, override);
	const own = ownSnap === null ? null : parseOwnManifest(parseJson(ownSnap));
	if (ownSnap !== null && own !== null) assertCanonicalJson(ownSnap, serializeOwnManifest(own));
	if (ownSnap !== null) snapshots.push(ownSnap);
	const removedSnap = optionalSnapshot(root, REMOVED_PATH, override);
	const removed = removedSnap === null ? null : parseRemoved(parseJson(removedSnap)).entries;
	if (removedSnap !== null && removed !== null) assertCanonicalJson(removedSnap, serializeRemoved({ entries: removed }));
	if (removedSnap !== null) snapshots.push(removedSnap);
	return { snapshots: snapshots.sort(byPath), patches, rules, overlays, resources, own, removed };
}

function assertComplete(inventory: Inventory, classifications: ReadonlyMap<string, CycleApplyClassification>): void {
	const expected = [
		...inventory.patches.keys(),
		...inventory.rules.keys(),
		...inventory.overlays.keys(),
		...inventory.resources.map((entry) => entry.source)
	].sort(compareText);
	const actual = [...classifications]
		.filter(([, item]) => {
			if (expected.includes(item.artifactPath)) return true;
			return !(
				item.kind === 'patch' &&
				['clean', 'shifted', 'merged'].includes(item.outcome) &&
				item.bytes !== null &&
				item.materials !== null &&
				bytesEqual(item.bytes, item.materials.ours)
			);
		})
		.map(([path]) => path)
		.sort(compareText);
	if (JSON.stringify(expected) !== JSON.stringify(actual))
		throw broken('classification list does not exactly cover the regeneration inventory');
}

function classificationMap(items: readonly CycleApplyClassification[]): ReadonlyMap<string, CycleApplyClassification> {
	const out = new Map<string, CycleApplyClassification>();
	for (const item of items) {
		if (out.has(item.artifactPath)) throw broken(`duplicate classification ${item.artifactPath}`);
		out.set(item.artifactPath, item);
	}
	return out;
}

function causeMap(
	items: readonly CycleClassificationCause[],
	classifications: ReadonlyMap<string, CycleApplyClassification>
): ReadonlyMap<string, CycleClassificationCause['cause']> {
	const out = new Map<string, CycleClassificationCause['cause']>();
	for (const item of items) {
		const classified = classifications.get(item.artifactPath);
		if (classified === undefined || classified.artifactId !== item.artifactId || classified.targetPath !== item.targetPath)
			throw broken(`${item.artifactPath}: cause does not match classification identity`);
		const key = causeKey(item.artifactPath, item.artifactId);
		if (out.has(key)) throw broken(`${item.artifactPath}: duplicate cause`);
		out.set(key, item.cause);
	}
	return out;
}

function assertCanonicalInput(classifications: readonly CycleApplyClassification[], causes: readonly CycleClassificationCause[]): void {
	if (!ordered(classifications.map((item) => item.artifactPath))) throw broken('classifications are not in deterministic path order');
	if (!ordered(causes.map((item) => `${item.artifactPath}\0${item.artifactId}`)))
		throw broken('causes are not in deterministic path order');
}

function action(
	item: CycleApplyClassification,
	kind: CycleRegenerationAction['action'],
	cause: CycleRegenerationAction['cause']
): CycleRegenerationAction {
	return { artifactPath: item.artifactPath, artifactId: item.artifactId, kind: item.kind, action: kind, cause };
}

function validState(state: CycleState): CycleState {
	const parsed = cycleStateSchema.safeParse(state);
	if (!parsed.success) throw broken(`invalid cycle state: ${parsed.error.issues[0]?.message ?? 'validation failed'}`);
	if (!['apply', 'regen'].includes(parsed.data.phase)) throw broken(`cycle phase must be apply or regen, got ${parsed.data.phase}`);
	return parsed.data;
}

function assertIdentity(item: CycleApplyClassification, id: string, target: string): void {
	if (item.artifactId !== id || item.targetPath !== target) throw broken(`${item.artifactPath}: classification identity is stale`);
}

function updatedPatchHeader(patch: ParsedPatch, cause: string, pin: string): string {
	let causeFields = 0;
	let pinFields = 0;
	const lines = patch.header.lines.map((line) => {
		if (line.startsWith('# cause:')) {
			causeFields += 1;
			return `# cause: ${cause}`;
		}
		if (line.startsWith('# pin:')) {
			pinFields += 1;
			return `# pin: ${pin}`;
		}
		return line;
	});
	if (causeFields !== 1 || pinFields !== 1) throw broken('parsed patch header lost its unique cause or pin field');
	return `${lines.join('\n')}\n`;
}

function assertPin(actual: string, expected: string, path: string): void {
	if (actual !== expected) throw broken(`${path}: metadata pin ${actual} does not match cycle source ${expected}`);
}

function assertTransitionPin(actual: string, source: string, target: string, path: string): void {
	if (actual !== source && actual !== target) throw broken(`${path}: metadata pin ${actual} matches neither cycle source nor target`);
}

function files(root: string, directory: string, suffix: string, override: ReadonlyMap<string, RegenerationBasis>): readonly string[] {
	const resolved = resolveContainedPath(root, directory, { allowMissing: true });
	if (!resolved.ok) throw broken(`${directory}: unsafe inventory directory: ${resolved.reason}`);
	const recovered = [...override.keys()].filter((path) => path.startsWith(`${directory}/`) && path.endsWith(suffix));
	let live: string[] = [];
	let stat;
	try {
		stat = lstatSync(resolved.absolute);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return [...new Set(recovered)].sort(compareText);
		throw broken(`${directory}: cannot inspect inventory directory: ${messageOf(error)}`);
	}
	if (!stat.isDirectory()) throw broken(`${directory}: inventory path is not a real directory`);
	try {
		live = readdirSync(resolved.absolute)
			.filter((name) => name.endsWith(suffix))
			.map((name) => `${directory}/${name}`);
	} catch (error) {
		throw broken(`${directory}: cannot read inventory directory: ${messageOf(error)}`);
	}
	return [...new Set([...live, ...recovered])].sort(compareText);
}

function snapshot(root: string, path: string, override: ReadonlyMap<string, RegenerationBasis>): Snapshot {
	const recovered = override.get(path);
	if (recovered !== undefined) return { path, bytes: fromBase64(recovered.before), mode: recovered.mode };
	const state = readFileState(root, path);
	if (state === null) throw broken(`${path}: required artifact disappeared`);
	return { path, ...state };
}

function optionalSnapshot(root: string, path: string, override: ReadonlyMap<string, RegenerationBasis>): Snapshot | null {
	const recovered = override.get(path);
	if (recovered !== undefined) return { path, bytes: fromBase64(recovered.before), mode: recovered.mode };
	const state = readFileState(root, path);
	return state === null ? null : { path, ...state };
}

function parseJson(snapshot: Snapshot): unknown {
	const text = decodeUtf8Strict(snapshot.bytes);
	if (text === null || !text.endsWith('\n') || text.includes('\r')) throw broken(`${snapshot.path}: metadata is not canonical LF UTF-8`);
	try {
		return JSON.parse(text);
	} catch (error) {
		throw broken(`${snapshot.path}: invalid JSON: ${messageOf(error)}`);
	}
}

function assertCanonicalJson(snapshot: Snapshot, canonical: string): void {
	if (!bytesEqual(snapshot.bytes, encodeUtf8(canonical))) throw broken(`${snapshot.path}: metadata bytes are not canonical JSON`);
}

function authorityDigest(options: CycleRegenerationOptions): string {
	return digest({
		sourcePin: options.state.sourcePin,
		targetPin: options.state.targetPin,
		classifications: options.classifications.map((item) => ({
			kind: item.kind,
			artifactPath: item.artifactPath,
			artifactId: item.artifactId,
			targetPath: item.targetPath,
			outcome: item.outcome,
			bytes: 'bytes' in item && item.bytes !== null ? hash(item.bytes) : null,
			materials:
				'materials' in item && item.materials !== null
					? {
							base: hash(item.materials.base),
							baseExists: item.materials.baseExists,
							ours: hash(item.materials.ours),
							oursExists: item.materials.oursExists,
							theirs: hash(item.materials.theirs)
						}
					: null
		})),
		causes: options.causes
	});
}

function requiredAfter(value: FileState | null): FileState {
	if (value === null) throw broken('write operation lost its output bytes');
	return value;
}
function requiredDesired(values: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
	const value = values.get(path);
	if (value === undefined) throw broken(`${path}: desired bytes disappeared`);
	return value;
}
function pinValue(pin: CycleState['sourcePin']): string {
	return `${pin.tag}@${pin.sha}`;
}
function causeKey(path: string, id: string): string {
	return `${path}\0${id}`;
}
function ordered(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || compareText(values[index - 1] ?? '', value) <= 0);
}
function byPath<T extends { readonly path: string }>(left: T, right: T): number {
	return compareText(left.path, right.path);
}
function actionOrder(left: CycleRegenerationAction, right: CycleRegenerationAction): number {
	return compareText(causeKey(left.artifactPath, left.artifactId), causeKey(right.artifactPath, right.artifactId));
}
function compareText(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}
function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function broken(message: string): Error {
	return ckError('ARTIFACT-BROKEN', `cannot regenerate cycle: ${message}`, 'repair cycle inputs or resume the durable transaction');
}
