/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
// Replay feature-only patches from HEAD^1 over an object-only HEAD^2 baseline.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { findCause } from './cause.js';
import { buildGeneratedTip } from './syncEngine.js';
import { detectRenames } from './renames.js';
import { gitOk, runGit, runGitBytes } from './gitx.js';
import { applyUnified } from './applyUnified.js';
import { bytesEqual } from './bytes.js';
import { loadConventions } from './conventionsFile.js';
import { devChannelFile } from './layers/overlay.js';
import { sha256 } from './renameFileState.js';
import { ckError } from './messages.js';
import { encodePatchName, parseCkpatch, serializeCkpatch } from './patchFormat.js';
import { resolveContainedPath } from './pathSafety.js';
import { replayPatch } from './replayPatch.js';
import { prepareRebaseGraph } from './rebaseOntoPinGraph.js';
import { materializeRebaseDesiredTree } from './rebaseOntoPinMove.js';
import { hasRebasePendingRecords, rebaseHeaderMetadataSha256, writeRebasePending } from './rebaseOntoPinPending.js';
import { runSave } from './saveEngine.js';
import { PATCHES_DIR } from './syncEngine.js';
/** Execute one clean two-parent rebase without moving a real ref or index. */
export function rebaseOntoPin(options) {
    const graph = prepareRebaseGraph(options.patchesDir, options.type, options.resolution.path, options.config);
    const scratch = createScratchFork(options.resolution.path);
    try {
        const sourceBaseline = buildGeneratedTip({
            patchesDir: graph.sourcePatchesDir,
            resolution: { path: scratch.dir, source: 'flag', exists: true, warning: null },
            config: graph.sourceConfig,
            type: options.type,
            out: options.out,
            verbose: options.verbose === true,
            patchSetCommit: graph.featureParent,
            patchesRepositoryRoot: options.patchesDir
        });
        const baseline = buildGeneratedTip({
            patchesDir: graph.targetPatchesDir,
            resolution: { path: scratch.dir, source: 'flag', exists: true, warning: null },
            config: graph.targetConfig,
            type: options.type,
            out: options.out,
            verbose: options.verbose === true,
            patchSetCommit: graph.targetParent,
            patchesRepositoryRoot: options.patchesDir
        });
        const renames = detectRenames({
            cwd: options.resolution.path,
            oldPin: graph.sourceConfig.pin.sha,
            newPin: graph.targetConfig.pin.sha,
            fromTargets: graph.featurePatches.map((entry) => entry.patch.targetPath),
            ...(options.similarity === undefined ? {} : { threshold: options.similarity })
        });
        const renameByOld = new Map(renames.map((rename) => [rename.from, rename]));
        const prepared = graph.featurePatches.map((feature) => preparePatch(options, graph.sourceConfig.pin.sha, graph.targetConfig.pin, scratch.dir, baseline, feature, renameByOld.get(feature.patch.targetPath)));
        assertPatchSetArtifactStates(options, prepared, graph.targetConfig.pin.sha);
        const desiredTree = buildDesiredTree(scratch.dir, baseline, prepared);
        // The dev-channel sidecar of this family is written by `load` and ignored
        // by the tree, so it is not unrelated dirt (##OVERLAY-TWO-CHANNELS).
        const devChannel = devChannelFile(options.type);
        const devChannelPaths = devChannel === null ? [] : [devChannel];
        const move = materializeRebaseDesiredTree({
            patchesDir: options.patchesDir,
            treeDir: options.resolution.path,
            scratchTree: scratch.dir,
            desiredTree,
            patchsetHead: graph.head,
            allowedOwnBeforeTree: sourceBaseline,
            allowedIgnoredPrefix: `${graph.targetConfig.typeConfig.ownRoot}/`,
            allowedIgnoredPaths: devChannelPaths,
            allowCompletedRollover: !hasRebasePendingRecords(options.patchesDir),
            completedCheckpoint: () => options.checkpoint?.('after-complete'),
            ...(options.moveCheckpoint === undefined ? {} : { checkpoint: options.moveCheckpoint }),
            ...(options.moveTempCheckpoint === undefined ? {} : { tempCheckpoint: options.moveTempCheckpoint })
        });
        options.checkpoint?.('after-move');
        reconcilePatchSetArtifactRenames(options, prepared);
        const satisfiedArtifacts = assertPatchSetArtifactStates(options, prepared, graph.targetConfig.pin.sha);
        for (const entry of prepared) {
            if (entry.outcome === 'conflict') {
                writeRebasePending(options.patchesDir, {
                    ...entry.override,
                    artifactSha256: entry.originalArtifactSha256,
                    headerMetadataSha256: entry.headerMetadataSha256,
                    desiredTree
                });
                options.checkpoint?.('during-pending', entry.artifactPath);
            }
        }
        const automatic = prepared.filter((entry) => (entry.outcome === 'clean' || entry.outcome === 'shifted' || entry.outcome === 'merged' || entry.outcome === 'target-renamed') &&
            !satisfiedArtifacts.has(entry.artifactPath));
        options.checkpoint?.('before-save');
        const save = automatic.length === 0 ? null : saveAutomatic(options, graph.targetConfig, automatic);
        options.checkpoint?.('after-save');
        const patches = prepared.map(stripPrepared);
        const blockers = patches.filter((entry) => entry.outcome === 'conflict' || entry.outcome === 'target-deleted');
        const exitCode = save?.exitCode === 2 ? 2 : blockers.length > 0 || (save !== null && save.exitCode !== 0) ? 1 : 0;
        if (save === null || save.exitCode === 0)
            move.complete();
        return {
            exitCode,
            sourcePin: { tag: graph.sourceConfig.pin.tag, sha: graph.sourceConfig.pin.sha },
            targetPin: { tag: graph.targetConfig.pin.tag, sha: graph.targetConfig.pin.sha },
            mergeBase: graph.mergeBase,
            patches,
            blockers,
            save
        };
    }
    finally {
        scratch.release();
        graph.release();
    }
}
function assertPatchSetArtifactStates(options, prepared, targetPin) {
    const conventions = loadConventions(options.type, options.patchesDir);
    const satisfied = new Set();
    for (const entry of prepared) {
        const oldBytes = optionalFile(options.patchesDir, entry.mergedArtifactPath);
        const current = optionalFile(options.patchesDir, entry.artifactPath);
        if (entry.mergedArtifactPath !== entry.artifactPath && oldBytes !== null && !bytesEqual(oldBytes, entry.mergedArtifactBytes)) {
            throw ckError('ARTIFACT-BROKEN', `${entry.mergedArtifactPath}: pending artifact rename source was modified`);
        }
        if (current === null) {
            if (entry.mergedArtifactPath !== entry.artifactPath && oldBytes !== null)
                continue;
            if (entry.replay.bytes === null)
                throw ckError('ARTIFACT-BROKEN', `${entry.artifactPath}: pending rebase artifact disappeared`);
            const pin = blobState(options.resolution.path, targetPin, entry.targetPath);
            if (!pin.exists || !bytesEqual(pin.bytes, entry.replay.bytes))
                throw ckError('ARTIFACT-BROKEN', `${entry.artifactPath}: missing patch is not redundant at target pin`);
            satisfied.add(entry.artifactPath);
            continue;
        }
        if (bytesEqual(current, entry.originalArtifactBytes))
            continue;
        if (entry.replay.bytes === null)
            throw ckError('ARTIFACT-BROKEN', `${entry.artifactPath}: pending rebase artifact state is not authorized`);
        const patch = parseCkpatch(current, conventions, entry.artifactPath);
        if (!sameRebasedHeader(entry, patch))
            throw ckError('ARTIFACT-BROKEN', `${entry.artifactPath}: pending rebase header is not exact`);
        const pin = blobState(options.resolution.path, targetPin, entry.targetPath);
        const applied = applyUnified(pin.bytes, patch);
        if (pin.exists === patch.isAddFile || !bytesEqual(applied, entry.replay.bytes)) {
            throw ckError('ARTIFACT-BROKEN', `${entry.artifactPath}: pending rebase body is not the exact replay output`);
        }
        if (entry.mergedArtifactPath !== entry.artifactPath && oldBytes !== null) {
            throw ckError('ARTIFACT-BROKEN', `${entry.mergedArtifactPath}: completed artifact rename left its old path`);
        }
        satisfied.add(entry.artifactPath);
    }
    return satisfied;
}
function sameRebasedHeader(entry, patch) {
    const before = entry.sourcePatch.header;
    const after = patch.header;
    return (patch.targetPath === entry.targetPath &&
        after.id === before.id &&
        after.layer === before.layer &&
        after.layerExplicit === before.layerExplicit &&
        after.type === before.type &&
        after.category === before.category &&
        after.owner === before.owner &&
        after.reason === before.reason &&
        after.link === before.link &&
        after.cause === entry.override.cause &&
        after.pin === `${entry.override.pin.tag}@${entry.override.pin.sha}` &&
        JSON.stringify(after.contractTests) === JSON.stringify(before.contractTests));
}
function reconcilePatchSetArtifactRenames(options, prepared) {
    const patchesDir = options.patchesDir;
    for (const entry of prepared) {
        if (entry.mergedArtifactPath === entry.artifactPath)
            continue;
        const old = optionalFile(patchesDir, entry.mergedArtifactPath);
        const current = optionalFile(patchesDir, entry.artifactPath);
        const tempPath = `${entry.artifactPath}.codkit-rebase-rename.tmp`;
        const temp = optionalFile(patchesDir, tempPath);
        if (old !== null && !bytesEqual(old, entry.mergedArtifactBytes))
            throw ckError('ARTIFACT-BROKEN', `${entry.mergedArtifactPath}: artifact rename source changed`);
        if (temp !== null && !bytesEqual(temp, entry.originalArtifactBytes)) {
            throw ckError('ARTIFACT-BROKEN', `${tempPath}: artifact rename temp differs from durable bytes`);
        }
        if (current !== null && !bytesEqual(current, entry.originalArtifactBytes)) {
            // A prior partial save is validated by the second artifact-state pass.
            if (old !== null)
                throw ckError('ARTIFACT-BROKEN', `${entry.artifactPath}: artifact rename destination collision`);
        }
        else if (current === null) {
            if (old === null)
                throw ckError('ARTIFACT-BROKEN', `${entry.artifactPath}: both artifact rename paths are absent`);
            if (temp === null)
                atomicWrite(options, entry.artifactPath, entry.originalArtifactBytes);
            else
                renameSync(containedPatchesPath(patchesDir, tempPath, false), containedPatchesPath(patchesDir, entry.artifactPath, true));
        }
        if (temp !== null && optionalFile(patchesDir, tempPath) !== null)
            rmSync(containedPatchesPath(patchesDir, tempPath, false), { force: true });
        if (old !== null)
            unlinkSync(containedPatchesPath(patchesDir, entry.mergedArtifactPath, false));
    }
}
function optionalFile(root, path) {
    try {
        return readFileSync(containedPatchesPath(root, path, true));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function atomicWrite(options, path, bytes) {
    const root = options.patchesDir;
    let target = containedPatchesPath(root, path, true);
    mkdirSync(dirname(target), { recursive: true });
    target = containedPatchesPath(root, path, true);
    const temporary = containedPatchesPath(root, `${path}.codkit-rebase-rename.tmp`, true);
    rmSync(temporary, { force: true });
    let completed = false;
    try {
        writeFileSync(temporary, bytes, { flag: 'wx' });
        options.artifactRenameTempCheckpoint?.(path);
        renameSync(temporary, target);
        completed = true;
    }
    finally {
        if (completed)
            rmSync(temporary, { force: true });
    }
}
function containedPatchesPath(root, path, allowMissing) {
    const resolved = resolveContainedPath(root, path, allowMissing ? { allowMissing: true } : {});
    if (!resolved.ok)
        throw ckError('ARTIFACT-BROKEN', `${path}: unsafe rebase artifact path: ${resolved.reason}`);
    return resolved.absolute;
}
function preparePatch(options, oldPin, targetPin, scratchTree, baseline, feature, rename) {
    const targetPath = rename?.to ?? feature.patch.targetPath;
    const expectedArtifact = `${PATCHES_DIR}/${encodePatchName(targetPath)}`;
    if (feature.artifactPath !== expectedArtifact && rename === undefined) {
        throw ckError('CONFIG', `${feature.artifactPath}: merged patch path does not match replay target ${targetPath}`);
    }
    const originalArtifactBytes = feature.artifactPath === expectedArtifact ? feature.mergedBytes : serializeCkpatch({ ...feature.patch, targetPath });
    const base = blobState(options.resolution.path, oldPin, feature.patch.targetPath);
    const ours = blobState(scratchTree, baseline, targetPath);
    const replay = replayPatch({
        treeDir: scratchTree,
        targetPath,
        base: base.bytes,
        baseExists: base.exists,
        ours: ours.bytes,
        oursExists: ours.exists,
        patch: feature.patch
    });
    const mode = ours.mode ?? base.mode ?? '100644';
    const outcome = rename !== undefined && replay.outcome === 'clean' ? 'target-renamed' : replay.outcome;
    const foundCause = outcome === 'clean' ? null : causeOf(options.resolution.path, oldPin, targetPin.sha, feature, replay, rename);
    const headerCause = outcome === 'clean' ? feature.patch.header.cause : (foundCause?.sha ?? feature.patch.header.cause);
    const cause = foundCause ?? { sha: feature.patch.header.cause === 'none' ? null : feature.patch.header.cause, approx: false };
    const override = {
        targetPath,
        artifactPath: expectedArtifact,
        artifactId: feature.patch.header.id,
        cause: headerCause,
        pin: { tag: targetPin.tag, sha: targetPin.sha }
    };
    return {
        artifactPath: expectedArtifact,
        artifactId: feature.patch.header.id,
        sourceTarget: feature.patch.targetPath,
        targetPath,
        outcome,
        cause,
        replay,
        headerCause,
        override,
        mode,
        originalArtifactSha256: sha256(originalArtifactBytes),
        headerMetadataSha256: rebaseHeaderMetadataSha256(feature.patch.header),
        mergedArtifactPath: feature.artifactPath,
        mergedArtifactBytes: feature.mergedBytes,
        originalArtifactBytes,
        sourcePatch: feature.patch
    };
}
function causeOf(treeDir, oldPin, newPin, feature, replay, rename) {
    const lifecycle = rename !== undefined
        ? { outcome: 'target-renamed', newTarget: rename.to }
        : replay.outcome === 'target-deleted'
            ? { outcome: 'target-deleted' }
            : undefined;
    return findCause({
        cwd: treeDir,
        oldPin,
        newPin,
        target: feature.patch.targetPath,
        ranges: feature.patch.hunks
            .filter((hunk) => hunk.countOld > 0)
            .map((hunk) => ({ start: Math.max(1, hunk.startOld), end: Math.max(1, hunk.startOld) + hunk.countOld - 1 })),
        ...(lifecycle === undefined ? {} : { lifecycle })
    });
}
function saveAutomatic(options, config, prepared) {
    return runSave({
        patchesDir: options.patchesDir,
        resolution: options.resolution,
        config,
        type: options.type,
        out: options.out,
        paths: prepared.map((entry) => entry.targetPath),
        allowNewFile: prepared.filter((entry) => !entry.replay.materials.baseExists).map((entry) => entry.targetPath),
        commit: false,
        message: null,
        verbose: options.verbose === true,
        patchHeaderOverrides: prepared.map((entry) => entry.override),
        forcedPaths: prepared.map((entry) => entry.targetPath),
        deferSync: true,
        // The rebase path moves the artifacts itself - it replays feature
        // patches onto a new pin and hands `save` the regeneration - so the
        // delta under the tree is its own doing (campaign decision D18).
        skipPatchsetMovedCheck: true
    });
}
function buildDesiredTree(scratchTree, baseline, prepared) {
    const index = join(scratchTree, '.git/rebase-onto-pin.index');
    const blobFile = join(scratchTree, '.git/rebase-onto-pin.blob');
    const env = { GIT_INDEX_FILE: index };
    rmSync(index, { force: true });
    try {
        mustScratch(scratchTree, ['read-tree', baseline], env, 'seed the complete target baseline');
        for (const entry of prepared) {
            if (entry.replay.bytes === null)
                continue;
            writeFileSync(blobFile, entry.replay.bytes);
            const blob = mustScratch(scratchTree, ['hash-object', '-w', '--no-filters', '--', blobFile], env, `store ${entry.targetPath}`);
            mustScratch(scratchTree, ['update-index', '--add', '--cacheinfo', `${entry.mode},${blob},${entry.targetPath}`], env, `stage ${entry.targetPath}`);
        }
        return mustScratch(scratchTree, ['write-tree'], env, 'write the complete desired tree');
    }
    finally {
        rmSync(index, { force: true });
        rmSync(blobFile, { force: true });
    }
}
function stripPrepared(entry) {
    return {
        artifactPath: entry.artifactPath,
        artifactId: entry.artifactId,
        sourceTarget: entry.sourceTarget,
        targetPath: entry.targetPath,
        outcome: entry.outcome,
        cause: entry.cause
    };
}
function blobState(treeDir, ref, path) {
    const listed = runGit({ args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', path], cwd: treeDir });
    if (listed.status !== 0 || (listed.stdout !== '' && !listed.stdout.endsWith('\0')))
        throw ckError('ARTIFACT-BROKEN', `cannot inspect ${path} at ${ref}`);
    if (listed.stdout === '')
        return { exists: false, bytes: new Uint8Array(0), mode: null };
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)\0$/.exec(listed.stdout);
    if (match === null || match[3] !== path)
        throw ckError('ARTIFACT-BROKEN', `${path} is not one regular blob at ${ref}`);
    const blob = runGitBytes({ args: ['cat-file', 'blob', match[2] ?? ''], cwd: treeDir });
    if (blob.status !== 0)
        throw ckError('ARTIFACT-BROKEN', `cannot read ${path} at ${ref}`);
    return { exists: true, bytes: blob.stdout, mode: match[1] };
}
function createScratchFork(realTree) {
    const root = mkdtempSync(join(tmpdir(), 'codkit-rebase-fork-'));
    const dir = join(root, 'tree');
    const release = () => rmSync(root, { recursive: true, force: true });
    try {
        gitOk({ args: ['init', '--quiet', dir], cwd: root }, { code: 'INTERNAL', message: 'cannot create rebase scratch repository' });
        const common = gitOk({ args: ['rev-parse', '--git-common-dir'], cwd: realTree }, { code: 'INTERNAL', message: 'cannot locate fork object directory' }).stdout.trim();
        const objects = join(isAbsolute(common) ? common : resolve(realTree, common), 'objects');
        const alternates = join(dir, '.git/objects/info/alternates');
        mkdirSync(dirname(alternates), { recursive: true });
        writeFileSync(alternates, `${objects}\n`, 'utf8');
        return { dir, release };
    }
    catch (error) {
        release();
        throw error;
    }
}
function mustScratch(cwd, args, env, action) {
    return gitOk({ args, cwd, env }, {
        code: 'ARTIFACT-BROKEN',
        message: `cannot ${action} while preparing rebase worktree`,
        hint: 'repair the fork object database and retry'
    }).stdout.trim();
}
