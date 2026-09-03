/** @scope spec://codkit/modules/codkit/PROP-009#state */
// Durable state for the resumable upgrade-cycle state machine.
//
// The Zod schema is the on-disk SSOT. The library owns strict byte validation,
// repository containment and atomic replacement; the later orchestrator owns
// the common cycle lock that excludes concurrent state/journal writers.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { bytesEqual, CR_BYTE, decodeUtf8Strict, encodeUtf8, LF_BYTE } from './bytes.ts';
import { ckError, isCkError } from './messages.ts';
import { repoRelativePathProblem, resolveContainedPath, safeBasenameProblem } from './pathSafety.ts';

export const CYCLE_STATE_SCHEMA_VERSION = 2;
export const CYCLE_STATE_PATH = 'cycle/state.json';

export const CYCLE_PHASES = ['init', 'apply', 'resolve', 'renames', 'regen', 'deps-advisory', 'stabilize', 'done'] as const;

export const CYCLE_ARTIFACT_OUTCOMES = [
	'clean',
	'shifted',
	'merged',
	'conflict',
	'target-deleted',
	'target-renamed',
	'rule-broken',
	'contract-failed'
] as const;

export const CYCLE_BLOCKER_OUTCOMES = ['conflict', 'target-deleted', 'target-renamed', 'rule-broken', 'contract-failed'] as const;

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const branchSchema = z
	.string()
	.min(1)
	.refine((value) => cycleBranchProblem(value) === null, 'must be one structurally safe Git branch name');
const portablePathSchema = z
	.string()
	.min(1)
	.superRefine((value, context) => {
		const problem = portableRepositoryPathProblem(value);
		if (problem !== null) {
			context.addIssue({ code: 'custom', message: problem });
		}
	});

export const cyclePinSchema = z
	.object({
		tag: z
			.string()
			.min(1)
			.refine((value) => safeBasenameProblem(value) === null, 'must be one portable tag basename'),
		sha: shaSchema,
		date: dateSchema
	})
	.strict();

export const cycleRenameSchema = z
	.object({
		from: portablePathSchema,
		to: portablePathSchema,
		similarity: z.number().int().min(0).max(100)
	})
	.strict();

export const cycleTransactionSchema = z
	.discriminatedUnion('kind', [
		z
			.object({
				kind: z.literal('init'),
				baseCommit: shaSchema,
				baseBranch: branchSchema
			})
			.strict(),
		z
			.object({
				kind: z.literal('restart'),
				baseCommit: shaSchema,
				bumpCommit: shaSchema
			})
			.strict()
	])
	.nullable();

const artifactPathListSchema = z.array(portablePathSchema);

export const cycleArtifactsSchema = z
	.object({
		clean: artifactPathListSchema,
		shifted: artifactPathListSchema,
		merged: artifactPathListSchema,
		conflict: artifactPathListSchema,
		'target-deleted': artifactPathListSchema,
		'target-renamed': artifactPathListSchema,
		'rule-broken': artifactPathListSchema,
		'contract-failed': artifactPathListSchema
	})
	.strict();

export const cycleStateSchema = z
	.object({
		codkitCycleState: z.literal(CYCLE_STATE_SCHEMA_VERSION),
		sourcePin: cyclePinSchema,
		targetPin: cyclePinSchema,
		branch: branchSchema,
		startedAt: timestampSchema,
		updatedAt: timestampSchema,
		phase: z.enum(CYCLE_PHASES),
		nextAction: z.string().min(1),
		transaction: cycleTransactionSchema,
		artifacts: cycleArtifactsSchema,
		resolved: z.array(portablePathSchema),
		renames: z.array(cycleRenameSchema)
	})
	.strict()
	.superRefine((state, context) => {
		if (state.phase === 'init' && state.transaction?.kind !== 'init') {
			addIssue(context, ['transaction'], 'phase init requires an init transaction');
		}
		if (state.transaction?.kind === 'init' && state.phase !== 'init') {
			addIssue(context, ['phase'], 'an init transaction requires phase init');
		}
		if (Date.parse(state.updatedAt) < Date.parse(state.startedAt)) {
			addIssue(context, ['updatedAt'], 'must not precede startedAt');
		}

		const artifactOutcome = new Map<string, CycleArtifactOutcome>();
		for (const outcome of CYCLE_ARTIFACT_OUTCOMES) {
			for (const [index, artifact] of state.artifacts[outcome].entries()) {
				const previous = artifactOutcome.get(artifact);
				if (previous !== undefined) {
					addIssue(context, ['artifacts', outcome, index], `duplicates artifact already classified as ${previous}: ${artifact}`);
				} else {
					artifactOutcome.set(artifact, outcome);
				}
			}
		}

		const blockers = new Set(CYCLE_BLOCKER_OUTCOMES.flatMap((outcome) => state.artifacts[outcome]));
		const resolved = new Set<string>();
		for (const [index, artifact] of state.resolved.entries()) {
			if (resolved.has(artifact)) {
				addIssue(context, ['resolved', index], `duplicates resolved artifact: ${artifact}`);
			}
			resolved.add(artifact);
			if (!blockers.has(artifact)) {
				addIssue(context, ['resolved', index], `is not a blocker artifact: ${artifact}`);
			}
		}

		const renameFrom = new Set<string>();
		const renameTo = new Set<string>();
		for (const [index, rename] of state.renames.entries()) {
			if (rename.from === rename.to) {
				addIssue(context, ['renames', index, 'to'], 'must differ from from');
			}
			if (renameFrom.has(rename.from)) {
				addIssue(context, ['renames', index, 'from'], `duplicates rename source: ${rename.from}`);
			}
			if (renameTo.has(rename.to)) {
				addIssue(context, ['renames', index, 'to'], `duplicates rename destination: ${rename.to}`);
			}
			renameFrom.add(rename.from);
			renameTo.add(rename.to);
		}

		if (phaseRequiresResolvedBlockers(state.phase)) {
			for (const blocker of blockers) {
				if (!resolved.has(blocker)) {
					addIssue(context, ['resolved'], `${state.phase} requires resolved blocker: ${blocker}`);
				}
			}
		}
	});

export type CyclePin = z.infer<typeof cyclePinSchema>;
export type CycleRename = z.infer<typeof cycleRenameSchema>;
export type CycleTransaction = z.infer<typeof cycleTransactionSchema>;
export type CycleArtifacts = z.infer<typeof cycleArtifactsSchema>;
export type CycleState = z.infer<typeof cycleStateSchema>;
export type CyclePhase = (typeof CYCLE_PHASES)[number];
export type CycleArtifactOutcome = (typeof CYCLE_ARTIFACT_OUTCOMES)[number];

/** Injectable byte-level seam for deterministic interrupted-write tests. */
export type CycleStateFileSystem = {
	readonly readBytes: (path: string) => Uint8Array | null;
	readonly makeDirectory: (path: string) => void;
	readonly writeBytes: (path: string, document: Uint8Array) => void;
	readonly rename: (from: string, to: string) => void;
	readonly remove: (path: string) => void;
};

export const nodeCycleStateFileSystem: CycleStateFileSystem = {
	readBytes(path) {
		try {
			return readFileSync(path);
		} catch (error) {
			if (errorCode(error) === 'ENOENT') {
				return null;
			}
			throw error;
		}
	},
	makeDirectory(path) {
		mkdirSync(path, { recursive: true });
	},
	writeBytes(path, document) {
		writeFileSync(path, document, { flag: 'wx' });
	},
	rename(from, to) {
		renameSync(from, to);
	},
	remove(path) {
		try {
			unlinkSync(path);
		} catch (error) {
			if (errorCode(error) !== 'ENOENT') {
				throw error;
			}
		}
	}
};

export type WriteCycleStateOptions = {
	readonly fileSystem?: CycleStateFileSystem;
	readonly temporarySuffix?: () => string;
};

export function cycleStatePath(patchesDir: string): string {
	return containedCycleStatePath(patchesDir);
}

/** Parse strict canonical JSON text with exactly one final LF. */
export function parseCycleState(document: string, file = CYCLE_STATE_PATH): CycleState {
	return parseCycleStateBytes(encodeUtf8(document), file);
}

/** Canonical JSON: schema key order, bytewise-sorted collections, one final LF. */
export function serializeCycleState(state: CycleState): string {
	const parsed = cycleStateSchema.safeParse(state);
	if (!parsed.success) {
		throw stateValidationError(parsed.error, CYCLE_STATE_PATH);
	}
	return `${JSON.stringify(canonicalState(parsed.data), null, 2)}\n`;
}

/** Missing state means no cycle; every existing non-canonical byte is fatal. */
export function readCycleState(patchesDir: string, fileSystem: CycleStateFileSystem = nodeCycleStateFileSystem): CycleState | null {
	const path = containedCycleStatePath(patchesDir);
	let bytes: Uint8Array | null;
	try {
		bytes = fileSystem.readBytes(path);
	} catch (error) {
		throw ckError('CONFIG', `cannot read cycle state: ${messageOf(error)}`, 'make cycle/state.json readable and retry', CYCLE_STATE_PATH);
	}
	return bytes === null ? null : parseCycleStateBytes(bytes, CYCLE_STATE_PATH);
}

/** Atomically replace state. The caller must hold the common cycle lock. */
export function writeCycleState(patchesDir: string, state: CycleState, options: WriteCycleStateOptions = {}): boolean {
	const fileSystem = options.fileSystem ?? nodeCycleStateFileSystem;
	let path = containedCycleStatePath(patchesDir);
	const bytes = encodeUtf8(serializeCycleState(state));
	let existing: Uint8Array | null;
	try {
		existing = fileSystem.readBytes(path);
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot read cycle state before writing it: ${messageOf(error)}`,
			'make cycle/state.json readable and retry',
			CYCLE_STATE_PATH
		);
	}
	if (existing !== null) {
		parseCycleStateBytes(existing, CYCLE_STATE_PATH);
		if (bytesEqual(existing, bytes)) {
			return false;
		}
	}

	try {
		fileSystem.makeDirectory(dirname(path));
		path = containedCycleStatePath(patchesDir);
	} catch (error) {
		if (isCkError(error)) {
			throw error;
		}
		throw ckError(
			'CONFIG',
			`cannot prepare cycle state directory: ${messageOf(error)}`,
			'make cycle/ writable and retry',
			CYCLE_STATE_PATH
		);
	}
	atomicReplace(path, bytes, fileSystem, options.temporarySuffix);
	return true;
}

function parseCycleStateBytes(bytes: Uint8Array, file: string): CycleState {
	const document = strictManagedText(bytes, file);
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch (error) {
		throw ckError('CONFIG', `cycle state is not valid JSON: ${messageOf(error)}`, 'restore or restart the upgrade cycle', file);
	}
	refuseNewerStateVersion(value, file);
	const parsed = cycleStateSchema.safeParse(value);
	if (!parsed.success) {
		throw stateValidationError(parsed.error, file);
	}
	const canonical = `${JSON.stringify(canonicalState(parsed.data), null, 2)}\n`;
	if (document !== canonical) {
		throw ckError('CONFIG', 'cycle state bytes are not canonical JSON', 'rewrite the state through codkit cycle commands', file);
	}
	return parsed.data;
}

function refuseNewerStateVersion(value: unknown, file: string): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return;
	}
	const version = (value as Record<string, unknown>)['codkitCycleState'];
	if (typeof version === 'number' && Number.isInteger(version) && version > CYCLE_STATE_SCHEMA_VERSION) {
		throw ckError(
			'CONFIG',
			`cycle state schema ${version} is newer than supported schema ${CYCLE_STATE_SCHEMA_VERSION}`,
			'update codkit before continuing this cycle',
			file
		);
	}
}

function canonicalState(state: CycleState): CycleState {
	const artifacts: CycleArtifacts = {
		clean: sortedPaths(state.artifacts.clean),
		shifted: sortedPaths(state.artifacts.shifted),
		merged: sortedPaths(state.artifacts.merged),
		conflict: sortedPaths(state.artifacts.conflict),
		'target-deleted': sortedPaths(state.artifacts['target-deleted']),
		'target-renamed': sortedPaths(state.artifacts['target-renamed']),
		'rule-broken': sortedPaths(state.artifacts['rule-broken']),
		'contract-failed': sortedPaths(state.artifacts['contract-failed'])
	};
	const renames = [...state.renames].sort(
		(left, right) => compareUtf8(left.from, right.from) || compareUtf8(left.to, right.to) || left.similarity - right.similarity
	);
	return {
		codkitCycleState: CYCLE_STATE_SCHEMA_VERSION,
		sourcePin: state.sourcePin,
		targetPin: state.targetPin,
		branch: state.branch,
		startedAt: state.startedAt,
		updatedAt: state.updatedAt,
		phase: state.phase,
		nextAction: state.nextAction,
		transaction: state.transaction,
		artifacts,
		resolved: sortedPaths(state.resolved),
		renames
	};
}

function strictManagedText(bytes: Uint8Array, file: string): string {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw ckError('ENCODING', 'cycle state must not have a UTF-8 BOM', 'write UTF-8 without BOM', file, 1);
	}
	const document = decodeUtf8Strict(bytes);
	if (document === null) {
		throw ckError('ENCODING', 'cycle state is not valid UTF-8', 'write UTF-8 without BOM', file);
	}
	const carriageReturn = bytes.indexOf(CR_BYTE);
	if (carriageReturn !== -1) {
		throw ckError('CRLF', 'cycle state contains a carriage return', 'use LF line endings', file, lineAt(bytes, carriageReturn));
	}
	if (bytes.length === 0 || bytes[bytes.length - 1] !== LF_BYTE || (bytes.length > 1 && bytes[bytes.length - 2] === LF_BYTE)) {
		throw ckError('EOF-NEWLINE', 'cycle state must end with exactly one LF', 'remove the missing or excess final newline', file);
	}
	return document;
}

function containedCycleStatePath(patchesDir: string): string {
	const resolved = resolveContainedPath(patchesDir, CYCLE_STATE_PATH, { allowMissing: true });
	if (!resolved.ok) {
		throw ckError(
			'CONFIG',
			`unsafe cycle state path: ${resolved.reason}`,
			'replace symlink components with real directories inside the repository',
			CYCLE_STATE_PATH
		);
	}
	return resolved.absolute;
}

function atomicReplace(path: string, bytes: Uint8Array, fileSystem: CycleStateFileSystem, suffixFactory: (() => string) | undefined): void {
	const suffix = (suffixFactory ?? randomUUID)();
	if (suffix === '' || suffix.includes('/') || suffix.includes('\\')) {
		throw ckError('INTERNAL', 'cycle state temporary suffix must be a non-empty file-name segment');
	}
	const temporaryPath = `${path}.${suffix}.tmp`;
	let renamed = false;
	try {
		fileSystem.writeBytes(temporaryPath, bytes);
		fileSystem.rename(temporaryPath, path);
		renamed = true;
	} catch (error) {
		if (isCkError(error)) {
			throw error;
		}
		throw ckError('CONFIG', `cannot atomically write cycle state: ${messageOf(error)}`, 'make cycle/ writable and retry', CYCLE_STATE_PATH);
	} finally {
		if (!renamed) {
			try {
				fileSystem.remove(temporaryPath);
			} catch {
				// Preserve the primary failure; this complete unique temp is ignored.
			}
		}
	}
}

function phaseRequiresResolvedBlockers(phase: CyclePhase): boolean {
	return phase === 'deps-advisory' || phase === 'stabilize' || phase === 'done';
}

function cycleBranchProblem(branch: string): string | null {
	if (
		branch === '' ||
		branch === '@' ||
		branch.startsWith('-') ||
		branch.startsWith('/') ||
		branch.endsWith('/') ||
		branch.endsWith('.') ||
		branch.includes('..') ||
		branch.includes('//') ||
		branch.includes('@{') ||
		/[\u0000-\u0020\u007f~^:?*\\]/.test(branch) ||
		branch.includes('[') ||
		branch.split('/').some((segment) => segment === '' || segment.startsWith('.') || segment.endsWith('.lock'))
	) {
		return 'must be one structurally safe Git branch name';
	}
	return null;
}

function portableRepositoryPathProblem(value: string): string | null {
	const problem = repoRelativePathProblem(value);
	if (problem !== null) {
		return problem;
	}
	const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
	return value.split('/').some((segment) => windowsDevice.test(segment)) ? 'contains a Windows device path component' : null;
}

function stateValidationError(error: z.ZodError, file: string) {
	const issue = error.issues[0];
	const field = issue?.path.map(String).join('.') || 'document';
	return ckError(
		'CONFIG',
		`cycle state ${field} failed validation: ${issue?.message ?? 'unknown schema error'}`,
		`restore ${CYCLE_STATE_PATH} with schema version ${CYCLE_STATE_SCHEMA_VERSION}, or restart the cycle`,
		file
	);
}

function addIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
	context.addIssue({ code: 'custom', path, message });
}

function sortedPaths(paths: readonly string[]): string[] {
	return [...paths].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
	const leftBytes = encodeUtf8(left);
	const rightBytes = encodeUtf8(right);
	const length = Math.min(leftBytes.length, rightBytes.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return leftBytes.length - rightBytes.length;
}

function lineAt(bytes: Uint8Array, index: number): number {
	let line = 1;
	for (let cursor = 0; cursor < index; cursor += 1) {
		if (bytes[cursor] === LF_BYTE) {
			line += 1;
		}
	}
	return line;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
