/** @scope spec://codkit/modules/codkit/PROP-008#classify */
import { pinKey } from './pinIdentity.js';
// Generic, read-only upgrade analysis. The caller supplies one immutable target
// commit; no cycle state, branch, journal, recovery record, or work-tree target
// participates in the result.
import { CLASSIFICATION_OUTCOMES } from './classifyEngine.js';
import { classifyUpgradeInventory } from './cycleClassify.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
/** Analyze every classifiable D5 artifact against one exact descendant commit. */
export function analyzeUpgrade(options) {
    assertCommit(options.treeDir, options.config.pin.sha, 'current pin');
    assertPinDate(options.treeDir, options.config.pin);
    assertCommit(options.treeDir, options.newRef, 'newRef');
    assertAncestor(options.treeDir, options.config.pin.sha, options.newRef);
    const expectedPin = `${pinKey(options.config.pin)}@${options.config.pin.sha}`;
    const classified = classifyUpgradeInventory({
        patchesDir: options.patchesDir,
        treeDir: options.treeDir,
        type: options.type,
        expectedPin,
        oldPin: options.config.pin.sha,
        newRef: options.newRef,
        ...(options.similarity === undefined ? {} : { similarity: options.similarity }),
        ...(options.layerRuntime === undefined ? {} : { layerRuntime: options.layerRuntime }),
        ...(options.mergeFile === undefined ? {} : { mergeFile: options.mergeFile })
    });
    if (classified.buckets['contract-failed'].length !== 0) {
        throw internal('read-only classification produced contract-failed without running contracts');
    }
    const ownersByArtifact = inventoryOwners(classified.inventory);
    const outcomeByArtifact = bucketValues(classified.buckets);
    const causeByArtifact = new Map(classified.causes.map((entry) => [entry.artifactPath, entry.cause]));
    const artifacts = classified.classifications.map((classification) => {
        const owner = ownersByArtifact.get(classification.artifactPath);
        const outcome = outcomeByArtifact.get(classification.artifactPath);
        if (owner === undefined)
            throw internal(`${classification.artifactPath}: classification has no owner`);
        if (outcome === undefined)
            throw internal(`${classification.artifactPath}: classification has no outcome bucket`);
        const cause = causeByArtifact.get(classification.artifactPath) ?? null;
        if ((outcome === 'clean') !== (cause === null)) {
            throw internal(`${classification.artifactPath}: cause presence does not match outcome ${outcome}`);
        }
        return {
            artifactPath: classification.artifactPath,
            artifactId: classification.artifactId,
            targetPath: classification.targetPath,
            kind: classification.kind,
            layer: classification.layer,
            owner,
            outcome,
            cause,
            classification
        };
    });
    const outcomes = readonlyBuckets(classified.buckets);
    return {
        sourcePin: { ...options.config.pin },
        newRef: options.newRef,
        renames: classified.renames,
        artifacts,
        outcomes,
        counts: countsOf(outcomes),
        owners: groupByOwner(artifacts),
        validated: classified.inventory.validated
    };
}
function inventoryOwners(inventory) {
    const owners = new Map();
    for (const artifact of inventory.artifacts) {
        const path = artifact.kind === 'patch'
            ? artifact.artifactPath
            : artifact.kind === 'rule'
                ? artifact.rule.artifactPath
                : artifact.overlay.artifactPath;
        const owner = artifact.kind === 'patch' ? artifact.patch.header.owner : artifact.kind === 'rule' ? artifact.rule.owner : artifact.overlay.owner;
        owners.set(path, owner);
    }
    for (const resource of inventory.resources)
        owners.set(resource.source, resource.owner);
    return owners;
}
function bucketValues(buckets) {
    const values = new Map();
    for (const outcome of CLASSIFICATION_OUTCOMES) {
        for (const artifact of buckets[outcome]) {
            if (values.has(artifact))
                throw internal(`${artifact}: appears in more than one outcome bucket`);
            values.set(artifact, outcome);
        }
    }
    return values;
}
function readonlyBuckets(buckets) {
    return Object.fromEntries(CLASSIFICATION_OUTCOMES.map((outcome) => [outcome, [...buckets[outcome]].sort(compareText)]));
}
function countsOf(outcomes) {
    const byOutcome = Object.fromEntries(CLASSIFICATION_OUTCOMES.map((outcome) => [outcome, outcomes[outcome].length]));
    const total = CLASSIFICATION_OUTCOMES.reduce((sum, outcome) => sum + byOutcome[outcome], 0);
    return { total, nonClean: total - byOutcome.clean, byOutcome };
}
function groupByOwner(artifacts) {
    const byOwner = new Map();
    for (const artifact of artifacts) {
        const group = byOwner.get(artifact.owner) ?? [];
        group.push(artifact);
        byOwner.set(artifact.owner, group);
    }
    return [...byOwner.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([owner, owned]) => {
        const outcomes = emptyBuckets();
        for (const artifact of owned)
            outcomes[artifact.outcome].push(artifact.artifactPath);
        const readonly = readonlyBuckets(outcomes);
        return { owner, artifacts: owned.map((artifact) => artifact.artifactPath), outcomes: readonly, counts: countsOf(readonly) };
    });
}
function emptyBuckets() {
    return Object.fromEntries(CLASSIFICATION_OUTCOMES.map((outcome) => [outcome, []]));
}
function assertCommit(treeDir, ref, label) {
    if (!/^[0-9a-f]{40}$/.test(ref))
        throw unreachable(`${label} must be one exact immutable 40-hex commit sha`);
    const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd: treeDir });
    if (resolved.status !== 0 || resolved.stdout.trim() !== ref)
        throw unreachable(`${label} ${ref} is not one reachable commit`);
}
function assertPinDate(treeDir, pin) {
    const date = runGit({ args: ['show', '-s', '--format=%cs', pin.sha], cwd: treeDir });
    if (date.status !== 0 || date.stdout.trim() !== pin.date)
        throw unreachable(`current pin date does not match commit ${pin.sha}`);
}
function assertAncestor(treeDir, oldPin, newRef) {
    if (runGit({ args: ['merge-base', '--is-ancestor', oldPin, newRef], cwd: treeDir }).status !== 0) {
        throw unreachable(`newRef ${newRef} is not a descendant of current pin ${oldPin}`);
    }
}
function compareText(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function unreachable(reason) {
    return ckError('PIN-UNREACHABLE', `cannot analyze upgrade: ${reason}`, 'fetch one exact descendant commit outside codkit, then retry');
}
function internal(reason) {
    return ckError('INTERNAL', `cannot analyze upgrade: ${reason}`, 'repair the complete frozen inventory and retry');
}
