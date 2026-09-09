/** @scope spec://codkit/modules/codkit/PROP-009#state */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { decodeUtf8Strict } from './bytes.ts';
import { DEPENDENCY_ADVISORY_REPORT_PATH, STABILIZE_REPORT_PATH, parseStabilizeAuthority } from './cycleStabilize.ts';
import { cycleStateSchema } from './cycleState.ts';
import type { CycleState } from './cycleState.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';

export const CYCLE_TRANSITION_RECORD_PATH = '.codkit/cycle-transition.json';
export type CycleTransitionCheckpoint = 'planned' | 'written' | 'committed';
export type CycleTransitionWrite = { readonly path: string; readonly previous: string | null; readonly contents: string };
export type CycleTransitionRecord = {
	readonly codkitCycleTransition: 1;
	readonly inputState: CycleState;
	readonly nextState: CycleState;
	readonly writes: readonly CycleTransitionWrite[];
	readonly parent: string;
	readonly subject: string;
	readonly timestamp: string;
	readonly checkpoint: CycleTransitionCheckpoint;
	readonly commitSha: string | null;
	readonly digest: string;
};

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const writeSchema = z
	.object({ path: z.enum([DEPENDENCY_ADVISORY_REPORT_PATH, STABILIZE_REPORT_PATH]), previous: z.string().nullable(), contents: z.string() })
	.strict();
const schema = z
	.object({
		codkitCycleTransition: z.literal(1),
		inputState: cycleStateSchema,
		nextState: cycleStateSchema,
		writes: z.array(writeSchema),
		parent: sha,
		subject: z.string().min(1),
		timestamp: z.iso.datetime({ offset: true }),
		checkpoint: z.enum(['planned', 'written', 'committed']),
		commitSha: sha.nullable(),
		digest: z.string().regex(/^[0-9a-f]{64}$/)
	})
	.strict();

export function makeCycleTransitionRecord(input: Omit<CycleTransitionRecord, 'codkitCycleTransition' | 'digest'>): CycleTransitionRecord {
	const body = { codkitCycleTransition: 1 as const, ...input };
	const record = { ...body, digest: digest(body) };
	assertRecord(record);
	return record;
}

export function updateCycleTransitionRecord(
	record: CycleTransitionRecord,
	change: Pick<CycleTransitionRecord, 'checkpoint' | 'commitSha'>
): CycleTransitionRecord {
	const { codkitCycleTransition: _version, digest: _digest, ...body } = record;
	return makeCycleTransitionRecord({ ...body, ...change });
}

export function writeCycleTransitionRecord(root: string, record: CycleTransitionRecord): void {
	assertRecord(record);
	mkdirSync(dirname(absolute(root)), { recursive: true });
	atomicWrite(absolute(root), serialize(record));
}

export function readCycleTransitionRecord(root: string): CycleTransitionRecord | null {
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

export function clearCycleTransitionRecord(root: string): void {
	removeOptional(absolute(root));
}

function assertRecord(record: CycleTransitionRecord): void {
	const { digest: claimed, ...body } = record;
	if (claimed !== digest(body)) throw broken('record digest does not match its authority');
	if ((record.checkpoint === 'committed') !== (record.commitSha !== null)) throw broken('checkpoint and commit sha disagree');
	if (record.inputState.branch !== record.nextState.branch || record.inputState.targetPin.sha !== record.nextState.targetPin.sha)
		throw broken('transition changes cycle identity');
	const edge = `${record.inputState.phase}->${record.nextState.phase}`;
	if (!['deps-advisory->deps-advisory', 'deps-advisory->stabilize', 'stabilize->resolve', 'stabilize->done'].includes(edge))
		throw broken(`unsupported transition ${edge}`);
	if (record.subject.includes(record.nextState.targetPin.tag) === false) throw broken('subject does not name target tag');
	if (!orderedUnique(record.writes.map((write) => write.path))) throw broken('writes are not sorted and unique');
	assertNestedAuthority(record);
}

function assertNestedAuthority(record: CycleTransitionRecord): void {
	if (record.inputState.phase === 'deps-advisory') {
		const write = exactAuthorityWrite(record, DEPENDENCY_ADVISORY_REPORT_PATH);
		let document: unknown;
		try {
			document = JSON.parse(write.contents);
		} catch {
			throw broken('advisory authority is not JSON');
		}
		if (!isRecord(document) || `${JSON.stringify(document, null, 2)}\n` !== write.contents)
			throw broken('advisory authority is not canonical');
		if (JSON.stringify(document['state']) !== JSON.stringify(record.inputState)) throw broken('advisory input state differs');
		const acceptance = document['acceptance'];
		if (!['not-required', 'pending', 'interactive', 'ci'].includes(typeof acceptance === 'string' ? acceptance : ''))
			throw broken('advisory acceptance is invalid');
		const stopped = acceptance === 'pending';
		const acknowledgement = document['acknowledgement'];
		const next = cycleStateSchema.parse({
			...record.inputState,
			phase: stopped ? 'deps-advisory' : 'stabilize',
			nextAction: stopped
				? `acknowledge dependency advisory with ${typeof acknowledgement === 'string' ? acknowledgement : ''}`
				: 'run verify, build and contract stabilization gates',
			updatedAt: record.nextState.updatedAt
		});
		if (JSON.stringify(next) !== JSON.stringify(record.nextState)) throw broken('advisory next state is not derived');
		return;
	}
	const write = exactAuthorityWrite(record, STABILIZE_REPORT_PATH);
	let report;
	try {
		report = parseStabilizeAuthority(write.contents, record.inputState);
	} catch (error) {
		throw broken(error instanceof Error ? error.message : String(error));
	}
	if (JSON.stringify(report.nextState) !== JSON.stringify(record.nextState)) throw broken('stabilize next state differs');
	if (report.basis.red.length === 0) {
		const tip = report.basis.execution.build?.branchTip;
		if (tip === null || tip === undefined || !/^[0-9a-f]{40}$/.test(tip) || tip !== report.basis.live.fork.head)
			throw broken('green stabilize authority does not bind branch tip');
	}
}

function exactAuthorityWrite(record: CycleTransitionRecord, path: string): CycleTransitionWrite {
	if (record.writes.length !== 1 || record.writes[0]?.path !== path) throw broken(`transition does not carry exactly one ${path}`);
	return record.writes[0];
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serialize(record: CycleTransitionRecord): string {
	return `${JSON.stringify(record, null, 2)}\n`;
}
function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function orderedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || Buffer.from(values[index - 1] ?? '').compare(Buffer.from(value)) < 0);
}
function absolute(root: string): string {
	const resolved = resolveContainedPath(root, CYCLE_TRANSITION_RECORD_PATH, { allowMissing: true });
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
	return ckError('ARTIFACT-BROKEN', `cycle transition record: ${reason}`, `inspect ${CYCLE_TRANSITION_RECORD_PATH}; never edit it`);
}
function codeOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
