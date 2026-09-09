/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit cycle - the resumable upgrade-cycle command surface.
// Contract: PROP-007 sec. 14; state machine: PROP-009 sec. 4.
import { EXIT_CHECK_FAILED, EXIT_OK, commandFlagGiven, forkResolution, requireProjectType } from '../lib/command.js';
import { loadConfig } from '../lib/configFile.js';
import { startCycle, cycleStatus, restartCycle } from '../lib/cycleControl.js';
import { readCycleControlRecord } from '../lib/cycleControlRecord.js';
import { continueCycle } from '../lib/cycleEngine.js';
import { clearCycleApplyRecord } from '../lib/cycleEngineRecord.js';
import { clearCycleTerminalRecord, readCycleTerminalRecord } from '../lib/cycleEngineTerminal.js';
import { committedTerminalReceipt } from '../lib/cycleEngineTransactions.js';
import { clearCycleTransitionRecord, readCycleTransitionRecord } from '../lib/cycleEngineTransition.js';
import { CYCLE_ARTIFACT_OUTCOMES, CYCLE_STATE_PATH } from '../lib/cycleState.js';
import { readCycleState } from '../lib/cycleState.js';
import { CYCLE_TEST_CRASH_ENV, cycleTestCrashCheckpoint, isCycleTestBuild } from '../lib/cycleTestCrash.js';
import { ckError, isCkError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
const YES = '--yes';
const ACTIONS = ['start', 'continue', 'status', 'restart'];
async function run(ctx) {
    try {
        return await runUnsafe(ctx);
    }
    catch (error) {
        if (!isCkError(error) || (error.code !== 'ARTIFACT-BROKEN' && error.file !== CYCLE_STATE_PATH))
            throw error;
        ctx.out.addError(error.toPayload());
        ctx.out.setData({
            status: 'failed',
            phase: null,
            counts: emptyCounts(),
            nextAction: error.hint ?? 'repair the malformed cycle artifact and retry',
            commits: [],
            red: [{ code: error.code, detail: error.message }]
        });
        return EXIT_CHECK_FAILED;
    }
}
async function runUnsafe(ctx) {
    const action = requireAction(ctx.args);
    assertArguments(action, ctx.args.slice(1));
    assertFlags(action, ctx);
    const crashCheckpoint = cycleTestCrashCheckpoint(ctx.env[CYCLE_TEST_CRASH_ENV], isCycleTestBuild(process.execArgv));
    // Every command, including the patchset-only status/restart operations, names
    // the exact fork tree and source before it does any domain work.
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    if (resolution.warning !== null) {
        ctx.out.warn(resolution.warning);
    }
    const config = requireConfig(ctx.config);
    switch (action) {
        case 'start': {
            const target = ctx.args[1];
            if (target === undefined) {
                throw usage('cycle start needs exactly one target tag or sha', 'usage: codkit cycle start <tag-or-sha>');
            }
            prepareCycleStart(ctx.patchesDir, resolution.path, config, requireProjectType(ctx));
            const started = startCycle({
                patchesDir: ctx.patchesDir,
                forkDir: resolution.path,
                config,
                type: requireProjectType(ctx),
                target,
                ...(crashCheckpoint === undefined ? {} : { dependencies: { checkpoint: crashCheckpoint } })
            });
            clearCycleRuntimeRecords(ctx.patchesDir);
            ctx.out.info(`${started.resumed ? 'resumed' : 'started'} cycle ${started.sourcePin.tag} -> ${started.targetPin.tag}`);
            // startCycle atomically bumps codkit.json. The phase engine must receive
            // those new bytes, not the pre-init config object loaded by main.
            const bumpedConfig = requireConfig(loadConfig(ctx.patchesDir));
            return runContinuation(ctx, resolution, bumpedConfig, [started.bumpCommit], crashCheckpoint);
        }
        case 'continue': {
            const resumed = resumeInterruptedInit(ctx, resolution.path, config, crashCheckpoint);
            return runContinuation(ctx, resolution, resumed.config, resumed.commits, crashCheckpoint);
        }
        case 'status': {
            const transition = readCycleTransitionRecord(ctx.patchesDir);
            if (transition !== null) {
                reportTransitionStatus(ctx, transition);
                return EXIT_OK;
            }
            let terminal = readCycleTerminalRecord(ctx.patchesDir);
            const liveState = readCycleState(ctx.patchesDir);
            if (terminal?.checkpoint === 'committed' &&
                liveState !== null &&
                terminal.state.targetPin.sha !== liveState.targetPin.sha &&
                config.pin.sha === liveState.targetPin.sha) {
                clearCycleTerminalRecord(ctx.patchesDir);
                terminal = null;
            }
            if (terminal !== null) {
                if (terminal.checkpoint === 'committed')
                    committedTerminalReceipt(ctx.patchesDir, config);
                reportTerminalStatus(ctx, terminal);
                return EXIT_OK;
            }
            const status = cycleStatus(ctx.patchesDir, config);
            reportStatus(ctx, status);
            return EXIT_OK;
        }
        case 'restart': {
            const restarted = restartCycle({
                patchesDir: ctx.patchesDir,
                forkDir: resolution.path,
                config,
                type: requireProjectType(ctx),
                yes: commandFlagGiven(ctx.commandFlags, YES),
                ...(crashCheckpoint === undefined ? {} : { dependencies: { checkpoint: crashCheckpoint } })
            });
            clearCycleRuntimeRecords(ctx.patchesDir);
            ctx.out.info(`restarted ${restarted.branch}: reset to ${restarted.resetTo}`);
            ctx.out.setData({
                status: 'restarted',
                phase: null,
                counts: emptyCounts(),
                nextAction: 'run codkit cycle start <tag-or-sha>',
                commits: [],
                red: [],
                branch: restarted.branch,
                resetTo: restarted.resetTo,
                removedState: restarted.removedState
            });
            return EXIT_OK;
        }
    }
}
function reportTransitionStatus(ctx, transition) {
    const observed = readCycleState(ctx.patchesDir);
    const state = observed !== null && JSON.stringify(observed) === JSON.stringify(transition.nextState) ? transition.nextState : transition.inputState;
    ctx.out.info(`cycle: active; phase: ${state.phase}; durable transition: ${transition.checkpoint}`);
    ctx.out.info('next: run codkit cycle continue');
    ctx.out.setData({
        status: 'active',
        phase: state.phase,
        counts: countsOf(state),
        nextAction: 'run codkit cycle continue',
        commits: transition.commitSha === null ? [] : [transition.commitSha],
        red: [],
        transaction: 'cycle-transition',
        checkpoint: transition.checkpoint
    });
}
function prepareCycleStart(root, forkDir, config, type) {
    let status = cycleStatus(root, config);
    if (status.status === 'active' && status.transaction === 'restart') {
        restartCycle({ patchesDir: root, forkDir, config, type, yes: true });
        status = cycleStatus(root, config);
    }
    if (status.status !== 'absent')
        return;
    if (readCycleControlRecord(root)?.status === 'done') {
        clearCycleRuntimeRecords(root);
        return;
    }
    if (readCycleTransitionRecord(root) !== null) {
        throw ckError('CONFIG', 'a durable cycle transition is pending', 'run codkit cycle continue before starting another cycle');
    }
    const terminal = readCycleTerminalRecord(root);
    if (terminal !== null) {
        if (terminal.checkpoint !== 'committed') {
            throw ckError('CONFIG', 'terminal cycle finalization is pending', 'run codkit cycle continue before starting another cycle');
        }
        committedTerminalReceipt(root, config);
    }
    clearCycleApplyRecord(root);
}
function clearCycleRuntimeRecords(root) {
    clearCycleApplyRecord(root);
    clearCycleTransitionRecord(root);
    clearCycleTerminalRecord(root);
}
function reportTerminalStatus(ctx, terminal) {
    const committed = terminal.checkpoint === 'committed';
    ctx.out.info(`cycle: ${committed ? 'completed' : 'active'}; phase: done`);
    ctx.out.info(`next: ${committed ? 'merge the cycle branch without squashing' : 'run codkit cycle continue'}`);
    ctx.out.setData({
        status: committed ? 'completed' : 'active',
        phase: 'done',
        counts: countsOf(terminal.state),
        nextAction: committed ? 'merge the cycle branch without squashing' : 'run codkit cycle continue',
        commits: terminal.commitSha === null ? [] : [terminal.commitSha],
        commit: terminal.commitSha,
        checklist: [...terminal.plan.checklist],
        red: []
    });
}
async function runContinuation(ctx, resolution, config, leadingCommits = [], crashCheckpoint) {
    const commits = [...leadingCommits];
    try {
        for (;;) {
            const result = await continueCycle({
                patchesDir: ctx.patchesDir,
                resolution,
                config,
                type: requireProjectType(ctx),
                ci: ctx.flags.ci,
                out: ctx.out,
                ...(crashCheckpoint === undefined ? {} : { dependencies: { checkpoint: crashCheckpoint } })
            });
            commits.push(...result.commitShas);
            // The engine commits one resumable atom at a time. One CLI invocation
            // is the keep-alive surface: advance through green atoms until the cycle
            // either completes, fails a terminal check, or reaches a human stop.
            if (result.status === 'advanced' && result.exitCode === EXIT_OK) {
                continue;
            }
            if (result.exitCode === EXIT_CHECK_FAILED && result.stop === 'log-incomplete') {
                const detail = jsonObject(result.data)['error'];
                ctx.out.addError({
                    code: 'LOG-INCOMPLETE',
                    message: typeof detail === 'string' ? detail : 'the cycle journal is incomplete',
                    hint: 'complete every required non-clean artifact journal entry and retry cycle continue'
                });
            }
            ctx.out.setData(continueData(result, commits));
            return result.exitCode;
        }
    }
    catch (error) {
        // LOG-INCOMPLETE is a cycle completeness verdict (exit 1). It is also
        // used by CI for missing runner evidence (exit 2), so it cannot be mapped
        // globally in main.ts.
        if (!isCkError(error) || error.code !== 'LOG-INCOMPLETE') {
            throw error;
        }
        ctx.out.addError(error.toPayload());
        ctx.out.setData({
            status: 'failed',
            phase: null,
            counts: emptyCounts(),
            nextAction: error.hint ?? 'complete the cycle journal and retry',
            commits: [...new Set(commits)],
            red: [{ code: error.code, detail: error.message }]
        });
        return EXIT_CHECK_FAILED;
    }
}
function resumeInterruptedInit(ctx, forkDir, config, crashCheckpoint) {
    const state = readCycleState(ctx.patchesDir);
    if (state?.phase !== 'init' || state.transaction?.kind !== 'init')
        return { config, commits: [] };
    const started = startCycle({
        patchesDir: ctx.patchesDir,
        forkDir,
        config,
        type: requireProjectType(ctx),
        target: state.targetPin.sha,
        ...(crashCheckpoint === undefined ? {} : { dependencies: { checkpoint: crashCheckpoint } })
    });
    ctx.out.info(`resumed cycle init ${started.sourcePin.tag} -> ${started.targetPin.tag}`);
    return { config: requireConfig(loadConfig(ctx.patchesDir)), commits: [started.bumpCommit] };
}
function requireAction(args) {
    const action = args[0];
    if (action !== undefined && ACTIONS.some((known) => known === action)) {
        return action;
    }
    throw usage(action === undefined ? 'cycle needs a subcommand' : `unknown cycle subcommand: ${action}`, 'usage: codkit cycle start <tag-or-sha> | continue | status | restart --yes');
}
function assertArguments(action, args) {
    const expected = action === 'start' ? 1 : 0;
    if (args.length === expected) {
        return;
    }
    const suffix = action === 'start' ? ' <tag-or-sha>' : action === 'restart' ? ' --yes' : '';
    throw usage(`cycle ${action} ${expected === 0 ? 'takes no arguments' : 'needs exactly one target tag or sha'}`, `usage: codkit cycle ${action}${suffix}`);
}
function assertFlags(action, ctx) {
    if (action !== 'restart' && commandFlagGiven(ctx.commandFlags, YES)) {
        throw usage(`flag ${YES} is only valid for cycle restart`, 'usage: codkit cycle restart --yes');
    }
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: cycle needs the source pin and branch conventions', 'run cycle from a patchset checkout that carries codkit.json');
    }
    return config;
}
function reportStatus(ctx, status) {
    if (status.status === 'absent') {
        ctx.out.info('cycle: absent');
        ctx.out.info(`next: ${status.nextAction}`);
        ctx.out.setData({
            status: status.status,
            phase: null,
            counts: emptyCounts(),
            nextAction: status.nextAction,
            commits: [],
            red: []
        });
        return;
    }
    ctx.out.info(`cycle: ${status.status}; phase: ${status.phase}`);
    ctx.out.info(`outcomes: ${formatCounts(status.counts)}; resolved: ${status.resolved}`);
    ctx.out.info(`next: ${status.nextAction}`);
    ctx.out.setData({
        status: status.status,
        phase: status.phase,
        counts: status.counts,
        nextAction: status.nextAction,
        commits: [],
        red: [],
        branch: status.branch,
        targetPin: status.targetPin,
        transaction: status.transaction,
        resolved: status.resolved
    });
}
function continueData(result, leadingCommits = []) {
    const details = jsonObject(result.data);
    const commits = [...new Set([...leadingCommits, ...result.commitShas])];
    return {
        ...details,
        status: result.status,
        phase: result.state?.phase ?? details['phase'] ?? (result.status === 'completed' ? 'done' : null),
        counts: result.state === null ? (details['counts'] ?? emptyCounts()) : countsOf(result.state),
        nextAction: result.state?.nextAction ?? details['nextAction'] ?? completedAction(result),
        commits,
        red: details['red'] ?? [],
        stop: result.stop
    };
}
function countsOf(state) {
    return Object.fromEntries(CYCLE_ARTIFACT_OUTCOMES.map((outcome) => [outcome, state.artifacts[outcome].length]));
}
function emptyCounts() {
    return Object.fromEntries(CYCLE_ARTIFACT_OUTCOMES.map((outcome) => [outcome, 0]));
}
function formatCounts(counts) {
    return CYCLE_ARTIFACT_OUTCOMES.map((outcome) => `${outcome}=${counts[outcome]}`).join(', ');
}
function jsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { report: value };
}
function completedAction(result) {
    return result.status === 'completed' ? 'cycle completed' : (result.stop ?? 'run codkit cycle continue');
}
function usage(message, hint) {
    return ckError('CONFIG', message, hint);
}
export const cycleCommand = {
    name: 'cycle',
    summary: 'upgrade cycle: start <tag-or-sha>, continue, status, restart --yes',
    configMode: 'load',
    maxArgs: 2,
    commandFlags: [YES],
    run
};
