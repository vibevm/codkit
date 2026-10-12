/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { pinKey } from './pinIdentity.js';
import { withoutDeliveredExtensionDirt } from './cycleOwnedDirt.js';
import { cycleRepositoryStatus } from './workspaceCycleStatus.js';
import { createHash } from 'node:crypto';
import { downChannel, loadBuildWatch } from './buildWrap.js';
import { runCi } from './ciEngine.js';
import { dependencyAdvisoryAcknowledgement, inspectDependencyAdvisory } from './cycleAdvisory.js';
import { captureCycleLiveSnapshot } from './cycleStabilizeEvidence.js';
import { stabilizeDocumentSchema } from './cycleStabilizeReport.js';
import { cycleStateSchema } from './cycleState.js';
import { treeId } from './fingerprint.js';
import { Output } from './jsonOut.js';
import { assertOwnedLockHandle, lockPath, readLock } from './lock.js';
import { ckError, isCkError } from './messages.js';
import { runVerify } from './verifyEngine.js';
const CYCLE_LOCK_ID = 'cycle-global';
const REPORT_VERSION = 1;
export const DEPENDENCY_ADVISORY_REPORT_PATH = 'cycle/report/deps-advisory.json';
export const STABILIZE_REPORT_PATH = 'cycle/report/stabilize.json';
export async function continueCycleStabilization(options) {
    assertInput(options);
    assertLiveLocks(options);
    if (options.state.phase === 'deps-advisory')
        return planAdvisory(options);
    return planStabilize(options);
}
async function planAdvisory(options) {
    const report = inspectDependencyAdvisory({
        cwd: options.resolution.path,
        oldPin: options.state.sourcePin.sha,
        newPin: options.state.targetPin.sha,
        type: options.type
    });
    options.checkpoint?.('advisory-inspected');
    assertLiveLocks(options);
    const acknowledgement = dependencyAdvisoryAcknowledgement(report);
    const existing = parseAdvisoryDocument(options.existingAdvisoryReport ?? null, report, options.state);
    const alreadyAccepted = existing !== null && existing.acceptance !== 'pending';
    const exactPersistedAcknowledgement = existing?.acceptance === 'pending' && acknowledgement !== null && options.acknowledgement === acknowledgement;
    const acceptance = acknowledgement === null
        ? 'not-required'
        : options.ci
            ? 'ci'
            : alreadyAccepted
                ? existing.acceptance
                : exactPersistedAcknowledgement
                    ? 'interactive'
                    : 'pending';
    const document = {
        codkitCycleDependencyAdvisory: REPORT_VERSION,
        state: options.state,
        report,
        acknowledgement,
        acceptance
    };
    const contents = serializeDocument(document);
    const stopped = acceptance === 'pending';
    const nextState = transition(options.state, stopped ? 'deps-advisory' : 'stabilize', stopped ? `acknowledge dependency advisory with ${acknowledgement ?? ''}` : 'run verify, build and contract stabilization gates', options.updatedAt);
    options.checkpoint?.('advisory-planned');
    return {
        exitCode: stopped ? 3 : 0,
        stopCode: stopped ? 3 : null,
        nextState,
        writes: writeIfChanged(DEPENDENCY_ADVISORY_REPORT_PATH, options.existingAdvisoryReport ?? null, contents),
        advisory: report,
        acknowledgement,
        execution: null,
        contractFailures: [],
        red: [],
        resumed: alreadyAccepted
    };
}
async function planStabilize(options) {
    const live = captureCycleLiveSnapshot(options.patchesDir, options.resolution.path, options.state.targetPin.sha);
    const existing = parseStabilizeDocument(options.existingStabilizeReport ?? null, options.state, live);
    if (existing !== null) {
        return stabilizationResult(existing, options.existingStabilizeReport ?? null, true);
    }
    options.checkpoint?.('stabilize-started');
    let execution;
    try {
        execution = await (options.runner ?? runConcreteStabilization)({
            patchesDir: options.patchesDir,
            resolution: options.resolution,
            config: options.config,
            type: options.type
        });
    }
    catch (error) {
        execution = failedExecution(error);
    }
    const after = captureCycleLiveSnapshot(options.patchesDir, options.resolution.path, options.state.targetPin.sha);
    const expectedForkRef = `refs/heads/${options.config.generatedBranchPrefix}${pinKey(options.state.targetPin)}`;
    const exactDeliveredDirt = options.runner === undefined &&
        withoutDeliveredExtensionDirt(cycleRepositoryStatus(options.resolution.path), options.patchesDir, options.resolution.path, options.type)
            .length === 0;
    const stable = options.runner === undefined
        ? concreteStabilizationWorldMatches(live, after, expectedForkRef, execution.build?.branchTip ?? null, exactDeliveredDirt)
        : same(live, after);
    if (!stable)
        execution = appendRunnerFailure(execution, 'live repository snapshot changed during stabilization');
    options.checkpoint?.('stabilize-run-finished');
    assertLiveLocks(options);
    const inventory = execution.verify?.inventory ?? null;
    const contractFailures = findContractFailures(execution, inventory?.entries ?? []);
    let red = buildRedList(execution, contractFailures);
    if (options.runner === undefined && red.length === 0 && !concreteBranchTipMatches(execution, after)) {
        execution = appendRunnerFailure(execution, 'green stabilization did not produce the exact checked build branch tip');
        red = buildRedList(execution, contractFailures);
    }
    const nextState = stabilizationState(options.state, contractFailures, red, options.updatedAt);
    const basis = {
        state: jsonClone(options.state),
        updatedAt: options.updatedAt,
        live: after,
        execution: jsonClone(execution),
        contractFailures,
        red
    };
    const base = {
        codkitCycleStabilize: options.config.codkitConfig >= 3 || options.state.codkitCycleState === 3 ? 2 : 1,
        basis,
        nextState
    };
    const document = { ...base, digest: digest(base) };
    options.checkpoint?.('stabilize-planned');
    return stabilizationResult(document, options.existingStabilizeReport ?? null, false);
}
function stabilizationResult(document, previous, resumed) {
    const parsed = stabilizeDocumentSchema.safeParse(document);
    if (!parsed.success)
        throw broken(`cannot plan ${STABILIZE_REPORT_PATH}: ${parsed.error.issues[0]?.message ?? 'schema failure'}`);
    document = parsed.data;
    const stopped = document.basis.red.length > 0;
    return {
        exitCode: stopped ? 3 : 0,
        stopCode: stopped ? 3 : null,
        nextState: document.nextState,
        writes: writeIfChanged(STABILIZE_REPORT_PATH, previous, serializeDocument(document)),
        advisory: null,
        acknowledgement: null,
        execution: document.basis.execution,
        contractFailures: document.basis.contractFailures,
        red: document.basis.red,
        resumed
    };
}
export async function runConcreteStabilization(options) {
    const stdout = [];
    const stderr = [];
    const out = new Output({
        command: 'cycle stabilize',
        version: 'internal',
        jsonMode: true,
        streams: { writeOut: (chunk) => stdout.push(chunk), writeErr: (chunk) => stderr.push(chunk) }
    });
    let channels = [];
    let verify = null;
    let build = null;
    const failures = [];
    const cleanupFailures = [];
    try {
        // A type with no compile channels has no daemon to stop afterwards, and no
        // profile to read either (PROP-016 ##TYPE-CONFIGURED).
        channels = options.type.capabilities.has('build-channels')
            ? loadBuildWatch(options.type, options.patchesDir).channels.map((channel) => channel.name)
            : [];
        verify = runVerify({ ...options, type: options.type });
        build = await runCi({
            ...options,
            out,
            profile: 'build',
            effectiveDiffBase: null,
            pinGuardBase: null,
            verbose: false
        });
    }
    catch (error) {
        failures.push(error);
    }
    finally {
        for (const channel of channels) {
            try {
                // Bound to the tree this run stabilised: an unbound stop would signal
                // and delete a daemon owned by another fork tree sharing this patch set.
                await downChannel(options.patchesDir, channel, {
                    expectedTreeId: treeId(options.resolution.path),
                    expectedTreePath: options.resolution.path,
                    ...(options.config.workspace === undefined ? {} : { expectedWorkspaceId: options.config.workspace.record.id }),
                    ...(options.config.workspace === undefined ? {} : { workspaceRegistryRoot: options.config.workspace.registryRoot }),
                    onWarn: (text) => out.warn(text)
                });
            }
            catch (error) {
                cleanupFailures.push(error);
            }
        }
        out.finish(build?.exitCode ?? 2);
    }
    const envelope = parseEnvelope(stdout.join(''));
    const errors = [...envelope.errors];
    errors.push(...failures.map(errorPayload));
    return {
        verify,
        verifyExitCode: verify === null ? null : verify.findings.length === 0 ? 0 : 1,
        build,
        log: normalizedLines(stderr.join('')),
        errors,
        cleanupErrors: cleanupFailures.map(errorPayload),
        runnerFailure: failures.length === 0 ? null : failures.map((failure) => messageOf(failure)).join('; ')
    };
}
function findContractFailures(execution, entries) {
    if (!execution.build?.steps.some((step) => step.name === 'product tests' && step.state === 'failed'))
        return [];
    const text = execution.log.join('\n');
    const byTest = new Map();
    for (const entry of entries) {
        for (const test of entry.contractTests) {
            if (!containsToken(text, test))
                continue;
            const artifacts = byTest.get(test) ?? [];
            artifacts.push(entry.artifact);
            byTest.set(test, artifacts);
        }
    }
    return [...byTest.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([test, artifacts]) => ({ test, artifacts: uniqueSorted(artifacts) }));
}
function buildRedList(execution, contracts) {
    const red = [];
    if (execution.runnerFailure !== null)
        red.push(redItem('runner', 'heavy-runner', execution.runnerFailure));
    if (execution.verify === null)
        red.push(redItem('verify', 'missing', 'verify result is missing'));
    if (execution.verifyExitCode !== 0)
        red.push(redItem('verify', 'exit', `verify exited ${execution.verifyExitCode ?? 'without a code'}`));
    for (const finding of execution.verify?.findings ?? []) {
        red.push({ kind: 'verify', id: finding.code, detail: finding.message, artifact: finding.file ?? null });
    }
    if (execution.build === null)
        red.push(redItem('build', 'missing', 'build result is missing'));
    for (const step of execution.build?.steps ?? []) {
        if (step.state === 'failed')
            red.push(redItem('build', step.name, step.detail));
    }
    if (execution.build !== null) {
        if (execution.build.profile !== 'build')
            red.push(redItem('build', 'profile', `expected build profile, got ${execution.build.profile}`));
        if (execution.build.exitCode !== 0)
            red.push(redItem('build', 'exit', `build profile exited ${execution.build.exitCode}`));
        // The build profile skips `compile` when the project type declares no
        // compile channels and `product tests` when it has no own-root runner,
        // and the skipped step carries the reason (PROP-016 ##TYPE-AREA-BUILD).
        // A step that had nothing to do is not evidence of a broken upgrade;
        // `verify` is universal and has to be green whatever the family is.
        const skippable = new Set(['compile', 'product tests']);
        for (const required of ['verify', 'compile', 'product tests']) {
            const observed = execution.build.steps.find((step) => step.name === required);
            if (observed?.state === 'ok' || (skippable.has(required) && observed?.state === 'skipped'))
                continue;
            red.push(redItem('build', required, `required ${required} step was not observed green`));
        }
    }
    for (const error of execution.errors)
        red.push({ kind: 'error', id: error.code, detail: error.message, artifact: error.file ?? null });
    for (const error of execution.cleanupErrors)
        red.push({ kind: 'cleanup', id: error.code, detail: error.message, artifact: error.file ?? null });
    for (const contract of contracts) {
        for (const artifact of contract.artifacts) {
            red.push({ kind: 'contract', id: contract.test, detail: `contract test ${contract.test} failed`, artifact });
        }
    }
    return red;
}
function stabilizationState(state, contracts, red, updatedAt) {
    const failed = new Set(contracts.flatMap((contract) => contract.artifacts));
    const classified = new Set(Object.values(state.artifacts).flat());
    for (const artifact of failed)
        if (!classified.has(artifact))
            throw broken(`contract test names unclassified artifact ${artifact}`);
    const artifacts = {};
    for (const [outcome, paths] of Object.entries(state.artifacts)) {
        artifacts[outcome] = outcome === 'contract-failed' ? [...paths] : paths.filter((path) => !failed.has(path));
    }
    artifacts['contract-failed'] = uniqueSorted([...artifacts['contract-failed'], ...failed]);
    const phase = red.length === 0 ? 'done' : 'resolve';
    return transition({ ...state, artifacts, resolved: state.resolved.filter((path) => !failed.has(path)) }, phase, phase === 'done' ? 'finalize the completed cycle' : `resolve ${red.length} stabilization failure(s)`, updatedAt);
}
function transition(state, phase, nextAction, updatedAt) {
    const candidate = { ...state, phase, nextAction, updatedAt };
    const parsed = cycleStateSchema.safeParse(candidate);
    if (!parsed.success) {
        throw ckError('CONFIG', `invalid cycle transition: ${parsed.error.issues[0]?.message ?? 'schema failure'}`);
    }
    return parsed.data;
}
export function parseAdvisoryDocument(document, report, state) {
    if (document === null)
        return null;
    const value = parseCanonicalDocument(document, DEPENDENCY_ADVISORY_REPORT_PATH);
    const expectedAcknowledgement = dependencyAdvisoryAcknowledgement(report);
    const acceptance = String(value['acceptance']);
    if (!same(Object.keys(value), ['codkitCycleDependencyAdvisory', 'state', 'report', 'acknowledgement', 'acceptance']) ||
        value['codkitCycleDependencyAdvisory'] !== REPORT_VERSION ||
        !same(value['state'], state) ||
        !same(value['report'], report) ||
        value['acknowledgement'] !== expectedAcknowledgement ||
        !['not-required', 'pending', 'interactive', 'ci'].includes(acceptance) ||
        (expectedAcknowledgement === null ? acceptance !== 'not-required' : acceptance === 'not-required')) {
        throw broken(`stale or malformed ${DEPENDENCY_ADVISORY_REPORT_PATH}`);
    }
    return value;
}
function parseStabilizeDocument(document, state, live) {
    if (document === null)
        return null;
    const report = parseStabilizeAuthority(document, state);
    if (!same(report.basis.live, live))
        return null;
    return report;
}
export function parseStabilizeAuthority(document, state) {
    const value = parseCanonicalDocument(document, STABILIZE_REPORT_PATH);
    const parsed = stabilizeDocumentSchema.safeParse(value);
    if (!parsed.success)
        throw broken(`stale or malformed ${STABILIZE_REPORT_PATH}: ${parsed.error.issues[0]?.message ?? 'schema failure'}`);
    const report = parsed.data;
    const withoutDigest = { ...value };
    delete withoutDigest['digest'];
    if (report.digest !== digest(withoutDigest))
        throw broken(`digest mismatch in ${STABILIZE_REPORT_PATH}`);
    if (!same(report.basis.state, state))
        throw broken(`input state mismatch in ${STABILIZE_REPORT_PATH}`);
    const inventory = report.basis.execution.verify?.inventory ?? null;
    const contracts = findContractFailures(report.basis.execution, inventory?.entries ?? []);
    if (!same(contracts, report.basis.contractFailures))
        throw broken(`contract evidence mismatch in ${STABILIZE_REPORT_PATH}`);
    const red = buildRedList(report.basis.execution, contracts);
    if (!same(red, report.basis.red))
        throw broken(`red evidence mismatch in ${STABILIZE_REPORT_PATH}`);
    const nextState = stabilizationState(state, contracts, red, report.basis.updatedAt);
    if (!same(nextState, report.nextState))
        throw broken(`next state mismatch in ${STABILIZE_REPORT_PATH}`);
    return report;
}
function concreteBranchTipMatches(execution, live) {
    const tip = execution.build?.branchTip;
    return tip !== null && tip !== undefined && /^[0-9a-f]{40}$/.test(tip) && tip === live.fork.head;
}
function parseCanonicalDocument(document, path) {
    let value;
    try {
        value = JSON.parse(document);
    }
    catch {
        throw broken(`${path} is not valid JSON`);
    }
    if (!isRecord(value) || serializeDocument(value) !== document)
        throw broken(`${path} is not canonical JSON`);
    return value;
}
function assertInput(options) {
    if (options.state.phase !== 'deps-advisory' && options.state.phase !== 'stabilize') {
        throw broken(`cycle phase must be deps-advisory or stabilize, got ${options.state.phase}`);
    }
    if (options.state.transaction !== null)
        throw broken(`${options.state.phase} requires transaction null`);
    if (!same(options.config.pin, options.state.targetPin))
        throw broken('codkit config pin does not match cycle target pin');
}
function assertLiveLocks(options) {
    assertLiveLock(options.locks.cycle, lockPath(options.patchesDir, CYCLE_LOCK_ID), 'cycle');
    assertLiveLock(options.locks.tree, lockPath(options.patchesDir, treeId(options.resolution.path)), 'tree');
}
function assertLiveLock(handle, expectedPath, label) {
    assertOwnedLockHandle(handle, `cycle stabilize ${label} lock`);
    if (handle.path !== expectedPath || handle.info.nonce === undefined)
        throw broken(`${label} lock capability is not for this cycle`);
    const current = readLock(expectedPath);
    if (current === null || !sameLock(current, handle.info))
        throw broken(`${label} lock capability is no longer live`);
}
function sameLock(left, right) {
    return left.pid === right.pid && left.startedAt === right.startedAt && left.command === right.command && left.nonce === right.nonce;
}
function failedExecution(error) {
    const payload = errorPayload(error);
    return { verify: null, verifyExitCode: null, build: null, log: [], errors: [payload], cleanupErrors: [], runnerFailure: payload.message };
}
function appendRunnerFailure(execution, message) {
    return {
        ...execution,
        errors: [...execution.errors, { code: 'CK-E-DIRTY-TREE', message }],
        runnerFailure: execution.runnerFailure ?? message
    };
}
function errorPayload(error) {
    if (isCkError(error)) {
        const payload = error.toPayload();
        return jsonClone({ ...payload, code: `CK-E-${payload.code}` });
    }
    return { code: 'CK-E-INTERNAL', message: messageOf(error) };
}
function parseEnvelope(document) {
    try {
        const value = JSON.parse(document);
        return { errors: Array.isArray(value.errors) ? value.errors : [] };
    }
    catch {
        return { errors: [{ code: 'CK-E-INTERNAL', message: 'cannot capture stabilization output envelope' }] };
    }
}
function normalizedLines(text) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized === '' ? [] : normalized.split('\n');
}
function containsToken(text, token) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escaped}(?:$|[^A-Za-z0-9_.-])`, 'm').test(text);
}
function redItem(kind, id, detail) {
    return { kind, id, detail, artifact: null };
}
function writeIfChanged(path, previous, contents) {
    return previous === contents ? [] : [{ path, previous, contents }];
}
function digest(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function serializeDocument(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}
function jsonClone(value) {
    return JSON.parse(JSON.stringify(value));
}
function uniqueSorted(values) {
    return [...new Set(values)].sort(compareText);
}
function compareText(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
export function concreteStabilizationWorldMatches(left, right, expectedForkRef, branchTip, exactDeliveredDirt = false) {
    if (!same(left.patchset, right.patchset))
        return false;
    if (branchTip === null || !/^[0-9a-f]{40}$/.test(branchTip))
        return same(left.fork, right.fork);
    return (right.fork.ref === expectedForkRef &&
        (right.fork.dirty === false || exactDeliveredDirt) &&
        right.fork.head === branchTip &&
        left.fork.targetCommit === right.fork.targetCommit &&
        left.fork.targetTree === right.fork.targetTree);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function broken(message) {
    return ckError('CONFIG', message, 'restore the durable cycle report or restart the cycle');
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
