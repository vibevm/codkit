/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit build up|down|status|errors - the wrapper over the watch daemons of
// the fork tree. Contract: PROP-007 section 13; process model, channels, traps
// and the algorithm of `errors`: PROP-010 section 2.
//
// These are commands over the tree, so each of them resolves the tree and runs
// the identity checks first; `up` runs them in write mode, because it is about
// to start processes that write into the tree. None of them takes the per-tree
// lock: a daemon outlives the command that started it, and holding a lock for
// the lifetime of a background process would block every other command for
// hours.
//
// Two refusals here carry no CK error code, deliberately: "a watcher somebody
// else started is already running over this tree" and "no daemon is running" or
// "the pass did not finish in time" are conditions of the environment around
// the command, and PROP-007 section 13 fixes their exit codes (1 and 2) without
// naming codes for them.
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, commandFlagValue, forkResolution } from '../lib/command.js';
import { DEFAULT_ERRORS_TIMEOUT_MS, DEFAULT_UP_CHANNELS, downChannel, foreignWatchers, inotifyWarning, inventoryTargets, isMine, logPath, loadBuildWatch, readFinishedPass, readPass, selectChannels, statusOf, treeRelativePath, upChannel } from '../lib/buildWrap.js';
import { treeId } from '../lib/fingerprint.js';
import { buildInventory } from '../lib/inventory.js';
import { ckError, isCkError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { checkTree } from '../lib/treeIdentity.js';
const CHANNEL = '--channel';
const MINE = '--mine';
const TIMEOUT = '--timeout';
async function run(ctx, mode) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    const config = requireConfig(ctx.config, mode);
    const watch = loadBuildWatch(ctx.patchesDir);
    const requested = commandFlagValue(ctx.commandFlags, CHANNEL);
    const identity = checkTree(resolution, config, { mode: mode === 'up' ? 'write' : 'read' });
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    if (mode === 'up') {
        return runUp(ctx, watch, requested, resolution.path);
    }
    if (mode === 'status') {
        return runStatus(ctx, watch, requested, resolution.path);
    }
    if (mode === 'down') {
        return runDown(ctx, watch, requested, resolution.path);
    }
    return runErrors(ctx, watch, requested, resolution.path, config);
}
// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------
function runUp(ctx, watch, requested, treeDir) {
    const channels = selectChannels(watch, requested, DEFAULT_UP_CHANNELS);
    const id = treeId(treeDir);
    // The environment contract of PROP-010 sec. 2: a warning, never a refusal.
    const inotify = inotifyWarning();
    if (inotify !== null) {
        ctx.out.warn(inotify);
    }
    // Everything living, not only what was asked for: our own compilers must not
    // be mistaken for somebody else's watcher.
    const ourGroups = new Set();
    for (const known of watch.channels) {
        const state = statusOf(ctx.patchesDir, known.name, { expectedTreeId: id, expectedTreePath: treeDir });
        if (state.state === 'living' && state.record !== null) {
            ourGroups.add(state.record.pid);
        }
    }
    const foreign = foreignWatchers(treeDir, ourGroups);
    if (foreign.length > 0) {
        for (const watcher of foreign) {
            ctx.out.warn(`foreign watcher over ${treeDir}: pid ${watcher.pid} (${watcher.commandLine})`);
        }
        ctx.out.warn('codkit build up refuses to start next to a watcher it did not start: two watchers over one tree fight over out/. ' +
            `Stop the process(es) above, then re-run; nothing was started (${foreign.length} found)`);
        ctx.out.setData({ foreignWatchers: foreign.map((watcher) => ({ pid: watcher.pid, commandLine: watcher.commandLine })) });
        return EXIT_CHECK_FAILED;
    }
    const rows = [];
    let refused = 0;
    for (const channel of channels) {
        const result = upChannel({ patchesDir: ctx.patchesDir, treeDir, treeId: id, onWarn: (text) => ctx.out.warn(text) }, channel);
        if (!result.ok) {
            refused += 1;
            ctx.out.warn(result.reason);
            rows.push({ channel: channel.name, action: 'refused', reason: result.reason });
            continue;
        }
        if (result.action === 'already-running') {
            // The trap of PROP-010 section 2: restarting transpile empties out/.
            ctx.out.info(`${channel.name}: already running (pid ${result.pid}); not restarted`);
        }
        else {
            ctx.out.info(`${channel.name}: started (pid ${result.pid}), npm run ${channel.script}, log ${result.log}`);
        }
        rows.push({ channel: channel.name, action: result.action, pid: result.pid, log: result.log, script: channel.script });
    }
    ctx.out.setData({ channels: rows });
    return refused === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
function runStatus(ctx, watch, requested, treeDir) {
    const channels = selectChannels(watch, requested, watch.channels.map((channel) => channel.name));
    const rows = [];
    for (const channel of channels) {
        const state = statusOf(ctx.patchesDir, channel.name, treeProbe(treeDir));
        const pid = state.state === 'dead' ? 0 : (state.record?.pid ?? 0);
        ctx.out.info(`${channel.name.padEnd(12)} ${state.state.padEnd(7)} ${state.detail}`);
        rows.push({
            channel: channel.name,
            state: state.state,
            pid,
            detail: state.detail,
            script: channel.script,
            log: logPath(ctx.patchesDir, channel.name),
            startedAt: state.record?.startedAt ?? null,
            recordedTreeId: state.record?.treeId ?? null,
            recordedTreePath: state.record?.treePath ?? null,
            treeMatches: state.treeMatches
        });
    }
    ctx.out.setData({ channels: rows });
    return EXIT_OK;
}
// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------
async function runDown(ctx, watch, requested, treeDir) {
    const channels = selectChannels(watch, requested, watch.channels.map((channel) => channel.name));
    const rows = [];
    let worst = EXIT_OK;
    for (const channel of channels) {
        // One channel that cannot be stopped must not hide the ones that can. A
        // throw here used to abort the sweep before the later channels were even
        // inspected - leaving their watchers running - and skip the envelope, so
        // the command reported nothing about the channels it did stop.
        try {
            const result = await downChannel(ctx.patchesDir, channel.name, { ...treeProbe(treeDir), onWarn: (text) => ctx.out.warn(text) });
            if (result.action === 'not-running') {
                ctx.out.info(`${channel.name}: not running`);
            }
            else {
                ctx.out.info(`${channel.name}: ${result.action} (pid ${result.pid} and its process group)`);
            }
            rows.push({ channel: channel.name, action: result.action, pid: result.pid });
        }
        catch (error) {
            const detail = isCkError(error) ? error.toPayload().message : error instanceof Error ? error.message : String(error);
            ctx.out.warn(`${channel.name}: ${detail}`);
            rows.push({ channel: channel.name, action: 'refused', detail });
            worst = EXIT_ENVIRONMENT;
        }
    }
    ctx.out.setData({ channels: rows });
    return worst;
}
// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------
async function runErrors(ctx, watch, requested, treeDir, config) {
    const timeoutMs = timeoutOf(ctx);
    if (timeoutMs === null) {
        ctx.out.warn(`${TIMEOUT} expects a positive number of seconds`);
        return EXIT_ENVIRONMENT;
    }
    let channels;
    if (requested === null) {
        // No channel named: every channel that has an answer - one that is
        // running, and one whose daemon is gone while its log still holds the
        // pass it finished.
        channels = watch.channels.filter((channel) => hasAnswer(ctx.patchesDir, channel, treeDir));
        if (channels.length === 0) {
            ctx.out.warn(`no build daemon is running for this tree; hint: run codkit build up`);
            ctx.out.setData({ channels: [] });
            return EXIT_ENVIRONMENT;
        }
    }
    else {
        channels = selectChannels(watch, requested, DEFAULT_UP_CHANNELS);
    }
    const mine = commandFlagGiven(ctx.commandFlags, MINE);
    const targets = mine ? inventoryTargets(buildInventory(ctx.patchesDir, { config }), config.ownDirName) : new Set();
    const rows = [];
    let worst = EXIT_OK;
    for (const channel of channels) {
        const state = statusOf(ctx.patchesDir, channel.name, treeProbe(treeDir));
        if (state.state === 'starting' || state.state === 'unknown') {
            ctx.out.warn(`${channel.name}: ${state.detail}; refusing to read or certify any existing log`);
            rows.push({ channel: channel.name, state: state.state, detail: state.detail });
            worst = EXIT_ENVIRONMENT;
            continue;
        }
        if (state.state !== 'living') {
            // PROP-007 sec. 13: a daemon that is gone is exit 2 only when its log
            // carries no finished pass. When it does, that pass is the answer, with
            // a warning that nothing is watching the tree any more - which is what
            // makes a single CI pass usable after its daemon has ended.
            const finished = gonePass(ctx.patchesDir, channel, state.record !== null, treeDir);
            if (finished === null) {
                ctx.out.warn(`${channel.name}: no daemon is running (${state.detail}); ` + `hint: run codkit build up --channel ${channel.name}`);
                rows.push({ channel: channel.name, state: 'dead' });
                worst = EXIT_ENVIRONMENT;
                continue;
            }
            ctx.out.warn(`${channel.name}: the daemon is gone (${state.detail}); showing the finished pass from the log ` +
                `(${logPath(ctx.patchesDir, channel.name)}); hint: run codkit build up --channel ${channel.name} to watch the tree again`);
            const reportedOfGone = mine ? mineOnly(finished.errors, treeDir, config.ownDirName, targets) : finished.errors;
            printPass(ctx, channel, finished, reportedOfGone, mine);
            rows.push(rowOf(channel, finished, reportedOfGone, mine, true));
            if (reportedOfGone.length > 0 || (!mine && finished.errorCount > 0)) {
                worst = worst === EXIT_ENVIRONMENT ? EXIT_ENVIRONMENT : EXIT_CHECK_FAILED;
            }
            continue;
        }
        const outcome = await readPass(ctx.patchesDir, channel, { timeoutMs, probe: treeProbe(treeDir) });
        if (outcome.state === 'gone') {
            ctx.out.warn(`${channel.name}: the daemon stopped before the pass finished (log ${logPath(ctx.patchesDir, channel.name)}); ` +
                `hint: run codkit build up --channel ${channel.name}`);
            rows.push({ channel: channel.name, state: 'gone' });
            worst = EXIT_ENVIRONMENT;
            continue;
        }
        if (outcome.state === 'timeout') {
            ctx.out.warn(`${channel.name}: the current pass did not finish within ${Math.round(timeoutMs / 1000)}s ` +
                `(log ${logPath(ctx.patchesDir, channel.name)}); hint: raise ${TIMEOUT} or check the daemon`);
            rows.push({ channel: channel.name, state: 'timeout' });
            worst = EXIT_ENVIRONMENT;
            continue;
        }
        const report = outcome.report;
        const reported = mine ? mineOnly(report.errors, treeDir, config.ownDirName, targets) : report.errors;
        printPass(ctx, channel, report, reported, mine);
        rows.push(rowOf(channel, report, reported, mine, false));
        if (reported.length > 0 || (!mine && report.errorCount > 0)) {
            worst = worst === EXIT_ENVIRONMENT ? EXIT_ENVIRONMENT : EXIT_CHECK_FAILED;
        }
    }
    ctx.out.setData({ channels: rows, mine });
    return worst;
}
function mineOnly(errors, treeDir, ownDirName, targets) {
    return errors.filter((error) => isMine(treeRelativePath(error.file, treeDir), ownDirName, targets));
}
/**
 * The finished pass of a channel whose daemon is gone, or null when there is
 * none to show.
 *
 * `hasRecord` is what ties the log to a daemon of this tree: `up` rotates the
 * log when it starts a channel, so the log beside a record is the log of that
 * record's run. A channel with no record was never started here, or was stopped
 * with `build down` - which retires the channel, and with it the answer.
 */
function gonePass(patchesDir, channel, hasRecord, treeDir) {
    return hasRecord ? readFinishedPass(patchesDir, channel, { probe: treeProbe(treeDir) }) : null;
}
/** Whether `errors` has anything to report about a channel it was not asked for. */
function hasAnswer(patchesDir, channel, treeDir) {
    const state = statusOf(patchesDir, channel.name, treeProbe(treeDir));
    if (state.state !== 'dead') {
        return true;
    }
    return gonePass(patchesDir, channel, state.record !== null, treeDir) !== null;
}
function treeProbe(treeDir) {
    return { expectedTreeId: treeId(treeDir), expectedTreePath: treeDir };
}
function printPass(ctx, channel, report, reported, mine) {
    ctx.out.info(`--- ${channel.name}: last finished pass (${report.lines.length} line(s))`);
    for (const line of report.lines) {
        ctx.out.info(line);
    }
    const total = report.errorCount;
    const source = report.countFromSummary ? 'reported by the pass' : 'parsed from the log';
    ctx.out.info(`--- ${channel.name}: ${total} error(s) ${source}${mine ? `, ${reported.length} of them mine` : ''}`);
    for (const error of reported) {
        ctx.out.info(`  ${formatError(error)}`);
    }
}
function formatError(error) {
    const position = error.line === null ? '' : error.column === null ? `:${error.line}` : `:${error.line}:${error.column}`;
    const code = error.code === null ? '' : ` ${error.code}`;
    return `${error.file}${position}${code}: ${error.message}`;
}
/**
 * One channel's row. A channel whose daemon is gone gives the ordinary row, with
 * the state it is really in and the mark that says where the numbers came from.
 */
function rowOf(channel, report, reported, mine, gone) {
    return {
        channel: channel.name,
        state: gone ? 'dead' : 'living',
        daemonGone: gone,
        errorCount: report.errorCount,
        countFromSummary: report.countFromSummary,
        reportedCount: reported.length,
        mine,
        lines: [...report.lines],
        errors: reported.map((error) => ({
            file: error.file,
            line: error.line,
            column: error.column,
            code: error.code,
            message: error.message
        }))
    };
}
/** `--timeout <seconds>`; null when the value is not a positive number. */
function timeoutOf(ctx) {
    const raw = commandFlagValue(ctx.commandFlags, TIMEOUT);
    if (raw === null) {
        return DEFAULT_ERRORS_TIMEOUT_MS;
    }
    if (!/^\d+$/.test(raw)) {
        return null;
    }
    const seconds = Number.parseInt(raw, 10);
    return seconds > 0 ? seconds * 1000 : null;
}
function requireConfig(config, mode) {
    if (config === null) {
        throw ckError('CONFIG', `codkit.json was not found in the patchset root: build ${mode} needs the pin and the own directory of this repository`, `run build ${mode} from a patchset checkout that carries codkit.json`);
    }
    return config;
}
export const buildUpCommand = {
    name: 'build up',
    summary: 'start the watch daemons of the fork tree in the background',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [CHANNEL],
    run: (ctx) => run(ctx, 'up')
};
export const buildDownCommand = {
    name: 'build down',
    summary: 'stop the watch daemons of the fork tree',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [CHANNEL],
    run: (ctx) => run(ctx, 'down')
};
export const buildStatusCommand = {
    name: 'build status',
    summary: 'report which watch daemons are living, by probing their processes',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [CHANNEL],
    run: (ctx) => run(ctx, 'status')
};
export const buildErrorsCommand = {
    name: 'build errors',
    summary: 'wait for the current compilation pass and print its errors',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [CHANNEL, MINE, TIMEOUT],
    run: (ctx) => run(ctx, 'errors')
};
