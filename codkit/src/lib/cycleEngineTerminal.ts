/** @scope spec://codkit/modules/codkit/PROP-009#state */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { decodeUtf8Strict } from './bytes.ts';
import { CYCLE_FINALIZATION_CHECKLIST } from './cycleFinalize.ts';
import type { CycleFinalizationPlan } from './cycleFinalize.ts';
import { CYCLE_STATE_PATH, cycleStateSchema } from './cycleState.ts';
import type { CycleState } from './cycleState.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';

export const CYCLE_TERMINAL_RECORD_PATH = '.codkit/cycle-terminal.json';
export type CycleTerminalCheckpoint = 'planned' | 'applied' | 'committed';
export type CycleTerminalRecord = {
	readonly codkitCycleTerminal: 1;
	readonly state: CycleState;
	readonly plan: CycleFinalizationPlan;
	readonly bumpParent: string;
	readonly finalParent: string;
	readonly subject: string;
	readonly timestamp: string;
	readonly checkpoint: CycleTerminalCheckpoint;
	readonly commitSha: string | null;
	readonly digest: string;
};

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const schema = z
	.object({
		codkitCycleTerminal: z.literal(1),
		state: cycleStateSchema,
		plan: z.custom<CycleFinalizationPlan>(isPlan, 'invalid finalization plan'),
		bumpParent: sha,
		finalParent: sha,
		subject: z.string().min(1),
		timestamp: z.iso.datetime({ offset: true }),
		checkpoint: z.enum(['planned', 'applied', 'committed']),
		commitSha: sha.nullable(),
		digest: z.string().regex(/^[0-9a-f]{64}$/)
	})
	.strict();

export function makeCycleTerminalRecord(input: Omit<CycleTerminalRecord, 'codkitCycleTerminal' | 'digest'>): CycleTerminalRecord {
	const body = { codkitCycleTerminal: 1 as const, ...input };
	const record = { ...body, digest: digest(body) };
	assertRecord(record);
	return record;
}

export function updateCycleTerminalRecord(
	record: CycleTerminalRecord,
	change: Pick<CycleTerminalRecord, 'checkpoint' | 'commitSha'>
): CycleTerminalRecord {
	const { codkitCycleTerminal: _version, digest: _digest, ...body } = record;
	return makeCycleTerminalRecord({ ...body, ...change });
}

export function writeCycleTerminalRecord(root: string, record: CycleTerminalRecord): void {
	assertRecord(record);
	mkdirSync(dirname(absolute(root)), { recursive: true });
	atomicWrite(absolute(root), serialize(record));
}

export function readCycleTerminalRecord(root: string): CycleTerminalRecord | null {
	const text = readOptional(absolute(root));
	if (text === null) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw broken(`record is not JSON: ${messageOf(error)}`);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) throw broken(`record schema failed: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
	const record = parsed.data;
	assertRecord(record);
	if (serialize(record) !== text) throw broken('record bytes are not canonical');
	return record;
}

export function clearCycleTerminalRecord(root: string): void {
	removeOptional(absolute(root));
}

function assertRecord(record: CycleTerminalRecord): void {
	const { digest: claimed, ...body } = record;
	if (claimed !== digest(body)) throw broken('record digest does not match its authority');
	if ((record.checkpoint === 'committed') !== (record.commitSha !== null)) throw broken('checkpoint and commit sha disagree');
	if (record.state.phase !== 'done' || record.state.transaction !== null) throw broken('terminal state is not done');
	if (record.plan.targetTag !== record.state.targetPin.tag) throw broken('plan target tag differs from state');
	if (JSON.stringify(record.plan.authority.state) !== JSON.stringify(record.state))
		throw broken('plan authority state differs from receipt');
	if (!record.plan.deletions.some((item) => item.path === CYCLE_STATE_PATH)) throw broken('plan does not delete cycle state');
	if (record.subject.includes(record.state.targetPin.tag) === false) throw broken('subject does not name target tag');
	if (JSON.stringify(record.plan.checklist) !== JSON.stringify(CYCLE_FINALIZATION_CHECKLIST)) throw broken('terminal checklist differs');
}

function isPlan(value: unknown): value is CycleFinalizationPlan {
	return (
		isRecord(value) &&
		value['codkitCycleFinalization'] === 1 &&
		typeof value['digest'] === 'string' &&
		typeof value['targetTag'] === 'string' &&
		isRecord(value['authority']) &&
		isRecord(value['basis']) &&
		Array.isArray(value['writes']) &&
		Array.isArray(value['deletions']) &&
		Array.isArray(value['checklist'])
	);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function serialize(record: CycleTerminalRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}
function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function absolute(root: string): string {
	const resolved = resolveContainedPath(root, CYCLE_TERMINAL_RECORD_PATH, { allowMissing: true });
	if (!resolved.ok) throw broken(`unsafe record path: ${resolved.reason}`);
	return resolved.absolute;
}
function atomicWrite(path: string, contents: string): void {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, contents, { flag: 'wx' });
		renameSync(temporary, path);
	} finally {
		removeOptional(temporary);
	}
}
function readOptional(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') return null;
		throw broken(`cannot open record: ${messageOf(error)}`);
	}
	try {
		if (!fstatSync(fd).isFile()) throw broken('record is not a regular file');
		const text = decodeUtf8Strict(readFileSync(fd));
		if (text === null || text.includes('\r') || !text.endsWith('\n')) throw broken('record is not canonical UTF-8/LF');
		return text;
	} finally {
		closeSync(fd);
	}
}
function removeOptional(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (codeOf(error) !== 'ENOENT') throw error;
	}
}
function broken(reason: string): Error {
	return ckError('ARTIFACT-BROKEN', `cycle terminal record: ${reason}`, `inspect ${CYCLE_TERMINAL_RECORD_PATH}; never edit it`);
}
function codeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
