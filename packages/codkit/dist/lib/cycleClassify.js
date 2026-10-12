/** @scope spec://codkit/modules/codkit/PROP-009#state */
import { pinKey } from './pinIdentity.js';
import { assertSourceToTargetAncestry } from './cycleControlGit.js';
// Complete deterministic classification for cycle phase apply. Preview is
// read-only. The separate apply entry point requires both live orchestrator
// locks and recovers a durable rename transaction before parsing inventory.
import { lstatSync } from 'node:fs';
import { classifyArtifacts } from './classifyEngine.js';
import { findCause } from './cause.js';
import { classifyCycleResources, loadCycleClassificationInventory } from './cycleClassifyLayers.js';
import { clearCycleClassifyRecovery, makeCycleClassifyRecovery, readCycleClassifyRecovery, writeCycleClassifyRecovery } from './cycleClassifyRecovery.js';
import { treeId } from './fingerprint.js';
import { runGit } from './gitx.js';
import { assertOwnedLockHandle, lockPath, readLock } from './lock.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
import { applyPatchRenameBatch, buildPatchRenameBatch, RENAME_TRANSACTION_PATH, resumePatchRenameTransaction } from './renameApply.js';
import { detectRenames } from './renames.js';
import { CYCLE_ARTIFACT_OUTCOMES } from './cycleState.js';
import { encodePatchName } from './patchFormat.js';
import { planPatchArtifactRename } from './renames.js';
const CYCLE_LOCK_ID = 'cycle-global';
/** Read-only proposal. A pending durable rename must be resumed by apply first. */
export function previewCycleApply(options) {
    assertCycleInput(options);
    if (renameTransactionExists(options.patchesDir) || readCycleClassifyRecovery(options.patchesDir) !== null) {
        throw broken(`pending durable rename requires locked apply recovery before inventory can be read`);
    }
    return classifyPrepared(options, false);
}
/** Backward-compatible read-only name; it can no longer authorize writes. */
export const classifyCycleApply = previewCycleApply;
/** Mutating rename path, callable only with both currently live cycle locks. */
export function applyCycleClassification(options) {
    assertCycleInput(options);
    assertLiveLocks(options);
    recoverRenameBeforeInventory(options);
    return classifyPrepared(options, true);
}
export function classifyUpgradeInventory(options) {
    const { treeDir, oldPin, newRef, mergeFile } = options;
    const inventory = loadCycleClassificationInventory(options.patchesDir, options.type, options.expectedPin, options.layerRuntime);
    const detected = detectRenames({
        cwd: treeDir,
        oldPin,
        newPin: newRef,
        ...(options.similarity === undefined ? {} : { threshold: options.similarity })
    });
    const patchRenames = relevantPatchRenames(inventory, detected);
    const classified = classifyLoadedUpgrade(options.type, treeDir, oldPin, newRef, inventory, detected, patchRenames, mergeFile);
    return {
        inventory,
        renames: relevantCycleRenames(inventory, detected).map(({ from, to, similarity }) => ({ from, to, similarity })),
        ...classified
    };
}
function classifyPrepared(options, apply) {
    const expectedPin = `${pinKey(options.state.sourcePin)}@${options.state.sourcePin.sha}`;
    const before = loadCycleClassificationInventory(options.patchesDir, options.type, expectedPin, options.layerRuntime);
    const detected = detectRenames({
        cwd: options.treeDir,
        oldPin: options.state.sourcePin.sha,
        newPin: options.state.targetPin.sha,
        ...(options.similarity === undefined ? {} : { threshold: options.similarity })
    });
    const patchRenames = relevantPatchRenames(before, detected);
    const relevantRenames = relevantCycleRenames(before, detected);
    assertRecordedRenames(options.state.renames, relevantRenames);
    const pending = patchRenames.filter((rename) => before.patches.some((artifact) => artifact.patch.targetPath === rename.from));
    const renameBatch = buildRenameBatch(options, before, pending);
    if (apply && renameBatch.plans.length > 0) {
        const writeOptions = options;
        if (renameBatch.needsReview && writeOptions.reviewedRenames !== true) {
            throw broken('rename batch needs explicit review before durable mutation');
        }
        writeOptions.runtime?.beforeRenameMutation?.();
        assertLiveLocks(writeOptions);
        const recovery = makeCycleClassifyRecovery({
            sourcePin: writeOptions.state.sourcePin,
            targetPin: writeOptions.state.targetPin,
            branch: writeOptions.state.branch,
            similarity: writeOptions.similarity ?? 50,
            detectedRenames: canonicalRenames(detected),
            batch: renameBatch
        });
        writeCycleClassifyRecovery(writeOptions.patchesDir, recovery);
        writeOptions.runtime?.afterRecoveryWrite?.();
        const applied = applyPatchRenameBatch({
            patchesDir: writeOptions.patchesDir,
            batch: renameBatch,
            ...(writeOptions.reviewedRenames === undefined ? {} : { reviewed: writeOptions.reviewedRenames })
        }, writeOptions.runtime?.rename);
        if (!applied.completed)
            throw broken('rename apply returned without exact completion');
        clearCycleClassifyRecovery(writeOptions.patchesDir, recovery);
    }
    const loaded = apply ? loadCycleClassificationInventory(options.patchesDir, options.type, expectedPin, options.layerRuntime) : before;
    return completeResult(options, loaded, detected, relevantRenames, patchRenames, renameBatch);
}
function completeResult(options, loaded, detected, relevantRenames, patchRenames, renameBatch) {
    const { sourcePin, targetPin } = options.state;
    const classified = classifyLoadedUpgrade(options.type, options.treeDir, sourcePin.sha, targetPin.sha, loaded, detected, patchRenames);
    return {
        renames: relevantRenames.map(({ from, to, similarity }) => ({ from, to, similarity })),
        ...classified,
        renameBatch,
        reviewRequired: renameBatch.needsReview || classified.classifications.some((item) => item.kind === 'resource' && item.outcome !== 'clean'),
        validated: loaded.validated
    };
}
function classifyLoadedUpgrade(type, treeDir, oldPin, newRef, loaded, detected, patchRenames, mergeFile) {
    const mapped = mapPatchTargets(loaded.artifacts, patchRenames);
    const artifactClassifications = classifyArtifacts({
        type,
        treeDir,
        artifacts: mapped,
        oldPin,
        newRef,
        ...(mergeFile === undefined ? {} : { mergeFile })
    });
    const renameByOld = new Map(detected.map((rename) => [rename.from, rename]));
    const resources = classifyCycleResources(treeDir, oldPin, newRef, loaded.resources, renameByOld);
    const classifications = canonicalClassifications([...artifactClassifications, ...resources]);
    assertComplete(loaded, classifications);
    const targets = renameTargets(patchRenames);
    const buckets = buildBuckets(classifications, targets);
    const ranges = new Map(loaded.patches.map((artifact) => [artifact.artifactPath, patchRanges(artifact.patch)]));
    const causes = findClassificationCauses(treeDir, oldPin, newRef, classifications, buckets, targets, renameByOld, ranges);
    return { classifications, buckets, causes };
}
function buildRenameBatch(options, loaded, pending) {
    return buildPatchRenameBatch({
        patchesDir: options.patchesDir,
        renames: pending,
        artifacts: loaded.patches,
        ...(options.contractTestPaths === undefined ? {} : { contractTestPaths: options.contractTestPaths }),
        ...(options.ownPaths === undefined ? {} : { ownPaths: options.ownPaths }),
        ...(options.explicitReferenceReplacements === undefined ? {} : { explicitReferenceReplacements: options.explicitReferenceReplacements })
    });
}
function relevantPatchRenames(inventory, detected) {
    const targets = new Set(inventory.patches.map((artifact) => artifact.patch.targetPath));
    const relevant = detected.filter((rename) => targets.has(rename.from) || targets.has(rename.to));
    const sources = new Set();
    const destinations = new Set();
    for (const rename of relevant) {
        if (sources.has(rename.from))
            throw broken(`duplicate relevant rename source ${rename.from}`);
        if (destinations.has(rename.to))
            throw broken(`duplicate relevant rename destination ${rename.to}`);
        sources.add(rename.from);
        destinations.add(rename.to);
    }
    return [...relevant].sort((left, right) => compareText(left.from, right.from));
}
function relevantCycleRenames(inventory, detected) {
    const targets = new Set([
        ...inventory.patches.flatMap((artifact) => [artifact.patch.targetPath]),
        ...inventory.resources.map((entry) => entry.target)
    ]);
    return canonicalRenames(detected.filter((rename) => targets.has(rename.from) || targets.has(rename.to)));
}
function canonicalRenames(renames) {
    return [...renames].sort((left, right) => compareText(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`));
}
function assertRecordedRenames(recorded, relevant) {
    const expected = new Map(relevant.map((rename) => [rename.from, rename]));
    for (const rename of recorded) {
        const actual = expected.get(rename.from);
        if (actual === undefined || actual.to !== rename.to || actual.similarity !== rename.similarity) {
            throw broken(`state rename ${rename.from} -> ${rename.to} is stale or not present in the current pin diff`);
        }
    }
}
function mapPatchTargets(artifacts, renames) {
    const byOld = new Map(renames.map((rename) => [rename.from, rename]));
    const byNew = new Map(renames.map((rename) => [rename.to, rename]));
    return artifacts.map((artifact) => {
        if (artifact.kind !== 'patch')
            return artifact;
        const rename = byOld.get(artifact.patch.targetPath) ?? byNew.get(artifact.patch.targetPath);
        return rename === undefined ? artifact : { ...artifact, baseTargetPath: rename.from, newTargetPath: rename.to };
    });
}
function canonicalClassifications(items) {
    return [...items].sort((left, right) => compareText(left.artifactPath, right.artifactPath));
}
function assertComplete(inventory, classifications) {
    const expected = [...inventory.artifacts.map(classificationArtifactPath), ...inventory.resources.map((entry) => entry.source)].sort(compareText);
    const actual = classifications.map((item) => item.artifactPath).sort(compareText);
    if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
        throw broken(`classification is incomplete (expected ${expected.length} artifacts, got ${actual.length})`);
    }
}
function renameTargets(renames) {
    const targets = new Map();
    for (const rename of renames) {
        targets.set(rename.from, rename);
        targets.set(rename.to, rename);
    }
    return targets;
}
function buildBuckets(classifications, patchRenameByTarget) {
    const buckets = Object.fromEntries(CYCLE_ARTIFACT_OUTCOMES.map((outcome) => [outcome, []]));
    for (const item of classifications) {
        const renamed = item.kind === 'patch' && patchRenameByTarget.has(item.targetPath);
        const outcome = renamed && item.outcome === 'clean' ? 'target-renamed' : item.outcome;
        buckets[outcome].push(item.artifactPath);
    }
    for (const outcome of CYCLE_ARTIFACT_OUTCOMES)
        buckets[outcome].sort(compareText);
    return buckets;
}
function findClassificationCauses(treeDir, oldPin, newRef, classifications, buckets, patchRenameByTarget, resourceRenameByOld, rangesByArtifact) {
    const outcomeByPath = new Map(CYCLE_ARTIFACT_OUTCOMES.flatMap((outcome) => buckets[outcome].map((path) => [path, outcome])));
    return classifications.flatMap((item) => {
        const outcome = outcomeByPath.get(item.artifactPath);
        if (outcome === undefined)
            throw broken(`${item.artifactPath}: classification has no state bucket`);
        if (outcome === 'clean')
            return [];
        const patchRename = item.kind === 'patch' ? patchRenameByTarget.get(item.targetPath) : undefined;
        const resourceRename = item.kind === 'resource' ? [...resourceRenameByOld.values()].find((entry) => entry.to === item.targetPath) : undefined;
        const rename = patchRename ?? resourceRename;
        const target = rename?.from ?? item.targetPath;
        const lifecycle = rename === undefined
            ? item.outcome === 'target-deleted'
                ? { outcome: 'target-deleted' }
                : undefined
            : { outcome: 'target-renamed', newTarget: rename.to };
        const cause = findCause({
            cwd: treeDir,
            oldPin,
            newPin: newRef,
            target,
            ranges: item.kind === 'patch' ? (rangesByArtifact.get(item.artifactPath) ?? []) : [],
            ...(lifecycle === undefined ? {} : { lifecycle })
        });
        return [{ artifactPath: item.artifactPath, artifactId: item.artifactId, targetPath: item.targetPath, outcome, cause }];
    });
}
function patchRanges(patch) {
    return patch.hunks
        .filter((hunk) => hunk.countOld > 0)
        .map((hunk) => ({ start: Math.max(1, hunk.startOld), end: Math.max(1, hunk.startOld) + hunk.countOld - 1 }));
}
function assertCycleInput(options) {
    if (options.state.phase !== 'apply')
        throw broken(`cycle phase must be apply, got ${options.state.phase}`);
    if (options.state.transaction !== null)
        throw broken('cycle phase apply requires transaction null');
    if (!samePin(options.config.pin, options.state.targetPin))
        throw broken('codkit.json pin does not exactly match cycle targetPin');
    const expectedBranch = `${options.config.cycleBranchPrefix}${pinKey(options.state.targetPin)}`;
    if (options.state.branch !== expectedBranch)
        throw broken(`cycle branch must be exactly ${expectedBranch}`);
    const branch = runGit({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: options.patchesDir });
    if (branch.status !== 0 || branch.stdout.trim() !== expectedBranch)
        throw broken(`patchset checkout must be on cycle branch ${expectedBranch}`);
    assertPin(options.treeDir, options.state.sourcePin, 'sourcePin');
    assertPin(options.treeDir, options.state.targetPin, 'targetPin');
    if (options.state.branchTransitionAnchor !== undefined) {
        if (options.state.codkitCycleState !== 4 || options.state.branchTransitionAnchor !== options.config.upstreamAnchorCommit)
            throw broken('cycle branch transition authorization does not match schema/configuration');
        assertSourceToTargetAncestry(options.treeDir, options.state.sourcePin, options.state.targetPin, runGit, options.state.branchTransitionAnchor);
        return;
    }
    if (runGit({ args: ['merge-base', '--is-ancestor', options.state.sourcePin.sha, options.state.targetPin.sha], cwd: options.treeDir })
        .status !== 0) {
        throw broken('cycle sourcePin is not an ancestor of targetPin');
    }
}
function assertPin(treeDir, pin, label) {
    const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', `${pin.sha}^{commit}`], cwd: treeDir });
    if (resolved.status !== 0 || resolved.stdout.trim() !== pin.sha)
        throw broken(`${label} sha is not one exact reachable commit`);
    const date = runGit({ args: ['show', '-s', '--format=%cs', pin.sha], cwd: treeDir });
    if (date.status !== 0 || date.stdout.trim() !== pin.date)
        throw broken(`${label} date does not match commit ${pin.sha}`);
}
function assertLiveLocks(options) {
    assertLiveLock(options.locks.cycle, lockPath(options.patchesDir, CYCLE_LOCK_ID), 'cycle');
    assertLiveLock(options.locks.tree, lockPath(options.patchesDir, treeId(options.treeDir)), 'tree');
}
function assertLiveLock(handle, expectedPath, label) {
    assertOwnedLockHandle(handle, `cycle classification ${label} lock`);
    if (handle.path !== expectedPath || handle.info.nonce === undefined)
        throw broken(`${label} lock capability is not for this cycle`);
    const current = readLock(expectedPath);
    if (current === null || !sameLock(current, handle.info))
        throw broken(`${label} lock capability is no longer live`);
}
function recoverRenameBeforeInventory(options) {
    const transaction = renameTransactionExists(options.patchesDir);
    const recovery = readCycleClassifyRecovery(options.patchesDir);
    if (transaction && recovery === null)
        throw broken(`${RENAME_TRANSACTION_PATH} exists without ${'.codkit/cycle-classify.json'}`);
    if (recovery === null)
        return;
    assertRecoveryEvidence(options, recovery);
    options.runtime?.beforeRenameMutation?.();
    assertLiveLocks(options);
    let result;
    if (transaction) {
        assertRecoveryPlanEvidence(options, recovery);
        result = resumePatchRenameTransaction(options.patchesDir, recovery.batch, options.runtime?.rename);
    }
    else {
        const expected = rebuildRecoveryBatch(options, recovery);
        if (JSON.stringify(expected) !== JSON.stringify(recovery.batch)) {
            throw broken('durable recovery batch does not match the pristine inventory and current review inputs');
        }
        if (expected.needsReview && options.reviewedRenames !== true) {
            throw broken('recovered rename batch needs explicit review before durable mutation');
        }
        result = applyPatchRenameBatch({
            patchesDir: options.patchesDir,
            batch: expected,
            ...(options.reviewedRenames === undefined ? {} : { reviewed: options.reviewedRenames })
        }, options.runtime?.rename);
    }
    if (!result.completed)
        throw broken('durable rename recovery returned without exact completion');
    clearCycleClassifyRecovery(options.patchesDir, recovery);
}
function rebuildRecoveryBatch(options, recovery) {
    const expectedPin = `${pinKey(options.state.sourcePin)}@${options.state.sourcePin.sha}`;
    const pristine = loadCycleClassificationInventory(options.patchesDir, options.type, expectedPin, options.layerRuntime);
    const patchRenames = relevantPatchRenames(pristine, recovery.detectedRenames);
    const pending = patchRenames.filter((rename) => pristine.patches.some((artifact) => artifact.patch.targetPath === rename.from));
    return buildRenameBatch(options, pristine, pending);
}
function assertRecoveryPlanEvidence(options, recovery) {
    const detected = new Map(recovery.detectedRenames.map((rename) => [rename.from, rename]));
    const explicit = options.explicitReferenceReplacements ?? [];
    for (const plan of recovery.batch.plans) {
        const rename = detected.get(plan.fromTarget);
        if (rename === undefined ||
            rename.to !== plan.toTarget ||
            rename.similarity !== plan.similarity ||
            plan.oldArtifactPath !== `delta/patches/${encodePatchName(rename.from)}` ||
            plan.newArtifactPath !== `delta/patches/${encodePatchName(rename.to)}`) {
            throw broken('durable recovery plan is not derived from current rename-detection evidence');
        }
        const references = plan.operations.flatMap((operation) => {
            if (operation.kind !== 'replace' || operation.area === 'patch-header')
                return [];
            const replacement = { area: operation.area, file: operation.file, from: operation.from, to: operation.to };
            const automatic = operation.from === rename.from && operation.to === rename.to;
            const authorized = explicit.some((entry) => entry.renameFrom === rename.from &&
                entry.area === replacement.area &&
                entry.file === replacement.file &&
                entry.from === replacement.from &&
                entry.to === replacement.to);
            if (!automatic && !authorized)
                throw broken('durable recovery contains an unapproved reference replacement');
            return [replacement];
        });
        const canonical = planPatchArtifactRename({ rename, referenceReplacements: references });
        if (JSON.stringify(canonical) !== JSON.stringify(plan)) {
            throw broken('durable recovery plan operations are not canonical for the detected rename');
        }
    }
}
function assertRecoveryEvidence(options, recovery) {
    if (JSON.stringify(recovery.sourcePin) !== JSON.stringify(options.state.sourcePin) ||
        JSON.stringify(recovery.targetPin) !== JSON.stringify(options.state.targetPin) ||
        recovery.branch !== options.state.branch) {
        throw broken('durable rename recovery does not match current cycle state');
    }
    const detected = canonicalRenames(detectRenames({
        cwd: options.treeDir,
        oldPin: recovery.sourcePin.sha,
        newPin: recovery.targetPin.sha,
        threshold: recovery.similarity
    }));
    if (JSON.stringify(detected) !== JSON.stringify(recovery.detectedRenames)) {
        throw broken('durable rename recovery does not match current rename-detection evidence');
    }
}
function sameLock(left, right) {
    return (left.pid === right.pid &&
        left.startedAt === right.startedAt &&
        left.command === right.command &&
        left.nonce !== undefined &&
        left.nonce === right.nonce);
}
function renameTransactionExists(patchesDir) {
    const resolved = resolveContainedPath(patchesDir, RENAME_TRANSACTION_PATH, { allowMissing: true });
    if (!resolved.ok)
        throw broken(`${RENAME_TRANSACTION_PATH}: unsafe transaction path: ${resolved.reason}`);
    const path = resolved.absolute;
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile())
            throw broken(`${RENAME_TRANSACTION_PATH} is not a real file`);
        return true;
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return false;
        if (error instanceof Error && error.message.includes('cannot classify cycle apply:'))
            throw error;
        throw broken(`cannot inspect ${RENAME_TRANSACTION_PATH}: ${messageOf(error)}`);
    }
}
function classificationArtifactPath(artifact) {
    return artifact.kind === 'patch'
        ? artifact.artifactPath
        : artifact.kind === 'rule'
            ? artifact.rule.artifactPath
            : artifact.overlay.artifactPath;
}
function samePin(left, right) {
    return left.tag === right.tag && left.sha === right.sha && left.date === right.date;
}
function compareText(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function broken(reason) {
    return ckError('ARTIFACT-BROKEN', `cannot classify cycle apply: ${reason}`, 'repair the complete cycle inventory or restart the cycle before retrying');
}
function errorCode(error) {
    return error.code;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
