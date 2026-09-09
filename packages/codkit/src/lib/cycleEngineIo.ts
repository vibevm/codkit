/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonValue } from './jsonOut.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';
import type { CycleState } from './cycleState.ts';
import { isDeliveredOwnFile, listOwnFiles, ownSourceRoot } from './ownCopy.ts';
import { ownCodeFilter } from './ownedRoots.ts';
import type { OwnedRoot } from './ownedRoots.ts';

/**
 * The delta paths a rename plan is written against: the contract tests of the
 * own layer, and the rest of the own code. Every directory the delta owns
 * contributes its own files - a rename inside the application directory has the
 * same references as one inside the own root (PROP-016 ##TYPE-AREA-LAYOUT) -
 * and the build outputs inside an owned directory contribute none, because they
 * are not own code.
 */
export function renameReferencePaths(
	patchesDir: string,
	roots: readonly OwnedRoot[]
): { readonly contractTests: readonly string[]; readonly own: readonly string[] } {
	const contractTests: string[] = [];
	const own: string[] = [];
	for (const owned of roots) {
		const options = { refuseSymlinks: true, keep: ownCodeFilter(owned) };
		for (const relative of listOwnFiles(ownSourceRoot(patchesDir, owned.deltaDir), options)) {
			if (!isDeliveredOwnFile(relative)) continue;
			(relative.startsWith('test/') ? contractTests : own).push(`${owned.deltaDir}/${relative}`);
		}
	}
	return { contractTests, own };
}

export function applyReportWrites(root: string, writes: readonly { path: string; previous: string | null; contents: string }[]): void {
	for (const write of writes) {
		const current = readText(root, write.path);
		if (current !== write.previous && current !== write.contents)
			throw ckError('ARTIFACT-BROKEN', `${write.path}: report changed after planning`);
		if (current === write.contents) continue;
		const path = contained(root, write.path);
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, write.contents, { flag: 'wx' });
			renameSync(temporary, path);
		} finally {
			removeOptional(temporary);
		}
	}
}

export function pendingAcknowledgement(document: string | null): string | null {
	if (document === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch {
		return null;
	}
	if (!isRecord(value) || value['acceptance'] !== 'pending') return null;
	return typeof value['acknowledgement'] === 'string' ? value['acknowledgement'] : null;
}

export function rebindAdvisoryState(document: string | null, state: CycleState): string | null {
	if (document === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch {
		return document;
	}
	if (!isRecord(value) || !isRecord(value['state'])) return document;
	const previous = value['state'];
	if (!isRecord(previous['sourcePin']) || !isRecord(previous['targetPin'])) return document;
	if (previous['sourcePin']['sha'] !== state.sourcePin.sha || previous['targetPin']['sha'] !== state.targetPin.sha) return null;
	return `${JSON.stringify({ ...value, state }, null, 2)}\n`;
}

export function stabilizeReportIsRed(document: string | null): boolean {
	if (document === null) return false;
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch {
		return false;
	}
	return isRecord(value) && isRecord(value['nextState']) && value['nextState']['phase'] === 'resolve';
}

export function stabilizeReportMatchesCycle(document: string | null, state: CycleState): boolean {
	if (document === null) return false;
	let value: unknown;
	try {
		value = JSON.parse(document);
	} catch {
		return true;
	}
	if (!isRecord(value) || !isRecord(value['basis']) || !isRecord(value['basis']['state'])) return true;
	const previous = value['basis']['state'];
	return (
		isRecord(previous['sourcePin']) &&
		isRecord(previous['targetPin']) &&
		previous['sourcePin']['sha'] === state.sourcePin.sha &&
		previous['targetPin']['sha'] === state.targetPin.sha
	);
}

export function removeExactText(root: string, relative: string, expected: string): void {
	if (readText(root, relative) !== expected) throw ckError('ARTIFACT-BROKEN', `${relative}: report changed before cleanup`);
	unlinkSync(contained(root, relative));
}

export function fileDigest(root: string, relative: string): string | null {
	try {
		return createHash('sha256')
			.update(readFileSync(contained(root, relative)))
			.digest('hex');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export function readText(root: string, relative: string): string | null {
	try {
		return readFileSync(contained(root, relative), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

export function byteSorted(values: readonly string[]): readonly string[] {
	return [...new Set(values)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

export function toJson(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value.map(toJson);
	if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
	return String(value);
}

function contained(root: string, relative: string): string {
	const resolved = resolveContainedPath(root, relative, { allowMissing: true });
	if (!resolved.ok) throw ckError('ARTIFACT-BROKEN', `${relative}: ${resolved.reason}`);
	return resolved.absolute;
}
function removeOptional(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
