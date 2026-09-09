/** @scope spec://codkit/modules/codkit/PROP-009#state */
// Durable identity of one rename classification mutation. This record is
// written before renameApply creates its transaction, so a fresh process can
// recover the exact BoundRenameBatch without parsing a half-rewritten patch.

import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { decodeUtf8Strict } from './bytes.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';
import type { PatchRenameBatchPlan } from './renameApply.ts';
import type { UpstreamRename } from './renames.ts';
import type { CyclePin } from './cycleState.ts';

export const CYCLE_CLASSIFY_RECOVERY_PATH = '.codkit/cycle-classify.json';
const VERSION = 1 as const;

export type CycleClassifyRecovery = {
	readonly codkitCycleClassify: 1;
	readonly sourcePin: CyclePin;
	readonly targetPin: CyclePin;
	readonly branch: string;
	readonly similarity: number;
	readonly detectedRenames: readonly UpstreamRename[];
	readonly batch: PatchRenameBatchPlan;
	readonly digest: string;
};

export type NewCycleClassifyRecovery = Omit<CycleClassifyRecovery, 'codkitCycleClassify' | 'digest'>;

const pinSchema = z
	.object({ tag: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
	.strict();
const renameSchema = z
	.object({ from: z.string().min(1), to: z.string().min(1), similarity: z.number().int().min(0).max(100), needsReview: z.boolean() })
	.strict();
const batchSchema = z
	.object({
		plans: z.array(z.unknown()),
		bindings: z.array(z.unknown()),
		modes: z.array(z.unknown()),
		candidates: z.array(z.unknown()),
		needsReview: z.boolean()
	})
	.strict();
const schema = z
	.object({
		codkitCycleClassify: z.literal(VERSION),
		sourcePin: pinSchema,
		targetPin: pinSchema,
		branch: z.string().min(1),
		similarity: z.number().int().min(0).max(100),
		detectedRenames: z.array(renameSchema),
		batch: batchSchema,
		digest: z.string().regex(/^[0-9a-f]{64}$/)
	})
	.strict();

export function makeCycleClassifyRecovery(input: NewCycleClassifyRecovery): CycleClassifyRecovery {
	const body = { codkitCycleClassify: VERSION, ...input };
	return { ...body, digest: digest(body) };
}

/** Existing bytes must describe this exact operation; they are never replaced. */
export function writeCycleClassifyRecovery(patchesDir: string, record: CycleClassifyRecovery): void {
	assertRecord(record);
	let path = absolute(patchesDir);
	const bytes = serialize(record);
	const existing = readCycleClassifyRecovery(patchesDir);
	if (existing !== null) {
		if (serialize(existing) !== bytes) throw broken('existing recovery record describes a different rename operation');
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	path = absolute(patchesDir);
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, bytes, { flag: 'wx' });
		renameSync(temporary, path);
	} finally {
		try {
			unlinkSync(temporary);
		} catch (error) {
			if (codeOf(error) !== 'ENOENT') throw error;
		}
	}
}

/** Single open/read: absence is legal; a present document must remain readable. */
export function readCycleClassifyRecovery(patchesDir: string): CycleClassifyRecovery | null {
	const bytes = readOptionalFile(absolute(patchesDir));
	if (bytes === null) return null;
	const text = decodeUtf8Strict(bytes);
	if (text === null || !text.endsWith('\n') || text.includes('\r')) throw broken('recovery record is not canonical UTF-8 JSON');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw broken(`recovery record is not valid JSON: ${messageOf(error)}`);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw broken(`recovery record failed schema validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
	const record = parsed.data as CycleClassifyRecovery;
	assertRecord(record);
	if (serialize(record) !== text) throw broken('recovery record bytes are not canonical');
	return record;
}

/** Remove only the exact record that was independently verified and completed. */
export function clearCycleClassifyRecovery(patchesDir: string, expected: CycleClassifyRecovery): void {
	const current = readCycleClassifyRecovery(patchesDir);
	if (current === null || current.digest !== expected.digest) throw broken('recovery record changed before completion cleanup');
	try {
		unlinkSync(absolute(patchesDir));
	} catch (error) {
		throw broken(`cannot clear completed recovery record: ${messageOf(error)}`);
	}
}

function assertRecord(record: CycleClassifyRecovery): void {
	const { digest: claimed, ...body } = record;
	if (claimed !== digest(body)) throw broken('recovery digest does not match its canonical evidence');
}

function serialize(record: CycleClassifyRecovery): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readOptionalFile(path: string): Uint8Array | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') return null;
		throw broken(`cannot open recovery record: ${messageOf(error)}`);
	}
	try {
		if (!fstatSync(fd).isFile()) throw broken('recovery path is not a regular file');
		return readFileSync(fd);
	} catch (error) {
		if (error instanceof Error && error.message.includes('cycle classification recovery')) throw error;
		throw broken(`cannot read recovery record: ${messageOf(error)}`);
	} finally {
		closeSync(fd);
	}
}

function absolute(patchesDir: string): string {
	const resolved = resolveContainedPath(patchesDir, CYCLE_CLASSIFY_RECOVERY_PATH, { allowMissing: true });
	if (!resolved.ok) throw broken(`unsafe recovery path: ${resolved.reason}`);
	return resolved.absolute;
}

function broken(reason: string): Error {
	return ckError('ARTIFACT-BROKEN', `cycle classification recovery: ${reason}`, `inspect ${CYCLE_CLASSIFY_RECOVERY_PATH}; never edit it`);
}

function codeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
