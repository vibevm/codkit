/** @scope spec://codkit/modules/codkit/PROP-007#CMD-SYNC-TWO-WAY */
// codkit sync - the two-way command: one run that extracts what the fork tree
// has and delivers what the patch set has (PROP-007 sec. 5a ##CMD-SYNC-TWO-WAY;
// algorithm: PROP-008 sec. 5a; campaign TREE-COMMITS-SAVE, decisions D15-D21).
// The name was reserved for it since the one-way `sync` became `load` (D14).
//
// The run has two answers for a file both sides moved, and both are the
// phase's point, not a detail: the classification runs before the first write,
// so nothing happens until the conflict is named; then the 3-way goes into the
// tree file as diff3 markers under a durable transaction (##SYNC-CONFLICT-DIFF3),
// the run stops with exit 1, and the operator resolves it by hand -
// `sync --continue` finishes the run, `sync --abort` puts everything back
// (##SYNC-CONTINUE, ##SYNC-ABORT; the recovery lives in lib/syncRecovery.ts).
// A crash never leaves an unreadable half-state: the transaction record is
// written before the first mutation and retired after the last, and while it
// exists the engines refuse with CK-E-SYNC-IN-PROGRESS (D20).
//
// The halves are the one-way engines: the save half (`runSave`, with the
// patchset-shift refusal replaced by the per-target rule) and the load half
// (`runSync`, whose rebuild applies what patchset moved - explained by D16's
// extension of the rebuild invariant).
import { commandFlagGiven, commandFlagValue, forkResolution } from '../lib/command.js';
import { isCycleTestBuild } from '../lib/cycleTestCrash.js';
import { treeId } from '../lib/fingerprint.js';
import { runGit } from '../lib/gitx.js';
import { withLock } from '../lib/lock.js';
import { ckError, isCkError } from '../lib/messages.js';
import { classifyOwn, ownTargetRelativeDir } from '../lib/ownCopy.js';
import { encodePatchName } from '../lib/patchFormat.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { artifactTarget, blocked, materializeConflicts, NO_CLASSES, ok, runSyncRecovery, runWritePass, stoppedMidway, unfit } from '../lib/syncRecovery.js';
import { bothSidesConflictError, checkLineage, classifyTargets, loadedFrom, patchsetMovedError, reportSyncPlan } from '../lib/syncMerge.js';
import { PATCHES_DIR, generatedBranchName, runSync } from '../lib/syncEngine.js';
import { SYNC_TEST_CRASH_ENV, openSyncTransaction, refuseOverLiveSyncTransaction, retireSyncTransaction, saveSyncTransaction, syncCrashCheckpoint } from '../lib/syncTransaction.js';
import { readTreeMark, revParse } from '../lib/treeCache.js';
import { foreignCommits, treeHeadError } from '../lib/treeCommits.js';
import { changesSince } from '../lib/treeState.js';
import { checkTree } from '../lib/treeIdentity.js';
import { assertGeneratedRefExclusive } from '../lib/worktrees.js';
const SQUASH = '--squash';
const COMMIT = '--commit';
const MESSAGE = '--message';
const DISCARD = '--discard';
const FRESH = '--fresh';
const DRY_RUN = '--dry-run';
const ABORT = '--abort';
const CONTINUE = '--continue';
async function run(ctx) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    if (resolution.warning !== null) {
        ctx.out.warn(resolution.warning);
    }
    const config = requireConfig(ctx.config);
    // A non-interactive run must never decide on its own to drop somebody's
    // work (D11): the flag names a loss, and naming a loss is interactive.
    const discard = commandFlagGiven(ctx.commandFlags, DISCARD);
    if (discard && ctx.flags.ci) {
        throw ckError('CONFIG', 'sync --discard drops fork-tree commits on purpose, and a --ci run must not make that decision', 'run codkit sync to keep the commits, or codkit sync --discard interactively');
    }
    // Test-only crash injection, validated at this boundary exactly like the
    // save replay one: an unknown stage or a non-test runtime is a config
    // error before any lock is taken.
    const crashAt = syncCrashCheckpoint(ctx.env[SYNC_TEST_CRASH_ENV], isCycleTestBuild(process.execArgv));
    const crash = (stage) => {
        crashAt?.(stage);
    };
    const flags = {
        squash: commandFlagGiven(ctx.commandFlags, SQUASH),
        commit: commandFlagGiven(ctx.commandFlags, COMMIT),
        message: commandFlagValue(ctx.commandFlags, MESSAGE),
        discard,
        fresh: commandFlagGiven(ctx.commandFlags, FRESH),
        dryRun: commandFlagGiven(ctx.commandFlags, DRY_RUN)
    };
    // The recovery of a stopped sync (D21): --abort puts everything back,
    // --continue finishes the interrupted run. Recovery takes no side of its
    // own - a discard or a dry run is a fresh run's decision, and --abort
    // shapes no extraction at all.
    const aborting = commandFlagGiven(ctx.commandFlags, ABORT);
    const continuing = commandFlagGiven(ctx.commandFlags, CONTINUE);
    if (aborting || continuing) {
        const mode = aborting ? 'abort' : 'continue';
        if (aborting && continuing) {
            throw ckError('CONFIG', 'codkit sync takes one of --abort and --continue, not both', 'choose the recovery the stopped sync needs');
        }
        if (flags.discard || flags.dryRun) {
            throw ckError('CONFIG', `codkit sync --${mode} recovers a stopped sync and takes neither --discard nor --dry-run`, 'run the recovery alone; the extraction flags --squash/--commit/--message/--fresh may shape the continued extraction');
        }
        if (aborting && (flags.squash || flags.commit || flags.message !== null || flags.fresh)) {
            throw ckError('CONFIG', 'codkit sync --abort returns the tree and the patch set to the state before the run and shapes no extraction', 'drop the extraction flags, or run the recovery as codkit sync --abort alone');
        }
    }
    return withLock(ctx.patchesDir, treeId(resolution.path), 'sync', () => {
        const input = { patchesDir: ctx.patchesDir, resolution, config, out: ctx.out, flags, verbose: ctx.flags.verbose, crash };
        const result = aborting || continuing ? runSyncRecovery(input, aborting ? 'abort' : 'continue') : runTwoWay(input);
        ctx.out.setData(buildData(result));
        return result.exitCode;
    }, (text) => {
        ctx.out.warn(text);
    });
}
function runTwoWay(input) {
    const { patchesDir, resolution, config, out, flags, crash } = input;
    const tree = resolution.path;
    const branch = generatedBranchName(config);
    // 0. A live transaction: nothing may operate over its half-applied state.
    if (refuseOverLiveSyncTransaction(patchesDir, 'sync', out)) {
        return blocked(NO_CLASSES, 0);
    }
    // 1. Is this the tree we think it is, and may we write to it? A dry run
    // only reads, so it takes the read mode and skips the exclusive preflight,
    // exactly like `load --dry-run`.
    const identity = checkTree(resolution, config, { mode: flags.dryRun ? 'read' : 'write' });
    if (identity.fatal !== null) {
        out.addError(identity.fatal.toPayload());
        return unfit();
    }
    if (!flags.dryRun) {
        try {
            assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
        }
        catch (error) {
            if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
                out.addError(error.toPayload());
                return unfit();
            }
            throw error;
        }
    }
    // 2. Commits made in the tree are work, and the wrong line is a position
    // to correct, not a fact to extract from (D8).
    const treeState = foreignCommits(tree, config.pin.sha, branch);
    const head = treeHeadError(treeState, branch);
    if (head !== null) {
        out.addError(head.toPayload());
        return blocked(NO_CLASSES, treeState.commits.length);
    }
    // 3. The lineage question (D17): a loaded-from sha that stopped being an
    // ancestor of patchset HEAD names a state this checkout no longer carries,
    // and merging across that line is a human decision however the bytes look.
    const mark = readTreeMark(tree, (text) => {
        out.warn(text);
    });
    const loaded = loadedFrom({ treeDir: tree, base: treeState.base, pinSha: config.pin.sha, mark });
    const patchsetHead = revParse(patchesDir, 'HEAD') ?? 'HEAD';
    const restoreRef = loaded.kind === 'sha' ? loaded.sha : patchsetHead;
    if (loaded.kind === 'sha') {
        const lineage = checkLineage(patchesDir, loaded.sha);
        if (!lineage.ok) {
            out.addError(patchsetMovedError({ loaded, lineageHead: lineage.head, moved: [] }).toPayload());
            return blocked(NO_CLASSES, treeState.commits.length);
        }
    }
    else if (loaded.kind === 'dirty' || loaded.kind === 'none') {
        out.warn(loaded.kind === 'dirty'
            ? 'the tree was loaded from an uncommitted patchset state (dirty); sync cannot verify the patchset lineage and proceeds'
            : 'the tree was loaded from a patchset without a HEAD (none); sync cannot verify the patchset lineage and proceeds');
    }
    // 4. The per-target rule (D16). A mark without the artifact map cannot
    // answer the byte question, and a two-way merge may not guess (R13): one
    // load records the map, and the refusal says so.
    const classes = classifyTargets({
        patchesDir,
        treeDir: tree,
        pinSha: config.pin.sha,
        base: treeState.base,
        mark,
        ownDirName: config.ownDirName,
        commits: treeState.commits
    });
    if (classes.unknown) {
        out.addError(ckError('PATCHSET-MOVED', 'the apply mark carries no delta artifact map, so sync cannot tell which side moved which artifact', 'run codkit load once to record the loaded state (every load writes the map), then codkit sync').toPayload());
        return blocked(classes, treeState.commits.length);
    }
    // 5. Own code, file by file (##PATCHSET-SIDE-EDIT-RULE): own code has no
    // marker blocks to materialize a merge into, so a both-sided own file keeps
    // the choose-a-side refusal.
    const ownClasses = classifyOwn(patchesDir, tree, config.ownDirName, mark?.ownFiles ?? null).filter((entry) => entry.kind !== 'same');
    const ownBoth = ownClasses.filter((entry) => entry.kind === 'both-edited');
    if (ownBoth.length > 0) {
        const prefix = ownTargetRelativeDir(config.ownDirName);
        const sides = ownBoth.map((entry) => ({ artifact: `delta/own/${entry.relative}`, target: `${prefix}/${entry.relative}` }));
        out.addError(bothSidesConflictError(sides, restoreRef).toPayload());
        return blocked(classes, treeState.commits.length);
    }
    // 6. The patch layer: both sides moved the same target (D19). The answer
    // is the markers - materialized under the transaction at step 10. Under
    // `--discard` the commits' half of the tree side is dropped on purpose, so
    // only targets the *uncommitted* state still carries conflict, and those
    // keep the choose-a-side refusal: a `--continue` is an extraction, never a
    // discard, and materializing under `--discard` would resurrect what the
    // operator named as lost (D11: the flag speaks about commits, never edits).
    const bothSides = classes.both.map((artifact) => ({ artifact, target: artifactTarget(artifact) }));
    const conflictTargets = flags.discard
        ? bothSides
            .filter((side) => uncommittedChanges(tree, treeState, config.ownDirName).some((change) => change.path === side.target))
            .map((side) => side.target)
        : bothSides.map((side) => side.target);
    if (flags.discard && conflictTargets.length > 0) {
        const refusingBoth = bothSides.filter((side) => conflictTargets.includes(side.target));
        out.addError(bothSidesConflictError(refusingBoth, restoreRef).toPayload());
        return blocked(classes, treeState.commits.length);
    }
    // 7. --dry-run: the classification is the answer; nothing is written.
    if (flags.dryRun) {
        const paths = changesSince(tree, treeState.base, { kind: 'worktree' }, config.ownDirName).map((change) => change.path);
        reportSyncPlan(out, classes, treeState.commits.length, paths);
        return ok('dry-run', classes, treeState.commits.length);
    }
    // 8. --discard: drop the tree commits deliberately (D11). The discard's
    // rebuild is a full load - it applies whatever patchset holds - and its
    // guard keeps protecting everything the flag did not name.
    if (flags.discard && treeState.commits.length > 0) {
        return discardBranch(input, classes, treeState, mark, crash);
    }
    if (flags.discard) {
        out.info('discard: no fork-tree commits above the generated tip; nothing to drop');
    }
    // 9. Is there anything to merge at all? With both sides still, the load
    // engine alone answers - usually from its fast path - and no transaction is
    // written, because nothing is about to mutate.
    const changes = changesSince(tree, treeState.base, { kind: 'worktree' }, config.ownDirName);
    const hasTreeWork = treeState.commits.length > 0 ||
        changes.length > 0 ||
        ownClasses.some((entry) => entry.kind === 'tree-edited' || entry.kind === 'unknown');
    const hasPatchsetWork = classes.patchsetOnly.length > 0 || ownClasses.some((entry) => entry.kind === 'patchset-edited');
    if (!hasTreeWork && !hasPatchsetWork) {
        const settled = runSync({ patchesDir, resolution, config, out, fresh: flags.fresh, dryRun: false, verbose: input.verbose });
        return {
            ...ok(settled.status === 'up-to-date' ? 'up-to-date' : 'synced', classes, 0, { consumedRef: settled.discardedRef }),
            exitCode: settled.exitCode
        };
    }
    // 10. The conflict stop (D19, ##SYNC-CONFLICT-DIFF3): the record exists
    // before the first mutation - the ours-snapshots of the conflict files
    // included - then every merge lands in its tree file, and the run stops
    // with exit 1 naming them. Recovery: `sync --continue` / `sync --abort`.
    if (conflictTargets.length > 0) {
        const record = openRecord(input, treeState, mark, changes, ownClasses, classes.patchsetOnly, conflictTargets);
        crash('transaction-written');
        return materializeConflicts(input, record, classes, treeState, conflictTargets);
    }
    // 11. The merge, under the transaction: the record exists before the first
    // mutation and is retired after the last (D20).
    const record = openRecord(input, treeState, mark, changes, ownClasses, classes.patchsetOnly, []);
    crash('transaction-written');
    return runWritePass(input, record, classes, treeState, hasTreeWork, false);
}
// ---------------------------------------------------------------------------
// The discard branch
// ---------------------------------------------------------------------------
/**
 * `sync --discard` over tree commits (D11/D15): the operator named the loss,
 * so the commits are dropped by the load engine's own discard path - consumed
 * ref first, rebuild second - under this run's transaction; the file halves of
 * the guard stay armed inside that engine.
 */
function discardBranch(input, classes, treeState, mark, crash) {
    const { patchesDir, resolution, config, out, flags } = input;
    let record = openRecord(input, treeState, mark, [], [], classes.patchsetOnly, []);
    crash('transaction-written');
    let discarded;
    try {
        discarded = runSync({
            patchesDir,
            resolution,
            config,
            out,
            fresh: flags.fresh,
            dryRun: false,
            verbose: input.verbose,
            discardTreeCommits: true,
            skipSyncInProgressCheck: true,
            checkpoint: (stage) => {
                crash(stage);
            }
        });
    }
    catch (error) {
        return stoppedMidway(input, record, classes, treeState, { error });
    }
    if (discarded.exitCode !== 0) {
        return stoppedMidway(input, record, classes, treeState, { engine: discarded });
    }
    if (discarded.discardedRef !== null) {
        record = saveSyncTransaction(patchesDir, { ...record, consumedRef: discarded.discardedRef });
    }
    retireSyncTransaction(patchesDir);
    out.info(`sync complete: the tree commits were dropped and the patchset side applied; transaction ${record.id} retired`);
    return ok('synced', classes, treeState.commits.length, { transaction: record.id, consumedRef: discarded.discardedRef });
}
// ---------------------------------------------------------------------------
// The transaction of this run
// ---------------------------------------------------------------------------
/**
 * The record of this run before its first mutation (D20), by way of
 * `openSyncTransaction`: heads, mark, snapshots of everything the run intends
 * to rewrite, and - for a conflict stop - the ours-snapshots of the files the
 * markers are about to rewrite.
 */
function openRecord(input, treeState, mark, changes, ownClasses, patchsetOnly, conflictTargets) {
    const { patchesDir, resolution, config } = input;
    return openSyncTransaction({
        patchesDir,
        treeDir: resolution.path,
        branch: generatedBranchName(config),
        patchsetHead: revParse(patchesDir, 'HEAD'),
        deltaDirtyBefore: deltaDirty(patchesDir),
        treeHead: treeState.head,
        markSnapshot: mark,
        treeArtifacts: changes.map((change) => `${PATCHES_DIR}/${encodePatchName(change.path)}`),
        patchsetTargets: patchsetOnly.map(artifactTarget),
        ownRelatives: ownClasses.map((entry) => entry.relative),
        ownTargetPrefix: ownTargetRelativeDir(config.ownDirName),
        conflictTargets
    });
}
// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
function buildData(result) {
    return {
        status: result.status,
        classes: {
            treeOnly: [...result.classes.treeOnly],
            patchsetOnly: [...result.classes.patchsetOnly],
            both: [...result.classes.both]
        },
        treeCommits: result.treeCommitCount,
        transaction: result.transactionId,
        patchsetCommits: [...result.patchsetCommits],
        consumedRef: result.consumedRef
    };
}
// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------
/** Changes the working tree carries on top of its own HEAD: the part `--discard` may not drop. */
function uncommittedChanges(tree, treeState, ownDirName) {
    return changesSince(tree, treeState.head, { kind: 'worktree' }, ownDirName);
}
/** Whether delta paths of the patchset carry uncommitted modifications right now. */
function deltaDirty(patchesDir) {
    const status = runGit({ args: ['status', '--porcelain', '-z', '--', 'delta'], cwd: patchesDir });
    return status.status === 0 && status.stdout.trim() !== '';
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: sync needs the pin, the delta and the fork tree of this repository', 'run sync from a patchset checkout that carries codkit.json');
    }
    return config;
}
export const syncCommand = {
    name: 'sync',
    summary: 'extract the fork tree work and apply the patch set shifts, one run per side',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [SQUASH, COMMIT, MESSAGE, DISCARD, FRESH, DRY_RUN, ABORT, CONTINUE],
    run
};
