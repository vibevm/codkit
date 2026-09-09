/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { dependencyAdvisoryAcknowledgement, inspectDependencyAdvisory } from './cycleAdvisory.js';
import { DEPENDENCY_ADVISORY_REPORT_PATH, STABILIZE_REPORT_PATH, parseAdvisoryDocument, parseStabilizeAuthority } from './cycleStabilize.js';
import { captureCycleLiveSnapshot } from './cycleStabilizeEvidence.js';
import { cycleStateSchema } from './cycleState.js';
import { ckError, isCkError } from './messages.js';
export function validateCycleAdvisoryTransition(options) {
    if (options.inputState.phase !== 'deps-advisory')
        throw artifact('advisory transition input phase is not deps-advisory');
    const report = inspectDependencyAdvisory({
        cwd: options.treeDir,
        oldPin: options.inputState.sourcePin.sha,
        newPin: options.inputState.targetPin.sha,
        type: options.type
    });
    try {
        const parsed = parseAdvisoryDocument(options.document, report, options.inputState);
        if (parsed === null)
            throw artifact(`missing ${DEPENDENCY_ADVISORY_REPORT_PATH}`);
        const expectedAcknowledgement = dependencyAdvisoryAcknowledgement(report);
        if (parsed.acknowledgement !== expectedAcknowledgement)
            throw artifact(`acknowledgement mismatch in ${DEPENDENCY_ADVISORY_REPORT_PATH}`);
        const stopped = parsed.acceptance === 'pending';
        const expected = transition(options.inputState, stopped ? 'deps-advisory' : 'stabilize', stopped
            ? `acknowledge dependency advisory with ${parsed.acknowledgement ?? ''}`
            : 'run verify, build and contract stabilization gates', options.nextState.updatedAt);
        if (!same(expected, options.nextState))
            throw artifact(`next state mismatch in ${DEPENDENCY_ADVISORY_REPORT_PATH}`);
    }
    catch (error) {
        throw semantic(error);
    }
}
export function validateCycleStabilizeTransition(options) {
    let report;
    try {
        report = parseStabilizeAuthority(options.document, options.inputState);
        if (!same(report.nextState, options.nextState))
            throw artifact(`next state mismatch in ${STABILIZE_REPORT_PATH}`);
    }
    catch (error) {
        throw semantic(error);
    }
    const current = captureCycleLiveSnapshot(options.patchesDir, options.treeDir, options.inputState.targetPin.sha);
    if (!same(current.fork, report.basis.live.fork) || (options.requirePatchSetLive && !same(current.patchset, report.basis.live.patchset)))
        throw artifact(`live evidence mismatch in ${STABILIZE_REPORT_PATH}`);
    if (report.basis.red.length === 0) {
        const tip = report.basis.execution.build?.branchTip;
        if (tip === null || tip === undefined || !/^[0-9a-f]{40}$/.test(tip) || tip !== report.basis.live.fork.head)
            throw artifact(`green ${STABILIZE_REPORT_PATH} does not bind the concrete build branch tip`);
    }
}
function transition(state, phase, nextAction, updatedAt) {
    return cycleStateSchema.parse({ ...state, phase, nextAction, updatedAt });
}
function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function artifact(message) {
    return ckError('ARTIFACT-BROKEN', message, 'restore the durable cycle report or restart the cycle');
}
function semantic(error) {
    if (isCkError(error) && error.code === 'ARTIFACT-BROKEN')
        return error;
    return artifact(error instanceof Error ? error.message : String(error));
}
