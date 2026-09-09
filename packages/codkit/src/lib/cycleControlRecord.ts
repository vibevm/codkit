/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Durable control record outside Git's reset scope. cycle/state.json is part of
// cycle history and a reset can legitimately delete it; this `.codkit` record
// survives long enough to reconcile and finish restart idempotently.

import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { bytesEqual, CR_BYTE, decodeUtf8Strict, encodeUtf8, LF_BYTE } from './bytes.ts';
import { cycleStateSchema } from './cycleState.ts';
import type { CycleStateFileSystem } from './cycleState.ts';
import { nodeCycleStateFileSystem } from './cycleState.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath, safeBasenameProblem } from './pathSafety.ts';

export const CYCLE_CONTROL_RECORD_VERSION = 1;
export const CYCLE_CONTROL_RECORD_PATH = '.codkit/cycle-control.json';

export const cycleControlRecordSchema = z
	.object({
		codkitCycleControl: z.literal(CYCLE_CONTROL_RECORD_VERSION),
		kind: z.literal('restart'),
		status: z.enum(['running', 'done']),
		state: cycleStateSchema
	})
	.strict()
	.superRefine((record, context) => {
		if (record.state.transaction?.kind !== 'restart') {
			context.addIssue({ code: 'custom', path: ['state', 'transaction'], message: 'must be a restart transaction' });
		}
	});

export type CycleControlRecord = z.infer<typeof cycleControlRecordSchema>;

export type CycleControlRecordOptions = {
	readonly fileSystem?: CycleStateFileSystem;
	readonly temporarySuffix?: () => string;
};

export function readCycleControlRecord(
	patchesDir: string,
	fileSystem: CycleStateFileSystem = nodeCycleStateFileSystem
): CycleControlRecord | null {
	const path = recordPath(patchesDir);
	let bytes: Uint8Array | null;
	try {
		bytes = fileSystem.readBytes(path);
	} catch (error) {
		throw recordError(`cannot read: ${messageOf(error)}`);
	}
	return bytes === null ? null : parseRecord(bytes);
}

export function writeCycleControlRecord(patchesDir: string, record: CycleControlRecord, options: CycleControlRecordOptions = {}): boolean {
	const fileSystem = options.fileSystem ?? nodeCycleStateFileSystem;
	let path = recordPath(patchesDir);
	const parsed = cycleControlRecordSchema.safeParse(record);
	if (!parsed.success) {
		throw recordError(`failed validation: ${parsed.error.issues[0]?.message ?? 'unknown schema error'}`);
	}
	const bytes = encodeUtf8(`${JSON.stringify(parsed.data, null, 2)}\n`);
	let existing: Uint8Array | null;
	try {
		existing = fileSystem.readBytes(path);
	} catch (error) {
		throw recordError(`cannot read before writing: ${messageOf(error)}`);
	}
	if (existing !== null) {
		parseRecord(existing);
		if (bytesEqual(existing, bytes)) {
			return false;
		}
	}

	try {
		fileSystem.makeDirectory(dirname(path));
		path = recordPath(patchesDir);
	} catch (error) {
		throw recordError(`cannot prepare directory: ${messageOf(error)}`);
	}
	const suffix = (options.temporarySuffix ?? randomUUID)();
	if (safeBasenameProblem(suffix) !== null) {
		throw ckError('INTERNAL', 'cycle control temporary suffix must be one portable basename');
	}
	const temporary = `${path}.${suffix}.tmp`;
	let renamed = false;
	try {
		fileSystem.writeBytes(temporary, bytes);
		fileSystem.rename(temporary, path);
		renamed = true;
		return true;
	} catch (error) {
		throw recordError(`cannot atomically write: ${messageOf(error)}`);
	} finally {
		if (!renamed) {
			try {
				fileSystem.remove(temporary);
			} catch {
				// Preserve the primary error; the uniquely named complete temp is ignored.
			}
		}
	}
}

export function removeCycleControlRecord(patchesDir: string, fileSystem: CycleStateFileSystem = nodeCycleStateFileSystem): void {
	const path = recordPath(patchesDir);
	try {
		fileSystem.remove(path);
	} catch (error) {
		throw recordError(`cannot remove: ${messageOf(error)}`);
	}
}

function parseRecord(bytes: Uint8Array): CycleControlRecord {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw ckError('ENCODING', 'cycle control record must not have a UTF-8 BOM', 'write UTF-8 without BOM', CYCLE_CONTROL_RECORD_PATH);
	}
	const document = decodeUtf8Strict(bytes);
	if (document === null) {
		throw ckError('ENCODING', 'cycle control record is not valid UTF-8', 'restore or remove the record', CYCLE_CONTROL_RECORD_PATH);
	}
	if (bytes.indexOf(CR_BYTE) !== -1) {
		throw ckError('CRLF', 'cycle control record contains a carriage return', 'use LF line endings', CYCLE_CONTROL_RECORD_PATH);
	}
	if (bytes.length === 0 || bytes[bytes.length - 1] !== LF_BYTE || (bytes.length > 1 && bytes[bytes.length - 2] === LF_BYTE)) {
		throw ckError(
			'EOF-NEWLINE',
			'cycle control record must end with exactly one LF',
			'restore or remove the record',
			CYCLE_CONTROL_RECORD_PATH
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch (error) {
		throw recordError(`is not valid JSON: ${messageOf(error)}`);
	}
	const parsed = cycleControlRecordSchema.safeParse(value);
	if (!parsed.success) {
		throw recordError(`failed validation: ${parsed.error.issues[0]?.message ?? 'unknown schema error'}`);
	}
	if (document !== `${JSON.stringify(parsed.data, null, 2)}\n`) {
		throw recordError('bytes are not canonical JSON');
	}
	return parsed.data;
}

function recordPath(patchesDir: string): string {
	const resolved = resolveContainedPath(patchesDir, CYCLE_CONTROL_RECORD_PATH, { allowMissing: true });
	if (!resolved.ok) {
		throw recordError(`unsafe path: ${resolved.reason}`);
	}
	return resolved.absolute;
}

function recordError(message: string): Error {
	return ckError(
		'CONFIG',
		`cycle control record ${message}`,
		'finish the recorded restart or restore/remove the record after inspecting the cycle branch',
		CYCLE_CONTROL_RECORD_PATH
	);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
