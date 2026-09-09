/** @scope spec://codkit/modules/codkit/PROP-008#SAVE-REPLAYS-TREE-COMMITS */
// The replay half of `save` over tree commits (PROP-008 sec. 4, campaign
// decision D5): every foreign commit of the fork tree becomes one patchset
// commit with the original message, author and date plus a `Codkit-Tree-Commit`
// trailer - the "rebase and merge" of a pull request, with `--squash` as the
// "squash and merge".
//
// The planning is two-pass on purpose. Pass 1 (`planStates`) validates every
// state - each commit, then the worktree remainder - over an in-memory
// ArtifactStore that overlays `delta/patches` and `.codkit/pending`, so a file
// planned for S_2 is planned against the artifact S_1 just produced, not
// against the one on disk. A state that cannot be planned refuses the whole
// save naming its sha and subject, and nothing is written: a half-replayed
// delta is worse than one the developer has to fix and re-run. Only pass 2
// (`writeStates`) writes artifacts and commits them, one state at a time, so
// the patchset history holds the state of each tree commit as it stood.
//
// Idempotency is grep-based, not hope-based: a commit whose trailer is already
// in patchset history (a run interrupted after its commit) is skipped rather
// than duplicated, and the remaining ones are replayed on top.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './gitx.js';
import { badCause } from './hooksPatchSet.js';
import { ckError, isCkError } from './messages.js';
import { readPendingHeader } from './pendingHeader.js';
import { readRebasePending } from './rebaseOntoPinPending.js';
import { materializerOf, ownExtensionTreePrefixes } from './layers/ownExtensions.js';
import { loadOwnManifest } from './layers/ownManifest.js';
import { changesSince } from './treeState.js';
/** The trailer that ties a patchset commit to the tree commit it replays. */
export const TREE_COMMIT_TRAILER = 'Codkit-Tree-Commit';
/**
 * The artifact layer of one planning pass: an in-memory overlay over
 * `delta/patches` and the pending drafts of the patchset root. Planning a state
 * records what it would write, and the next state reads the recorded bytes
 * instead of the ones on disk - the disk still holds the pre-save state until
 * pass 2 starts. A target whose pending draft (or rebase pending record) was
 * consumed by an earlier state reads as having none, exactly as it will after
 * the writes of that earlier state land.
 */
export class ArtifactStore {
    patchesDir;
    overlay = new Map();
    consumedPendingTargets = new Set();
    constructor(patchesDir) {
        this.patchesDir = patchesDir;
    }
    /** Artifact bytes relative to the patchset root; null when absent. */
    read(artifact) {
        const overlaid = this.overlay.get(artifact);
        if (overlaid !== undefined) {
            return overlaid;
        }
        const absolute = join(this.patchesDir, ...artifact.split('/'));
        return existsSync(absolute) ? readFileSync(absolute) : null;
    }
    write(artifact, bytes) {
        this.overlay.set(artifact, bytes);
    }
    remove(artifact) {
        this.overlay.set(artifact, null);
    }
    /** The draft of `marker new`, hidden once a planned state consumed it. */
    readPendingHeader(target) {
        return this.consumedPendingTargets.has(target) ? null : readPendingHeader(this.patchesDir, target);
    }
    /** The rebase pending record, hidden by the same rule. */
    readRebasePending(target) {
        return this.consumedPendingTargets.has(target) ? null : readRebasePending(this.patchesDir, target);
    }
    /** Record one file's plan: the overlay takes its bytes (or its removal). */
    apply(plan) {
        if (plan.action === 'removed') {
            this.remove(plan.artifact);
        }
        else if (plan.action === 'created' || plan.action === 'updated') {
            if (plan.bytes !== null) {
                this.write(plan.artifact, plan.bytes);
            }
        }
        if (plan.consumesPending) {
            this.consumedPendingTargets.add(plan.target);
        }
    }
}
/**
 * Pass 1 (D5): plan every state of the run - each foreign commit not already
 * replayed, then the worktree - over one store, collecting every refusal
 * instead of stopping at the first. An error from a commit state is prefixed
 * with that commit's sha and subject, because "line 41" means nothing when the
 * line came from a commit three states back; worktree errors keep today's
 * wording, being about files the caller can see.
 */
export function planStates(input) {
    const store = new ArtifactStore(input.patchesDir);
    const states = [];
    const skipped = [];
    const errors = [];
    for (const commit of input.commits) {
        if (alreadyReplayed(input.patchesDir, commit.sha)) {
            skipped.push(commit);
            continue;
        }
        const message = commitMessageOf(input.tree, commit.sha);
        const cause = badCause(message);
        if (cause !== null) {
            errors.push(causeRefusal(commit, cause));
            continue;
        }
        const plans = planEntriesOf(input, { kind: 'commit', sha: commit.sha }, store, commit, errors);
        states.push({ commit, message, plans });
    }
    const worktreePlans = planEntriesOf(input, { kind: 'worktree' }, store, null, errors);
    return { states, skipped, worktreePlans, errors };
}
function planEntriesOf(input, state, store, commit, errors) {
    const plans = [];
    // ##OWN-EXTENSION-UNIT: the replay selects upstream work exactly like the
    // direct path, so the tree roots the own-extension layer supplies are not
    // upstream files here either.
    const materializer = materializerOf(input.type);
    const ownedPrefixes = materializer === null ? [] : ownExtensionTreePrefixes(materializer, loadOwnManifest(input.patchesDir).extensions);
    for (const entry of changesSince(input.tree, input.base, state, input.roots, input.forcedPaths, ownedPrefixes)) {
        try {
            const plan = input.planFile(entry, state, store);
            if (plan !== null) {
                plans.push(plan);
                store.apply(plan);
            }
        }
        catch (error) {
            if (!isCkError(error)) {
                throw error;
            }
            errors.push(commit === null ? error : namedByState(commit, error));
        }
    }
    return plans;
}
/** Prefix a refusal with the commit it came from, keeping its code and hint. */
function namedByState(commit, error) {
    return ckError(error.code, `tree commit ${commit.sha.slice(0, 8)} "${commit.subject}": ${error.message}`, error.hint, error.file, error.line);
}
/**
 * Pass 2 (D5): write and commit the planned states, oldest first. A state whose
 * staged delta is empty is skipped with a message - an empty tree commit is
 * still consumed work, but there is nothing to say in patchset history for it.
 */
export function writeStates(input) {
    const commits = [];
    const emptyStates = [];
    let written = 0;
    for (const state of input.states) {
        written += input.writeArtifacts(state.plans);
        const sha = input.commitState(state);
        if (sha === null) {
            emptyStates.push(state.commit);
            continue;
        }
        commits.push(sha);
        input.checkpoint?.('state-committed', sha);
    }
    return { commits, emptyStates, written };
}
/**
 * The replay commit message: the tree commit verbatim, a blank line, then the
 * trailer. The separator is unconditional on purpose - `appendTrailer` guesses
 * from the shape of the last line, and a subject like `work: fix the thing`
 * has exactly the shape of a trailer, which would glue the trailer into the
 * subject paragraph where neither git nor a human reads it as a trailer.
 */
export function replayCommitMessage(message, sha) {
    return `${message.trimEnd()}\n\n${TREE_COMMIT_TRAILER}: ${sha}\n`;
}
/**
 * Idempotency (D5): a patchset commit carrying this trailer means the state is
 * already replayed - an interrupted run left it behind, and re-running must not
 * duplicate it.
 */
export function alreadyReplayed(patchesDir, sha) {
    const found = runGit({
        args: ['log', '--fixed-strings', `--grep=${TREE_COMMIT_TRAILER}: ${sha}`, '-1', '--format=%H'],
        cwd: patchesDir
    });
    return found.status === 0 && found.stdout.trim() !== '';
}
/** The full message of a tree commit (`%B`), the verbatim base of the replay. */
export function commitMessageOf(treeDir, sha) {
    const shown = runGit({ args: ['show', '--quiet', '--format=%B', sha], cwd: treeDir });
    if (shown.status !== 0) {
        throw ckError('INTERNAL', `cannot read the message of tree commit ${sha.slice(0, 8)} in ${treeDir}`, 're-run with --verbose and attach the output to a bug report');
    }
    return shown.stdout;
}
function causeRefusal(commit, value) {
    return ckError('CONFIG', `tree commit ${commit.sha.slice(0, 8)} "${commit.subject}": the Cause: trailer must be a 40-character upstream sha, got "${value}"`, 'write "Cause: <40 hex>" for the upstream commit that forced this change, or drop the trailer; ' +
        'the message becomes a patchset commit as-is, and the patchset hook never runs for it');
}
// ---------------------------------------------------------------------------
// Test-only crash injection through the real CLI (the shape of
// cycleTestCrash.ts): the environment variable names a stage, the checkpoint
// hard-exits the first time the stage is reached, and both are refused outside
// the test runtime.
// ---------------------------------------------------------------------------
export const SAVE_REPLAY_CRASH_ENV = 'CODKIT_TEST_SAVE_REPLAY_CRASH_AT';
export const SAVE_REPLAY_CRASH_EXIT_CODE = 86;
export const SAVE_REPLAY_CRASH_STAGES = ['state-committed'];
export function saveReplayCrashCheckpoint(crashAt, testBuild, terminate = hardExit) {
    if (crashAt === undefined || crashAt === '') {
        return undefined;
    }
    if (!SAVE_REPLAY_CRASH_STAGES.includes(crashAt)) {
        throw ckError('CONFIG', `${SAVE_REPLAY_CRASH_ENV} names an unknown save replay stage`, `use one of: ${SAVE_REPLAY_CRASH_STAGES.join(', ')}`);
    }
    if (!testBuild) {
        throw ckError('CONFIG', `${SAVE_REPLAY_CRASH_ENV} is disabled outside the test runtime`, 'unset the test-only crash injection variable');
    }
    return (stage) => {
        if (stage === crashAt) {
            terminate(SAVE_REPLAY_CRASH_EXIT_CODE);
        }
    };
}
function hardExit(exitCode) {
    // Deliberately bypasses catch/finally, matching an uncatchable process loss
    // at the exact boundary the stage names.
    process.exit(exitCode);
}
