/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { readFileSync } from 'node:fs';
import { applyUnified } from './applyUnified.js';
import { bytesEqual, decodeUtf8Strict } from './bytes.js';
import { cycleJournalEntrySchema } from './cycleJournal.js';
import { CYCLE_JOURNAL_DIR } from './cycleJournal.js';
import { CYCLE_STATE_PATH, cycleStateSchema, writeCycleState } from './cycleState.js';
import { CYCLE_BLOCKER_OUTCOMES } from './cycleState.js';
import { cycleResolveTreeCurrent, recoverCycleResolveTree } from './cycleResolveCurrent.js';
import { cycleResolveSnapshotMismatch, validateCycleResolveSnapshots } from './cycleResolveSnapshots.js';
import { porcelainZEntries } from './driftGuard.js';
import { treeId } from './fingerprint.js';
import { runGit, runGitBytes } from './gitx.js';
import { assertOwnedLockHandle, lockPath, readLock } from './lock.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
import { parseCkpatch } from './patchFormat.js';
import { runSave } from './saveEngine.js';
import { loadConventions } from './conventionsFile.js';
const CYCLE_LOCK_ID = 'cycle-global';
const MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?: .*)?$/m;
export function planCycleResolve(options) {
    const facts = collectFacts(options);
    const plans = makePlans(options, facts);
    return finish(options, plans, facts.state, null);
}
export function runCycleResolve(options) {
    let facts = collectFacts(options);
    let plans = makePlans(options, facts);
    if (plans.every((plan) => plan.status === 'resolved'))
        return reconcileOrFinish(options, facts, plans);
    const selected = plans.find((plan) => plan.status === 'ready-commit' || plan.status === 'ready-extract');
    if (selected === undefined)
        return finish(options, plans, facts.state, null);
    const artifact = requireDescriptor(facts, selected.artifactPath);
    const proof = requireProof(facts, artifact);
    if (selected.status === 'ready-commit' && facts.treeDirt.length === 0) {
        facts = recoverCleanTree(options, facts, artifact);
        plans = makePlans(options, facts);
        if (plans.find((plan) => plan.artifactPath === artifact.artifactPath)?.status !== 'ready-commit')
            throw broken(`${artifact.artifactPath}: exact ready-commit proof changed during recovery`);
    }
    assertNoUnknownDirt(options, facts, artifact);
    if (selected.status === 'ready-extract') {
        const target = requireTarget(artifact);
        const saveOptions = {
            patchesDir: options.patchesDir,
            resolution: options.resolution,
            config: options.config,
            out: options.out,
            paths: [target],
            allowNewFile: [],
            commit: false,
            message: null,
            verbose: false,
            patchHeaderOverrides: [headerOverride(artifact, options.config)]
        };
        const result = patchAdapter(options).extract(saveOptions);
        if (result.exitCode !== 0 || (result.status !== 'saved' && result.status !== 'nothing')) {
            throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: exact cycle save did not complete`);
        }
        if (!patchAdapter(options).prove(options, artifact, proof)) {
            throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: regenerated patch does not exactly reproduce the resolved tree target`);
        }
    }
    const next = facts.state.resolved.includes(artifact.artifactPath)
        ? facts.state
        : cycleStateSchema.parse({
            ...facts.state,
            updatedAt: laterTimestamp(facts.state.updatedAt, proof.ts),
            resolved: byteSorted([...facts.state.resolved, artifact.artifactPath])
        });
    if (next !== facts.state) {
        options.runtime?.beforeStateWrite?.();
        assertLiveLocks(options);
        (options.runtime?.writeState ?? ((root, state) => void writeCycleState(root, state)))(options.patchesDir, next);
    }
    facts = collectFacts({ ...options, state: next });
    plans = makePlans({ ...options, state: next }, facts);
    const paths = exactCommitPaths(facts, artifact);
    const request = {
        patchesDir: options.patchesDir,
        expectedBranch: next.branch,
        expectedParent: readHead(options),
        targetTag: next.targetPin.tag,
        subject: `fix(cycle): resolve ${artifact.artifactId}`,
        paths,
        timestamp: commitTimestamp(proof.ts),
        cause: proof.cause.sha
    };
    return finish(options, plans, next, request);
}
function reconcileOrFinish(options, facts, plans) {
    if (facts.patchsetDirt.length > 0) {
        throw ckError('DIRTY-TREE', `resolved cycle still has uncommitted patchset dirt: ${facts.patchsetDirt.map((item) => item.path).join(', ')}`);
    }
    if (facts.treeDirt.length === 0) {
        if (!treeIsCurrent(options)) {
            assertAllExact(options, facts);
            facts = recoverCleanTree(options, facts);
            plans = makePlans(options, facts);
            if (facts.patchsetDirt.length > 0)
                throw broken('forced final load introduced patchset dirt');
        }
        return finish(options, plans, facts.state, null);
    }
    const unknown = unknownTreePaths(facts);
    if (unknown.length > 0)
        throw ckError('DIRTY-TREE', `cannot reconcile unknown fork dirt: ${unknown.join(', ')}`);
    const targets = byteSorted(facts.treeDirt.map((item) => item.path));
    const artifacts = targets.map((target) => {
        const artifact = [...facts.descriptors.values()].find((item) => item.kind === 'patch' && item.targetPath === target);
        if (artifact === undefined)
            throw broken(`no resolved patch owns dirty target ${target}`);
        const proof = requireProof(facts, artifact);
        if (!patchAdapter(options).prove(options, artifact, proof))
            throw broken(`${artifact.artifactPath}: committed patch does not reproduce ${target}`);
        return artifact;
    });
    const result = patchAdapter(options).extract({
        patchesDir: options.patchesDir,
        resolution: options.resolution,
        config: options.config,
        out: options.out,
        paths: targets,
        allowNewFile: [],
        commit: false,
        message: null,
        verbose: false,
        patchHeaderOverrides: artifacts.map((artifact) => headerOverride(artifact, options.config))
    });
    if (result.exitCode !== 0)
        throw broken('final exact-path save/load did not complete');
    const after = collectFacts(options);
    if (after.treeDirt.length > 0 || after.patchsetDirt.length > 0 || !treeIsCurrent(options)) {
        throw broken('final reconciliation did not produce zero dirt with current mark/cache/fingerprint');
    }
    return finish(options, makePlans(options, after), after.state, null);
}
function recoverCleanTree(options, facts, artifact) {
    if (facts.treeDirt.length > 0)
        throw broken('clean-tree recovery was requested with fork dirt');
    if (artifact !== undefined)
        assertNoUnknownDirt(options, facts, artifact);
    else
        assertLiveLocks(options);
    (options.runtime?.recoverTree ?? ((input) => recoverCycleResolveTree(input.patchesDir, input.resolution, input.config, input.out)))(options);
    const after = collectFacts(options);
    if (after.treeDirt.length > 0 || !treeIsCurrent(options))
        throw broken('forced load did not restore a clean current fork proof');
    return after;
}
function assertAllExact(options, facts) {
    for (const artifact of facts.descriptors.values()) {
        const proof = requireProof(facts, artifact);
        if (artifact.kind === 'patch' && artifact.outcome === 'conflict') {
            if (!patchAdapter(options).prove(options, artifact, proof))
                throw broken(`${artifact.artifactPath}: patch proof is stale`);
        }
        else if (cycleResolveSnapshotMismatch(options.patchesDir, [], artifact, false).length > 0)
            throw broken(`${artifact.artifactPath}: committed snapshot is stale`);
    }
}
function collectFacts(options) {
    const state = validateInput(options);
    const entries = latestEntries(options.journal);
    const descriptors = descriptorMap(state, options.artifacts);
    const status = options.runtime?.status ?? repositoryStatus;
    return { state, entries, descriptors, treeDirt: status(options.resolution.path), patchsetDirt: status(options.patchesDir) };
}
function makePlans(options, facts) {
    const unknownTree = unknownTreePaths(facts);
    return blockerPairs(facts.state).map(({ artifactPath, outcome }) => {
        const descriptor = requireDescriptor(facts, artifactPath);
        const entry = facts.entries.get(artifactPath);
        const base = {
            artifactPath,
            artifactId: descriptor.artifactId,
            kind: descriptor.kind,
            outcome,
            targetPath: descriptor.targetPath ?? null
        };
        const result = (status, reason, cause) => ({
            ...base,
            status,
            reason,
            cause,
            patchesPaths: byteSorted(descriptor.patchesPaths)
        });
        if (entry === undefined)
            return result('journal-missing', 'latest journal proof is missing', null);
        if (entry.outcome !== outcome)
            return result('journal-mismatch', `latest journal outcome is ${entry.outcome}`, entry.cause.sha);
        if (entry.verified.some((check) => check.exitCode !== 0))
            return result('journal-red', 'latest journal verification is red', entry.cause.sha);
        if (!sameCause(entry.cause, descriptor.cause))
            return result('journal-cause-mismatch', 'latest journal cause differs from immutable classification cause', entry.cause.sha);
        if (facts.state.resolved.includes(artifactPath)) {
            const pending = facts.patchsetDirt.filter((item) => descriptor.patchesPaths.includes(item.path));
            if (pending.length === 0)
                return result('resolved', 'state and latest green journal agree', entry.cause.sha);
            const exact = descriptor.kind === 'patch' && outcome === 'conflict'
                ? patchAdapter(options).prove(options, descriptor, entry)
                : nonPatchSnapshotMismatch(options, facts, descriptor).length === 0;
            return exact
                ? result('ready-commit', 'resolved state has an uncommitted exact atom', entry.cause.sha)
                : result('patchset-change-missing', 'resolved atom no longer matches its complete snapshot', entry.cause.sha);
        }
        if (unknownTree.length > 0)
            return result('unknown-dirt', `unknown fork-tree dirt: ${unknownTree.join(', ')}`, entry.cause.sha);
        const unknownPatchSet = unknownPatchesPaths(facts, descriptor);
        if (unknownPatchSet.length > 0)
            return result('unknown-dirt', `unknown patchset dirt: ${unknownPatchSet.join(', ')}`, entry.cause.sha);
        if (outcome === 'conflict') {
            if (descriptor.kind !== 'patch')
                return result('patchset-change-missing', 'a conflict resolution must identify one patch', entry.cause.sha);
            const target = requireTarget(descriptor);
            const bytes = readTreeBytes(options, target);
            if (bytes === null)
                return result('tree-change-missing', `resolved target ${target} is absent`, entry.cause.sha);
            if (hasConflictMarkers(bytes))
                return result('markers-remain', `standard conflict markers remain in ${target}`, entry.cause.sha);
            if (facts.treeDirt.some((item) => item.path === target))
                return result('ready-extract', `extract ${target} with exact-path save`, entry.cause.sha);
            return patchAdapter(options).prove(options, descriptor, entry)
                ? result('ready-commit', 'save completed earlier; exact regenerated artifact is pending', entry.cause.sha)
                : result('tree-change-missing', `${target} has neither a resolved tree edit nor an exact extracted patch`, entry.cause.sha);
        }
        const mismatch = nonPatchSnapshotMismatch(options, facts, descriptor);
        return mismatch.length === 0
            ? result('ready-commit', 'explicit patchset artifact changes and green proof are present', entry.cause.sha)
            : result('patchset-change-missing', `explicit patchset snapshot mismatch: ${mismatch.join(', ')}`, entry.cause.sha);
    });
}
function validateInput(options) {
    const state = cycleStateSchema.parse(options.state);
    if (state.phase !== 'resolve' || state.transaction !== null)
        throw broken(`cycle phase must be resolve with transaction null`);
    if (!samePin(options.config.pin, state.targetPin))
        throw broken('codkit.json pin does not exactly match cycle targetPin');
    if (state.branch !== `${options.config.cycleBranchPrefix}${state.targetPin.tag}`)
        throw broken('cycle branch does not match config');
    if (readBranch(options) !== state.branch)
        throw broken(`patchset checkout must be on cycle branch ${state.branch}`);
    assertLiveLocks(options);
    return state;
}
function descriptorMap(state, artifacts) {
    const expected = new Map(blockerPairs(state).map((entry) => [entry.artifactPath, entry.outcome]));
    const map = new Map();
    for (const artifact of artifacts) {
        if (map.has(artifact.artifactPath))
            throw broken(`duplicate resolve descriptor ${artifact.artifactPath}`);
        if (expected.get(artifact.artifactPath) !== artifact.outcome)
            throw broken(`stale resolve descriptor ${artifact.artifactPath}`);
        if (artifact.patchesPaths.length === 0 || new Set(artifact.patchesPaths).size !== artifact.patchesPaths.length)
            throw broken(`${artifact.artifactPath}: explicit patchset paths are empty or duplicated`);
        if (!/^[0-9a-f]{40}$/.test(artifact.cause.sha))
            throw broken(`${artifact.artifactPath}: immutable cause is not a full sha`);
        if (artifact.kind !== 'patch' || artifact.outcome !== 'conflict')
            validateCycleResolveSnapshots(artifact);
        map.set(artifact.artifactPath, artifact);
    }
    const missing = [...expected.keys()].filter((path) => !map.has(path));
    if (missing.length > 0)
        throw broken(`resolve descriptors are incomplete: ${missing.join(', ')}`);
    return map;
}
function latestEntries(entries) {
    const latest = new Map();
    for (const [index, entry] of entries.entries()) {
        const parsed = cycleJournalEntrySchema.safeParse(entry);
        if (!parsed.success)
            throw ckError('LOG-INCOMPLETE', `cycle journal entry ${index + 1} is invalid`);
        latest.set(parsed.data.artifact, parsed.data);
    }
    return latest;
}
function blockerPairs(state) {
    return CYCLE_BLOCKER_OUTCOMES.flatMap((outcome) => state.artifacts[outcome].map((artifactPath) => ({ artifactPath, outcome }))).sort((left, right) => compareText(left.artifactPath, right.artifactPath));
}
function assertNoUnknownDirt(options, facts, artifact) {
    const allowedPatchSet = new Set([...artifact.patchesPaths, CYCLE_STATE_PATH, journalPath(facts.state.targetPin.tag)]);
    const unknownPatchSet = facts.patchsetDirt
        .filter((entry) => !allowedPatchSet.has(entry.path) || (entry.status[0] !== ' ' && entry.status !== '??'))
        .map((entry) => entry.path);
    const unknownTree = unknownTreePaths(facts);
    if (unknownPatchSet.length > 0 || unknownTree.length > 0) {
        throw ckError('DIRTY-TREE', `resolve atom has unknown dirt (patchset: ${show(unknownPatchSet)}; fork: ${show(unknownTree)})`, 'retain only the journal, cycle state, exact artifact paths and classified blocker targets');
    }
    assertLiveLocks(options);
}
function exactCommitPaths(facts, artifact) {
    const allowed = new Set([...artifact.patchesPaths, CYCLE_STATE_PATH, journalPath(facts.state.targetPin.tag)]);
    const staged = facts.patchsetDirt.filter((entry) => entry.status[0] !== ' ' && entry.status !== '??');
    const unknown = facts.patchsetDirt.filter((entry) => !allowed.has(entry.path));
    if (staged.length > 0 || unknown.length > 0)
        throw ckError('DIRTY-TREE', 'cannot build an exact cycle commit request from staged or unknown dirt');
    const paths = byteSorted(facts.patchsetDirt.map((entry) => entry.path).filter((path) => allowed.has(path)));
    if (!artifact.patchesPaths.some((path) => paths.includes(path)))
        throw broken(`${artifact.artifactPath}: exact artifact change vanished before commit`);
    if (!paths.includes(CYCLE_STATE_PATH))
        throw broken(`${artifact.artifactPath}: resolved state was not durably written before commit`);
    return paths;
}
function unknownTreePaths(facts) {
    const known = new Set([...facts.descriptors.values()].flatMap((artifact) => (artifact.targetPath === undefined ? [] : [artifact.targetPath])));
    return byteSorted(facts.treeDirt.filter((entry) => !known.has(entry.path) || entry.status[0] !== ' ').map((entry) => entry.path));
}
function unknownPatchesPaths(facts, artifact) {
    const allowed = new Set([...artifact.patchesPaths, CYCLE_STATE_PATH, journalPath(facts.state.targetPin.tag)]);
    return byteSorted(facts.patchsetDirt
        .filter((entry) => !allowed.has(entry.path) || (entry.status[0] !== ' ' && entry.status !== '??'))
        .map((entry) => entry.path));
}
function nonPatchSnapshotMismatch(options, facts, artifact) {
    return cycleResolveSnapshotMismatch(options.patchesDir, facts.patchsetDirt.map((item) => item.path), artifact);
}
function assertLiveLocks(options) {
    assertLiveLock(options.locks.cycle, lockPath(options.patchesDir, CYCLE_LOCK_ID), 'cycle');
    assertLiveLock(options.locks.tree, lockPath(options.patchesDir, treeId(options.resolution.path)), 'tree');
}
function assertLiveLock(handle, expectedPath, label) {
    assertOwnedLockHandle(handle, `cycle resolve ${label} lock`);
    if (handle.path !== expectedPath || handle.info.nonce === undefined)
        throw broken(`${label} lock capability is not for this cycle`);
    const current = readLock(expectedPath);
    if (current === null || !sameLock(current, handle.info))
        throw broken(`${label} lock capability is no longer live`);
}
function sameLock(left, right) {
    return left.pid === right.pid && left.startedAt === right.startedAt && left.command === right.command && left.nonce === right.nonce;
}
function repositoryStatus(root) {
    const result = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: root });
    if (result.status !== 0)
        throw ckError('NOT-A-REPO', `cannot inspect resolve dirt in ${root}`);
    return porcelainZEntries(result.stdout);
}
function readTreeBytes(options, path) {
    if (options.runtime?.treeBytes !== undefined)
        return options.runtime.treeBytes(options.resolution.path, path);
    const resolved = resolveContainedPath(options.resolution.path, path);
    return resolved.ok ? readFileSync(resolved.absolute) : null;
}
function readHead(options) {
    if (options.runtime?.head !== undefined)
        return options.runtime.head(options.patchesDir);
    const result = runGit({ args: ['rev-parse', '--verify', 'HEAD^{commit}'], cwd: options.patchesDir });
    if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim()))
        throw broken('cannot resolve patchset HEAD');
    return result.stdout.trim();
}
function readBranch(options) {
    if (options.runtime?.branch !== undefined)
        return options.runtime.branch(options.patchesDir);
    return runGit({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: options.patchesDir }).stdout.trim();
}
function patchAdapter(options) {
    return options.runtime?.patch ?? nodeCycleResolvePatchAdapter;
}
function headerOverride(artifact, config) {
    return {
        targetPath: requireTarget(artifact),
        artifactPath: artifact.artifactPath,
        artifactId: artifact.artifactId,
        cause: artifact.cause.sha,
        pin: { tag: config.pin.tag, sha: config.pin.sha }
    };
}
export const nodeCycleResolvePatchAdapter = {
    extract: runSave,
    prove(options, artifact, proof) {
        const target = requireTarget(artifact);
        const absolute = contained(options.patchesDir, artifact.artifactPath);
        let document;
        try {
            document = readFileSync(absolute);
        }
        catch {
            return false;
        }
        const patch = parseCkpatch(document, loadConventions(options.patchesDir), artifact.artifactPath);
        if (patch.targetPath !== target ||
            patch.header.id !== artifact.artifactId ||
            patch.header.cause !== proof.cause.sha ||
            patch.header.pin !== `${options.state.targetPin.tag}@${options.state.targetPin.sha}`)
            return false;
        const tree = readTreeBytes(options, target);
        if (tree === null || hasConflictMarkers(tree))
            return false;
        const shown = runGitBytes({ args: ['show', `${options.state.targetPin.sha}:${target}`], cwd: options.resolution.path });
        if (shown.status !== 0 && !patch.isAddFile)
            return false;
        try {
            return bytesEqual(applyUnified(shown.status === 0 ? shown.stdout : new Uint8Array(0), patch), tree);
        }
        catch {
            return false;
        }
    }
};
function finish(options, plans, state, commit) {
    for (const plan of plans)
        options.out.info(`cycle resolve ${plan.status}: ${plan.outcome}:${plan.artifactPath} — ${plan.reason}`);
    if (commit !== null) {
        options.out.info(`cycle resolve commit ready: ${commit.subject}; paths ${commit.paths.join(', ')}`);
        return { status: 'commit-ready', plans, state, commit };
    }
    return { status: plans.every((plan) => plan.status === 'resolved') ? 'complete' : 'blocked', plans, state, commit: null };
}
function requireDescriptor(facts, path) {
    const artifact = facts.descriptors.get(path);
    if (artifact === undefined)
        throw broken(`missing resolve descriptor ${path}`);
    return artifact;
}
function requireProof(facts, artifact) {
    const proof = facts.entries.get(artifact.artifactPath);
    if (proof === undefined ||
        proof.outcome !== artifact.outcome ||
        proof.verified.some((entry) => entry.exitCode !== 0) ||
        !sameCause(proof.cause, artifact.cause))
        throw ckError('LOG-INCOMPLETE', `${artifact.artifactPath}: latest green matching journal proof is absent`);
    return proof;
}
function requireTarget(artifact) {
    if (artifact.targetPath === undefined || artifact.targetPath === '')
        throw broken(`${artifact.artifactPath}: patch target is absent`);
    return artifact.targetPath;
}
function hasConflictMarkers(bytes) {
    const text = decodeUtf8Strict(bytes);
    return text === null || MARKER.test(text);
}
function contained(root, path) {
    const result = resolveContainedPath(root, path);
    if (!result.ok)
        throw broken(`unsafe resolve path ${path}: ${result.reason}`);
    return result.absolute;
}
function treeIsCurrent(options) {
    if (options.runtime?.treeCurrent !== undefined)
        return options.runtime.treeCurrent(options);
    return cycleResolveTreeCurrent(options.patchesDir, options.resolution, options.config);
}
function journalPath(tag) {
    return `${CYCLE_JOURNAL_DIR}/${tag}.jsonl`;
}
function laterTimestamp(left, right) {
    return Date.parse(right) > Date.parse(left) ? right : left;
}
function commitTimestamp(timestamp) {
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds))
        throw broken(`journal timestamp is invalid: ${timestamp}`);
    return new Date(Math.floor(milliseconds / 1000) * 1000).toISOString();
}
function samePin(left, right) {
    return left.tag === right.tag && left.sha === right.sha && left.date === right.date;
}
function sameCause(left, right) {
    return left.sha === right.sha && left.approx === right.approx;
}
function byteSorted(values) {
    return [...values].sort(compareText);
}
function compareText(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function show(paths) {
    return paths.length === 0 ? 'none' : paths.join(', ');
}
function broken(message) {
    return ckError('ARTIFACT-BROKEN', message, 're-read state, journal and exact repository facts before retrying cycle continue');
}
