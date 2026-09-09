/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Exact non-patch snapshot validation for resolve and crash recovery.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CycleResolveArtifact } from './cycleResolve.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';

export function validateCycleResolveSnapshots(artifact: CycleResolveArtifact): void {
	const snapshots = artifact.patchsetSnapshots ?? [];
	const paths = sorted(artifact.patchesPaths);
	if (snapshots.length !== paths.length || new Set(snapshots.map((item) => item.path)).size !== snapshots.length) fail(artifact);
	const ordered = [...snapshots].sort((left, right) => compare(left.path, right.path));
	for (const [index, path] of paths.entries()) {
		const snapshot = ordered[index];
		if (snapshot?.path !== path || (snapshot.sha256 !== null && !/^[0-9a-f]{64}$/.test(snapshot.sha256))) fail(artifact);
	}
}

export function cycleResolveSnapshotMismatch(
	patchesDir: string,
	dirtyPaths: readonly string[],
	artifact: CycleResolveArtifact,
	requireDirty = true
): readonly string[] {
	const dirty = new Set(dirtyPaths);
	return (artifact.patchsetSnapshots ?? []).flatMap((snapshot): readonly string[] => {
		if (requireDirty && !dirty.has(snapshot.path)) return [`${snapshot.path} (not changed)`];
		const bytes = optionalBytes(patchesDir, snapshot.path);
		const digest = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
		return digest === snapshot.sha256 ? [] : [`${snapshot.path} (bytes differ)`];
	});
}

function optionalBytes(root: string, path: string): Uint8Array | null {
	const resolved = resolveContainedPath(root, path, { allowMissing: true });
	if (!resolved.ok) throw ckError('ARTIFACT-BROKEN', `unsafe resolve snapshot ${path}: ${resolved.reason}`);
	try {
		return readFileSync(resolved.absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function fail(artifact: CycleResolveArtifact): never {
	throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: non-patch snapshots are invalid or incomplete`);
}
function sorted(values: readonly string[]): readonly string[] {
	return [...values].sort(compare);
}
function compare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}
