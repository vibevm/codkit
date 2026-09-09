/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { createHash } from 'node:crypto';
import { downChannel, loadBuildWatch } from './buildWrap.ts';
import type { CiResult } from './ciEngine.ts';
import { runCi } from './ciEngine.ts';
import type { CodkitConfig } from './configFile.ts';
import { dependencyAdvisoryAcknowledgement, inspectDependencyAdvisory, type DependencyAdvisoryReport } from './cycleAdvisory.ts';
import { captureCycleLiveSnapshot, type CycleLiveSnapshot } from './cycleStabilizeEvidence.ts';
import { stabilizeDocumentSchema } from './cycleStabilizeReport.ts';
import { cycleStateSchema, type CycleArtifactOutcome, type CycleState } from './cycleState.ts';
import { treeId } from './fingerprint.ts';
import type { InventoryEntry } from './inventory.ts';
import { Output } from './jsonOut.ts';
import { assertOwnedLockHandle, lockPath, readLock, type LockHandle, type LockInfo } from './lock.ts';
import { ckError, isCkError, type CkErrorPayload } from './messages.ts';
import type { ForkDirResolution } from './paths.ts';
import type { VerifyResult } from './verifyEngine.ts';
import { runVerify } from './verifyEngine.ts';
import type { ProjectType } from '@codkit/type-api';

const CYCLE_LOCK_ID = 'cycle-global';
const REPORT_VERSION = 1;
export const DEPENDENCY_ADVISORY_REPORT_PATH = 'cycle/report/deps-advisory.json';
export const STABILIZE_REPORT_PATH = 'cycle/report/stabilize.json';
export type CycleStabilizeLocks = { readonly cycle: LockHandle; readonly tree: LockHandle };
export type CycleReportWrite = {
	readonly path: string;
	readonly previous: string | null;
	readonly contents: string;
};
export type StabilizeExecution = {
	readonly verify: VerifyResult | null;
	readonly verifyExitCode: number | null;
	readonly build: CiResult | null;
	readonly log: readonly string[];
	readonly errors: readonly StabilizeError[];
	readonly cleanupErrors: readonly StabilizeError[];
	readonly runnerFailure: string | null;
};
export type StabilizeError = {
	readonly code: string;
	readonly message: string;
	readonly hint?: string;
	readonly file?: string;
	readonly line?: number;
};
export type StabilizeHeavyRunner = (options: StabilizeHeavyRunnerOptions) => Promise<StabilizeExecution>;
export type StabilizeHeavyRunnerOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	/** The project type of the patch set; the engines below are handed it. */
	readonly type: ProjectType;
};
export type CycleStabilizeCheckpoint =
	'advisory-inspected' | 'advisory-planned' | 'stabilize-started' | 'stabilize-run-finished' | 'stabilize-planned';
export type ContinueCycleStabilizationOptions = StabilizeHeavyRunnerOptions & {
	readonly state: CycleState;
	readonly locks: CycleStabilizeLocks;
	readonly ci: boolean;
	readonly updatedAt: string;
	readonly acknowledgement?: string | null;
	readonly existingAdvisoryReport?: string | null;
	readonly existingStabilizeReport?: string | null;
	readonly runner?: StabilizeHeavyRunner;
	readonly checkpoint?: (checkpoint: CycleStabilizeCheckpoint) => void;
};
export type ContractFailure = {
	readonly test: string;
	readonly artifacts: readonly string[];
};
export type StabilizeRedItem = {
	readonly kind: 'runner' | 'verify' | 'build' | 'error' | 'cleanup' | 'contract';
	readonly id: string;
	readonly detail: string;
	readonly artifact: string | null;
};
export type ContinueCycleStabilizationResult = {
	readonly exitCode: 0 | 3;
	readonly stopCode: 3 | null;
	readonly nextState: CycleState;
	readonly writes: readonly CycleReportWrite[];
	readonly advisory: DependencyAdvisoryReport | null;
	readonly acknowledgement: string | null;
	readonly execution: StabilizeExecution | null;
	readonly contractFailures: readonly ContractFailure[];
	readonly red: readonly StabilizeRedItem[];
	readonly resumed: boolean;
};
export type AdvisoryAcceptance = 'not-required' | 'pending' | 'interactive' | 'ci';
export type AdvisoryDocument = {
	readonly codkitCycleDependencyAdvisory: 1;
	readonly state: CycleState;
	readonly report: DependencyAdvisoryReport;
	readonly acknowledgement: string | null;
	readonly acceptance: AdvisoryAcceptance;
};
export type StabilizeBasis = {
	readonly state: CycleState;
	readonly updatedAt: string;
	readonly live: CycleLiveSnapshot;
	readonly execution: StabilizeExecution;
	readonly contractFailures: readonly ContractFailure[];
	readonly red: readonly StabilizeRedItem[];
};
export type StabilizeDocument = {
	readonly codkitCycleStabilize: 1;
	readonly basis: StabilizeBasis;
	readonly nextState: CycleState;
	readonly digest: string;
};
export async function continueCycleStabilization(options: ContinueCycleStabilizationOptions): Promise<ContinueCycleStabilizationResult> {
	assertInput(options);
	assertLiveLocks(options);
	if (options.state.phase === 'deps-advisory') return planAdvisory(options);
	return planStabilize(options);
}

async function planAdvisory(options: ContinueCycleStabilizationOptions): Promise<ContinueCycleStabilizationResult> {
	const report = inspectDependencyAdvisory({
		cwd: options.resolution.path,
		oldPin: options.state.sourcePin.sha,
		newPin: options.state.targetPin.sha,
		type: options.type
	});
	options.checkpoint?.('advisory-inspected');
	assertLiveLocks(options);
	const acknowledgement = dependencyAdvisoryAcknowledgement(report);
	const existing = parseAdvisoryDocument(options.existingAdvisoryReport ?? null, report, options.state);
	const alreadyAccepted = existing !== null && existing.acceptance !== 'pending';
	const exactPersistedAcknowledgement =
		existing?.acceptance === 'pending' && acknowledgement !== null && options.acknowledgement === acknowledgement;
	const acceptance: AdvisoryAcceptance =
		acknowledgement === null
			? 'not-required'
			: options.ci
				? 'ci'
				: alreadyAccepted
					? existing.acceptance
					: exactPersistedAcknowledgement
						? 'interactive'
						: 'pending';
	const document: AdvisoryDocument = {
		codkitCycleDependencyAdvisory: REPORT_VERSION,
		state: options.state,
		report,
		acknowledgement,
		acceptance
	};
	const contents = serializeDocument(document);
	const stopped = acceptance === 'pending';
	const nextState = transition(
		options.state,
		stopped ? 'deps-advisory' : 'stabilize',
		stopped ? `acknowledge dependency advisory with ${acknowledgement ?? ''}` : 'run verify, build and contract stabilization gates',
		options.updatedAt
	);
	options.checkpoint?.('advisory-planned');
	return {
		exitCode: stopped ? 3 : 0,
		stopCode: stopped ? 3 : null,
		nextState,
		writes: writeIfChanged(DEPENDENCY_ADVISORY_REPORT_PATH, options.existingAdvisoryReport ?? null, contents),
		advisory: report,
		acknowledgement,
		execution: null,
		contractFailures: [],
		red: [],
		resumed: alreadyAccepted
	};
}

async function planStabilize(options: ContinueCycleStabilizationOptions): Promise<ContinueCycleStabilizationResult> {
	const live = captureCycleLiveSnapshot(options.patchesDir, options.resolution.path, options.state.targetPin.sha);
	const existing = parseStabilizeDocument(options.existingStabilizeReport ?? null, options.state, live);
	if (existing !== null) {
		return stabilizationResult(existing, options.existingStabilizeReport ?? null, true);
	}

	options.checkpoint?.('stabilize-started');
	let execution: StabilizeExecution;
	try {
		execution = await (options.runner ?? runConcreteStabilization)({
			patchesDir: options.patchesDir,
			resolution: options.resolution,
			config: options.config,
			type: options.type
		});
	} catch (error) {
		execution = failedExecution(error);
	}
	const after = captureCycleLiveSnapshot(options.patchesDir, options.resolution.path, options.state.targetPin.sha);
	const expectedForkRef = `refs/heads/${options.config.generatedBranchPrefix}${options.state.targetPin.tag}`;
	const stable =
		options.runner === undefined
			? concreteStabilizationWorldMatches(live, after, expectedForkRef, execution.build?.branchTip ?? null)
			: same(live, after);
	if (!stable) execution = appendRunnerFailure(execution, 'live repository snapshot changed during stabilization');
	options.checkpoint?.('stabilize-run-finished');
	assertLiveLocks(options);
	const inventory = execution.verify?.inventory ?? null;
	const contractFailures = findContractFailures(execution, inventory?.entries ?? []);
	let red = buildRedList(execution, contractFailures);
	if (options.runner === undefined && red.length === 0 && !concreteBranchTipMatches(execution, after)) {
		execution = appendRunnerFailure(execution, 'green stabilization did not produce the exact checked build branch tip');
		red = buildRedList(execution, contractFailures);
	}
	const nextState = stabilizationState(options.state, contractFailures, red, options.updatedAt);
	const basis: StabilizeBasis = {
		state: jsonClone(options.state),
		updatedAt: options.updatedAt,
		live: after,
		execution: jsonClone(execution),
		contractFailures,
		red
	};
	const base = {
		codkitCycleStabilize: 1 as const,
		basis,
		nextState
	};
	const document: StabilizeDocument = { ...base, digest: digest(base) };
	options.checkpoint?.('stabilize-planned');
	return stabilizationResult(document, options.existingStabilizeReport ?? null, false);
}

function stabilizationResult(document: StabilizeDocument, previous: string | null, resumed: boolean): ContinueCycleStabilizationResult {
	const parsed = stabilizeDocumentSchema.safeParse(document);
	if (!parsed.success) throw broken(`cannot plan ${STABILIZE_REPORT_PATH}: ${parsed.error.issues[0]?.message ?? 'schema failure'}`);
	document = parsed.data as StabilizeDocument;
	const stopped = document.basis.red.length > 0;
	return {
		exitCode: stopped ? 3 : 0,
		stopCode: stopped ? 3 : null,
		nextState: document.nextState,
		writes: writeIfChanged(STABILIZE_REPORT_PATH, previous, serializeDocument(document)),
		advisory: null,
		acknowledgement: null,
		execution: document.basis.execution,
		contractFailures: document.basis.contractFailures,
		red: document.basis.red,
		resumed
	};
}

export async function runConcreteStabilization(options: StabilizeHeavyRunnerOptions): Promise<StabilizeExecution> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const out = new Output({
		command: 'cycle stabilize',
		version: 'internal',
		jsonMode: true,
		streams: { writeOut: (chunk) => stdout.push(chunk), writeErr: (chunk) => stderr.push(chunk) }
	});
	let channels: readonly string[] = [];
	let verify: VerifyResult | null = null;
	let build: CiResult | null = null;
	const failures: unknown[] = [];
	const cleanupFailures: unknown[] = [];
	try {
		channels = loadBuildWatch(options.type, options.patchesDir).channels.map((channel) => channel.name);
		verify = runVerify({ ...options, type: options.type });
		build = await runCi({
			...options,
			out,
			profile: 'build',
			effectiveDiffBase: null,
			pinGuardBase: null,
			verbose: false
		});
	} catch (error) {
		failures.push(error);
	} finally {
		for (const channel of channels) {
			try {
				// Bound to the tree this run stabilised: an unbound stop would signal
				// and delete a daemon owned by another fork tree sharing this patch set.
				await downChannel(options.patchesDir, channel, {
					expectedTreeId: treeId(options.resolution.path),
					expectedTreePath: options.resolution.path,
					onWarn: (text) => out.warn(text)
				});
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		out.finish(build?.exitCode ?? 2);
	}
	const envelope = parseEnvelope(stdout.join(''));
	const errors = [...envelope.errors];
	errors.push(...failures.map(errorPayload));
	return {
		verify,
		verifyExitCode: verify === null ? null : verify.findings.length === 0 ? 0 : 1,
		build,
		log: normalizedLines(stderr.join('')),
		errors,
		cleanupErrors: cleanupFailures.map(errorPayload),
		runnerFailure: failures.length === 0 ? null : failures.map((failure) => messageOf(failure)).join('; ')
	};
}

function findContractFailures(execution: StabilizeExecution, entries: readonly InventoryEntry[]): readonly ContractFailure[] {
	if (!execution.build?.steps.some((step) => step.name === 'product tests' && step.state === 'failed')) return [];
	const text = execution.log.join('\n');
	const byTest = new Map<string, string[]>();
	for (const entry of entries) {
		for (const test of entry.contractTests) {
			if (!containsToken(text, test)) continue;
			const artifacts = byTest.get(test) ?? [];
			artifacts.push(entry.artifact);
			byTest.set(test, artifacts);
		}
	}
	return [...byTest.entries()]
		.sort(([left], [right]) => compareText(left, right))
		.map(([test, artifacts]) => ({ test, artifacts: uniqueSorted(artifacts) }));
}

function buildRedList(execution: StabilizeExecution, contracts: readonly ContractFailure[]): readonly StabilizeRedItem[] {
	const red: StabilizeRedItem[] = [];
	if (execution.runnerFailure !== null) red.push(redItem('runner', 'heavy-runner', execution.runnerFailure));
	if (execution.verify === null) red.push(redItem('verify', 'missing', 'verify result is missing'));
	if (execution.verifyExitCode !== 0) red.push(redItem('verify', 'exit', `verify exited ${execution.verifyExitCode ?? 'without a code'}`));
	for (const finding of execution.verify?.findings ?? []) {
		red.push({ kind: 'verify', id: finding.code, detail: finding.message, artifact: finding.file ?? null });
	}
	if (execution.build === null) red.push(redItem('build', 'missing', 'build result is missing'));
	for (const step of execution.build?.steps ?? []) {
		if (step.state === 'failed') red.push(redItem('build', step.name, step.detail));
	}
	if (execution.build !== null) {
		if (execution.build.profile !== 'build')
			red.push(redItem('build', 'profile', `expected build profile, got ${execution.build.profile}`));
		if (execution.build.exitCode !== 0) red.push(redItem('build', 'exit', `build profile exited ${execution.build.exitCode}`));
		for (const required of ['verify', 'compile', 'product tests']) {
			if (!execution.build.steps.some((step) => step.name === required && step.state === 'ok'))
				red.push(redItem('build', required, `required ${required} step was not observed green`));
		}
	}
	for (const error of execution.errors) red.push({ kind: 'error', id: error.code, detail: error.message, artifact: error.file ?? null });
	for (const error of execution.cleanupErrors)
		red.push({ kind: 'cleanup', id: error.code, detail: error.message, artifact: error.file ?? null });
	for (const contract of contracts) {
		for (const artifact of contract.artifacts) {
			red.push({ kind: 'contract', id: contract.test, detail: `contract test ${contract.test} failed`, artifact });
		}
	}
	return red;
}

function stabilizationState(
	state: CycleState,
	contracts: readonly ContractFailure[],
	red: readonly StabilizeRedItem[],
	updatedAt: string
): CycleState {
	const failed = new Set(contracts.flatMap((contract) => contract.artifacts));
	const classified = new Set(Object.values(state.artifacts).flat());
	for (const artifact of failed) if (!classified.has(artifact)) throw broken(`contract test names unclassified artifact ${artifact}`);
	const artifacts = {} as Record<CycleArtifactOutcome, string[]>;
	for (const [outcome, paths] of Object.entries(state.artifacts) as [CycleArtifactOutcome, string[]][]) {
		artifacts[outcome] = outcome === 'contract-failed' ? [...paths] : paths.filter((path) => !failed.has(path));
	}
	artifacts['contract-failed'] = uniqueSorted([...artifacts['contract-failed'], ...failed]);
	const phase = red.length === 0 ? 'done' : 'resolve';
	return transition(
		{ ...state, artifacts, resolved: state.resolved.filter((path) => !failed.has(path)) },
		phase,
		phase === 'done' ? 'finalize the completed cycle' : `resolve ${red.length} stabilization failure(s)`,
		updatedAt
	);
}

function transition(state: CycleState, phase: CycleState['phase'], nextAction: string, updatedAt: string): CycleState {
	const candidate = { ...state, phase, nextAction, updatedAt };
	const parsed = cycleStateSchema.safeParse(candidate);
	if (!parsed.success) {
		throw ckError('CONFIG', `invalid cycle transition: ${parsed.error.issues[0]?.message ?? 'schema failure'}`);
	}
	return parsed.data;
}

export function parseAdvisoryDocument(
	document: string | null,
	report: DependencyAdvisoryReport,
	state: CycleState
): AdvisoryDocument | null {
	if (document === null) return null;
	const value = parseCanonicalDocument(document, DEPENDENCY_ADVISORY_REPORT_PATH);
	const expectedAcknowledgement = dependencyAdvisoryAcknowledgement(report);
	const acceptance = String(value['acceptance']);
	if (
		!same(Object.keys(value), ['codkitCycleDependencyAdvisory', 'state', 'report', 'acknowledgement', 'acceptance']) ||
		value['codkitCycleDependencyAdvisory'] !== REPORT_VERSION ||
		!same(value['state'], state) ||
		!same(value['report'], report) ||
		value['acknowledgement'] !== expectedAcknowledgement ||
		!['not-required', 'pending', 'interactive', 'ci'].includes(acceptance) ||
		(expectedAcknowledgement === null ? acceptance !== 'not-required' : acceptance === 'not-required')
	) {
		throw broken(`stale or malformed ${DEPENDENCY_ADVISORY_REPORT_PATH}`);
	}
	return value as unknown as AdvisoryDocument;
}

function parseStabilizeDocument(document: string | null, state: CycleState, live: CycleLiveSnapshot): StabilizeDocument | null {
	if (document === null) return null;
	const report = parseStabilizeAuthority(document, state);
	if (!same(report.basis.live, live)) return null;
	return report;
}

export function parseStabilizeAuthority(document: string, state: CycleState): StabilizeDocument {
	const value = parseCanonicalDocument(document, STABILIZE_REPORT_PATH);
	const parsed = stabilizeDocumentSchema.safeParse(value);
	if (!parsed.success) throw broken(`stale or malformed ${STABILIZE_REPORT_PATH}: ${parsed.error.issues[0]?.message ?? 'schema failure'}`);
	const report = parsed.data as StabilizeDocument;
	const withoutDigest = { ...value };
	delete withoutDigest['digest'];
	if (report.digest !== digest(withoutDigest)) throw broken(`digest mismatch in ${STABILIZE_REPORT_PATH}`);
	if (!same(report.basis.state, state)) throw broken(`input state mismatch in ${STABILIZE_REPORT_PATH}`);
	const inventory = report.basis.execution.verify?.inventory ?? null;
	const contracts = findContractFailures(report.basis.execution, inventory?.entries ?? []);
	if (!same(contracts, report.basis.contractFailures)) throw broken(`contract evidence mismatch in ${STABILIZE_REPORT_PATH}`);
	const red = buildRedList(report.basis.execution, contracts);
	if (!same(red, report.basis.red)) throw broken(`red evidence mismatch in ${STABILIZE_REPORT_PATH}`);
	const nextState = stabilizationState(state, contracts, red, report.basis.updatedAt);
	if (!same(nextState, report.nextState)) throw broken(`next state mismatch in ${STABILIZE_REPORT_PATH}`);
	return report;
}

function concreteBranchTipMatches(execution: StabilizeExecution, live: CycleLiveSnapshot): boolean {
	const tip = execution.build?.branchTip;
	return tip !== null && tip !== undefined && /^[0-9a-f]{40}$/.test(tip) && tip === live.fork.head;
}

function parseCanonicalDocument(document: string, path: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch {
		throw broken(`${path} is not valid JSON`);
	}
	if (!isRecord(value) || serializeDocument(value) !== document) throw broken(`${path} is not canonical JSON`);
	return value;
}

function assertInput(options: ContinueCycleStabilizationOptions): void {
	if (options.state.phase !== 'deps-advisory' && options.state.phase !== 'stabilize') {
		throw broken(`cycle phase must be deps-advisory or stabilize, got ${options.state.phase}`);
	}
	if (options.state.transaction !== null) throw broken(`${options.state.phase} requires transaction null`);
	if (!same(options.config.pin, options.state.targetPin)) throw broken('codkit config pin does not match cycle target pin');
}

function assertLiveLocks(options: ContinueCycleStabilizationOptions): void {
	assertLiveLock(options.locks.cycle, lockPath(options.patchesDir, CYCLE_LOCK_ID), 'cycle');
	assertLiveLock(options.locks.tree, lockPath(options.patchesDir, treeId(options.resolution.path)), 'tree');
}

function assertLiveLock(handle: LockHandle, expectedPath: string, label: string): void {
	assertOwnedLockHandle(handle, `cycle stabilize ${label} lock`);
	if (handle.path !== expectedPath || handle.info.nonce === undefined) throw broken(`${label} lock capability is not for this cycle`);
	const current = readLock(expectedPath);
	if (current === null || !sameLock(current, handle.info)) throw broken(`${label} lock capability is no longer live`);
}

function sameLock(left: LockInfo, right: LockInfo): boolean {
	return left.pid === right.pid && left.startedAt === right.startedAt && left.command === right.command && left.nonce === right.nonce;
}

function failedExecution(error: unknown): StabilizeExecution {
	const payload = errorPayload(error);
	return { verify: null, verifyExitCode: null, build: null, log: [], errors: [payload], cleanupErrors: [], runnerFailure: payload.message };
}

function appendRunnerFailure(execution: StabilizeExecution, message: string): StabilizeExecution {
	return {
		...execution,
		errors: [...execution.errors, { code: 'CK-E-DIRTY-TREE', message }],
		runnerFailure: execution.runnerFailure ?? message
	};
}

function errorPayload(error: unknown): StabilizeError {
	if (isCkError(error)) {
		const payload: CkErrorPayload = error.toPayload();
		return jsonClone({ ...payload, code: `CK-E-${payload.code}` });
	}
	return { code: 'CK-E-INTERNAL', message: messageOf(error) };
}

function parseEnvelope(document: string): { readonly errors: readonly StabilizeError[] } {
	try {
		const value = JSON.parse(document) as { errors?: unknown };
		return { errors: Array.isArray(value.errors) ? (value.errors as StabilizeError[]) : [] };
	} catch {
		return { errors: [{ code: 'CK-E-INTERNAL', message: 'cannot capture stabilization output envelope' }] };
	}
}

function normalizedLines(text: string): readonly string[] {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized === '' ? [] : normalized.split('\n');
}

function containsToken(text: string, token: string): boolean {
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?:$|[^A-Za-z0-9_.-])`, 'm').test(text);
}

function redItem(kind: StabilizeRedItem['kind'], id: string, detail: string): StabilizeRedItem {
	return { kind, id, detail, artifact: null };
}

function writeIfChanged(path: string, previous: string | null, contents: string): readonly CycleReportWrite[] {
	return previous === contents ? [] : [{ path, previous, contents }];
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function serializeDocument(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function concreteStabilizationWorldMatches(
	left: CycleLiveSnapshot,
	right: CycleLiveSnapshot,
	expectedForkRef: string,
	branchTip: string | null
): boolean {
	if (!same(left.patchset, right.patchset)) return false;
	if (branchTip === null || !/^[0-9a-f]{40}$/.test(branchTip)) return same(left.fork, right.fork);
	return (
		right.fork.ref === expectedForkRef &&
		right.fork.dirty === false &&
		right.fork.head === branchTip &&
		left.fork.targetCommit === right.fork.targetCommit &&
		left.fork.targetTree === right.fork.targetTree
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function broken(message: string) {
	return ckError('CONFIG', message, 'restore the durable cycle report or restart the cycle');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
