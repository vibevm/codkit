import { CONFIG_FILE_NAME } from './configFile.js';
import { currentBranchName, headCommit, branchTip, readPatchSetStatus, assertOnlyCycleStatus, samePin, recognizeBump } from './cycleControlGit.js';
import { pinKey } from './pinIdentity.js';
import { ckError } from './messages.js';
export function inspectInitStep(patchesDir, state, workingPin, git, workspace) {
    const transaction = state.transaction;
    if (state.phase !== 'init' || transaction?.kind !== 'init') {
        throw ckError('CONFIG', 'cycle state is not an init transaction', 'inspect cycle status before retrying start');
    }
    const current = currentBranchName(patchesDir, git);
    const head = headCommit(patchesDir, git);
    const tip = branchTip(patchesDir, state.branch, git);
    const status = readPatchSetStatus(patchesDir, git, workspace);
    if (current === transaction.baseBranch && head === transaction.baseCommit && tip === null && samePin(workingPin, state.sourcePin)) {
        assertOnlyCycleStatus(status, 'none');
        return 'create-branch';
    }
    if (current === transaction.baseBranch &&
        current === state.branch &&
        head === transaction.baseCommit &&
        tip === transaction.baseCommit &&
        samePin(workingPin, state.sourcePin)) {
        assertOnlyCycleStatus(status, 'none');
        return 'write-config';
    }
    if (current !== state.branch || tip !== head) {
        throw initMismatch(state, `current=${current}, HEAD=${head}, branchTip=${tip ?? 'absent'}`);
    }
    if (head === transaction.baseCommit && samePin(workingPin, state.sourcePin)) {
        assertOnlyCycleStatus(status, 'none');
        return 'write-config';
    }
    if (head === transaction.baseCommit && samePin(workingPin, state.targetPin)) {
        const configCode = status.find((entry) => entry.path === CONFIG_FILE_NAME)?.code;
        if (configCode === ' M') {
            assertOnlyCycleStatus(status, 'unstaged');
            return 'stage-config';
        }
        if (configCode === 'M ') {
            assertOnlyCycleStatus(status, 'staged');
            return 'commit-bump';
        }
    }
    if (samePin(workingPin, state.targetPin)) {
        const bump = recognizeBump(patchesDir, 'HEAD', state.targetPin, git);
        if (bump !== null && bump.parent === transaction.baseCommit && samePin(bump.sourcePin, state.sourcePin)) {
            assertOnlyCycleStatus(status, 'none');
            return 'complete';
        }
    }
    throw initMismatch(state, `HEAD=${head}, config pin=${pinKey(workingPin)}@${workingPin.sha}`);
}
export function initAction(step, state) {
    return {
        'create-branch': `create ${state.branch}`,
        'write-config': `write target pin ${pinKey(state.targetPin)}`,
        'stage-config': `stage ${CONFIG_FILE_NAME}`,
        'commit-bump': 'retry canonical bump commit',
        complete: 'finish init state and continue apply'
    }[step];
}
export function initMismatch(state, detail) {
    const base = state.transaction?.kind === 'init' ? state.transaction.baseCommit : 'recorded base';
    return ckError('CONFIG', `init transaction does not match its exact checkpoint: ${detail}`, `restore ${base} or the canonical bump`);
}
