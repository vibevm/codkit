/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-RUNTIME-STATE */
// Contained runtime files and the atomic daemon reservation state machine.

import { closeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import {
	openContainedFileAppend,
	readContainedFile,
	removeContainedFile,
	renameContainedFile,
	writeContainedFileAtomic,
	writeContainedFileExclusive
} from './containedFile.ts';
import { ckError } from './messages.ts';
import { validateChannelName } from './buildChannel.ts';
import { assertDaemonChannelLock } from './daemonChannelLock.ts';
import type { DaemonChannelLock } from './daemonChannelLock.ts';
export { validateChannelName } from './buildChannel.ts';

export const BUILD_DIR = '.codkit/build';
export const DAEMON_RECORD_SCHEMA_VERSION = 1;

export type DaemonRecord = {
	readonly codkitBuildDaemon: number;
	readonly channel: string;
	readonly script: string;
	readonly pid: number;
	readonly cmdline: string;
	readonly startedAt: string;
	readonly treeId: string;
	readonly treePath: string;
	/** Ownership token of atomic reservation -> pid transition. */
	readonly nonce: string;
};

const recordSchema = z
	.object({
		codkitBuildDaemon: z.literal(DAEMON_RECORD_SCHEMA_VERSION),
		channel: z.string().min(1),
		script: z.string().min(1),
		pid: z.number().int().min(0),
		cmdline: z.string().min(1),
		startedAt: z.string().refine(canonicalIso, 'must be a canonical finite ISO timestamp'),
		treeId: z.string().min(1),
		treePath: z.string().min(1),
		nonce: z.string().uuid()
	})
	.strict();

export type DaemonRecordState =
	| { readonly state: 'absent' }
	| { readonly state: 'invalid'; readonly detail: string }
	| { readonly state: 'valid'; readonly record: DaemonRecord; readonly bytes: Uint8Array };

export function buildDir(patchesDir: string): string {
	return join(patchesDir, ...BUILD_DIR.split('/'));
}

export function logPath(patchesDir: string, channel: string): string {
	validateChannelName(channel);
	return join(buildDir(patchesDir), `${channel}.log`);
}

export function rotatedLogPath(patchesDir: string, channel: string): string {
	return `${logPath(patchesDir, channel)}.1`;
}

export function recordPath(patchesDir: string, channel: string): string {
	validateChannelName(channel);
	return join(buildDir(patchesDir), `${channel}.json`);
}

function runtimeRelative(name: string): string {
	return `${BUILD_DIR}/${name}`;
}

function canonicalIso(value: string): boolean {
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function recordName(channel: string): string {
	validateChannelName(channel);
	return `${channel}.json`;
}

export function daemonRecordBytes(record: DaemonRecord): Uint8Array {
	return encodeUtf8(`${JSON.stringify(record, null, 2)}\n`);
}

export function readRecordState(patchesDir: string, channel: string, afterOpen?: () => void): DaemonRecordState {
	const name = recordName(channel);
	let read;
	try {
		read = readContainedFile(patchesDir, runtimeRelative(name), {
			what: recordPath(patchesDir, channel),
			...(afterOpen === undefined ? {} : { afterOpen })
		});
	} catch (error) {
		return { state: 'invalid', detail: error instanceof Error ? error.message : String(error) };
	}
	if (read.state === 'absent') return { state: 'absent' };
	let raw: unknown;
	try {
		const text = decodeUtf8Strict(read.bytes);
		if (text === null) return { state: 'invalid', detail: 'record is not valid UTF-8' };
		raw = JSON.parse(text);
	} catch (error) {
		return { state: 'invalid', detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = recordSchema.safeParse(raw);
	if (!parsed.success) return { state: 'invalid', detail: `schema-invalid: ${parsed.error.issues[0]?.message ?? 'record'}` };
	if (parsed.data.channel !== channel) return { state: 'invalid', detail: `record channel is ${JSON.stringify(parsed.data.channel)}` };
	return { state: 'valid', record: parsed.data, bytes: read.bytes };
}

export function createReservation(patchesDir: string, record: DaemonRecord, lock: DaemonChannelLock): boolean {
	assertDaemonChannelLock(lock, patchesDir, record.channel);
	if (record.pid !== 0) throw ckError('INTERNAL', 'daemon reservation requires pid 0 and an ownership nonce');
	return writeContainedFileExclusive(patchesDir, runtimeRelative(recordName(record.channel)), {
		bytes: daemonRecordBytes(record),
		what: recordPath(patchesDir, record.channel)
	});
}

export function finalizeReservation(
	patchesDir: string,
	reservation: DaemonRecord,
	pid: number,
	lock: DaemonChannelLock,
	afterCompare?: () => void
): boolean {
	assertDaemonChannelLock(lock, patchesDir, reservation.channel);
	const current = readRecordState(patchesDir, reservation.channel);
	if (current.state !== 'valid' || !Buffer.from(current.bytes).equals(Buffer.from(daemonRecordBytes(reservation)))) return false;
	afterCompare?.();
	const confirmed = readRecordState(patchesDir, reservation.channel);
	if (confirmed.state !== 'valid' || !Buffer.from(confirmed.bytes).equals(Buffer.from(current.bytes))) return false;
	writeContainedFileAtomic(patchesDir, runtimeRelative(recordName(reservation.channel)), {
		bytes: daemonRecordBytes({ ...reservation, pid }),
		what: recordPath(patchesDir, reservation.channel)
	});
	return true;
}

/**
 * Retire exactly one observed generation.
 *
 * `expected` is required, not optional: a lock-holding caller that skipped the
 * comparison could delete a record it never read, which is the same collapse
 * the discriminated reader exists to prevent one level up.
 */
export function removeRecord(
	patchesDir: string,
	channel: string,
	lock: DaemonChannelLock,
	expected: Uint8Array,
	afterCompare?: () => void
): boolean {
	assertDaemonChannelLock(lock, patchesDir, channel);
	const current = readRecordState(patchesDir, channel);
	if (current.state === 'absent') return true;
	if (current.state !== 'valid') return false;
	if (!Buffer.from(current.bytes).equals(Buffer.from(expected))) return false;
	afterCompare?.();
	const confirmed = readRecordState(patchesDir, channel);
	if (confirmed.state !== 'valid' || !Buffer.from(confirmed.bytes).equals(Buffer.from(current.bytes))) return false;
	removeContainedFile(patchesDir, runtimeRelative(recordName(channel)), { what: recordPath(patchesDir, channel) });
	return true;
}

export function rotateLog(patchesDir: string, channel: string, lock: DaemonChannelLock, afterOpen?: () => void): void {
	assertDaemonChannelLock(lock, patchesDir, channel);
	validateChannelName(channel);
	renameContainedFile(patchesDir, runtimeRelative(`${channel}.log`), runtimeRelative(`${channel}.log.1`), {
		what: logPath(patchesDir, channel),
		...(afterOpen === undefined ? {} : { afterOpen })
	});
}

export function openLogAppend(patchesDir: string, channel: string, lock: DaemonChannelLock, afterOpen?: () => void): number {
	assertDaemonChannelLock(lock, patchesDir, channel);
	validateChannelName(channel);
	return openContainedFileAppend(patchesDir, runtimeRelative(`${channel}.log`), {
		what: logPath(patchesDir, channel),
		...(afterOpen === undefined ? {} : { afterOpen })
	});
}

export function closeLog(handle: number): void {
	closeSync(handle);
}

export function readLog(patchesDir: string, channel: string, afterOpen?: () => void): string {
	validateChannelName(channel);
	const read = readContainedFile(patchesDir, runtimeRelative(`${channel}.log`), {
		what: logPath(patchesDir, channel),
		...(afterOpen === undefined ? {} : { afterOpen })
	});
	return read.state === 'absent' ? '' : Buffer.from(read.bytes).toString('utf8');
}
