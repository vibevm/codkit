/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Exact non-patch snapshot validation for resolve and crash recovery.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
export function validateCycleResolveSnapshots(artifact) {
    const snapshots = artifact.patchsetSnapshots ?? [];
    const paths = sorted(artifact.patchesPaths);
    if (snapshots.length !== paths.length || new Set(snapshots.map((item) => item.path)).size !== snapshots.length)
        fail(artifact);
    const ordered = [...snapshots].sort((left, right) => compare(left.path, right.path));
    for (const [index, path] of paths.entries()) {
        const snapshot = ordered[index];
        if (snapshot?.path !== path || (snapshot.sha256 !== null && !/^[0-9a-f]{64}$/.test(snapshot.sha256)))
            fail(artifact);
    }
}
export function cycleResolveSnapshotMismatch(patchesDir, dirtyPaths, artifact, requireDirty = true) {
    const dirty = new Set(dirtyPaths);
    return (artifact.patchsetSnapshots ?? []).flatMap((snapshot) => {
        if (requireDirty && !dirty.has(snapshot.path))
            return [`${snapshot.path} (not changed)`];
        const bytes = optionalBytes(patchesDir, snapshot.path);
        const digest = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
        return digest === snapshot.sha256 ? [] : [`${snapshot.path} (bytes differ)`];
    });
}
function optionalBytes(root, path) {
    const resolved = resolveContainedPath(root, path, { allowMissing: true });
    if (!resolved.ok)
        throw ckError('ARTIFACT-BROKEN', `unsafe resolve snapshot ${path}: ${resolved.reason}`);
    try {
        return readFileSync(resolved.absolute);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function fail(artifact) {
    throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: non-patch snapshots are invalid or incomplete`);
}
function sorted(values) {
    return [...values].sort(compare);
}
function compare(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
