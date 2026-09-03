/** @scope spec://codkit/modules/codkit/PROP-008#classify */
// Read-only patch classification for an upgrade from one pin to another.
//
// The work tree and index are deliberately absent from this module's model:
// source bytes come from git objects, exact patch application happens in
// memory, and the only files written are private merge-file scratch inputs.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUnified } from './applyUnified.js';
import { bytesEqual, encodeUtf8 } from './bytes.js';
import { runGit, runGitBytes } from './gitx.js';
import { checkOverlay } from './layers/overlay.js';
import { countRuleMatches } from './layers/rule.js';
import { ckError, isCkError } from './messages.js';
import { repoRelativePathProblem } from './pathSafety.js';
/** Exact cycle-state vocabulary of PROP-008 ##OUTCOME-CLASS-NAMES. */
export const CLASSIFICATION_OUTCOMES = [
    'clean',
    'shifted',
    'merged',
    'conflict',
    'target-deleted',
    'target-renamed',
    'rule-broken',
    'contract-failed'
];
export const PATCH_CLASSIFICATION_OUTCOMES = ['clean', 'shifted', 'merged', 'conflict', 'target-deleted'];
/**
 * Classify one patch without changing refs, the index, or work-tree files.
 * A rename mapping separates the base path from the current path. Without one,
 * both default to the target carried by the parsed patch.
 */
export function classifyPatchArtifact(options) {
    const { artifact, treeDir, oldPin, newRef } = options;
    const targets = patchTargets(options);
    const identity = {
        artifactPath: artifact.artifactPath,
        artifactId: artifact.patch.header.id,
        targetPath: targets.current
    };
    assertCommit(treeDir, oldPin);
    const oldObject = blobAtRef(treeDir, oldPin, targets.base);
    const base = artifact.patch.isAddFile
        ? requireAbsentAtOldPin(oldObject, oldPin, artifact, targets.base)
        : requireOldBytes(oldObject, oldPin, artifact, targets.base);
    assertCommit(treeDir, newRef);
    const newObject = blobAtRef(treeDir, newRef, targets.current);
    if (!artifact.patch.isAddFile && newObject === null) {
        return { ...identity, outcome: 'target-deleted', bytes: null, materials: null };
    }
    // Absence at both pins is the normal base/ours state of an add-file patch.
    // If upstream independently added the path, its actual bytes participate in
    // the same three-way merge against an empty base.
    const ours = newObject ?? new Uint8Array(0);
    const theirs = applyUnified(base, patchAtTarget(artifact.patch, targets.base));
    const materials = {
        base,
        baseExists: !artifact.patch.isAddFile,
        ours,
        oursExists: newObject !== null,
        theirs
    };
    if (bytesEqual(ours, base)) {
        return { ...identity, outcome: 'clean', bytes: theirs, materials };
    }
    const merged = (options.mergeFile ?? runMergeFile)({
        treeDir,
        targetPath: targets.current,
        ours,
        base,
        theirs
    });
    if (merged.hasConflicts) {
        return { ...identity, outcome: 'conflict', bytes: merged.bytes, materials };
    }
    return {
        ...identity,
        outcome: appliesExactly(ours, patchAtTarget(artifact.patch, targets.current)) ? 'shifted' : 'merged',
        bytes: merged.bytes,
        materials
    };
}
/** Classify the complete input list, retaining conflicts as values and continuing. */
export function classifyPatchArtifacts(options) {
    return options.artifacts.map((artifact) => classifyPatchArtifact({
        treeDir: options.treeDir,
        artifact,
        oldPin: options.oldPin,
        newRef: options.newRef,
        ...(artifact.baseTargetPath === undefined ? {} : { baseTargetPath: artifact.baseTargetPath }),
        ...(artifact.newTargetPath === undefined ? {} : { newTargetPath: artifact.newTargetPath }),
        ...(options.mergeFile === undefined ? {} : { mergeFile: options.mergeFile })
    }));
}
/**
 * Classify patches, rewrite rules, and overlays in input order. Conflicts,
 * rule mismatches, overlay drift, and deletions are values, so none of them
 * truncates the list. Invalid refs and unreadable objects remain loud failures.
 */
export function classifyArtifacts(options) {
    assertCommit(options.treeDir, options.oldPin);
    assertCommit(options.treeDir, options.newRef);
    return options.artifacts.map((artifact) => {
        switch (artifact.kind) {
            case 'patch': {
                const classified = classifyPatchArtifact({
                    treeDir: options.treeDir,
                    artifact,
                    oldPin: options.oldPin,
                    newRef: options.newRef,
                    ...(artifact.baseTargetPath === undefined ? {} : { baseTargetPath: artifact.baseTargetPath }),
                    ...(artifact.newTargetPath === undefined ? {} : { newTargetPath: artifact.newTargetPath }),
                    ...(options.mergeFile === undefined ? {} : { mergeFile: options.mergeFile })
                });
                return { ...classified, kind: 'patch', layer: artifact.patch.header.layer };
            }
            case 'rule':
                return classifyRule(options.treeDir, options.newRef, artifact.rule);
            case 'overlay':
                return classifyOverlay(options.treeDir, options.newRef, artifact.overlay);
        }
    });
}
/** Default `git merge-file -p --diff3` implementation over private scratch files. */
export const runMergeFile = (request) => {
    const scratch = mkdtempSync(join(tmpdir(), 'codkit-classify-'));
    const oursPath = join(scratch, 'ours');
    const basePath = join(scratch, 'base');
    const theirsPath = join(scratch, 'theirs');
    try {
        writeFileSync(oursPath, request.ours);
        writeFileSync(basePath, request.base);
        writeFileSync(theirsPath, request.theirs);
        const result = runGit({
            args: ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath],
            cwd: request.treeDir
        });
        // merge-file returns the number of conflicts, capped at 127. An error is
        // negative in git and reaches Node as a shell-style status above 127.
        if (result.status > 127) {
            throw ckError('INTERNAL', `git merge-file failed for ${request.targetPath}: ${firstDiagnostic(result.stderr, result.stdout)}`, 'check that git >= 2.40 is installed and re-run the classification');
        }
        return { bytes: encodeUtf8(result.stdout), hasConflicts: result.status !== 0 };
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};
function appliesExactly(bytes, patch) {
    try {
        applyUnified(bytes, patch);
        return true;
    }
    catch (error) {
        if (isCkError(error)) {
            return false;
        }
        throw error;
    }
}
function assertCommit(treeDir, ref) {
    const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd: treeDir });
    if (resolved.status !== 0) {
        throw ckError('PIN-UNREACHABLE', `cannot classify patches because ref ${ref} is not reachable in the fork tree`, `fetch ${ref} into the fork tree outside codkit, then re-run the classification`);
    }
}
function requireOldBytes(object, oldPin, artifact, baseTargetPath) {
    if (object !== null) {
        return object;
    }
    throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: ${baseTargetPath} does not exist at old pin ${oldPin}`, 'the patch must be regenerated against a pin where its target exists', artifact.artifactPath);
}
function requireAbsentAtOldPin(object, oldPin, artifact, baseTargetPath) {
    if (object === null) {
        return new Uint8Array(0);
    }
    throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: add-file target ${baseTargetPath} already exists at old pin ${oldPin}`, 'the patch must be regenerated as an edit patch against the existing upstream file', artifact.artifactPath);
}
function patchTargets(options) {
    const base = options.baseTargetPath ?? options.artifact.patch.targetPath;
    const current = options.newTargetPath ?? options.artifact.patch.targetPath;
    assertMappedTarget(base, 'baseTargetPath', options.artifact);
    assertMappedTarget(current, 'newTargetPath', options.artifact);
    return { base, current };
}
function assertMappedTarget(path, field, artifact) {
    const problem = repoRelativePathProblem(path);
    if (problem === null) {
        return;
    }
    throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: ${field} ${JSON.stringify(path)} ${problem}`, 'rename mappings must use canonical repository-relative POSIX file paths', artifact.artifactPath);
}
function patchAtTarget(patch, targetPath) {
    return patch.targetPath === targetPath ? patch : { ...patch, targetPath };
}
function classifyRule(treeDir, newRef, rule) {
    const identity = {
        artifactPath: rule.artifactPath,
        artifactId: rule.id,
        targetPath: rule.target
    };
    const targetBytes = blobAtRef(treeDir, newRef, rule.target);
    if (targetBytes === null) {
        return {
            ...identity,
            kind: 'rule',
            layer: 'rewrite-rule',
            outcome: 'target-deleted',
            targetBytes: null,
            matches: null,
            expectedMatches: rule.expectedMatches
        };
    }
    const matches = countRuleMatches(rule, targetBytes);
    return {
        ...identity,
        kind: 'rule',
        layer: 'rewrite-rule',
        outcome: matches.total === rule.expectedMatches ? 'clean' : 'rule-broken',
        targetBytes,
        matches,
        expectedMatches: rule.expectedMatches
    };
}
function classifyOverlay(treeDir, newRef, overlay) {
    const identity = {
        artifactPath: overlay.artifactPath,
        artifactId: overlay.id,
        targetPath: overlay.target
    };
    const targetBytes = blobAtRef(treeDir, newRef, overlay.target);
    if (targetBytes === null) {
        return {
            ...identity,
            kind: 'overlay',
            layer: 'config-overlay',
            outcome: 'target-deleted',
            targetBytes: null,
            report: null
        };
    }
    const report = checkOverlay(overlay, { treeDir, pinSha: newRef, pinOnly: true });
    return {
        ...identity,
        kind: 'overlay',
        layer: 'config-overlay',
        outcome: report.drift.length === 0 ? 'clean' : 'conflict',
        targetBytes,
        report
    };
}
/**
 * Read one path through Git plumbing. ls-tree distinguishes a genuinely absent
 * path from a damaged/unreadable object; cat-file preserves blob stdout bytes.
 */
function blobAtRef(treeDir, ref, targetPath) {
    const listed = runGit({
        args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', targetPath],
        cwd: treeDir
    });
    if (listed.status !== 0) {
        throw objectReadError(targetPath, ref, 'inspect the target', listed.status, listed.stderr, listed.stdout);
    }
    const records = listed.stdout.split('\0').filter((record) => record !== '');
    if (records.length === 0) {
        return null;
    }
    if (records.length !== 1) {
        throw ckError('ARTIFACT-BROKEN', `cannot read ${targetPath} at ${ref}: git ls-tree returned ${records.length} entries for one literal path`, 'check that the artifact target is one repository-relative file path', targetPath);
    }
    const record = records[0] ?? '';
    const tab = record.indexOf('\t');
    const fields = (tab === -1 ? record : record.slice(0, tab)).split(' ');
    const listedPath = tab === -1 ? '' : record.slice(tab + 1);
    const type = fields[1];
    const objectId = fields[2];
    if (listedPath !== targetPath || type !== 'blob' || objectId === undefined || !/^[0-9a-f]{40}$/i.test(objectId)) {
        throw ckError('ARTIFACT-BROKEN', `cannot read ${targetPath} at ${ref}: git ls-tree did not identify one blob at that exact path`, 'the artifact target must be a regular file carried by the selected commit', targetPath);
    }
    const blob = runGitBytes({ args: ['cat-file', 'blob', objectId], cwd: treeDir });
    if (blob.status !== 0) {
        throw objectReadError(targetPath, ref, `read blob ${objectId}`, blob.status, blob.stderr, '');
    }
    return blob.stdout;
}
function objectReadError(targetPath, ref, action, status, stderr, stdout) {
    return ckError('ARTIFACT-BROKEN', `cannot ${action} ${targetPath} at ${ref}: ${firstDiagnostic(stderr, stdout)} (git exit ${status})`, 'check the fork repository with git fsck and restore every object before classifying the upgrade', targetPath);
}
function firstDiagnostic(stderr, stdout) {
    for (const text of [stderr, stdout]) {
        const line = text.trim().split('\n')[0];
        if (line !== undefined && line !== '') {
            return line;
        }
    }
    return 'git exited without a diagnostic';
}
