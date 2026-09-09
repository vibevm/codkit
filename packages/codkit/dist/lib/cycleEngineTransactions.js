/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { applyCycleFinalizationPlan, planCycleFinalization } from './cycleFinalize.js';
import { commitCycleAtom, validateCycleCommitHistory, validateCycleCommitReceipt } from './cycleCommit.js';
import { findCycleBump, findCycleBumpTo } from './cycleControlGit.js';
import { applyReportWrites, byteSorted, pendingAcknowledgement, readText, rebindAdvisoryState, stabilizeReportIsRed, stabilizeReportMatchesCycle, toJson } from './cycleEngineIo.js';
import { makeCycleTerminalRecord, readCycleTerminalRecord, updateCycleTerminalRecord, writeCycleTerminalRecord } from './cycleEngineTerminal.js';
import { clearCycleApplyRecord } from './cycleEngineRecord.js';
import { clearCycleTransitionRecord, makeCycleTransitionRecord, readCycleTransitionRecord, updateCycleTransitionRecord, writeCycleTransitionRecord } from './cycleEngineTransition.js';
import { DEPENDENCY_ADVISORY_REPORT_PATH, STABILIZE_REPORT_PATH, continueCycleStabilization } from './cycleStabilize.js';
import { validateCycleAdvisoryTransition, validateCycleStabilizeTransition } from './cycleStabilizeValidate.js';
import { CYCLE_STATE_PATH, readCycleState, writeCycleState } from './cycleState.js';
import { runGit } from './gitx.js';
import { buildInventory } from './inventory.js';
import { ckError, isCkError } from './messages.js';
export async function planStabilizationTransition(options, state, locks, commits) {
    const deferredCheckpoints = [];
    const advisoryBefore = readText(options.patchesDir, DEPENDENCY_ADVISORY_REPORT_PATH);
    const advisory = state.phase === 'deps-advisory' ? rebindAdvisoryState(advisoryBefore, state) : advisoryBefore;
    const stabilizeBefore = readText(options.patchesDir, STABILIZE_REPORT_PATH);
    const staleStabilize = state.phase === 'stabilize' && (stabilizeReportIsRed(stabilizeBefore) || !stabilizeReportMatchesCycle(stabilizeBefore, state));
    const planned = await continueCycleStabilization({
        patchesDir: options.patchesDir,
        resolution: options.resolution,
        config: options.config,
        type: options.type,
        state,
        locks,
        ci: options.ci,
        updatedAt: nextTimestamp(options, state.updatedAt),
        acknowledgement: options.acknowledgement ?? pendingAcknowledgement(advisory),
        existingAdvisoryReport: advisory,
        existingStabilizeReport: staleStabilize ? null : stabilizeBefore,
        checkpoint: (name) => {
            // The concrete stabilization runner mutates its generated fork checkout.
            // Its two post-run notifications become CLI crash-safe only after the
            // exact result is protected by the durable transition record below.
            if (name === 'stabilize-run-finished' || name === 'stabilize-planned')
                deferredCheckpoints.push(name);
            else
                checkpoint(options, name);
        }
    });
    const authorityPath = state.phase === 'deps-advisory' ? DEPENDENCY_ADVISORY_REPORT_PATH : STABILIZE_REPORT_PATH;
    const authorityBefore = state.phase === 'deps-advisory' ? advisoryBefore : stabilizeBefore;
    const authorityContents = planned.writes.find((write) => write.path === authorityPath)?.contents ??
        (state.phase === 'deps-advisory' ? advisory : stabilizeBefore);
    if (authorityContents === null)
        throw ckError('ARTIFACT-BROKEN', `cycle transition has no ${authorityPath} authority`);
    const writes = normalizeWrites([
        { path: authorityPath, previous: authorityBefore, contents: authorityContents },
        ...(advisory !== advisoryBefore && advisory !== null
            ? [{ path: DEPENDENCY_ADVISORY_REPORT_PATH, previous: advisoryBefore, contents: advisory }]
            : []),
        ...planned.writes
    ], new Map([
        [DEPENDENCY_ADVISORY_REPORT_PATH, advisoryBefore],
        [STABILIZE_REPORT_PATH, stabilizeBefore]
    ]));
    const subject = state.phase === 'deps-advisory'
        ? `chore(cycle): record dependency advisory for ${state.targetPin.tag}`
        : `test(cycle): record stabilization for ${state.targetPin.tag}`;
    const record = makeCycleTransitionRecord({
        inputState: state,
        nextState: planned.nextState,
        writes,
        parent: head(options.patchesDir),
        subject,
        timestamp: commitTimestamp(nextTimestamp(options, state.updatedAt)),
        checkpoint: 'planned',
        commitSha: null
    });
    writeCycleTransitionRecord(options.patchesDir, record);
    for (const name of deferredCheckpoints)
        checkpoint(options, name);
    checkpoint(options, 'transition-planned');
    return resumeCycleTransition(options, record, commits);
}
export function resumeCycleTransition(options, record, commits) {
    let current = record;
    const observed = readCycleState(options.patchesDir);
    if (observed === null || (!same(observed, current.inputState) && !same(observed, current.nextState)))
        throw ckError('ARTIFACT-BROKEN', 'cycle transition state differs from both transaction endpoints');
    validateTransitionAuthority(options, current, observed);
    if (current.checkpoint === 'planned') {
        applyReportWrites(options.patchesDir, current.writes);
        checkpoint(options, 'transition-reports-written');
        const beforeState = readCycleState(options.patchesDir);
        if (beforeState === null || (!same(beforeState, current.inputState) && !same(beforeState, current.nextState)))
            throw ckError('ARTIFACT-BROKEN', 'cycle state changed after transition report preflight');
        if (!same(beforeState, current.nextState))
            writeCycleState(options.patchesDir, current.nextState);
        checkpoint(options, 'transition-state-written');
        current = updateCycleTransitionRecord(current, { checkpoint: 'written', commitSha: null });
        writeCycleTransitionRecord(options.patchesDir, current);
        checkpoint(options, 'transition-written');
    }
    if (current.checkpoint === 'written') {
        assertTransitionCheckoutBytes(options.patchesDir, current);
        const committed = commitCycleAtom({
            patchesDir: options.patchesDir,
            expectedBranch: current.nextState.branch,
            expectedParent: current.parent,
            targetTag: current.nextState.targetPin.tag,
            subject: current.subject,
            paths: transitionCommitPaths(current),
            timestamp: current.timestamp
        });
        if (committed.sha === null)
            throw ckError('INTERNAL', 'cycle transition unexpectedly produced no commit');
        commits.push(committed.sha);
        checkpoint(options, 'transition-commit-installed');
        checkpoint(options, current.inputState.phase === 'deps-advisory' ? 'deps-advisory-transition-commit-installed' : 'stabilize-transition-commit-installed');
        current = updateCycleTransitionRecord(current, { checkpoint: 'committed', commitSha: committed.sha });
        writeCycleTransitionRecord(options.patchesDir, current);
        checkpoint(options, 'transition-committed');
    }
    assertCommittedTransition(options.patchesDir, current);
    clearCycleTransitionRecord(options.patchesDir);
    return transitionResult(current, commits);
}
export function planTerminalTransaction(options, state, commits) {
    try {
        const inventory = buildInventory(options.patchesDir, options.type, { config: options.config });
        const plan = planCycleFinalization({
            patchesDir: options.patchesDir,
            state,
            inventory: { entryCount: inventory.entries.length, metrics: inventory.metrics }
        });
        const bump = findCycleBump(options.patchesDir, state, runGit);
        const finalParent = head(options.patchesDir);
        validateCycleCommitHistory({
            patchesDir: options.patchesDir,
            fromExclusive: bump.parent,
            toInclusive: finalParent,
            targetTag: state.targetPin.tag
        });
        const record = makeCycleTerminalRecord({
            state,
            plan,
            bumpParent: bump.parent,
            finalParent,
            subject: `docs(cycle): finalize ${state.targetPin.tag}`,
            timestamp: commitTimestamp(nextTimestamp(options, state.updatedAt)),
            checkpoint: 'planned',
            commitSha: null
        });
        writeCycleTerminalRecord(options.patchesDir, record);
        checkpoint(options, 'terminal-planned');
        return resumeCycleTerminal(options, record, commits);
    }
    catch (error) {
        if (!isCkError(error) || error.code !== 'LOG-INCOMPLETE')
            throw error;
        return makeResult(1, 'failed', state, 'log-incomplete', commits, { phase: 'done', error: error.message });
    }
}
export function resumeCycleTerminal(options, record, commits) {
    let current = record;
    if (current.checkpoint === 'planned') {
        const state = readCycleState(options.patchesDir);
        if (state !== null && !same(state, current.state))
            throw ckError('ARTIFACT-BROKEN', 'terminal state differs from final authority');
        if (head(options.patchesDir) !== current.finalParent)
            throw ckError('ARTIFACT-BROKEN', 'patchset HEAD changed before terminal apply');
        if (branch(options.patchesDir) !== current.state.branch)
            throw ckError('ARTIFACT-BROKEN', 'terminal apply is not on the cycle branch');
        validateCycleCommitHistory({
            patchesDir: options.patchesDir,
            fromExclusive: current.bumpParent,
            toInclusive: current.finalParent,
            targetTag: current.state.targetPin.tag
        });
        applyCycleFinalizationPlan(options.patchesDir, current.plan);
        checkpoint(options, 'terminal-state-deleted');
        current = updateCycleTerminalRecord(current, { checkpoint: 'applied', commitSha: null });
        writeCycleTerminalRecord(options.patchesDir, current);
        checkpoint(options, 'terminal-applied');
    }
    if (current.checkpoint === 'applied') {
        if (readCycleState(options.patchesDir) !== null)
            throw ckError('ARTIFACT-BROKEN', 'terminal apply retained cycle state');
        applyCycleFinalizationPlan(options.patchesDir, current.plan);
        const committed = commitCycleAtom({
            patchesDir: options.patchesDir,
            expectedBranch: current.state.branch,
            expectedParent: current.finalParent,
            targetTag: current.state.targetPin.tag,
            subject: current.subject,
            paths: terminalCommitPaths(current),
            timestamp: current.timestamp
        });
        if (committed.sha === null)
            throw ckError('INTERNAL', 'terminal transaction unexpectedly produced no commit');
        commits.push(committed.sha);
        checkpoint(options, 'terminal-commit-installed');
        current = updateCycleTerminalRecord(current, { checkpoint: 'committed', commitSha: committed.sha });
        writeCycleTerminalRecord(options.patchesDir, current);
        checkpoint(options, 'terminal-committed');
    }
    assertCommittedTerminal(options.patchesDir, options.config, current);
    clearCycleApplyRecord(options.patchesDir);
    return makeResult(0, 'completed', null, null, commits, {
        phase: 'done',
        commit: current.commitSha,
        checklist: current.plan.checklist
    });
}
export function committedTerminalReceipt(root, config) {
    const record = readCycleTerminalRecord(root);
    if (record === null || record.checkpoint !== 'committed')
        return null;
    assertCommittedTerminal(root, config, record);
    return record;
}
export function pendingTransition(root) {
    return readCycleTransitionRecord(root);
}
export function pendingTerminal(root) {
    return readCycleTerminalRecord(root);
}
function assertCommittedTransition(root, record) {
    if (record.checkpoint !== 'committed' || record.commitSha === null)
        throw ckError('ARTIFACT-BROKEN', 'transition is not committed');
    if (branch(root) !== record.nextState.branch)
        throw ckError('ARTIFACT-BROKEN', 'committed transition is not on its cycle branch');
    validateCycleCommitReceipt({
        patchesDir: root,
        expectedBranch: record.nextState.branch,
        expectedParent: record.parent,
        targetTag: record.nextState.targetPin.tag,
        subject: record.subject,
        paths: transitionCommitPaths(record),
        timestamp: record.timestamp,
        commitSha: record.commitSha
    });
    assertTransitionCheckoutBytes(root, record);
    const state = readCycleState(root);
    if (state === null || !same(state, record.nextState) || head(root) !== record.commitSha)
        throw ckError('ARTIFACT-BROKEN', 'committed transition does not match state and HEAD');
}
function assertTransitionCheckoutBytes(root, record) {
    const state = readCycleState(root);
    if (state === null || !same(state, record.nextState))
        throw ckError('ARTIFACT-BROKEN', 'transition checkout state differs from authority');
    for (const write of record.writes) {
        if (readText(root, write.path) !== write.contents)
            throw ckError('ARTIFACT-BROKEN', `${write.path}: transition checkout bytes differ from authority`);
    }
}
function assertCommittedTerminal(root, config, record) {
    if (record.checkpoint !== 'committed' || record.commitSha === null)
        throw ckError('ARTIFACT-BROKEN', 'terminal receipt is not committed');
    if (readCycleState(root) !== null)
        throw ckError('ARTIFACT-BROKEN', 'committed terminal receipt coexists with cycle state');
    if (record.state.targetPin.sha !== config.pin.sha || record.state.branch !== `${config.cycleBranchPrefix}${config.pin.tag}`)
        throw ckError('ARTIFACT-BROKEN', 'terminal receipt differs from current config identity');
    const currentHead = head(root);
    const exactCycleCheckout = branch(root) === record.state.branch && currentHead === record.commitSha;
    if (!exactCycleCheckout && runGit({ args: ['merge-base', '--is-ancestor', record.commitSha, currentHead], cwd: root }).status !== 0)
        throw ckError('ARTIFACT-BROKEN', 'terminal receipt commit is not an ancestor of current HEAD');
    const parent = gitValue(root, ['rev-parse', '--verify', `${record.commitSha}^1`], /^[0-9a-f]{40}$/, 'terminal parent');
    if (parent !== record.finalParent)
        throw ckError('ARTIFACT-BROKEN', 'terminal receipt final parent differs from commit history');
    validateCycleCommitReceipt({
        patchesDir: root,
        expectedBranch: record.state.branch,
        expectedParent: record.finalParent,
        targetTag: record.state.targetPin.tag,
        subject: record.subject,
        paths: terminalCommitPaths(record),
        timestamp: record.timestamp,
        commitSha: record.commitSha
    });
    const bump = findCycleBumpTo(root, record.state, record.commitSha, runGit);
    if (bump.parent !== record.bumpParent)
        throw ckError('ARTIFACT-BROKEN', 'terminal receipt bump parent differs from canonical bump');
    const status = runGit({ args: ['status', '--porcelain=v1', '--untracked-files=all'], cwd: root });
    if (status.status !== 0 || status.stdout !== '')
        throw ckError('ARTIFACT-BROKEN', 'terminal receipt requires a clean exact checkout');
    try {
        applyCycleFinalizationPlan(root, record.plan);
    }
    catch (error) {
        if (!isCkError(error))
            throw error;
        throw ckError('ARTIFACT-BROKEN', `terminal receipt outputs are not exact: ${error.message}`);
    }
    validateCycleCommitHistory({
        patchesDir: root,
        fromExclusive: record.bumpParent,
        toInclusive: record.commitSha,
        targetTag: record.state.targetPin.tag
    });
}
function normalizeWrites(writes, previous) {
    const final = new Map();
    for (const write of writes)
        final.set(write.path, { ...write, previous: previous.get(write.path) ?? null });
    return [...final.values()].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}
function transitionCommitPaths(record) {
    return byteSorted([...record.writes.filter((write) => write.previous !== write.contents).map((write) => write.path), CYCLE_STATE_PATH]);
}
function terminalCommitPaths(record) {
    return byteSorted([...record.plan.writes.map((write) => write.path), ...record.plan.deletions.map((deletion) => deletion.path)]);
}
function validateTransitionAuthority(options, record, observed) {
    if (record.inputState.phase === 'deps-advisory') {
        const writes = record.writes.filter((write) => write.path === DEPENDENCY_ADVISORY_REPORT_PATH);
        if (writes.length !== 1 || record.writes.length !== 1)
            throw ckError('ARTIFACT-BROKEN', 'advisory transition write set is not exact');
        validateCycleAdvisoryTransition({
            treeDir: options.resolution.path,
            inputState: record.inputState,
            nextState: record.nextState,
            document: writes[0]?.contents ?? ''
        });
        return;
    }
    const writes = record.writes.filter((write) => write.path === STABILIZE_REPORT_PATH);
    if (writes.length !== 1 || record.writes.length !== 1)
        throw ckError('ARTIFACT-BROKEN', 'stabilize transition write set is not exact');
    const reportsPristine = record.writes.every((write) => readText(options.patchesDir, write.path) === write.previous);
    validateCycleStabilizeTransition({
        patchesDir: options.patchesDir,
        treeDir: options.resolution.path,
        inputState: record.inputState,
        nextState: record.nextState,
        document: writes[0]?.contents ?? '',
        requirePatchSetLive: record.checkpoint === 'planned' && same(observed, record.inputState) && reportsPristine
    });
}
function transitionResult(record, commits) {
    const advisoryStop = record.inputState.phase === 'deps-advisory' && record.nextState.phase === 'deps-advisory';
    const redStop = record.nextState.phase === 'resolve';
    return makeResult(advisoryStop || redStop ? 3 : 0, advisoryStop || redStop ? 'stopped' : 'advanced', record.nextState, advisoryStop ? 'dependency-advisory' : redStop ? 'stabilize-red' : null, commits, transitionData(record));
}
function transitionData(record) {
    const stabilize = record.writes.find((write) => write.path === STABILIZE_REPORT_PATH);
    if (stabilize === undefined)
        return { phase: record.nextState.phase, red: [] };
    let value;
    try {
        value = JSON.parse(stabilize.contents);
    }
    catch {
        return { phase: record.nextState.phase, red: [] };
    }
    if (!isRecordValue(value))
        return { phase: record.nextState.phase, red: [] };
    const basis = value['basis'];
    if (!isRecordValue(basis))
        return { phase: record.nextState.phase, red: [] };
    return {
        phase: record.nextState.phase,
        red: Array.isArray(basis['red']) ? basis['red'] : [],
        contractFailures: Array.isArray(basis['contractFailures']) ? basis['contractFailures'] : []
    };
}
function makeResult(exitCode, status, state, stop, commitShas, data) {
    return { exitCode, status, state, stop, commitShas: [...commitShas], data: toJson(data) };
}
function nextTimestamp(options, minimum) {
    const source = options.now ?? options.dependencies?.now ?? (() => new Date());
    return new Date(Math.max(source().getTime(), Date.parse(minimum) + 1)).toISOString();
}
function commitTimestamp(timestamp) {
    return new Date(Math.ceil(Date.parse(timestamp) / 1000) * 1000).toISOString();
}
function checkpoint(options, name) {
    options.dependencies?.checkpoint?.(name);
}
function head(root) {
    return gitValue(root, ['rev-parse', '--verify', 'HEAD^{commit}'], /^[0-9a-f]{40}$/, 'HEAD');
}
function branch(root) {
    return gitValue(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], /.+/, 'branch');
}
function gitValue(root, args, pattern, label) {
    const result = runGit({ args, cwd: root });
    const value = result.stdout.trim();
    if (result.status !== 0 || !pattern.test(value))
        throw ckError('CONFIG', `cannot resolve exact cycle ${label}`);
    return value;
}
function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function isRecordValue(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
