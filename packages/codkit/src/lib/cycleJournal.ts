/** @scope spec://codkit/modules/codkit/PROP-009#journal */
// Machine-readable decision journal for an upgrade cycle.
//
// Every line is one canonical versioned JSON record. Append validates the old
// bytes and atomically replaces them with old+record; it never mutates a
// potentially corrupt prefix in place. The caller must hold the same cycle lock
// used for state writes so concurrent writers cannot lose a validated update.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CR_BYTE, decodeUtf8Strict, encodeUtf8, LF_BYTE } from './bytes.ts';
import { CYCLE_ARTIFACT_OUTCOMES, CYCLE_BLOCKER_OUTCOMES, cycleStateSchema } from './cycleState.ts';
import type { CycleArtifactOutcome, CycleState } from './cycleState.ts';
import { ckError, isCkError } from './messages.ts';
import { repoRelativePathProblem, resolveContainedPath, safeBasenameProblem } from './pathSafety.ts';

export const CYCLE_JOURNAL_SCHEMA_VERSION = 1;
export const CYCLE_JOURNAL_DIR = 'cycle/log';

const timestampSchema = z.iso.datetime({ offset: true });
const causeSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), approx: z.boolean() }).strict();
const verificationSchema = z.object({ command: z.string().min(1), exitCode: z.number().int() }).strict();
const actorSchema = z
	.string()
	.refine((value) => value === 'human' || (value.startsWith('agent:') && value.slice('agent:'.length).trim() !== ''), {
		message: 'must be "human" or "agent:<nonempty name>"'
	});
const artifactPathSchema = z
	.string()
	.min(1)
	.refine((value) => repoRelativePathProblem(value) === null, 'must be a portable repository-relative path');

export const cycleJournalEntrySchema = z
	.object({
		codkitCycleJournal: z.literal(CYCLE_JOURNAL_SCHEMA_VERSION),
		ts: timestampSchema,
		artifact: artifactPathSchema,
		outcome: z.enum(CYCLE_ARTIFACT_OUTCOMES),
		resolution: z.string().min(1),
		cause: causeSchema,
		by: actorSchema,
		verified: z.array(verificationSchema).min(1)
	})
	.strict();

export type CycleJournalCause = z.infer<typeof causeSchema>;
export type CycleJournalVerification = z.infer<typeof verificationSchema>;
export type CycleJournalEntry = z.infer<typeof cycleJournalEntrySchema>;

export type CycleJournalFileSystem = {
	readonly readBytes: (path: string) => Uint8Array | null;
	readonly makeDirectory: (path: string) => void;
	readonly writeBytes: (path: string, document: Uint8Array) => void;
	readonly rename: (from: string, to: string) => void;
	readonly remove: (path: string) => void;
};

export const nodeCycleJournalFileSystem: CycleJournalFileSystem = {
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

export type AppendCycleJournalOptions = {
	readonly fileSystem?: CycleJournalFileSystem;
	readonly temporarySuffix?: () => string;
};

export function cycleJournalPath(patchesDir: string, targetTag: string): string {
	return containedJournalPath(patchesDir, targetTag);
}

/** Parse a non-empty canonical compact JSONL document. */
export function parseCycleJournal(document: string, file = 'cycle journal'): readonly CycleJournalEntry[] {
	return parseCycleJournalBytes(encodeUtf8(document), file);
}

/** Missing journal means no entries; an existing empty journal is corrupt. */
export function readCycleJournal(
	patchesDir: string,
	targetTag: string,
	fileSystem: CycleJournalFileSystem = nodeCycleJournalFileSystem
): readonly CycleJournalEntry[] {
	const path = containedJournalPath(patchesDir, targetTag);
	let bytes: Uint8Array | null;
	try {
		bytes = fileSystem.readBytes(path);
	} catch (error) {
		throw journalError(`cannot read file: ${messageOf(error)}`, relativeJournalPath(targetTag));
	}
	return bytes === null ? [] : parseCycleJournalBytes(bytes, relativeJournalPath(targetTag));
}

/** Compact schema-key-order record with exactly one final LF. */
export function serializeCycleJournalEntry(entry: CycleJournalEntry): string {
	const parsed = cycleJournalEntrySchema.safeParse(entry);
	if (!parsed.success) {
		throw journalSchemaError(parsed.error, 'journal entry');
	}
	return `${JSON.stringify(parsed.data)}\n`;
}

/** Validate old bytes and atomically replace them with old+record. Caller holds the cycle lock. */
export function appendCycleJournalEntry(
	patchesDir: string,
	targetTag: string,
	entry: CycleJournalEntry,
	options: AppendCycleJournalOptions = {}
): void {
	const fileSystem = options.fileSystem ?? nodeCycleJournalFileSystem;
	const file = relativeJournalPath(targetTag);
	let path = containedJournalPath(patchesDir, targetTag);
	const record = encodeUtf8(serializeCycleJournalEntry(entry));
	let existing: Uint8Array | null;
	try {
		existing = fileSystem.readBytes(path);
	} catch (error) {
		throw journalError(`cannot read file before append: ${messageOf(error)}`, file);
	}
	if (existing !== null) {
		parseCycleJournalBytes(existing, file);
	}
	const replacement = concatenate(existing, record);

	try {
		fileSystem.makeDirectory(dirname(path));
		path = containedJournalPath(patchesDir, targetTag);
	} catch (error) {
		if (isCkError(error)) {
			throw error;
		}
		throw journalError(`cannot prepare journal directory: ${messageOf(error)}`, file);
	}
	atomicReplace(path, replacement, fileSystem, options.temporarySuffix, file);
}

export type RequiredJournalEntry = {
	readonly artifact: string;
	readonly outcome: Exclude<CycleArtifactOutcome, 'clean'>;
};

/** Derive proof obligations directly from validated state. */
export function requiredCycleJournalEntries(state: CycleState): readonly RequiredJournalEntry[] {
	const validState = validatedState(state);
	const required: RequiredJournalEntry[] = [];
	for (const outcome of CYCLE_ARTIFACT_OUTCOMES) {
		if (outcome === 'clean') {
			continue;
		}
		for (const artifact of validState.artifacts[outcome]) {
			required.push({ artifact, outcome });
		}
	}
	return required;
}

/** A terminal proof matches artifact+outcome and has at least one, all-green verification. */
export function assertCycleJournalComplete(state: CycleState, entries: readonly CycleJournalEntry[]): void {
	const validState = validatedState(state);
	const validEntries = entries.map((entry, index) => {
		const parsed = cycleJournalEntrySchema.safeParse(entry);
		if (!parsed.success) {
			throw journalSchemaError(parsed.error, 'cycle journal', index + 1);
		}
		return parsed.data;
	});
	const latest = new Map<string, CycleJournalEntry>();
	for (const entry of validEntries) {
		latest.set(entry.artifact, entry);
	}
	const missing = requiredEntries(validState).filter((required) => {
		const entry = latest.get(required.artifact);
		return (
			entry === undefined ||
			entry.outcome !== required.outcome ||
			entry.verified.some((verification) => verification.exitCode !== 0) ||
			(isBlockerOutcome(required.outcome) && !validState.resolved.includes(required.artifact))
		);
	});
	if (missing.length === 0) {
		return;
	}
	const list = missing.map((entry) => `${entry.outcome}:${entry.artifact}`).join(', ');
	throw ckError(
		'LOG-INCOMPLETE',
		`cycle journal is missing ${missing.length} terminal proof${missing.length === 1 ? '' : 's'}: ${list}`,
		'add one valid matching journal record whose verification commands all exit 0'
	);
}

function parseCycleJournalBytes(bytes: Uint8Array, file: string): readonly CycleJournalEntry[] {
	const document = strictJournalText(bytes, file);
	const lines = document.slice(0, -1).split('\n');
	return lines.map((line, index) => parseJournalLine(line, index + 1, file));
}

function parseJournalLine(line: string, lineNumber: number, file: string): CycleJournalEntry {
	if (line === '') {
		throw journalError('blank record', file, lineNumber);
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw journalError(`record is not valid JSON: ${messageOf(error)}`, file, lineNumber);
	}
	refuseNewerJournalVersion(value, file, lineNumber);
	const parsed = cycleJournalEntrySchema.safeParse(value);
	if (!parsed.success) {
		throw journalSchemaError(parsed.error, file, lineNumber);
	}
	if (line !== JSON.stringify(parsed.data)) {
		throw journalError('record is not canonical compact JSON', file, lineNumber);
	}
	return parsed.data;
}

function refuseNewerJournalVersion(value: unknown, file: string, line: number): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return;
	}
	const version = (value as Record<string, unknown>)['codkitCycleJournal'];
	if (typeof version === 'number' && Number.isInteger(version) && version > CYCLE_JOURNAL_SCHEMA_VERSION) {
		throw ckError(
			'CONFIG',
			`cycle journal schema ${version} is newer than supported schema ${CYCLE_JOURNAL_SCHEMA_VERSION}`,
			'update codkit before continuing this cycle',
			file,
			line
		);
	}
}

function isBlockerOutcome(outcome: CycleArtifactOutcome): boolean {
	return (CYCLE_BLOCKER_OUTCOMES as readonly CycleArtifactOutcome[]).includes(outcome);
}

function strictJournalText(bytes: Uint8Array, file: string): string {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw ckError('ENCODING', 'cycle journal must not have a UTF-8 BOM', 'write UTF-8 without BOM', file, 1);
	}
	const document = decodeUtf8Strict(bytes);
	if (document === null) {
		throw ckError('ENCODING', 'cycle journal is not valid UTF-8', 'write UTF-8 without BOM', file);
	}
	const carriageReturn = bytes.indexOf(CR_BYTE);
	if (carriageReturn !== -1) {
		throw ckError('CRLF', 'cycle journal contains a carriage return', 'use LF line endings', file, lineAt(bytes, carriageReturn));
	}
	if (bytes.length === 0 || bytes[bytes.length - 1] !== LF_BYTE || (bytes.length > 1 && bytes[bytes.length - 2] === LF_BYTE)) {
		throw ckError(
			'EOF-NEWLINE',
			'cycle journal must be non-empty and end with exactly one LF',
			'remove the missing or excess final newline',
			file
		);
	}
	return document;
}

function containedJournalPath(patchesDir: string, targetTag: string): string {
	const tagProblem = safeBasenameProblem(targetTag);
	if (tagProblem !== null) {
		throw ckError('CONFIG', `unsafe cycle journal target tag ${JSON.stringify(targetTag)}: ${tagProblem}`, 'use one portable tag basename');
	}
	const relative = relativeJournalPath(targetTag);
	const resolved = resolveContainedPath(patchesDir, relative, { allowMissing: true });
	if (!resolved.ok) {
		throw ckError(
			'CONFIG',
			`unsafe cycle journal path: ${resolved.reason}`,
			'replace symlink components with real directories inside the repository',
			relative
		);
	}
	return resolved.absolute;
}

function atomicReplace(
	path: string,
	bytes: Uint8Array,
	fileSystem: CycleJournalFileSystem,
	suffixFactory: (() => string) | undefined,
	file: string
): void {
	const suffix = (suffixFactory ?? randomUUID)();
	if (suffix === '' || suffix.includes('/') || suffix.includes('\\')) {
		throw ckError('INTERNAL', 'cycle journal temporary suffix must be a non-empty file-name segment');
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
		throw journalError(`cannot atomically append record: ${messageOf(error)}`, file);
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

function concatenate(existing: Uint8Array | null, record: Uint8Array): Uint8Array {
	if (existing === null) {
		return record;
	}
	const combined = new Uint8Array(existing.length + record.length);
	combined.set(existing, 0);
	combined.set(record, existing.length);
	return combined;
}

function validatedState(state: CycleState): CycleState {
	const parsed = cycleStateSchema.safeParse(state);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.path.map(String).join('.') || 'document';
		throw ckError(
			'CONFIG',
			`cycle state ${field} failed validation before journal completeness: ${issue?.message ?? 'unknown schema error'}`,
			'repair cycle/state.json first'
		);
	}
	return parsed.data;
}

function requiredEntries(state: CycleState): RequiredJournalEntry[] {
	const required: RequiredJournalEntry[] = [];
	for (const outcome of CYCLE_ARTIFACT_OUTCOMES) {
		if (outcome !== 'clean') {
			for (const artifact of state.artifacts[outcome]) {
				required.push({ artifact, outcome });
			}
		}
	}
	return required;
}

function journalSchemaError(error: z.ZodError, file: string, line?: number) {
	const issue = error.issues[0];
	const field = issue?.path.map(String).join('.') || 'document';
	return journalError(`${field} failed validation: ${issue?.message ?? 'unknown schema error'}`, file, line);
}

function journalError(message: string, file: string, line?: number) {
	return ckError(
		'LOG-INCOMPLETE',
		message,
		'repair or restore the complete canonical JSONL journal before continuing the cycle',
		file,
		line
	);
}

function relativeJournalPath(targetTag: string): string {
	return `${CYCLE_JOURNAL_DIR}/${targetTag}.jsonl`;
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
