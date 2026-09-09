/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
// Local metadata held while a rebase conflict has a new body in the fork tree
// but the committed patch still has its old body. Ordinary save consumes it
// only when it writes the regenerated header and body together.

import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { decodeUtf8Strict } from './bytes.ts';
import { ckError } from './messages.ts';
import { encodePatchName, PATCH_FILE_SUFFIX } from './patchFormat.ts';
import { resolveContainedPath } from './pathSafety.ts';
import type { SavePatchHeaderOverride } from './saveEngine.ts';
import type { PatchHeader } from './patchFormat.ts';

export const REBASE_PENDING_DIR = '.codkit/rebase-onto-pin';
const VERSION = 1;

export type RebasePendingOverride = SavePatchHeaderOverride & {
	readonly codkitRebaseOntoPin: 1;
	readonly artifactSha256: string;
	readonly headerMetadataSha256: string;
	readonly desiredTree: string;
};
export type NewRebasePendingOverride = Omit<RebasePendingOverride, 'codkitRebaseOntoPin'>;

const schema = z
	.object({
		codkitRebaseOntoPin: z.literal(VERSION),
		targetPath: z.string().min(1),
		artifactPath: z.string().min(1),
		artifactId: z.string().min(1),
		cause: z.string().regex(/^[0-9a-f]{40}$/),
		pin: z.object({ tag: z.string().min(1), sha: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
		artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
		headerMetadataSha256: z.string().regex(/^[0-9a-f]{64}$/),
		desiredTree: z.string().regex(/^[0-9a-f]{40}$/)
	})
	.strict();

export function rebasePendingPath(patchesDir: string, targetPath: string): string {
	const name = encodePatchName(targetPath).slice(0, -PATCH_FILE_SUFFIX.length);
	return contained(patchesDir, `${REBASE_PENDING_DIR}/${name}.json`);
}

/** Idempotent exclusive create: a retry accepts only byte-identical intent. */
export function writeRebasePending(patchesDir: string, override: NewRebasePendingOverride): string {
	const record: RebasePendingOverride = { codkitRebaseOntoPin: VERSION, ...override };
	const parsed = schema.parse(record);
	const document = `${JSON.stringify(parsed, null, 2)}\n`;
	const path = rebasePendingPath(patchesDir, override.targetPath);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = contained(patchesDir, `${REBASE_PENDING_DIR}/.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, document, { flag: 'wx' });
		try {
			linkSync(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(path, 'utf8') !== document) throw error;
		}
		unlinkSync(temporary);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw pendingError(`${relative(override.targetPath)} cannot be persisted atomically: ${messageOf(error)}`);
	}
	return path;
}

export function readRebasePending(patchesDir: string, targetPath: string): RebasePendingOverride | null {
	const path = rebasePendingPath(patchesDir, targetPath);
	let bytes: Uint8Array;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw pendingError(`${relative(targetPath)} cannot be read: ${messageOf(error)}`);
	}
	const text = decodeUtf8Strict(bytes);
	if (text === null || !text.endsWith('\n') || text.includes('\r'))
		throw pendingError(`${relative(targetPath)} is not canonical UTF-8 JSON`);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw pendingError(`${relative(targetPath)} is invalid JSON: ${messageOf(error)}`);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success || text !== `${JSON.stringify(parsed.data, null, 2)}\n`) {
		throw pendingError(`${relative(targetPath)} failed canonical validation`);
	}
	if (parsed.data.targetPath !== targetPath) throw pendingError(`${relative(targetPath)} names another target`);
	return parsed.data;
}

export function removeRebasePending(patchesDir: string, targetPath: string): void {
	rmSync(rebasePendingPath(patchesDir, targetPath), { force: true });
}

export function hasRebasePendingRecords(patchesDir: string): boolean {
	try {
		return readdirSync(contained(patchesDir, REBASE_PENDING_DIR)).some((name) => name.endsWith('.json'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw pendingError(`cannot list ${REBASE_PENDING_DIR}: ${messageOf(error)}`);
	}
}

export function listRebasePendingRecords(patchesDir: string): readonly RebasePendingOverride[] {
	let names: string[];
	try {
		names = readdirSync(contained(patchesDir, REBASE_PENDING_DIR));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw pendingError(`cannot list ${REBASE_PENDING_DIR}: ${messageOf(error)}`);
	}
	return names
		.filter((name) => name.endsWith('.json'))
		.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
		.map((name) => parsePendingFile(contained(patchesDir, `${REBASE_PENDING_DIR}/${name}`), `${REBASE_PENDING_DIR}/${name}`));
}

export function rebaseHeaderMetadataSha256(header: PatchHeader): string {
	const metadata = {
		id: header.id,
		layer: header.layer,
		layerExplicit: header.layerExplicit,
		type: header.type,
		category: header.category,
		owner: header.owner,
		reason: header.reason,
		link: header.link,
		contractTests: header.contractTests
	};
	return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
}

function parsePendingFile(path: string, label: string): RebasePendingOverride {
	const bytes = readFileSync(path);
	const text = decodeUtf8Strict(bytes);
	if (text === null || !text.endsWith('\n') || text.includes('\r')) throw pendingError(`${label} is not canonical UTF-8 JSON`);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw pendingError(`${label} is invalid JSON: ${messageOf(error)}`);
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success || text !== `${JSON.stringify(parsed.data, null, 2)}\n`) throw pendingError(`${label} failed canonical validation`);
	return parsed.data;
}

function contained(patchesDir: string, path: string): string {
	const resolved = resolveContainedPath(patchesDir, path, { allowMissing: true });
	if (!resolved.ok) throw pendingError(`${path}: unsafe path: ${resolved.reason}`);
	return resolved.absolute;
}

function relative(targetPath: string): string {
	return `${REBASE_PENDING_DIR}/${encodePatchName(targetPath)}`;
}

function pendingError(reason: string): Error {
	return ckError('ARTIFACT-BROKEN', `rebase pending override ${reason}`, 'repair or remove only the exact failed rebase pending record');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
