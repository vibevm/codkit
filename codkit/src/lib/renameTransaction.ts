/** @scope spec://codkit/modules/codkit/PROP-008#renames */

import { chmodSync, constants, copyFileSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import { decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import {
	canonicalBase64,
	captureFileState,
	compareText,
	containedRenamePath as contained,
	countOccurrences,
	fromBase64,
	modeBindings,
	matchesUnmodedTempState,
	portableMode,
	portableModeOptional,
	readCanonical,
	readOptionalBytes as readOptional,
	removeRequired,
	sameFileState as sameFile,
	sha256 as hash,
	toBase64,
	writeControlExclusive,
	type FileState,
	type PathModeBinding
} from './renameFileState.ts';
import { planPatchArtifactRename } from './renames.ts';
import type { PatchRenameOperation, PatchRenamePlan, RenameReferenceArea } from './renames.ts';

export const RENAME_TRANSACTION_VERSION = 1;
export const RENAME_TRANSACTION_PATH = '.codkit/rename-transaction.json';
export const RENAME_COMPLETIONS_DIR = '.codkit/rename-completions';

export type ReplacementBinding = {
	readonly planIndex: number;
	readonly operationIndex: number;
	readonly preimageSha256: string;
	readonly expectedOccurrences: number;
};
export type { PathModeBinding } from './renameFileState.ts';
export type BoundRenameBatch = {
	readonly plans: readonly PatchRenamePlan[];
	readonly bindings: readonly ReplacementBinding[];
	readonly modes: readonly PathModeBinding[];
};
export type RenameTransactionRuntime = {
	readonly afterTemporaryBytesWrite?: (operation: number) => void;
	readonly afterTemporaryWrite?: (operation: number) => void;
	readonly beforeMoveCreate?: (operation: number) => void;
	readonly afterMoveCreate?: (operation: number) => void;
	readonly afterOperation?: (completedOperations: number) => void;
};
export type BoundRenameResult = {
	readonly completed: true;
	readonly operations: number;
	readonly resumed: boolean;
	readonly repeated: boolean;
};

type ReplaceStep = {
	readonly kind: 'replace';
	readonly path: string;
	readonly from: string;
	readonly expectedOccurrences: number;
	readonly before: string;
	readonly after: string;
	readonly mode: number;
	readonly temp: string;
};
type MoveStep = { readonly kind: 'move'; readonly from: string; readonly to: string; readonly bytes: string; readonly mode: number };
type Step = ReplaceStep | MoveStep;
type Transaction = {
	readonly codkitRenameTransaction: 1;
	readonly planDigest: string;
	readonly plans: readonly PatchRenamePlan[];
	readonly bindings: readonly ReplacementBinding[];
	readonly initial: readonly FileState[];
};
type Completion = {
	readonly codkitRenameCompletion: 1;
	readonly planDigest: string;
	readonly final: readonly { readonly path: string; readonly sha256: string | null; readonly mode: number | null }[];
};
type Model = {
	readonly bindings: readonly ReplacementBinding[];
	readonly steps: readonly Step[];
	readonly final: ReadonlyMap<string, string | null>;
	readonly finalModes: ReadonlyMap<string, number | null>;
};

const portablePath = z.string().refine((value) => repoRelativePathProblem(value) === null, 'must be a portable repository-relative path');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const base64 = z.string().refine(canonicalBase64, 'must be canonical base64');
const mode = z.number().int().min(0).max(0o777);
const bindingSchema = z
	.object({
		planIndex: z.number().int().nonnegative(),
		operationIndex: z.number().int().nonnegative(),
		preimageSha256: sha256,
		expectedOccurrences: z.number().int().positive()
	})
	.strict();
const stateSchema = z.object({ path: portablePath, bytes: base64.nullable(), mode: mode.nullable() }).strict();
const transactionSchema = z
	.object({
		codkitRenameTransaction: z.literal(RENAME_TRANSACTION_VERSION),
		planDigest: sha256,
		plans: z.array(z.unknown()),
		bindings: z.array(bindingSchema),
		initial: z.array(stateSchema)
	})
	.strict();
const completionSchema = z
	.object({
		codkitRenameCompletion: z.literal(1),
		planDigest: sha256,
		final: z.array(z.object({ path: portablePath, sha256: sha256.nullable(), mode: mode.nullable() }).strict())
	})
	.strict();

export function bindRenamePlans(
	root: string,
	plans: readonly PatchRenamePlan[]
): { readonly bindings: readonly ReplacementBinding[]; readonly modes: readonly PathModeBinding[] } {
	validatePlanShape(plans);
	const initial = captureInitial(root, plans);
	return { bindings: deriveModel(plans, initial, '0'.repeat(64)).bindings, modes: modeBindings(initial) };
}

export function applyBoundRenameBatch(root: string, batch: BoundRenameBatch, runtime: RenameTransactionRuntime): BoundRenameResult {
	validatePlanShape(batch.plans);
	validateBindingsShape(batch.plans, batch.bindings);
	const digest = planDigest(batch);
	const transaction = readTransaction(root);
	if (transaction !== null) {
		assertExpected(transaction, batch, digest);
		return run(root, transaction, runtime, true);
	}
	const receipt = readCompletion(root, digest);
	if (receipt !== null) {
		validateCompletion(root, receipt, batch);
		return { completed: true, operations: orderedOperations(batch.plans).length, resumed: false, repeated: true };
	}
	const initial = captureInitial(root, batch.plans);
	const model = deriveModel(batch.plans, initial, digest);
	if (
		JSON.stringify(model.bindings) !== JSON.stringify(batch.bindings) ||
		JSON.stringify(modeBindings(initial)) !== JSON.stringify(batch.modes)
	) {
		throw broken('replacement preimage hash/count or portable file mode changed since planning');
	}
	const created: Transaction = {
		codkitRenameTransaction: RENAME_TRANSACTION_VERSION,
		planDigest: digest,
		plans: batch.plans,
		bindings: batch.bindings,
		initial
	};
	writeControlExclusive(root, RENAME_TRANSACTION_PATH, serialize(created));
	return run(root, created, runtime, false);
}

export function resumeBoundRenameBatch(root: string, expected: BoundRenameBatch, runtime: RenameTransactionRuntime): BoundRenameResult {
	validatePlanShape(expected.plans);
	validateBindingsShape(expected.plans, expected.bindings);
	const transaction = readTransaction(root);
	if (transaction === null) throw transactionError('does not exist; there is no interrupted rename to resume');
	assertExpected(transaction, expected, planDigest(expected));
	return run(root, transaction, runtime, true);
}

function run(root: string, transaction: Transaction, runtime: RenameTransactionRuntime, resumed: boolean): BoundRenameResult {
	const model = validateTransaction(root, transaction);
	for (;;) {
		const progress = recognize(root, transaction.initial, model.steps);
		if (progress.kind === 'complete') {
			const completion = completionOf(transaction.planDigest, model.final, model.finalModes);
			writeOrValidateCompletion(root, completion, transaction);
			removeRequired(root, RENAME_TRANSACTION_PATH);
			return { completed: true, operations: model.steps.length, resumed, repeated: false };
		}
		const step = model.steps[progress.index];
		if (step === undefined) throw transactionError('has impossible progress');
		try {
			if (step.kind === 'replace') {
				if (progress.kind === 'partial-move') throw transactionError('has a move partial state at a replacement step');
				applyReplace(root, step, progress.kind, progress.index, runtime);
			} else {
				if (progress.kind === 'partial-temp' || progress.kind === 'partial-temp-mode') {
					throw transactionError('has a temp partial state at a move step');
				}
				applyMove(root, step, progress.kind, progress.index, runtime);
			}
		} catch (error) {
			throw transactionError(`operation ${progress.index + 1} failed and remains resumable: ${messageOf(error)}`);
		}
		runtime.afterOperation?.(progress.index + 1);
	}
}

function applyReplace(
	root: string,
	step: ReplaceStep,
	progress: 'snapshot' | 'partial-temp' | 'partial-temp-mode',
	index: number,
	runtime: RenameTransactionRuntime
): void {
	const target = contained(root, step.path, false);
	const temp = contained(root, step.temp, true);
	if (progress === 'snapshot') {
		assertReplacementPreimage(readFileSync(target), portableMode(target), step);
		writeFileSync(temp, fromBase64(step.after), { flag: 'wx' });
		runtime.afterTemporaryBytesWrite?.(index + 1);
	}
	if (progress === 'snapshot' || progress === 'partial-temp-mode') {
		chmodSync(temp, step.mode);
		runtime.afterTemporaryWrite?.(index + 1);
	}
	assertReplacementPreimage(readFileSync(target), portableMode(target), step);
	if (!sameFile(root, step.temp, step.after, step.mode)) throw broken(`replacement temp changed: ${step.temp}`);
	renameSync(temp, target);
}

function applyMove(
	root: string,
	step: MoveStep,
	progress: 'snapshot' | 'partial-move',
	index: number,
	runtime: RenameTransactionRuntime
): void {
	const source = contained(root, step.from, false);
	const destination = contained(root, step.to, true);
	if (progress === 'snapshot') {
		if (!sameFile(root, step.from, step.bytes, step.mode)) throw broken(`move source changed: ${step.from}`);
		runtime.beforeMoveCreate?.(index + 1);
		createExclusive(source, destination, step.mode);
		if (!sameFile(root, step.to, step.bytes, step.mode)) throw broken(`exclusive move copy changed: ${step.to}`);
		runtime.afterMoveCreate?.(index + 1);
	}
	if (!sameFile(root, step.from, step.bytes, step.mode) || !sameFile(root, step.to, step.bytes, step.mode)) {
		throw broken(`two-name move state changed: ${step.from} -> ${step.to}`);
	}
	unlinkSync(source);
}

function createExclusive(source: string, destination: string, modeValue: number): void {
	try {
		linkSync(source, destination);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error;
		copyFileSync(source, destination, constants.COPYFILE_EXCL);
		chmodSync(destination, modeValue);
	}
}

function validateTransaction(root: string, transaction: Transaction): Model {
	validatePlanShape(transaction.plans);
	validateBindingsShape(transaction.plans, transaction.bindings);
	if (transaction.planDigest !== transactionDigest(transaction))
		throw transactionError('plan digest does not match canonical plans, bindings and modes');
	validateInitial(transaction.initial, transaction.plans);
	const model = deriveModel(transaction.plans, transaction.initial, transaction.planDigest);
	if (JSON.stringify(model.bindings) !== JSON.stringify(transaction.bindings)) {
		throw transactionError('bindings do not derive from canonical plans and initial snapshots');
	}
	for (const entry of transaction.initial) contained(root, entry.path, true);
	for (const step of model.steps) if (step.kind === 'replace') contained(root, step.temp, true);
	return model;
}

function assertExpected(transaction: Transaction, expected: BoundRenameBatch, digest: string): void {
	if (
		transaction.planDigest !== digest ||
		JSON.stringify(transaction.plans) !== JSON.stringify(expected.plans) ||
		JSON.stringify(transaction.bindings) !== JSON.stringify(expected.bindings) ||
		JSON.stringify(modeBindings(transaction.initial)) !== JSON.stringify(expected.modes)
	)
		throw transactionError('does not describe the independently expected rename batch');
}

function captureInitial(root: string, plans: readonly PatchRenamePlan[]): readonly FileState[] {
	const initial = [...operationPaths(plans)].sort().map((path) => captureFileState(root, path));
	for (const plan of plans) {
		if (initial.find((entry) => entry.path === plan.newArtifactPath)?.bytes !== null) {
			throw broken(`rename destination already exists: ${plan.newArtifactPath}`);
		}
	}
	return initial;
}

function deriveModel(plans: readonly PatchRenamePlan[], initial: readonly FileState[], digest: string): Model {
	const state = new Map(initial.map((entry) => [entry.path, entry.bytes]));
	const modes = new Map(initial.map((entry) => [entry.path, entry.mode]));
	const bindings: ReplacementBinding[] = [];
	const steps: Step[] = [];
	for (const indexed of orderedOperations(plans)) {
		const operation = indexed.operation;
		if (operation.kind === 'replace') {
			const before = state.get(operation.file);
			const beforeMode = modes.get(operation.file);
			if (before === undefined || before === null || beforeMode === undefined || beforeMode === null) {
				throw broken(`replacement source does not exist: ${operation.file}`);
			}
			const bytes = fromBase64(before);
			const text = decodeUtf8Strict(bytes);
			if (text === null) throw ckError('ENCODING', 'rename replacement source is not valid UTF-8', 'repair it', operation.file);
			const occurrences = countOccurrences(text, operation.from);
			if (occurrences === 0 || (operation.area === 'patch-header' && occurrences !== 1)) {
				throw broken(`${operation.area} replacement in ${operation.file} has unexpected occurrence count ${occurrences}`);
			}
			bindings.push({
				planIndex: indexed.planIndex,
				operationIndex: indexed.operationIndex,
				preimageSha256: hash(bytes),
				expectedOccurrences: occurrences
			});
			const after = toBase64(encodeUtf8(text.split(operation.from).join(operation.to)));
			const temp = posix.join(
				posix.dirname(operation.file),
				`.${posix.basename(operation.file)}.rename-${digest.slice(0, 16)}-${steps.length}.tmp`
			);
			if (state.has(temp) || isControlPath(temp)) throw broken(`derived rename temp collides with an input: ${temp}`);
			steps.push({
				kind: 'replace',
				path: operation.file,
				from: operation.from,
				expectedOccurrences: occurrences,
				before,
				after,
				mode: beforeMode,
				temp
			});
			state.set(operation.file, after);
		} else {
			const bytes = state.get(operation.from);
			const sourceMode = modes.get(operation.from);
			if (bytes === undefined || bytes === null || sourceMode === undefined || sourceMode === null) {
				throw broken(`patch move source does not exist: ${operation.from}`);
			}
			if (state.get(operation.to) !== null) throw broken(`patch move destination already exists: ${operation.to}`);
			steps.push({ kind: 'move', from: operation.from, to: operation.to, bytes, mode: sourceMode });
			state.set(operation.from, null);
			state.set(operation.to, bytes);
			modes.set(operation.from, null);
			modes.set(operation.to, sourceMode);
		}
	}
	return { bindings, steps, final: state, finalModes: modes };
}

type IndexedOperation = { readonly planIndex: number; readonly operationIndex: number; readonly operation: PatchRenameOperation };

function orderedOperations(plans: readonly PatchRenamePlan[]): readonly IndexedOperation[] {
	const indexed = plans.flatMap((plan, planIndex) =>
		plan.operations.map((operation, operationIndex) => ({ planIndex, operationIndex, operation }))
	);
	return [...indexed.filter((entry) => entry.operation.kind === 'replace'), ...indexed.filter((entry) => entry.operation.kind === 'move')];
}

function validatePlanShape(plans: readonly PatchRenamePlan[]): void {
	const sources = new Set<string>();
	const destinations = new Set<string>();
	for (const plan of plans) {
		const references = plan.operations.filter(
			(operation): operation is Extract<PatchRenameOperation, { readonly kind: 'replace' }> & { readonly area: RenameReferenceArea } =>
				operation.kind === 'replace' && operation.area !== 'patch-header'
		);
		const rebuilt = planPatchArtifactRename({
			rename: { from: plan.fromTarget, to: plan.toTarget, similarity: plan.similarity, needsReview: plan.needsReview },
			referenceReplacements: references
		});
		if (JSON.stringify(rebuilt) !== JSON.stringify(plan)) throw broken(`rename plan has a non-canonical shape for ${plan.fromTarget}`);
		if (sources.has(plan.oldArtifactPath) || destinations.has(plan.newArtifactPath)) throw broken('rename batch has duplicate patch move');
		sources.add(plan.oldArtifactPath);
		destinations.add(plan.newArtifactPath);
	}
	for (const path of sources) if (destinations.has(path)) throw broken(`chained patch moves are not allowed: ${path}`);
	for (const path of operationPaths(plans)) if (isControlPath(path)) throw broken(`rename plan addresses control path: ${path}`);
}

function validateBindingsShape(plans: readonly PatchRenamePlan[], bindings: readonly ReplacementBinding[]): void {
	const replacements = orderedOperations(plans).filter((entry) => entry.operation.kind === 'replace');
	if (bindings.length !== replacements.length) throw broken('rename batch does not bind every replacement exactly once');
	for (let index = 0; index < replacements.length; index += 1) {
		const expected = replacements[index];
		const binding = bindings[index];
		if (
			expected === undefined ||
			binding === undefined ||
			binding.planIndex !== expected.planIndex ||
			binding.operationIndex !== expected.operationIndex ||
			!/^[0-9a-f]{64}$/.test(binding.preimageSha256) ||
			!Number.isInteger(binding.expectedOccurrences) ||
			binding.expectedOccurrences < 1
		)
			throw broken('replacement bindings are not canonical or complete');
	}
}

function validateInitial(initial: readonly FileState[], plans: readonly PatchRenamePlan[]): void {
	const expected = [...operationPaths(plans)].sort();
	if (JSON.stringify(initial.map((entry) => entry.path)) !== JSON.stringify(expected)) {
		throw transactionError('initial snapshots do not exactly cover canonical operation paths');
	}
	for (const entry of initial) {
		if (
			isControlPath(entry.path) ||
			(entry.bytes !== null && !canonicalBase64(entry.bytes)) ||
			(entry.bytes === null) !== (entry.mode === null) ||
			(entry.mode !== null && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777))
		) {
			throw transactionError(`has invalid initial snapshot ${entry.path}`);
		}
	}
}

function operationPaths(plans: readonly PatchRenamePlan[]): ReadonlySet<string> {
	const paths = new Set<string>();
	for (const { operation } of orderedOperations(plans)) {
		if (operation.kind === 'replace') paths.add(operation.file);
		else {
			paths.add(operation.from);
			paths.add(operation.to);
		}
	}
	return paths;
}

type Progress =
	| { readonly kind: 'snapshot' | 'partial-temp' | 'partial-temp-mode' | 'partial-move'; readonly index: number }
	| { readonly kind: 'complete' };

function recognize(root: string, initial: readonly FileState[], steps: readonly Step[]): Progress {
	const expected = new Map(initial.map((entry) => [entry.path, entry.bytes]));
	const modes = new Map(initial.map((entry) => [entry.path, entry.mode]));
	const temps = steps.filter((step): step is ReplaceStep => step.kind === 'replace').map((step) => step.temp);
	const matches: Progress[] = [];
	for (let index = 0; index <= steps.length; index += 1) {
		if (matchesState(root, expected, modes, temps, null)) {
			matches.push(index === steps.length ? { kind: 'complete' } : { kind: 'snapshot', index });
		}
		const step = steps[index];
		if (step === undefined) break;
		if (step.kind === 'replace') {
			if (matchesState(root, expected, modes, temps, { path: step.temp, bytes: step.after, mode: step.mode })) {
				matches.push({ kind: 'partial-temp', index });
			} else if (matchesUnmodedTempState(root, expected, modes, temps, step.temp, step.after, step.mode)) {
				matches.push({ kind: 'partial-temp-mode', index });
			}
			expected.set(step.path, step.after);
		} else {
			if (matchesState(root, new Map([...expected, [step.to, step.bytes]]), new Map([...modes, [step.to, step.mode]]), temps, null)) {
				matches.push({ kind: 'partial-move', index });
			}
			expected.set(step.from, null);
			expected.set(step.to, step.bytes);
			modes.set(step.from, null);
			modes.set(step.to, step.mode);
		}
	}
	if (matches.length !== 1) {
		throw transactionError(
			matches.length === 0 ? 'filesystem is not an exact recognized partial state' : 'filesystem matches multiple states'
		);
	}
	return matches[0] ?? { kind: 'complete' };
}

function matchesState(
	root: string,
	expected: ReadonlyMap<string, string | null>,
	modes: ReadonlyMap<string, number | null>,
	temps: readonly string[],
	partialTemp: { readonly path: string; readonly bytes: string; readonly mode: number } | null
): boolean {
	for (const [path, bytes] of expected) if (!sameFile(root, path, bytes, modes.get(path) ?? null)) return false;
	for (const temp of temps) {
		if (
			!sameFile(root, temp, partialTemp?.path === temp ? partialTemp.bytes : null, partialTemp?.path === temp ? partialTemp.mode : null)
		) {
			return false;
		}
	}
	return true;
}

function assertReplacementPreimage(bytes: Uint8Array, modeValue: number, step: ReplaceStep): void {
	const text = decodeUtf8Strict(bytes);
	if (
		hash(bytes) !== hash(fromBase64(step.before)) ||
		modeValue !== step.mode ||
		text === null ||
		countOccurrences(text, step.from) !== step.expectedOccurrences
	) {
		throw broken(`replacement preimage hash/count/mode changed immediately before atomic replace: ${step.path}`);
	}
}

function completionOf(
	planDigestValue: string,
	final: ReadonlyMap<string, string | null>,
	finalModes: ReadonlyMap<string, number | null>
): Completion {
	return {
		codkitRenameCompletion: 1,
		planDigest: planDigestValue,
		final: [...final]
			.sort(([left], [right]) => compareText(left, right))
			.map(([path, bytes]) => ({ path, sha256: bytes === null ? null : hash(fromBase64(bytes)), mode: finalModes.get(path) ?? null }))
	};
}

function writeOrValidateCompletion(root: string, completion: Completion, transaction: Transaction): void {
	const path = completionPath(completion.planDigest);
	const existing = readCompletion(root, completion.planDigest);
	if (existing === null) writeControlExclusive(root, path, serialize(completion));
	else if (JSON.stringify(existing) !== JSON.stringify(completion))
		throw transactionError('completion receipt conflicts with derived final hashes');
	validateCompletion(root, completion, {
		plans: transaction.plans,
		bindings: transaction.bindings,
		modes: modeBindings(transaction.initial)
	});
}

function validateCompletion(root: string, completion: Completion, batch: BoundRenameBatch): void {
	if (completion.planDigest !== planDigest(batch)) throw completionError('digest does not match requested canonical plan');
	const expectedPaths = [...operationPaths(batch.plans)].sort();
	if (JSON.stringify(completion.final.map((entry) => entry.path)) !== JSON.stringify(expectedPaths)) {
		throw completionError('does not cover exact plan paths');
	}
	for (const entry of completion.final) {
		const actual = readOptional(root, entry.path);
		if ((actual === null ? null : hash(actual)) !== entry.sha256) throw completionError(`final hash mismatch at ${entry.path}`);
		if (portableModeOptional(root, entry.path) !== entry.mode) throw completionError(`final mode mismatch at ${entry.path}`);
	}
	for (const plan of batch.plans) {
		if (completion.final.find((entry) => entry.path === plan.oldArtifactPath)?.sha256 !== null) {
			throw completionError(`move source still exists: ${plan.oldArtifactPath}`);
		}
		if (completion.final.find((entry) => entry.path === plan.newArtifactPath)?.sha256 === null) {
			throw completionError(`move destination is absent: ${plan.newArtifactPath}`);
		}
	}
}

function readTransaction(root: string): Transaction | null {
	const parsed = readCanonical(root, RENAME_TRANSACTION_PATH, transactionSchema);
	return parsed === null ? null : { ...parsed, plans: parsed.plans as PatchRenamePlan[] };
}

function readCompletion(root: string, digest: string): Completion | null {
	return readCanonical(root, completionPath(digest), completionSchema);
}

function planDigest(batch: BoundRenameBatch): string {
	return hash(encodeUtf8(JSON.stringify({ plans: batch.plans, bindings: batch.bindings, modes: batch.modes })));
}
function transactionDigest(transaction: Transaction): string {
	return planDigest({ plans: transaction.plans, bindings: transaction.bindings, modes: modeBindings(transaction.initial) });
}
function completionPath(digest: string): string {
	return `${RENAME_COMPLETIONS_DIR}/${digest}.json`;
}
function isControlPath(path: string): boolean {
	return path === '.codkit' || path.startsWith('.codkit/');
}
function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
function broken(reason: string): Error {
	return ckError('ARTIFACT-BROKEN', `cannot apply patch rename: ${reason}`, 'repair the exact checked rename batch before retrying');
}
function transactionError(reason: string): Error {
	return ckError(
		'ARTIFACT-BROKEN',
		`rename transaction ${reason}`,
		`inspect ${RENAME_TRANSACTION_PATH}; never edit it`,
		RENAME_TRANSACTION_PATH
	);
}
function completionError(reason: string): Error {
	return ckError(
		'ARTIFACT-BROKEN',
		`rename completion receipt ${reason}`,
		'restore the recorded final bytes or remove the inspected stale receipt'
	);
}
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
