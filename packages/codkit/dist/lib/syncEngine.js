/** @scope spec://codkit/modules/codkit/PROP-008#root */
import { decodeTextArtifact } from './artifactCodec.js';
import { workspaceForkReceipt } from './workspaceReceipt.js';
import { pinKey } from './pinIdentity.js';
// The sync engine: bring the fork tree to the pin and put the delta on it.
// The pseudocode of PROP-008 sec. 3 is normative and this file follows its order.
//
// Three properties shape the implementation, and each of them is a requirement
// rather than a preference:
//
//   * the generated commits are imported as objects, from the pin's tree,
//     with a fixed author and the pin's own date - so their shas are identical
//     on every machine (##NFR-DETERMINISM) and CI caches keyed by them work;
//   * the work tree is moved by rewriting only the files that actually differ
//     from the new tip (##MTIME-DISCIPLINE) - a full checkout would restart every
//     watch daemon in the tree;
//   * `git clean` is never run: untracked content is only ever removed by
//     `--fresh`, and then only what the cleanup whitelist does not protect.
//
// The tree is the truth about what is applied (##TREE-IS-TRUTH); the cache in
// patchset and the mark inside .git are hints that let the next run skip the work.
import { declaredDiscipline } from './discipline.js';
import { mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { applyUnified } from './applyUnified.js';
import { encodeUtf8 } from './bytes.js';
import { readContainedFile, removeContainedFile, writeContainedFileAtomic } from './containedFile.js';
import { ensureAdminDirectory, sameEffectivePath } from './containedPath.js';
import { loadConventions, matchesPatternList } from './conventionsFile.js';
import { driftDirty, porcelainPaths, porcelainZEntries } from './driftGuard.js';
import { MARKER_BLOCK_DISCARD_HINT, emptyWorktreeDiscardPlan, markerBlockDirtMessage, worktreeDiscardClassifier } from './discardWorktree.js';
import { deltaArtifactMap, deltaFiles, treeId } from './fingerprint.js';
import { generatedOwnCommit, assertGeneratedTargetOwnership, generatedHistoryFingerprint } from './generatedBranch.js';
import { NO_OWN_EXTENSIONS, classifyOwnExtensions, materializerOf, ownExtensionTreePrefixes, strandedExtensionClassifier, syncOwnExtensions } from './layers/ownExtensions.js';
import { loadOwnManifest } from './layers/ownManifest.js';
import { gitOk, runGit, runGitUserPathResolution } from './gitx.js';
import { readTreeEntries, writeHistory } from './gitHistory.js';
import { readBlobs } from './publishRelease.js';
import { HOOK_MARKER, isOurs } from './hooksPatchSet.js';
import { assertInputPlacement } from './inputsPlacement.js';
import { appendInputCommits, deliverInputs, inputTreePaths, inputsHistoryFingerprint, produceInputs, warnInputEdits } from './inputsTree.js';
import { OVERLAYS_DIR, checkOverlay, isExactOverlayMaterialization, loadOverlays, overlayDriftErrors, renderOverlayTarget, writeDevChannel } from './layers/overlay.js';
import { RESOURCE_MAP_PATH, assertTargetAtPin, loadResourceMap, resourceSourcePath } from './layers/resource.js';
import { ckError, isCkError } from './messages.js';
import { syncAllOwnCode } from './ownCopy.js';
import { classifyAllOwn, ownMarkFilesOf, ownMarkState } from './ownSides.js';
import { isBuildOutput, ownedRootOf, ownedRootsOf } from './ownedRoots.js';
import { PATCH_FILE_SUFFIX, encodePatchName } from './patchFormat.js';
import { checkTree, formatCheckLine } from './treeIdentity.js';
import { TREE_CACHE_SCHEMA_VERSION, TREE_MARK_SCHEMA_VERSION, effectiveGitPath, fastPathOk, gitCommonDirOf, gitDirOf, readTreeCache, readTreeMark, writeTreeCache, writeTreeMark } from './treeCache.js';
import { COMMIT_AUTHOR_EMAIL, COMMIT_AUTHOR_NAME, foreignCommits, treeHeadError, writeConsumedRef } from './treeCommits.js';
import { assertCompletedRebaseMoveSyncTree, completedRebaseMoveForSync, finishCompletedRebaseMoveSync } from './rebaseOntoPinMove.js';
import { hasRebasePendingRecords } from './rebaseOntoPinPending.js';
import { refuseOverLiveSyncTransaction } from './syncTransaction.js';
import { restoreDeltaBytes } from './workTreeBytes.js';
import { acquireCommonRepositoryLock, assertGeneratedRefExclusive, listWorktrees } from './worktrees.js';
import { acquireWorkspaceRepositoryLock } from './workspaceRepositoryLock.js';
/** Patch artifacts live here, relative to the patchset root. */
export const PATCHES_DIR = 'delta/patches';
/**
 * Identity of every generated commit; fixed, so the shas are reproducible.
 * Defined next to its detector (the trailer-plus-author check of
 * `treeCommits.ts`, PROP-008 ##TREE-COMMITS-ARE-WORK) and re-exported here,
 * where the commits are built, so the two can never drift apart.
 */
export { COMMIT_AUTHOR_NAME, COMMIT_AUTHOR_EMAIL };
/** Managed block of the tree's effective info/exclude (PROP-005 ##OWN-EXCLUDED-LOCALLY). */
export const EXCLUDE_BEGIN = '# codkit:begin managed';
export const EXCLUDE_END = '# codkit:end managed';
/**
 * The per-worktree exclude file codkit owns, relative to the per-worktree
 * administrative directory (PROP-005 ##OWN-EXCLUDED-LOCALLY). `info/exclude`
 * of the common directory is one file shared by every sibling worktree: a
 * managed block there hides one tree's own paths in all of them, and a second
 * patch set with another own directory would replace the first block. In a
 * repository with more than one worktree the exclusion is therefore
 * worktree-local - this file, plus the per-worktree `core.excludesFile` config
 * key that points Git at it (requires `extensions.worktreeConfig`, which codkit
 * enables; a foreign value of either key is preserved and refused, never
 * overwritten).
 *
 * Lifecycle: rewritten by every load of that worktree; the per-worktree key and
 * file are codkit's own namespace and are never removed automatically - a
 * worktree that stops being managed keeps a harmless one-line exclude file
 * (drop it with `git config --worktree --unset core.excludesFile` if you ever
 * need to). The first worktree-local load also removes codkit's own stale
 * managed block from the shared `info/exclude`, leaving foreign lines intact.
 */
export const OWN_EXCLUDE_RELATIVE_PATH = 'codkit/exclude';
/** Environment variable the tree's pre-commit hook lets through. */
export const INTERNAL_COMMIT_ENV = 'CODKIT_INTERNAL_COMMIT';
/** How many paths are passed to one git invocation. */
const PATH_BATCH = 100;
/** How many dirty paths the guard lists before summarizing the rest. */
const DIRTY_LIST_LIMIT = 20;
const NO_OWN = { copied: 0, removed: 0, total: 0 };
/**
 * One `load`. The caller holds the lock and owns the output envelope; this
 * function does the work and reports what happened.
 */
export function runSync(options) {
    const { patchesDir, resolution, config, out, dryRun } = options;
    const tree = resolution.path;
    // Every directory the delta owns, the own root first (PROP-016
    // ##TYPE-AREA-LAYOUT). Mirroring, the drift guard, the exclusion, the
    // generated snapshot and the mark all work over this list.
    const roots = ownedRootsOf(options.type, config.typeConfig, { treeDir: tree, pinSha: config.pin.sha });
    const branch = `${config.generatedBranchPrefix}${pinKey(config.pin)}`;
    let generatedBranch = options.generatedBranch === true;
    // Only a release snapshot leaves the licence notice out; every other
    // generated branch carries it (PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION).
    const omitLicenceNotice = options.omitLicenceNotice === true;
    let materializeOverlays = generatedBranch || options.materializeOverlays === true;
    let completedRebase = null;
    // 0. A live two-way sync leaves the tree half one state and half another;
    // this engine is what applies and rebuilds, so it is the first thing to
    // refuse over that (PROP-008 ##SYNC-TWO-PASS, decision D20). Only the sync
    // that owns the record passes its halves through (skipSyncInProgressCheck).
    if (options.skipSyncInProgressCheck !== true && refuseOverLiveSyncTransaction(patchesDir, 'load', out)) {
        return result('blocked', 1, { branch });
    }
    // 1. Is this the tree we think it is, and may we write to it?
    const identity = checkTree(resolution, config, { mode: dryRun ? 'read' : 'write', type: options.type });
    if (options.verbose) {
        for (const check of identity.checks) {
            out.diag(formatCheckLine(check));
        }
    }
    if (identity.fatal !== null) {
        out.addError(identity.fatal.toPayload());
        return result('unfit', 2, { branch });
    }
    // 1b. The shared-ref preflight runs before any dirt verdict, unconditionally
    // (the D7 ruling of 2026-09-06, spike S0.12; PROP-008 §4): a sibling's
    // commit on the shared branch leaves THIS tree's index staged against a HEAD
    // nobody here moved - phantom dirt whose cause is the sharing, so the
    // sharing is what the refusal names, advising no command. The locked
    // preflight of step 9 stays: this one orders the diagnosis, that one guards
    // the mutation. `--dry-run` mutates nothing and keeps skipping both.
    if (!dryRun) {
        try {
            assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
        }
        catch (error) {
            if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
                out.addError(error.toPayload());
                return result('unfit', 2, { branch });
            }
            throw error;
        }
    }
    if (options.forceApply === true) {
        const drift = driftDirty(materializerOf(options.type), tree, roots, patchesDir, {
            workspace: config.workspace?.record,
            generated: { pinSha: config.pin.sha, branch }
        });
        const head = treeHeadError(drift.treeCommits, branch);
        if (head !== null) {
            out.addError(head.toPayload());
            return result('dirty', 1, { branch, dirtyFiles: drift.files });
        }
        if (drift.dirty) {
            throw ckError('DIRTY-TREE', 'forced load recovery requires a completely clean fork tree');
        }
    }
    if (!dryRun && !hasRebasePendingRecords(patchesDir)) {
        completedRebase = completedRebaseMoveForSync(patchesDir, tree);
        if (completedRebase !== null) {
            generatedBranch = true;
            materializeOverlays = true;
        }
    }
    // The inputs of the configuration (PROP-008 ##INPUTS-LOAD): their
    // directories are hidden like the owned ones - those declared, and those the
    // tree still carries from an earlier declaration until this run takes them
    // away. They are committed instead only on a generated branch of `ci` and
    // `publish` (##INPUTS-GENERATED).
    const declaredInputs = config.inputs ?? [];
    const inputMode = options.inputs;
    const committingInputs = generatedBranch && options.commitInputs === true && inputMode !== undefined && declaredInputs.length > 0;
    if (committingInputs && inputMode !== 'pinned') {
        throw ckError('INTERNAL', 'a generated branch takes the inputs from their pinned commits only');
    }
    const inputPaths = inputTreePaths(tree, declaredInputs, (text) => out.warn(text));
    // A shared file is classified before any mutation. A malformed managed
    // block is a human decision: load must not repair it after moving refs or
    // rewriting work-tree files.
    let excludePlan;
    try {
        excludePlan = planExclude(tree, roots, undefined, inputPaths);
    }
    catch (error) {
        return reportBroken(out, error, branch);
    }
    // 2. The config-overlay layer states what it expects the pin to look like,
    // and that expectation is checked on every load (##OVERLAY-DRIFT-DETECTOR):
    // upstream moving a key an intervention is written against must be loud here,
    // not at packaging time. Every mismatch is reported, not only the first.
    let overlays;
    try {
        overlays = loadOverlays(patchesDir, options.type);
        const drift = overlays.flatMap((overlay) => checkOverlay(overlay, { type: options.type, treeDir: tree, pinSha: config.pin.sha, pinOnly: true }).drift);
        if (drift.length > 0) {
            for (const error of overlayDriftErrors(drift)) {
                out.addError(error.toPayload());
            }
            return result('broken', 1, { branch, broken: [...new Set(drift.map((entry) => entry.artifactPath))] });
        }
    }
    catch (error) {
        return reportBroken(out, error, branch);
    }
    let prebuiltPlan;
    let prebuiltConventions;
    let ownershipEvidence;
    try {
        prebuiltConventions = loadConventions(options.type, patchesDir);
        prebuiltPlan = buildPlan(patchesDir, prebuiltConventions, overlays, warnFrom(out));
        ownershipEvidence = assertGeneratedTargetOwnership(patchesDir, options.type, roots, layerTargets(prebuiltPlan), omitLicenceNotice);
    }
    catch (error) {
        return reportBroken(out, error, branch);
    }
    // ##INPUTS-PLACEMENT: every `to` is checked on every run that writes the
    // exclude block, whether or not it delivers inputs - a line of that block
    // hides what git would otherwise show.
    assertInputPlacement({
        inputs: declaredInputs,
        treeDir: tree,
        pinSha: config.pin.sha,
        type: options.type,
        roots,
        cleanupWhitelist: prebuiltConventions.cleanupWhitelist,
        deliveredTargets: prebuiltPlan.map((artifact) => artifact.target)
    });
    // 3. What patchset asks for, and what this tree was last brought to. Reading
    // them is free of effects, and the guard below needs to know which side of
    // an own-code difference moved. The walk is taken once: the fingerprint and
    // the mark's artifact map below read the same files (##DELTA-FINGERPRINT,
    // ##TREE-MARK).
    const deltaState = deltaFiles(patchesDir, config.pin.sha, declaredDiscipline(config));
    const delta = deltaState.fingerprint;
    const historyFingerprint = generatedBranch
        ? generatedHistoryFingerprint(delta, patchesDir, options.type, roots, omitLicenceNotice, options.generatedModeSource)
        : delta;
    // A committed input is part of the history, so its declaration is part of
    // what the fast path compares: a new pin of an input rebuilds the branch.
    const fingerprint = committingInputs ? inputsHistoryFingerprint(historyFingerprint, declaredInputs) : historyFingerprint;
    const id = treeId(tree);
    const warn = (text) => {
        out.warn(text);
    };
    const cache = readTreeCache(patchesDir, id, warn);
    const mark = readTreeMark(tree, warn);
    // The variable context every materialization of this run uses, guard
    // included: the classified bytes and the bytes of the eventual apply must be
    // the same bytes, or the classification would certify something else.
    const context = overlayVarContext(config, pinCommitDate(tree, config.pin.sha), options.patchSetCommit ?? patchSetCommitId(patchesDir));
    // The state `--discard` asked to drop (D11): captured by the guard below,
    // performed by the rebuild of step 9, and kept diagnosable by the consumed
    // ref that the rebuild writes before it makes the commits unreachable. Null
    // until the guard sees both the flag and the commits.
    let discard = null;
    // The working-tree half of the same sacrifice (##CMD-LOAD-DISCARD-WORKTREE):
    // the tracked upstream paths this run may return to the tip. Planned by the
    // guard below, printed before the first write, restored in step 9 - and only
    // with `--fresh`, which is the pass that has an answer for the rest of the
    // tree.
    const discardWorktreeEdits = options.fresh && options.discardWorktreeEdits === true;
    const worktreePlan = emptyWorktreeDiscardPlan();
    let discardedPaths = [];
    // 4. Drift guard: never overwrite work that was not extracted back to patchset.
    if (!dryRun && options.skipDriftGuard !== true && completedRebase === null) {
        // --fresh is about to remove untracked paths by the whitelist, so they
        // are not counted as unextracted work in that run. The same run may also
        // replace a tracked overlay target that carries exactly the strict
        // composition of the configured overlays (##OVERLAY-KNOWN-MATERIALIZATION):
        // `overlay apply` writes those bytes for packaging, and refusing them
        // would lock the tree out of dev mode with no codkit command able to
        // return it. Every other byte of the target stays dirt, and an ordinary
        // `load` gets no exemption at all - it may answer the fast path "up to
        // date" and leave the materialization standing as if it were dev state.
        //
        // The one exemption a plain `load` does get is the other way round
        // (##DRIFT-GUARD-PREDICATE, the stranded exception): a directory under
        // the materialization root that no record declares is a directory this run
        // neither writes into nor removes, so refusing over it would guard
        // nothing and lock the daily command after a legal change of the patch
        // set. `--fresh` does not need it, and no other caller sets the option.
        const materialized = [];
        const passStranded = options.passStrandedExtensions === true && !options.fresh;
        const driftMaterializer = materializerOf(options.type);
        const drift = driftDirty(materializerOf(options.type), tree, roots, patchesDir, {
            untrackedIsDirt: !options.fresh,
            workspace: config.workspace?.record,
            generated: { pinSha: config.pin.sha, branch },
            ...(options.fresh
                ? { isKnownMaterialization: overlayMaterializationClassifier(overlays, tree, config.pin.sha, context, materialized) }
                : {}),
            ...(passStranded && driftMaterializer !== null
                ? { isStrandedExtension: strandedExtensionHook(driftMaterializer, patchesDir, tree, config.pin.sha) }
                : {}),
            ...(discardWorktreeEdits ? { isDiscardable: worktreeDiscardClassifier(tree, prebuiltConventions, worktreePlan) } : {})
        });
        // The D8 refusals come before the dirt verdict: a rewritten line below
        // the generated tip, or a HEAD carrying work outside the generated
        // branch, is not "dirt" to be extracted but a position to be corrected.
        const head = treeHeadError(drift.treeCommits, branch);
        if (head !== null) {
            out.addError(head.toPayload());
            return result('dirty', 1, { branch, dirtyFiles: drift.files });
        }
        // --discard lifts exactly the third half (D11). With commits present the
        // state is captured now, whatever the verdict below does with the rest of
        // the dirt: a refusal simply never reaches the rebuild that would use it.
        // Without commits there is nothing the flag was asked to do, and the run
        // says so instead of pretending it discarded anything.
        if (options.discardTreeCommits === true) {
            if (drift.treeCommits.commits.length === 0) {
                // Silent when the working-tree half found something: the flag was
                // asked to do a job and did one, and the plan lines below say
                // which. Only a run with nothing at all to drop says so.
                if (worktreePlan.discard.length === 0) {
                    out.info('discard: no fork-tree commits above the generated tip; nothing to drop');
                }
            }
            else {
                discard = { head: drift.treeCommits.head, commits: drift.treeCommits.commits };
            }
        }
        // The dirt refusal itself, shared by the halves that fire it: the listing
        // is the same whichever half carries the work, only the message names
        // which one.
        const refuseDrift = (message, hint) => {
            for (const path of drift.files.slice(0, DIRTY_LIST_LIMIT)) {
                out.info(`  dirty: ${path}`);
            }
            if (drift.files.length > DIRTY_LIST_LIMIT) {
                out.info(`  ... and ${drift.files.length - DIRTY_LIST_LIMIT} more`);
            }
            out.addError({
                code: 'DIRTY-TREE',
                message,
                hint: hint ?? 'run codkit save, or codkit status; codkit load --discard drops tree commits deliberately'
            });
            return result('dirty', 1, { branch, dirtyFiles: drift.files });
        };
        // The commits half is decided here, on its own and before the file-dirt
        // verdict: it is about commits, and no own-side verdict may subordinate
        // it. Wired one level deeper - inside the verdict, under `unextracted` -
        // a `patchset-side` verdict warned and continued, and the rebuild moved
        // the branch off commits that stayed reachable from the reflog alone:
        // the exact silent loss this half exists to make impossible
        // (##TREE-COMMITS-ARE-WORK). Only the captured discard lifts it (D11);
        // a tree without commits never sees this refusal, and the file halves
        // below keep their own verdicts.
        if (drift.commits.length > 0 && discard === null) {
            return refuseDrift(`${drift.commits.length} commit(s) in the fork tree since the last codkit apply are not in patchset yet`);
        }
        if (drift.dirty) {
            const artifacts = mark !== null && mark.pinSha === config.pin.sha && mark.branchTip === drift.treeCommits.head ? (mark.artifacts ?? null) : null;
            const verdict = judgeOwnSides(drift, patchesDir, tree, roots, mark, fingerprint, driftMaterializer, artifacts);
            if (verdict.kind === 'both-sides') {
                out.addError(verdict.error.toPayload());
                return result('dirty', 1, { branch, dirtyFiles: drift.files });
            }
            if (verdict.kind === 'unextracted') {
                // The one exemption: the dirt is the commits and nothing else, so
                // the refusal would be protecting exactly what the operator asked
                // to drop. File dirt or an own divergence keeps the refusal - the
                // flag speaks about commits, never about edits. Commits reach this
                // branch only under `--discard` (without it the refusal above
                // fired), and the message still names them: they are the dirt the
                // listing shows, even though the edits are what stops this run.
                if (discard === null || !commitsOnlyDirt(drift)) {
                    // A block is what `--discard` may never bury
                    // (##CMD-LOAD-DISCARD-WORKTREE): the file may hold an
                    // intervention nobody extracted yet, so the refusal names
                    // those paths and sends the operator to `save` rather than
                    // repeating the generic recipe.
                    if (worktreePlan.markerCarrying.length > 0) {
                        return refuseDrift(markerBlockDirtMessage(worktreePlan.markerCarrying), MARKER_BLOCK_DISCARD_HINT);
                    }
                    return refuseDrift(drift.commits.length > 0
                        ? `${drift.commits.length} commit(s) in the fork tree since the last codkit apply are not in patchset yet`
                        : `${drift.files.length} path(s) in the fork tree carry changes that are not in patchset yet`);
                }
                // Exempted: the commits are the payload of this run, the rebuild
                // below is the answer to them, and there is nothing to warn about.
            }
            else {
                out.warn(verdict.text, 'PATCHSET-SIDE-EDIT');
            }
        }
        // Said out loud because the tree did look dirty a moment ago: these bytes
        // were certified as codkit's own packaging state, and this run replaces
        // them (a --fresh run never takes the fast path, so it always does).
        if (materialized.length > 0) {
            out.info(`fresh: ${materialized.join(', ')} carries the exact overlay materialization; this run replaces it`);
        }
        // The plan, printed once the guard has let the run through and still
        // before its first write (R14): what step 9 restores is this list and
        // nothing besides it, so a refusal above never leaves a plan standing
        // that nobody executed.
        discardedPaths = [...worktreePlan.discard];
        for (const path of discardedPaths) {
            out.info(`discard ${path}`);
        }
    }
    // A dry run does not arm the guard (##DRIFT-GUARD-PREDICATE), so the forecast
    // classifies the same tracked dirt on its own. It prints the same plan and
    // writes nothing - and reports nothing as discarded either, because nothing
    // was.
    if (dryRun && discardWorktreeEdits) {
        driftDirty(materializerOf(options.type), tree, roots, patchesDir, {
            untrackedIsDirt: false,
            workspace: config.workspace?.record,
            generated: { pinSha: config.pin.sha, branch },
            isKnownMaterialization: overlayMaterializationClassifier(overlays, tree, config.pin.sha, context, []),
            isDiscardable: worktreeDiscardClassifier(tree, prebuiltConventions, worktreePlan)
        });
        for (const path of worktreePlan.discard) {
            out.info(`discard ${path}`);
        }
    }
    // 4b. The inputs a tree carries untracked are built now, before the first
    // write of the run, so a failing build leaves the tree as it was; the edits
    // found in their directories are named before anything replaces them
    // (##INPUTS-LOAD, ##INPUTS-EDITS). A dry run builds none.
    const deliveringInputs = inputMode !== undefined && !committingInputs && !dryRun;
    let producedInputs = [];
    if (deliveringInputs) {
        warnInputEdits(tree, declaredInputs, out);
        producedInputs = produceInputs({
            workspace: config.workspace,
            treeDir: tree,
            inputs: declaredInputs,
            mode: inputMode,
            rebuild: options.fresh,
            out,
            verbose: options.verbose
        });
    }
    else if (dryRun && inputMode !== undefined && declaredInputs.length > 0) {
        out.info(`inputs: ${declaredInputs.length} declared; a dry run builds and delivers none`);
    }
    // 5. The fast path.
    // --fresh is an explicit request for a from-scratch pass: it must not be
    // answered with "up to date", or the cleanup it asks for would never run.
    const verdict = completedRebase !== null
        ? { ok: false, reason: 'completed rebase receipt requires exact reconciliation' }
        : options.forceApply === true
            ? { ok: false, reason: 'post-checkout recovery was requested' }
            : options.fresh
                ? { ok: false, reason: '--fresh was requested' }
                : fastPathOk({ treeDir: tree, branch, cache, mark, pinSha: config.pin.sha, deltaFingerprint: fingerprint });
    if (verdict.ok) {
        if (dryRun) {
            out.info('up to date');
            return result('up-to-date', 0, {
                branch,
                branchTip: cache?.branchTip ?? null,
                generatedOwnPaths: generatedBranch ? generatedOwnPathsOf(ownershipEvidence) : []
            });
        }
        // The branch vouches for the content of the files the delta writes, not
        // for the bytes an earlier checkout left of them (##WORKTREE-DELTA-BYTES):
        // this is also where a tree written before that rule heals.
        const restoredBytes = restoreDeltaBytesOf(tree, prebuiltPlan, out);
        // Own code is verified on every run: locally it is not part of the
        // branch commits, so the branch cannot vouch for it. The own extensions
        // are materialized on the same terms (##OWN-EXTENSION-UNIT).
        const own = syncAllOwnCode(patchesDir, tree, roots);
        const materializer = materializerOf(options.type);
        const ownExtensions = materializer === null ? NO_OWN_EXTENSIONS : syncOwnExtensions(materializer, patchesDir, tree, declaredOwnExtensions(patchesDir));
        writeExcludePlan(excludePlan, undefined, config.workspace?.record.id);
        // The inputs are delivered on every run, like own code: the branch
        // cannot vouch for files it does not carry.
        const inputs = deliveringInputs ? deliverInputs({ workspace: config.workspace, treeDir: tree, produced: producedInputs, out }) : [];
        writeTreeHook(tree, branch, out);
        reportOwn(out, own);
        reportOwnExtensions(out, ownExtensions);
        out.info('up to date');
        return result('up-to-date', 0, {
            branch,
            branchTip: cache?.branchTip ?? null,
            own,
            generatedOwnPaths: generatedBranch ? generatedOwnPathsOf(ownershipEvidence) : [],
            restoredBytes,
            inputs
        });
    }
    if (options.verbose) {
        out.diag(`full apply: ${verdict.reason}`);
    }
    const conventions = prebuiltConventions;
    let cleaned = 0;
    // 7. The artifacts, in the order PROP-008 sec. 3 fixes: patches by file name,
    // then the overlay targets (CI and publish only), then the resource map by
    // target. Full generated history inserts its one aggregate own-code atom at
    // the patch/overlay boundary. The order is part of the resulting commit ids.
    let plan;
    try {
        plan = materializeOverlays ? prebuiltPlan : prebuiltPlan.filter((artifact) => artifact.kind !== 'overlay');
    }
    catch (error) {
        return reportBroken(out, error, branch);
    }
    if (dryRun) {
        return dryRunPlan(options, plan, context, branch);
    }
    // 8. Build the commits in a temporary index; the work tree is not touched.
    // A generated branch of `ci` and `publish` ends with one commit per input,
    // built from its pinned commit (##INPUTS-GENERATED); the tree keeps no
    // record of them, so the only reuse is of a build of the same content.
    const committedInputs = committingInputs
        ? produceInputs({
            workspace: config.workspace,
            treeDir: tree,
            inputs: declaredInputs,
            mode: 'pinned',
            rebuild: false,
            out,
            verbose: options.verbose
        })
        : [];
    let built;
    try {
        built = buildBranch(completedRebase === null ? options : { ...options, generatedBranch: true, materializeOverlays: true }, plan, context, id, committedInputs);
    }
    catch (error) {
        return reportBroken(out, error, branch);
    }
    if (completedRebase !== null) {
        const builtTree = runGit({ args: ['rev-parse', '--verify', `${built.top}^{tree}`], cwd: tree });
        const treeSha = builtTree.stdout.trim();
        if (builtTree.status !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) {
            throw ckError('ARTIFACT-BROKEN', 'cannot preflight generated tree while consuming completed rebase receipt');
        }
        assertCompletedRebaseMoveSyncTree(patchesDir, tree, completedRebase.desiredTree, treeSha);
    }
    // 9. Move the tree to the new tip, rewriting only what differs. The ref
    // mutation is guarded (##GENERATED-REF-WORKTREE-PREFLIGHT): under the
    // common-repository lock, a fresh worktree listing must show no sibling on
    // the generated branch, or the run refuses with every ref, index and work
    // tree unchanged.
    let changedPaths;
    let restoredBytes;
    let discardedRef = null;
    const coordination = acquireWorkspaceRepositoryLock(tree, `generated ref refs/heads/${branch}`, config.workspace?.record.id);
    try {
        assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
        // The discard's own precondition (the D6 discipline): the set the guard
        // judged droppable must still be the set present, or a commit that
        // appeared in between would be buried by the very rebuild asked to drop
        // only the named work. Checked before any ref or worktree byte moves.
        if (discard !== null) {
            assertDiscardSetHeld(discard, foreignCommits(tree, config.pin.sha, branch));
            // The consumed ref goes FIRST - before the rebuild makes the commits
            // unreachable from HEAD - because here it is the only keeper: unlike
            // `save`, nothing was replayed into patchset, so a crash before this
            // write would leave the dropped line reachable from the reflog alone,
            // the exact defect this campaign exists to remove. `save` writes the
            // same ref after its rebuild for the opposite reason: the patchset is
            // already the keeper there and the ref is diagnostics
            // (PROP-006 ##CONSUMED-REFS). A ref left by an unfinished discard
            // points at commits still on HEAD - "a discard was started and did
            // not finish" - which loses nothing and names itself.
            discardedRef = writeConsumedRef(tree, discard.head);
        }
        // The working-tree half of the sacrifice (##CMD-LOAD-DISCARD-WORKTREE),
        // by name and only by name: every planned path goes back to the tip this
        // tree stands on, before the delta of this run is laid over it, so the
        // file ends at the pin plus the delta. Doing it here rather than leaving
        // it to the rebuild is what makes the discard match the plan one for
        // one - the rebuild rewrites whatever else differs from the new tip, and
        // no path it touches was ever announced as dropped.
        if (discardedPaths.length > 0) {
            restoreToTip(tree, discardedPaths);
        }
        // No worktree byte changes before the exclusivity proof. In particular,
        // --fresh cleanup used to delete user untracked files and only then learn
        // that a sibling held the generated branch.
        if (options.fresh) {
            cleaned = cleanUntracked(tree, roots, conventions, config.workspace?.record);
            out.info(`fresh: removed ${cleaned} untracked path(s), kept everything the cleanup whitelist protects`);
        }
        updateRef(tree, branch, built.top);
        changedPaths = moveWorkTree(tree, branch);
        // What the checkout of the move converted gets the patch set's bytes back
        // (##WORKTREE-DELTA-BYTES).
        restoredBytes = restoreDeltaBytesOf(tree, prebuiltPlan, out);
    }
    catch (error) {
        if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
            out.addError(error.toPayload());
            return result('unfit', 2, { branch });
        }
        throw error;
    }
    finally {
        coordination.release();
    }
    options.checkpoint?.('worktree-moved');
    // Said only once the discard is a completed fact: HEAD has moved off the
    // dropped line, and the ref written before the rebuild is what keeps that
    // line diagnosable.
    if (discard !== null && discardedRef !== null) {
        const first = discard.commits[0]?.sha.slice(0, 8) ?? discard.head.slice(0, 8);
        const last = discard.commits[discard.commits.length - 1]?.sha.slice(0, 8) ?? first;
        out.info(`discarded ${discard.commits.length} commit(s): ${first}..${last}; kept as ${discardedRef}`);
    }
    // The working-tree half has no keeper and needs none: the bytes were an
    // artifact of a build, and the summary counts what the plan named.
    if (discardedPaths.length > 0) {
        out.info(`discarded ${discardedPaths.length} working-tree edit(s)`);
    }
    // 10. Own code, dev overlay, exclude, hook, mark, cache.
    const own = syncAllOwnCode(patchesDir, tree, roots);
    // ##OWN-EXTENSION-UNIT: the second pair of own roots, mirrored on the same
    // terms and in the same step, so the materialized extensions and the own root
    // are never half a load apart.
    const loadMaterializer = materializerOf(options.type);
    reportOwnExtensions(out, loadMaterializer === null ? NO_OWN_EXTENSIONS : syncOwnExtensions(loadMaterializer, patchesDir, tree, declaredOwnExtensions(patchesDir)));
    // The two channels of the config-overlay layer are alternatives, not layers
    // on top of each other: when the targets are materialized into the branch,
    // the dev-channel file has nothing left to say.
    if (!materializeOverlays) {
        writeDevChannel(options.type, tree, overlays, context, config.pin.sha, warn);
    }
    writeExcludePlan(excludePlan, undefined, config.workspace?.record.id);
    const inputs = deliveringInputs ? deliverInputs({ workspace: config.workspace, treeDir: tree, produced: producedInputs, out }) : [];
    writeTreeHook(tree, branch, out);
    // The own state is recorded after the copy, when both sides are identical by
    // construction: that is what makes the map usable as "who moved" evidence.
    // The artifact map and the patchset commit join it here (##TREE-MARK): the
    // map is the delta this load materialized outside delta/own/ (one traversal
    // with the fingerprint of step 3), the commit is exactly what the built
    // commits carry in their trailer - `save` reads both back before it writes
    // anything (##PATCHSET-MOVED-RULE, ##LINEAGE-CHECK).
    const ownState = ownMarkState(patchesDir, roots);
    writeTreeMark(tree, {
        codkitTreeMark: TREE_MARK_SCHEMA_VERSION,
        pinSha: config.pin.sha,
        deltaFingerprint: fingerprint,
        branchTip: built.top,
        ownFingerprint: ownState.ownFingerprint,
        ownFiles: ownState.ownFiles,
        ...(ownState.ownRootFiles === undefined ? {} : { ownRootFiles: ownState.ownRootFiles }),
        artifacts: deltaArtifactMap(deltaState.files),
        patchSetCommit: built.patchSetCommit
    }, (text) => {
        out.warn(text, 'MARK-RO');
    });
    options.checkpoint?.('mark-written');
    writeTreeCache(patchesDir, id, {
        codkitTreeCache: TREE_CACHE_SCHEMA_VERSION,
        treePath: tree,
        treeRepoAnchor: config.upstreamAnchorCommit,
        pinSha: config.pin.sha,
        deltaFingerprint: fingerprint,
        branchTip: built.top,
        updatedAt: new Date().toISOString()
    });
    if (completedRebase !== null) {
        const builtTree = runGit({ args: ['rev-parse', '--verify', `${built.top}^{tree}`], cwd: tree });
        const treeSha = builtTree.stdout.trim();
        if (builtTree.status !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) {
            throw ckError('ARTIFACT-BROKEN', 'cannot verify generated tree while consuming completed rebase receipt');
        }
        finishCompletedRebaseMoveSync(patchesDir, tree, completedRebase.desiredTree, treeSha);
    }
    out.info(`applied ${plan.length} artifact(s) on ${branch} at ${built.top.slice(0, 8)}`);
    out.info(`updated ${changedPaths.length} file(s) in the work tree`);
    reportOwn(out, own);
    return result('applied', 0, {
        branch,
        branchTip: built.top,
        artifacts: plan.length,
        own,
        cleaned,
        changedPaths,
        nonPatchTargets: saveMaterializationTargets(prebuiltPlan, ownershipEvidence.ownTargets),
        generatedOwnPaths: generatedBranch ? generatedOwnPathsOf(ownershipEvidence) : [],
        discarded: discard === null ? [] : discard.commits.map((commit) => commit.sha),
        discardedRef,
        discardedPaths,
        fastPathReason: verdict.reason,
        restoredBytes,
        inputs
    });
}
// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------
function buildPlan(patchesDir, conventions, overlays, onWarn) {
    const artifacts = [];
    for (const name of listPatchFiles(patchesDir)) {
        const artifactPath = `${PATCHES_DIR}/${name}`;
        const patch = decodeTextArtifact(readFileSync(join(patchesDir, ...PATCHES_DIR.split('/'), name)), conventions, artifactPath);
        artifacts.push({ kind: 'patch', id: patch.header.id, target: patch.targetPath, artifactPath, patch });
    }
    artifacts.push(...overlayArtifacts(overlays));
    const map = loadResourceMap(patchesDir);
    if (map !== null) {
        if (!map.wasSorted) {
            // The order of the file is part of its review value; applying it is
            // still deterministic, because it is sorted on read.
            onWarn(`${RESOURCE_MAP_PATH}: entries are not sorted by target; they are applied in target order anyway`);
        }
        for (const entry of map.entries) {
            artifacts.push({ kind: 'resource', id: entry.id, target: entry.target, artifactPath: entry.source, entry });
        }
    }
    return artifacts;
}
/**
 * One artifact per overlay target, in target order. Several overlay files may
 * name one target - the layer composes them - and they then share a commit,
 * because the commit is the target file, not the artifact that changed it.
 */
function overlayArtifacts(overlays) {
    const byTarget = new Map();
    for (const overlay of overlays) {
        const bucket = byTarget.get(overlay.target);
        if (bucket === undefined) {
            byTarget.set(overlay.target, [overlay]);
            continue;
        }
        bucket.push(overlay);
    }
    const targets = [...byTarget.keys()].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    return targets.map((target) => {
        const group = byTarget.get(target) ?? [];
        return {
            kind: 'overlay',
            id: group[0]?.id ?? target,
            target,
            artifactPath: group[0]?.artifactPath ?? `${OVERLAYS_DIR}/${target}`,
            overlays: group
        };
    });
}
/**
 * The known-state classifier `load --fresh` hands the drift guard
 * (##OVERLAY-KNOWN-MATERIALIZATION). A tracked path passes only when its bytes
 * are exactly the strict composition of every configured overlay that names it,
 * over the clean pin file, at the context this run materializes with - the bytes
 * `overlay apply` writes for packaging. Recognized paths are collected, so the
 * run can say which bytes it is about to replace.
 *
 * Any surprise while answering (unreadable base, unsafe target path) becomes a
 * false answer: the classifier may only narrow dirt, never weaken the guard, and
 * the drift check of step 2 has already read the same pin base for every overlay
 * that could reach here.
 */
export function overlayMaterializationClassifier(overlays, treeDir, pinSha, context, recognized) {
    const byTarget = new Map();
    for (const artifact of overlayArtifacts(overlays)) {
        byTarget.set(artifact.target, artifact.overlays);
    }
    return (path) => {
        const group = byTarget.get(path);
        if (group === undefined) {
            return false;
        }
        try {
            if (!isExactOverlayMaterialization(group, treeDir, pinSha, context)) {
                return false;
            }
        }
        catch {
            return false;
        }
        recognized.push(path);
        return true;
    };
}
/**
 * Which targets of a plan come from a layer other than the patch layer. Every
 * such target is a file the tree receives from patchset without anyone editing it
 * in the tree, which is exactly what makes it explainable when a rebuild has to
 * write it (see the assertion of `save`, PROP-008 sec. 4).
 */
function nonPatchTargets(plan) {
    return [...new Set(plan.filter((artifact) => artifact.kind !== 'patch').map((artifact) => artifact.target))];
}
function saveMaterializationTargets(plan, ownTargets) {
    return [...new Set([...nonPatchTargets(plan), ...ownTargets])];
}
function layerTargets(plan) {
    return plan.map((artifact) => {
        if (artifact.kind === 'patch') {
            let expected;
            try {
                expected = `${PATCHES_DIR}/${encodePatchName(artifact.target)}`;
            }
            catch {
                throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: patch target cannot be represented by the canonical artifact encoding: ${artifact.target}`, 'move the intervention to an encodable repository path', artifact.artifactPath);
            }
            if (artifact.artifactPath !== expected) {
                throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: patch file name does not canonically encode target ${artifact.target}; expected ${expected}`, 'rename the artifact to the canonical encoded target name', artifact.artifactPath);
            }
            return { layer: artifact.kind, target: toPosix(artifact.target), artifactPaths: [artifact.artifactPath], ids: [artifact.id] };
        }
        if (artifact.kind === 'overlay') {
            return {
                layer: artifact.kind,
                target: toPosix(artifact.target),
                artifactPaths: artifact.overlays.map((overlay) => overlay.artifactPath),
                ids: artifact.overlays.map((overlay) => overlay.id)
            };
        }
        return { layer: artifact.kind, target: toPosix(artifact.target), artifactPaths: [artifact.artifactPath], ids: [artifact.id] };
    });
}
/**
 * ##WORKTREE-DELTA-BYTES over every target the delta names - of its patches,
 * its overlays and its resource entries - announcing the files it rewrote.
 */
function restoreDeltaBytesOf(treeDir, plan, out) {
    const restored = restoreDeltaBytes(treeDir, plan.map((artifact) => toPosix(artifact.target)));
    if (restored.length > 0) {
        out.info(`restored the bytes of ${restored.length} file(s) the delta writes: ${restored.join(', ')}`);
    }
    return restored;
}
function warnFrom(out) {
    return (text) => out.warn(text);
}
/** Patch file names, sorted by their UTF-8 bytes so the order is locale-free. */
function listPatchFiles(patchesDir) {
    let names;
    try {
        names = readdirSync(join(patchesDir, ...PATCHES_DIR.split('/')));
    }
    catch {
        return [];
    }
    return names
        .filter((name) => name.endsWith(PATCH_FILE_SUFFIX))
        .sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}
function buildBranch(options, plan, context, id, inputs = []) {
    const { patchesDir, config, out } = options;
    const tree = options.resolution.path;
    const roots = ownedRootsOf(options.type, config.typeConfig, { treeDir: tree, pinSha: config.pin.sha });
    assertGeneratedTargetOwnership(patchesDir, options.type, roots, layerTargets(plan));
    const pinEntries = readTreeEntries(tree, config.pin.sha);
    const pinBlobs = readBlobs(tree, plan.flatMap((artifact) => {
        if (artifact.kind === 'resource' || (artifact.kind === 'patch' && artifact.patch.isAddFile))
            return [];
        const entry = pinEntries.get(toPosix(artifact.target));
        return entry === undefined ? [] : [entry.oid];
    }));
    const existingPaths = new Set([...pinEntries].filter(([, entry]) => entry.mode !== '040000').map(([path]) => path));
    const pinDateIso = context.buildDate;
    const patchSetCommit = context.patchSetCommit;
    const commits = [];
    const labels = [];
    let ownCommitted = false;
    const appendOwn = () => {
        const own = generatedOwnCommit({
            patchesDir,
            type: options.type,
            existingPaths,
            roots,
            pinTag: config.pin.tag ?? '',
            pinSha: config.pin.sha,
            patchSetCommit,
            omitLicenceNotice: options.omitLicenceNotice === true,
            ...(options.generatedModeSource === undefined ? {} : { modeSource: options.generatedModeSource })
        });
        ownCommitted = true;
        if (own === null) {
            if (options.verbose)
                out.diag('  own empty; commit skipped');
            return;
        }
        commits.push(own);
        labels.push(`own ${own.changes.filter((change) => !('remove' in change)).length} file(s)`);
    };
    for (const artifact of plan) {
        if (options.generatedBranch === true && !ownCommitted && artifact.kind !== 'patch')
            appendOwn();
        const path = toPosix(artifact.target);
        const bytes = materializeArtifact(artifact, options, context, pinEntries, pinBlobs);
        commits.push({
            message: commitMessage(artifact, config, patchSetCommit),
            changes: [{ path, mode: pinEntries.get(path)?.mode ?? '100644', bytes }]
        });
        existingPaths.add(path);
        labels.push(`${artifact.id} ${artifact.target}`);
    }
    if (options.generatedBranch === true && !ownCommitted)
        appendOwn();
    const shas = writeHistory({
        treeDir: tree,
        parent: config.pin.sha,
        dateIso: pinDateIso,
        authorName: COMMIT_AUTHOR_NAME,
        authorEmail: COMMIT_AUTHOR_EMAIL,
        commits
    });
    if (options.verbose)
        shas.forEach((sha, index) => out.diag(`  ${labels[index] ?? ''} -> ${sha.slice(0, 8)}`));
    let parent = shas.at(-1) ?? config.pin.sha;
    if (inputs.length > 0) {
        const scratch = join(patchesDir, '.codkit', 'tmp');
        mkdirSync(scratch, { recursive: true });
        const indexFile = join(scratch, `${id}.index`);
        rmSync(indexFile, { force: true });
        const indexEnv = { GIT_INDEX_FILE: indexFile };
        const commitEnv = {
            ...indexEnv,
            GIT_AUTHOR_DATE: pinDateIso,
            GIT_COMMITTER_DATE: pinDateIso,
            GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
            GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
            GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
            GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL
        };
        try {
            gitOk({ args: ['read-tree', parent], cwd: tree, env: indexEnv }, { code: 'ARTIFACT-BROKEN', message: 'cannot read the generated tree for inputs' });
            parent = appendInputCommits({
                treeDir: tree,
                indexEnv,
                commitEnv,
                parent,
                produced: inputs,
                patchSetCommit,
                pinTag: config.pin.tag ?? '',
                pinSha: config.pin.sha
            });
        }
        finally {
            rmSync(indexFile, { force: true });
            if (config.workspace !== undefined) {
                try {
                    rmdirSync(scratch);
                }
                catch (error) {
                    if (error instanceof Error &&
                        'code' in error &&
                        (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) {
                        // Another scratch user or caller data remains; do not remove it.
                    }
                    else
                        out.warn(`workspace temporary directory was retained: ${scratch}`);
                }
            }
        }
    }
    return { top: parent, pinDateIso, patchSetCommit };
}
/**
 * Build the generated commits of one state of patchset and return their tip,
 * without touching the work tree, any ref, the mark or the cache.
 *
 * `ci --effective-diff` needs it (PROP-011 sec. 6, the effective-diff rule): the diff a
 * reviewer reads is `git diff <base-top> <pr-top>` inside the tree, so the tip of
 * the base state has to exist as objects of that tree - and building it must not
 * disturb the tree that the run has just brought to the PR state. Everything the
 * commits are made of comes from git objects and from the given patchset root, so
 * the only changes to the tree repository are new Git objects.
 */
export function buildAppliedTip(options) {
    const tree = options.resolution.path;
    const engine = {
        patchesDir: options.patchesDir,
        resolution: options.resolution,
        config: options.config,
        type: options.type,
        out: options.out,
        fresh: false,
        dryRun: false,
        verbose: options.verbose === true,
        materializeOverlays: options.materializeOverlays === true,
        generatedBranch: options.generatedBranch === true,
        omitLicenceNotice: options.omitLicenceNotice === true,
        ...(options.patchSetCommit === undefined ? {} : { patchSetCommit: options.patchSetCommit }),
        ...(options.patchesRepositoryRoot === undefined || options.patchSetCommit === undefined
            ? {}
            : { generatedModeSource: { repositoryRoot: options.patchesRepositoryRoot, ref: options.patchSetCommit } })
    };
    const warn = (text) => {
        options.out.warn(text);
    };
    const conventions = loadConventions(options.type, options.patchesDir);
    const overlays = options.generatedBranch === true || options.materializeOverlays === true ? loadOverlays(options.patchesDir, options.type) : [];
    const plan = buildPlan(options.patchesDir, conventions, overlays, warn);
    assertGeneratedTargetOwnership(options.patchesDir, options.type, ownedRootsOf(options.type, options.config.typeConfig, { treeDir: tree, pinSha: options.config.pin.sha }), layerTargets(plan), options.omitLicenceNotice === true);
    const context = overlayVarContext(options.config, pinCommitDate(tree, options.config.pin.sha), options.patchSetCommit ?? patchSetCommitId(options.patchesDir));
    return buildBranch(engine, plan, context, treeId(tree)).top;
}
/** Complete object-only tip for CI today and publish later. */
export function buildGeneratedTip(options) {
    return buildAppliedTip({ ...options, generatedBranch: true });
}
/** Materialize bytes from the pin without hashing or staging each file separately. */
function materializeArtifact(artifact, options, context, pinEntries, pinBlobs) {
    const tree = options.resolution.path;
    if (artifact.kind === 'resource') {
        // Retain the established diagnostic for a missing target.
        if (!pinEntries.has(toPosix(artifact.target)))
            assertTargetAtPin(tree, options.config.pin.sha, artifact.entry);
        return readFileSync(resourceSourcePath(options.patchesDir, artifact.entry));
    }
    const pinBytes = pinBlobs.get(pinEntries.get(toPosix(artifact.target))?.oid ?? '');
    if (artifact.kind === 'overlay')
        return renderOverlayTarget(artifact.overlays, tree, options.config.pin.sha, context, pinBytes).bytes;
    return applyPatchAtPin(artifact, options, pinBytes);
}
/**
 * A codkit patch is regenerated against its own pin, so it must apply with
 * exact context. When it does not, the artifact is broken - not the tree.
 */
function applyPatchAtPin(artifact, options, pinBytes) {
    const tree = options.resolution.path;
    const pinSha = options.config.pin.sha;
    let base = new Uint8Array(0);
    if (!artifact.patch.isAddFile) {
        const shown = pinBytes === undefined
            ? runGit({ args: ['show', `${pinSha}:${toPosix(artifact.target)}`], cwd: tree })
            : { status: 0, stdout: Buffer.from(pinBytes).toString('utf8') };
        if (shown.status !== 0) {
            throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: ${artifact.target} does not exist at pin ${pinKey(options.config.pin)}`, 'regenerate the patch against the current pin with codkit save, or resolve it in an upgrade cycle', artifact.artifactPath);
        }
        base = encodeUtf8(shown.stdout);
    }
    try {
        return applyUnified(base, artifact.patch);
    }
    catch (error) {
        if (isCkError(error)) {
            throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: ${error.message}`, error.hint, artifact.artifactPath, error.line);
        }
        throw error;
    }
}
function commitMessage(artifact, config, patchSetCommit) {
    // One Codkit-Artifact trailer per artifact that shaped the commit: an overlay
    // target composed from two overlay files names both of them.
    const ids = artifact.kind === 'overlay' ? artifact.overlays.map((overlay) => overlay.id) : [artifact.id];
    return [
        `codkit: ${artifact.id} ${artifact.target}`,
        '',
        ...ids.map((id) => `Codkit-Artifact: ${id}`),
        `Codkit-Patchset-Commit: ${patchSetCommit}`,
        `Codkit-Upstream-Pin: ${pinKey(config.pin)}@${config.pin.sha}`
    ].join('\n');
}
/** Commit date of the pin, ISO-8601; the date every generated commit carries. */
export function pinCommitDate(treeDir, pinSha) {
    const result = gitOk({ args: ['log', '-1', '--format=%cI', pinSha], cwd: treeDir }, { code: 'PIN-UNREACHABLE', message: `cannot read the commit date of pin ${pinSha}`, hint: 'the pin must be present in the fork tree' });
    return result.stdout.trim();
}
/**
 * What patchset looked like when this branch was generated. A patchset checkout with
 * uncommitted work cannot be named by a sha, and says so.
 */
export function patchSetCommitId(patchesDir) {
    const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: patchesDir });
    if (head.status !== 0) {
        return 'none';
    }
    const status = runGit({ args: ['status', '--porcelain'], cwd: patchesDir });
    if (status.status === 0) {
        // .codkit/ is codkit's own scratch state, not content of the repository.
        const dirty = porcelainPaths(status.stdout).some((path) => !path.startsWith('.codkit/'));
        if (dirty) {
            return 'dirty';
        }
    }
    return head.stdout.trim();
}
// ---------------------------------------------------------------------------
// Moving the work tree
// ---------------------------------------------------------------------------
function updateRef(treeDir, branch, top) {
    gitOk({ args: ['update-ref', `refs/heads/${branch}`, top], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot update refs/heads/${branch}`, hint: 'check that the fork tree is writable' });
    gitOk({ args: ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot point HEAD at ${branch}`, hint: 'check that the fork tree is writable' });
}
/**
 * Move the work tree onto the new tip in three steps, rewriting only the files
 * that actually differ (##MTIME-DISCIPLINE): remove what the tip does not have,
 * bring the index in line with the tip, and check out what is left. Returns the
 * paths that were touched.
 *
 * Paths that exist in the work tree but not at the tip are removed: they belong
 * to a different upstream state, and the guard has already proved there is no
 * unsaved work in them.
 */
function moveWorkTree(treeDir, branch) {
    // 1. Paths the tree has and the new tip does not. They are removed first,
    // while the index still remembers that git tracks them.
    const drop = diffAgainstHead(treeDir, branch)
        .filter((entry) => entry.status.startsWith('A'))
        .map((entry) => entry.path);
    for (const batch of batches(drop)) {
        gitOk({ args: ['rm', '--quiet', '--force', '--ignore-unmatch', '--', ...batch], cwd: treeDir }, {
            code: 'ARTIFACT-BROKEN',
            message: `cannot remove ${batch.length} path(s) that do not exist at ${branch}`,
            hint: 're-run with --verbose'
        });
    }
    // 2. Make the index agree with the new tip without touching a single file.
    // Moving HEAD leaves the index describing the previous tip, and a stale
    // index makes `git status` report content that is in fact identical - which
    // the drift guard would then read as unextracted work. `git reset` on named
    // paths rewrites index entries only, so no mtime moves.
    reconcileIndex(treeDir, branch);
    // 3. Now the difference is a real difference of content: rewrite exactly
    // those files (##MTIME-DISCIPLINE).
    const restore = diffAgainstHead(treeDir, branch).map((entry) => entry.path);
    for (const batch of batches(restore)) {
        gitOk({ args: ['checkout', 'HEAD', '--', ...batch], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot check out ${batch.length} path(s) of ${branch}`, hint: 're-run with --verbose' });
    }
    return [...restore, ...drop];
}
/**
 * Return named tracked paths to the tree's current tip, index and working file
 * together (##CMD-LOAD-DISCARD-WORKTREE).
 *
 * `git checkout HEAD -- <path>` and not `git checkout -- <path>`: the second
 * restores from the index, which would keep a staged build artifact exactly
 * where it was. Only the paths of the plan are passed, so nothing else in the
 * tree can be reached from here.
 */
export function restoreToTip(treeDir, paths) {
    for (const batch of batches(paths)) {
        gitOk({ args: ['checkout', 'HEAD', '--', ...batch], cwd: treeDir }, {
            code: 'ARTIFACT-BROKEN',
            message: `cannot discard the working-tree edit of ${batch.length} path(s)`,
            hint: 're-run with --verbose'
        });
    }
}
/** `git diff --name-status HEAD`: the work tree against the current tip. */
function diffAgainstHead(treeDir, branch) {
    const diff = gitOk({ args: ['diff', '--name-status', '--no-renames', '-z', 'HEAD'], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot compare the work tree with ${branch}`, hint: 're-run with --verbose' });
    const entries = [];
    const fields = diff.stdout.split('\0');
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const status = fields[index];
        const path = fields[index + 1];
        if (status === undefined || path === undefined || path === '') {
            continue;
        }
        entries.push({ status, path });
    }
    return entries;
}
/** Index entries that disagree with HEAD, reset to HEAD. Files are not read. */
function reconcileIndex(treeDir, branch) {
    const staged = gitOk({ args: ['diff-index', '--cached', '--name-only', '-z', 'HEAD'], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot compare the index with ${branch}`, hint: 're-run with --verbose' });
    const paths = staged.stdout.split('\0').filter((path) => path !== '');
    for (const batch of batches(paths)) {
        gitOk({ args: ['reset', '--quiet', 'HEAD', '--', ...batch], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot bring the index of ${treeDir} in line with ${branch}`, hint: 're-run with --verbose' });
    }
}
function* batches(paths) {
    for (let index = 0; index < paths.length; index += PATH_BATCH) {
        yield paths.slice(index, index + PATH_BATCH);
    }
}
// ---------------------------------------------------------------------------
// --fresh: cleaning untracked content by the whitelist
// ---------------------------------------------------------------------------
/**
 * PROP-011 ##CLEANUP-WHITELIST-CONTENT: `git clean -fdx` is not used. The list of
 * untracked paths (ignored ones included - that is where the build caches are)
 * minus the whitelist is what gets removed. Discipline: what is not on the list
 * goes away.
 */
export function cleanUntracked(treeDir, roots, conventions, workspace) {
    // File by file, never `--directory`: a collapsed directory entry would hide
    // whitelisted content nested inside an untracked one (a build output under an
    // untracked materialization root, for instance) and take it down with it.
    const listed = new Set([
        ...listUntracked(treeDir, ['--others', '--exclude-standard', '-z']),
        ...listUntracked(treeDir, ['--others', '--ignored', '--exclude-standard', '-z'])
    ]);
    const receipts = workspaceForkReceipt(treeDir, workspace);
    const emptied = new Set();
    let removed = 0;
    for (const path of [...listed].sort()) {
        if (path === '' || path.startsWith('.git/') || receipts.includes(path)) {
            continue;
        }
        // Own code is not litter: it is the materialization of the delta. What a
        // build wrote *inside* an owned directory is litter, though - the type
        // named those paths, and a fresh pass is exactly the run that removes
        // them (PROP-016 ##TYPE-AREA-LAYOUT).
        const owned = ownedRootOf(roots, path.endsWith('/') ? path.slice(0, -1) : path);
        if (owned !== null) {
            const relative = path.slice(owned.path.length + 1);
            if (relative === '' || !isBuildOutput(owned, relative)) {
                continue;
            }
            rmSync(join(treeDir, ...path.split('/')), { recursive: true, force: true });
            removed += 1;
            collectAncestors(path, emptied);
            continue;
        }
        if (matchesCleanupWhitelist(path, conventions.cleanupWhitelist)) {
            continue;
        }
        rmSync(join(treeDir, ...path.split('/')), { recursive: true, force: true });
        removed += 1;
        collectAncestors(path, emptied);
    }
    pruneEmptyDirectories(treeDir, emptied);
    return removed;
}
function listUntracked(treeDir, args) {
    const result = gitOk({ args: ['ls-files', ...args], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot list untracked paths in ${treeDir}`, hint: 're-run with --verbose' });
    return result.stdout.split('\0').filter((path) => path !== '');
}
/**
 * The whitelist is read with the shared gitignore-style matcher of
 * conventions.json (##CLEANUP-WHITELIST-CONTENT). Kept as a named export because
 * the whitelist is what the tests and the callers talk about, not the matcher.
 */
export function matchesCleanupWhitelist(path, patterns) {
    return matchesPatternList(path, patterns);
}
function collectAncestors(relative, into) {
    let at = relative.endsWith('/') ? relative.slice(0, -1) : relative;
    for (;;) {
        const slash = at.lastIndexOf('/');
        if (slash === -1) {
            return;
        }
        at = at.slice(0, slash);
        into.add(at);
    }
}
function pruneEmptyDirectories(root, candidates) {
    const ordered = [...candidates].sort((left, right) => right.split('/').length - left.split('/').length);
    for (const relative of ordered) {
        const absolute = join(root, ...relative.split('/'));
        try {
            if (statSync(absolute).isDirectory() && readdirSync(absolute).length === 0) {
                rmdirSync(absolute);
            }
        }
        catch {
            // Already gone, or not empty: nothing to report.
        }
    }
}
export function writeExclude(treeDir, roots, checkpoints, inputPaths = []) {
    const plan = planExclude(treeDir, roots, checkpoints?.afterOpen, inputPaths);
    checkpoints?.afterPlan?.();
    writeExcludePlan(plan, checkpoints);
}
/**
 * The managed block carries one line per owned directory, in the order the type
 * answered: git reads them as it reads any exclude file, and a family that owns
 * one directory gets exactly the single line it always got. The directories of
 * the inputs follow, one line each (##INPUTS-LOAD): delivered untracked like own
 * code, they are hidden from git the same way.
 */
function excludeBody(roots, inputPaths) {
    return [...roots.map((owned) => owned.path), ...inputPaths].map((path) => `/${path}/`).join('\n');
}
function planExclude(treeDir, roots, afterOpen, inputPaths = []) {
    const listings = listWorktrees(treeDir);
    if (listings === null) {
        // Keep the historical lower-level fallback for a path that is not a git
        // worktree at all (unit callers use it to exercise managed-block bytes).
        // A real repository whose worktree listing failed is different: choosing
        // the shared file there would be an unsafe fail-open.
        const repository = runGit({ args: ['rev-parse', '--is-inside-work-tree'], cwd: treeDir });
        if (repository.status === 0) {
            throw ckError('ARTIFACT-BROKEN', 'cannot inspect linked worktrees before choosing the own-code exclusion scope', 'run git worktree list --porcelain in the fork repository, repair the reported error, and retry');
        }
        const adminRoot = gitCommonDirOf(treeDir);
        const segments = ['info'];
        const parent = ensureAdminDirectory(adminRoot, segments, { what: 'info/exclude', create: false });
        const path = join(parent, 'exclude');
        const existing = readExcludeFile(adminRoot, path, afterOpen);
        return {
            kind: 'common-block',
            treeDir,
            adminRoot,
            adminSegments: segments,
            ...planManagedBlock(path, existing, excludeBody(roots, inputPaths))
        };
    }
    const body = excludeBody(roots, inputPaths);
    if (listings.length > 1) {
        return planWorktreeExclude(treeDir, body);
    }
    const adminRoot = gitCommonDirOf(treeDir);
    const segments = ['info'];
    // Planning reads only: a missing directory is an absent exclude, a symlinked
    // one is a refusal, and nothing is created before the run is committed.
    const parent = ensureAdminDirectory(adminRoot, segments, { what: 'info/exclude', create: false });
    const path = join(parent, 'exclude');
    const existing = readExcludeFile(adminRoot, path, afterOpen);
    return { kind: 'common-block', treeDir, adminRoot, adminSegments: segments, ...planManagedBlock(path, existing, body) };
}
/**
 * The per-worktree plan: our own exclude file under the per-worktree admin
 * directory, the two config keys that make Git consult it, and the retirement
 * of our stale block from the shared info/exclude. Foreign config values and
 * foreign files are named and refused here, before any mutation of the run.
 */
function planWorktreeExclude(treeDir, body) {
    const adminRoot = gitDirOf(treeDir);
    const segments = OWN_EXCLUDE_RELATIVE_PATH.split('/').slice(0, -1);
    const parent = ensureAdminDirectory(adminRoot, segments, { what: OWN_EXCLUDE_RELATIVE_PATH, create: false });
    const path = join(parent, OWN_EXCLUDE_RELATIVE_PATH.split('/').pop() ?? 'exclude');
    const existing = readExcludeFile(adminRoot, path);
    if (existing !== '' && markerLines(existing, EXCLUDE_BEGIN).length === 0 && markerLines(existing, EXCLUDE_END).length === 0) {
        throw malformedExclude(path, 'this codkit-owned file carries foreign content', `remove the file (it is regenerated on every load) or move the patterns into the repository's own exclude configuration, then retry`);
    }
    const block = planManagedBlock(path, existing, body);
    const extension = worktreeConfigExtension(treeDir);
    if (extension.state === 'set' && extension.value !== 'true') {
        throw malformedExclude(path, `extensions.worktreeConfig is ${JSON.stringify(extension.value)}, not "true"`, 'a foreign value of a shared git extension is never overwritten; resolve it manually, then retry');
    }
    if (extension.state === 'set') {
        // Only readable once the extension is on; otherwise the key is unset.
        refuseForeignExcludesFile(treeDir, path);
    }
    else {
        // The extension is off, so a config.worktree that already exists is
        // inert - but enabling the extension would make it live, and a foreign
        // excludesFile in it must be refused HERE, at the preflight, not after
        // the run has moved refs. Read the file directly, the way git -f does.
        const worktreeConfig = join(gitDirOf(treeDir), 'config.worktree');
        refuseDormantForeignExcludesFile(treeDir, worktreeConfig, path);
    }
    // A repository-level (shared local) excludesFile is a deliberate foreign
    // decision too: the per-worktree key would shadow it for this worktree,
    // and shadowing somebody's configuration is not codkit's call. Personal
    // global/system values are deliberately NOT refused - the worktree key is
    // exactly the mechanism that scopes this worktree's exclusion away from
    // the machine's personal files.
    const shared = localConfigValue(treeDir, 'core.excludesFile');
    if (shared.state === 'set' && shared.value !== path) {
        throw malformedExclude(path, `the repository config already sets core.excludesFile=${shared.value}`, 'a foreign repository-level exclude configuration is never shadowed; unset it (git config --unset core.excludesFile) or point it at the file above, then retry');
    }
    // Retire our own stale managed block from the shared file, if an older
    // codkit left one there; foreign lines stay byte for byte.
    let legacyCommon = null;
    const commonRoot = gitCommonDirOf(treeDir);
    const commonParent = ensureAdminDirectory(commonRoot, ['info'], { what: 'info/exclude', create: false });
    const commonPath = join(commonParent, 'exclude');
    const commonExisting = readExcludeFile(commonRoot, commonPath);
    const openers = markerLines(commonExisting, EXCLUDE_BEGIN);
    const closers = markerLines(commonExisting, EXCLUDE_END);
    if (openers.length > 0 || closers.length > 0) {
        if (openers.length !== 1 || closers.length !== 1) {
            throw malformedExclude(commonPath, `expected zero markers or one ordered pair, found ${openers.length} opening and ${closers.length} closing marker(s)`);
        }
        const opener = openers[0];
        const closer = closers[0];
        if (opener === undefined || closer === undefined || opener.end > closer.start) {
            throw malformedExclude(commonPath, 'the closing marker appears before the opening marker');
        }
        let without = `${commonExisting.slice(0, opener.start)}${commonExisting.slice(closer.end)}`;
        if (without !== '' && !endsWithEol(without)) {
            without = `${without}${preferredEol(commonExisting)}`;
        }
        legacyCommon = { path: commonPath, existing: commonExisting, next: without };
    }
    return { kind: 'worktree-local', treeDir, adminRoot, adminSegments: segments, ...block, legacyCommon };
}
/** The managed-block merge: zero markers appends, one ordered pair replaces. */
function planManagedBlock(path, existing, body) {
    const openers = markerLines(existing, EXCLUDE_BEGIN);
    const closers = markerLines(existing, EXCLUDE_END);
    const eol = preferredEol(existing);
    let next;
    if (openers.length === 0 && closers.length === 0) {
        const separation = existing === '' ? '' : endsWithEol(existing) ? eol : `${eol}${eol}`;
        next = `${existing}${separation}${EXCLUDE_BEGIN}${eol}${body}${eol}${EXCLUDE_END}${eol}`;
    }
    else if (openers.length === 1 && closers.length === 1) {
        const opener = openers[0];
        const closer = closers[0];
        if (opener === undefined || closer === undefined || opener.end > closer.start) {
            throw malformedExclude(path, 'the closing marker appears before the opening marker');
        }
        const blockEol = opener.eol === '' ? eol : opener.eol;
        next = `${existing.slice(0, opener.end)}${body}${blockEol}${existing.slice(closer.start)}`;
    }
    else {
        throw malformedExclude(path, `expected zero markers or one ordered pair, found ${openers.length} opening and ${closers.length} closing marker(s)`);
    }
    return { path, existing, next };
}
/** One exclude file, read the contained way: absent is empty, a symlink refuses. */
function readExcludeFile(root, path, afterOpen) {
    const repositoryPath = relative(root, path).split(sep).join('/');
    const read = readContainedFile(root, repositoryPath, { what: path, ...(afterOpen === undefined ? {} : { afterOpen }) });
    return read.state === 'ok' ? Buffer.from(read.bytes).toString('utf8') : '';
}
function localConfigValue(treeDir, key) {
    const result = runGit({ args: ['config', '--local', '--get', key], cwd: treeDir });
    if (result.status !== 0) {
        return { state: 'unset' };
    }
    const value = result.stdout.trim();
    return value === '' ? { state: 'unset' } : { state: 'set', value };
}
function worktreeConfigExtension(treeDir) {
    return localConfigValue(treeDir, 'extensions.worktreeConfig');
}
/** The per-worktree core.excludesFile; only meaningful with the extension on. */
function worktreeExcludesFile(treeDir) {
    const result = runGit({ args: ['config', '--worktree', '--get', 'core.excludesFile'], cwd: treeDir });
    if (result.status !== 0) {
        return { state: 'unset' };
    }
    const value = result.stdout.trim();
    return value === '' ? { state: 'unset' } : { state: 'set', value };
}
/**
 * Inspect an inert `config.worktree` before enabling the shared extension. The
 * file is read no-follow before and after git parses it; different bytes are a
 * race and refuse. This check is run both at planning and, under the common
 * lock, immediately before the extension mutation.
 */
function refuseDormantForeignExcludesFile(treeDir, worktreeConfig, ownedPath) {
    const adminRoot = gitDirOf(treeDir);
    const before = readContainedFile(adminRoot, 'config.worktree', { what: worktreeConfig });
    if (before.state === 'absent') {
        return;
    }
    const latent = runGit({ args: ['config', '--includes', '-f', worktreeConfig, '--get', 'core.excludesFile'], cwd: treeDir });
    const after = readContainedFile(adminRoot, 'config.worktree', { what: worktreeConfig });
    if (after.state !== 'ok' || !Buffer.from(before.bytes).equals(Buffer.from(after.bytes))) {
        throw malformedExclude(worktreeConfig, 'changed while its dormant worktree configuration was being inspected', 'retry the command');
    }
    if (latent.status !== 0 && latent.status !== 1) {
        throw malformedExclude(worktreeConfig, `cannot parse dormant worktree configuration: ${latent.stderr.trim() || `git config exited ${latent.status}`}`, 'repair config.worktree before enabling extensions.worktreeConfig');
    }
    const value = latent.stdout.trim();
    if (latent.status === 0 && value !== '' && value !== ownedPath) {
        throw malformedExclude(ownedPath, `this worktree carries a dormant config.worktree with core.excludesFile=${value}`, 'enabling extensions.worktreeConfig would make that foreign value live; resolve it manually (git config -f <git-dir>/config.worktree --unset core.excludesFile), then retry');
    }
}
/**
 * Refuse a per-worktree excludesFile that is not ours, wherever it came from -
 * including a config.worktree that only became readable after codkit enabled
 * the extension. Never overwritten, never chained.
 */
function refuseForeignExcludesFile(treeDir, path) {
    const excludesFile = worktreeExcludesFile(treeDir);
    if (excludesFile.state === 'set' && excludesFile.value !== path) {
        throw malformedExclude(path, `this worktree already has core.excludesFile=${excludesFile.value}`, 'a foreign exclude configuration is never overwritten; unset it (git config --worktree --unset core.excludesFile) or point it at the file above, then retry');
    }
}
function setWorktreeExcludesFile(treeDir, path) {
    gitOk({ args: ['config', '--worktree', 'core.excludesFile', path], cwd: treeDir }, {
        code: 'CONFIG',
        message: `cannot set the per-worktree core.excludesFile to ${path}`,
        hint: 'check that the git configuration of the worktree is writable'
    });
}
function enableWorktreeConfig(treeDir) {
    gitOk({ args: ['config', '--local', 'extensions.worktreeConfig', 'true'], cwd: treeDir }, {
        code: 'CONFIG',
        message: 'cannot enable extensions.worktreeConfig (required for per-worktree exclude configuration)',
        hint: 'check that the repository configuration is writable'
    });
}
function writeExcludePlan(plan, checkpoints, workspaceId) {
    if (plan.kind === 'common-block') {
        writeCommonExcludePlan(plan);
        return;
    }
    // The shared config file and the shared info/exclude are involved even
    // though the exclusion itself is per-worktree: serialize with everything
    // else that touches this repository's shared state.
    const handle = workspaceId === undefined
        ? acquireCommonRepositoryLock(plan.treeDir, 'worktree-local exclude')
        : acquireWorkspaceRepositoryLock(plan.treeDir, `workspace ${workspaceId} worktree-local exclude`, workspaceId);
    try {
        writeWorktreeExcludePlan(plan, checkpoints);
    }
    finally {
        handle.release();
    }
}
function writeCommonExcludePlan(plan) {
    if (readExcludeFile(plan.adminRoot, plan.path) !== plan.existing) {
        throw malformedExclude(plan.path, 'the file changed after the preflight scan');
    }
    if (plan.next === plan.existing) {
        return;
    }
    writeContainedFileAtomic(plan.adminRoot, `${plan.adminSegments.join('/')}/${basename(plan.path)}`, {
        bytes: encodeUtf8(plan.next),
        what: plan.path
    });
}
function writeWorktreeExcludePlan(plan, checkpoints) {
    const commonRoot = gitCommonDirOf(plan.treeDir);
    const worktreeRoot = gitDirOf(plan.treeDir);
    const snapshots = [
        containedSnapshot(plan.adminRoot, plan.path),
        containedSnapshot(commonRoot, join(commonRoot, 'config')),
        containedSnapshot(worktreeRoot, join(worktreeRoot, 'config.worktree')),
        ...(plan.legacyCommon === null ? [] : [containedSnapshot(commonRoot, plan.legacyCommon.path)])
    ];
    try {
        if (readExcludeFile(plan.adminRoot, plan.path) !== plan.existing) {
            throw malformedExclude(plan.path, 'the file changed after the preflight scan');
        }
        const extension = worktreeConfigExtension(plan.treeDir);
        if (extension.state === 'set' && extension.value !== 'true') {
            throw malformedExclude(plan.path, `extensions.worktreeConfig is ${JSON.stringify(extension.value)}, not "true"`);
        }
        if (extension.state === 'unset') {
            refuseDormantForeignExcludesFile(plan.treeDir, join(worktreeRoot, 'config.worktree'), plan.path);
        }
        else {
            refuseForeignExcludesFile(plan.treeDir, plan.path);
        }
        // Materialize and verify the owned file before any config can point at it.
        if (plan.next !== plan.existing) {
            writeContainedFileAtomic(plan.adminRoot, OWN_EXCLUDE_RELATIVE_PATH, {
                bytes: encodeUtf8(plan.next),
                what: plan.path
            });
        }
        if (readExcludeFile(plan.adminRoot, plan.path) !== plan.next) {
            throw malformedExclude(plan.path, 'owned exclude verification failed after write');
        }
        checkpoints?.afterOwnedWrite?.();
        if (plan.legacyCommon !== null && plan.legacyCommon.next !== plan.legacyCommon.existing) {
            if (readExcludeFile(commonRoot, plan.legacyCommon.path) !== plan.legacyCommon.existing) {
                throw malformedExclude(plan.legacyCommon.path, 'the file changed after the preflight scan');
            }
            writeContainedFileAtomic(commonRoot, 'info/exclude', {
                bytes: encodeUtf8(plan.legacyCommon.next),
                what: plan.legacyCommon.path
            });
        }
        if (extension.state === 'unset') {
            enableWorktreeConfig(plan.treeDir);
            checkpoints?.afterExtensionEnable?.();
            refuseForeignExcludesFile(plan.treeDir, plan.path);
        }
        const excludesFileNow = worktreeExcludesFile(plan.treeDir);
        if (excludesFileNow.state === 'unset') {
            setWorktreeExcludesFile(plan.treeDir, plan.path);
        }
        checkpoints?.afterCoreSet?.();
    }
    catch (error) {
        try {
            for (const snapshot of [...snapshots].reverse())
                restoreContainedSnapshot(snapshot);
        }
        catch (rollbackError) {
            throw ckError('INTERNAL', `worktree-local exclude failed (${error instanceof Error ? error.message : String(error)}) and exact rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`, 'inspect the repository config and per-worktree exclude before retrying');
        }
        throw error;
    }
}
function containedSnapshot(root, path) {
    const repositoryPath = relative(root, path).split(sep).join('/');
    const read = readContainedFile(root, repositoryPath, { what: path });
    return { root, relative: repositoryPath, path, bytes: read.state === 'ok' ? read.bytes : null };
}
function restoreContainedSnapshot(snapshot) {
    if (snapshot.bytes === null) {
        removeContainedFile(snapshot.root, snapshot.relative, { what: snapshot.path });
        return;
    }
    writeContainedFileAtomic(snapshot.root, snapshot.relative, { bytes: snapshot.bytes, what: snapshot.path });
}
function markerLines(text, marker) {
    const found = [];
    let start = 0;
    while (start < text.length) {
        let contentEnd = start;
        while (contentEnd < text.length && text[contentEnd] !== '\n' && text[contentEnd] !== '\r') {
            contentEnd += 1;
        }
        let end = contentEnd;
        let eol = '';
        if (text[contentEnd] === '\r' && text[contentEnd + 1] === '\n') {
            end = contentEnd + 2;
            eol = '\r\n';
        }
        else if (text[contentEnd] === '\r' || text[contentEnd] === '\n') {
            end = contentEnd + 1;
            eol = text[contentEnd] ?? '';
        }
        if (text.slice(start, contentEnd) === marker) {
            found.push({ start, end, eol });
        }
        if (end === start) {
            break;
        }
        start = end;
    }
    return found;
}
function preferredEol(text) {
    const crlf = text.indexOf('\r\n');
    const lf = text.indexOf('\n');
    const cr = text.indexOf('\r');
    if (crlf !== -1 && (lf === -1 || crlf <= lf) && (cr === -1 || crlf <= cr)) {
        return '\r\n';
    }
    if (lf !== -1 && (cr === -1 || lf < cr)) {
        return '\n';
    }
    return cr === -1 ? '\n' : '\r';
}
function endsWithEol(text) {
    return text.endsWith('\n') || text.endsWith('\r');
}
function malformedExclude(path, detail, hint) {
    return ckError('CONFIG', `${path}: ${detail}`, hint ?? `restore exactly one ${EXCLUDE_BEGIN} / ${EXCLUDE_END} pair or remove both markers, then retry`, path);
}
/**
 * The hook body; regenerated by every load, so it cannot drift (PROP-012 sec. 5).
 * The marker line under the shebang claims the file the same way the patch-set
 * hooks do (PROP-007 sec. 19): a hook without it belongs to somebody else.
 *
 * The hook never rejects a commit (owner ruling RP-1: "instead of the refusal,
 * make it a reminder"). A commit in the tree is work that save extracts and the
 * destructive commands refuse over, so rejecting it guarded nothing; the hook
 * only says which command carries the work to the patchset, or that save will
 * refuse while HEAD is off the generated branch.
 */
export function treePreCommitHookScript(branch) {
    return [
        '#!/bin/sh',
        HOOK_MARKER,
        '# Installed by codkit. Commits in this fork tree are work; codkit save extracts them.',
        `if [ "$${INTERNAL_COMMIT_ENV}" = "1" ]; then`,
        '\texit 0',
        'fi',
        'case "$(git symbolic-ref -q --short HEAD)" in',
        '\tcodkit/applied/*)',
        '\t\techo "codkit: this commit is work in the fork tree; it reaches patchset only when you run codkit save or codkit sync" >&2',
        '\t\t;;',
        '\t*)',
        `\t\techo "codkit: HEAD is not on ${branch}; codkit save will refuse until you switch back (git switch ${branch})" >&2`,
        '\t\t;;',
        'esac',
        'exit 0',
        ''
    ].join('\n');
}
/** What codkit wrote before the ownership marker existed: still ours to renew. */
const LEGACY_TREE_PRE_COMMIT_HOOK = [
    '#!/bin/sh',
    '# Installed by codkit. Commits in this fork tree are made by codkit only.',
    `if [ "$${INTERNAL_COMMIT_ENV}" != "1" ]; then`,
    '\techo "codkit: manual commits in the fork tree are forbidden;" >&2',
    '\techo "codkit: save your work with: codkit save (from the patchset repo)." >&2',
    '\techo "codkit: This tree is managed by codkit." >&2',
    '\texit 1',
    'fi',
    'exit 0',
    ''
].join('\n');
/**
 * The effective hooks path for one config scope, or null when that scope's
 * resolution fails (`core.hooksPath=/dev/null` makes `--git-path hooks/*`
 * fatal, for instance). A failure is never proof of anything: the caller
 * reports the guard as unprovable, not as active.
 */
function effectiveHooksPath(treeDir, machineConfig) {
    if (!machineConfig) {
        const resolved = effectiveGitPath(treeDir, 'hooks/pre-commit');
        return resolved.ok ? resolved.path : null;
    }
    const result = runGitUserPathResolution({ cwd: treeDir, relative: 'hooks/pre-commit' });
    if (result.status !== 0) {
        return null;
    }
    const line = result.stdout.trim();
    return line === '' ? null : line;
}
export function writeTreeHook(treeDir, branch, out, afterOpen) {
    // A linked worktree shares the hooks directory with every sibling worktree
    // of its repository, so a codkit hook here would also speak in trees codkit
    // does not manage: its reminder names this tree's generated branch. Nothing
    // is written there, nor at the old unused per-worktree appended location;
    // the reminder is simply off, and the load/save refusal remains the guard.
    if (isLinkedGitLayout(gitDirOf(treeDir), gitCommonDirOf(treeDir))) {
        out.warn(`linked worktree ${treeDir}: not installing the pre-commit hook; hooks are shared by every worktree of a repository, ` +
            'so a codkit reminder here would speak for sibling worktrees codkit does not manage too (the commit reminder is unavailable in this tree; ' +
            'load and save still refuse over unextracted commits)', 'MARK-RO');
        return false;
    }
    // The repository's own administrative hooks directory, and nothing else:
    // `--git-path hooks/<name>` follows core.hooksPath, which may name a
    // directory outside the repository (a user's or a site-wide hooks
    // collection). Codkit has no authority over such a location, so the reminder
    // is written under the tree's own git dir, never at the configured path.
    const gitDir = gitDirOf(treeDir);
    const hooksDirPath = join(gitDir, 'hooks');
    const path = join(hooksDirPath, 'pre-commit');
    try {
        // Contained administrative write: a symlinked hooks directory or a
        // symlinked hook file refuses instead of landing outside git admin.
        const hookPath = join(gitDir, 'hooks', 'pre-commit');
        const existing = readContainedFile(gitDir, 'hooks/pre-commit', {
            what: hookPath,
            ...(afterOpen === undefined ? {} : { afterOpen })
        });
        if (existing.state === 'ok') {
            const current = Buffer.from(existing.bytes).toString('utf8');
            if (!isOurs(current) && current !== LEGACY_TREE_PRE_COMMIT_HOOK) {
                out.warn(`${hookPath} is a foreign pre-commit hook; codkit never overwrites or chains somebody else's hook. ` +
                    'The commit reminder is not installed in this tree; remove the foreign hook if you want codkit to govern it', 'MARK-RO');
                return false;
            }
        }
        writeContainedFileAtomic(gitDir, 'hooks/pre-commit', {
            bytes: encodeUtf8(treePreCommitHookScript(branch)),
            mode: 0o755,
            what: hookPath
        });
    }
    catch (error) {
        out.warn(`cannot install the fork-tree pre-commit hook ${path}: ${error instanceof Error ? error.message : String(error)}; ` +
            'its commit reminder will not print, and commits stay work that codkit save extracts', 'MARK-RO');
        return false;
    }
    // Honesty about the effect, not just the write, and across every config
    // scope: the isolated resolution sees the repository's own config, the
    // machine resolution sees the global and system config the user's git
    // actually runs with. The reminder is only "on" when both name our copy;
    // anything else - a custom core.hooksPath anywhere, or a resolution that
    // fails outright (core.hooksPath=/dev/null) - means git will not run this
    // copy, and saying otherwise would advertise a reminder that is not there. The
    // copy is still kept: it is the repository's own location, regenerated by
    // every load, and it becomes the live reminder the moment the config is gone.
    const isolated = effectiveHooksPath(treeDir, false);
    const machine = effectiveHooksPath(treeDir, true);
    if (isolated === null || machine === null) {
        out.warn(`${treeDir}: cannot prove which pre-commit hook git runs (effective path resolution failed; a configured ` +
            `core.hooksPath such as /dev/null breaks it); the codkit hook at ${path} may not run, so its commit reminder is ` +
            'not proven to print. Fix or remove core.hooksPath (git config --unset core.hooksPath) to make the reminder provable', 'MARK-RO');
        return false;
    }
    if (!sameEffectivePath(isolated, path) || !sameEffectivePath(machine, path)) {
        const effective = !sameEffectivePath(machine, path) ? machine : isolated;
        out.warn(`${treeDir}: git runs pre-commit hooks from ${effective} because of a configured core.hooksPath (repository, global ` +
            `or system scope); the codkit hook at ${path} will not run, so its commit reminder will not print while that ` +
            'config remains (git keeps executing the configured hook)', 'MARK-RO');
        return false;
    }
    return true;
}
/** Platform-aware normal-vs-linked Git layout predicate. */
export function isLinkedGitLayout(gitDir, commonDir, platform = process.platform) {
    return !sameEffectivePath(gitDir, commonDir, platform);
}
// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function dryRunPlan(options, plan, context, branch) {
    const { out } = options;
    const broken = [];
    for (const artifact of plan) {
        try {
            if (artifact.kind === 'patch') {
                applyPatchAtPin(artifact, options);
            }
            else if (artifact.kind === 'overlay') {
                renderOverlayTarget(artifact.overlays, options.resolution.path, options.config.pin.sha, context);
            }
            else {
                assertTargetAtPin(options.resolution.path, options.config.pin.sha, artifact.entry);
            }
        }
        catch (error) {
            if (!isCkError(error)) {
                throw error;
            }
            broken.push(artifact.artifactPath);
            out.addError(error.toPayload());
        }
    }
    if (broken.length > 0) {
        out.info(`dry run: ${broken.length} of ${plan.length} artifact(s) do not apply at the pin`);
        return result('broken', 1, { branch, artifacts: plan.length, broken });
    }
    out.info(`dry run: ${plan.length} artifact(s), all applicable`);
    return result('dry-run', 0, { branch, artifacts: plan.length });
}
function reportBroken(out, error, branch) {
    if (!isCkError(error) || error.code !== 'ARTIFACT-BROKEN') {
        throw error;
    }
    out.addError(error.toPayload());
    return result('broken', 1, { branch, broken: [error.file ?? 'unknown artifact'] });
}
/**
 * ##PATCHSET-SIDE-EDIT-RULE: own code edited in patchset while the tree is otherwise
 * clean is not "unextracted work" - at load time patchset is the direction of
 * truth, so the difference is announced and then applied.
 *
 * The sides are told apart file by file, against the own map of the mark
 * (PROP-006 ##TREE-MARK): a file that still equals the mark did not move on that
 * side. When both sides moved away from the mark and from each other, no
 * direction of truth exists and the run stops with CK-E-BOTH-SIDES-EDITED.
 *
 * Without a map - a mark from before it existed, or no mark at all - the classes
 * come out `unknown` and the guard stays strict, exactly as it did before the
 * map: the fingerprint is then the only evidence that patchset is the side that
 * moved.
 */
function judgeOwnSides(drift, patchesDir, treeDir, roots, mark, fingerprint, materializer, artifacts) {
    if (drift.upstream.length > 0) {
        return { kind: 'unextracted' };
    }
    const extensions = loadOwnManifest(patchesDir).extensions;
    const prefixes = materializer === null ? [] : ownExtensionTreePrefixes(materializer, extensions);
    const status = runGit({ cwd: treeDir, args: ['status', '--porcelain=v1', '-z', '--untracked-files=no'] });
    if (status.status !== 0 ||
        porcelainZEntries(status.stdout).some((entry) => entry.status[0] !== ' ' && prefixes.some((prefix) => entry.path.startsWith(prefix)))) {
        return { kind: 'unextracted' };
    }
    const extensionClasses = materializer === null ? [] : classifyOwnExtensions(materializer, patchesDir, treeDir, extensions, artifacts);
    if (extensionClasses.some((entry) => entry.kind === 'unknown' && entry.tree !== null)) {
        return { kind: 'unextracted' };
    }
    const classes = [...classifyAllOwn(patchesDir, treeDir, roots, (owned) => ownMarkFilesOf(mark, owned)), ...extensionClasses].filter((entry) => entry.kind !== 'same');
    const bothSides = classes.find((entry) => entry.kind === 'both-edited');
    if (bothSides !== undefined) {
        return { kind: 'both-sides', error: bothSidesError(bothSides) };
    }
    if (classes.some((entry) => entry.kind === 'tree-edited')) {
        return { kind: 'unextracted' };
    }
    const changed = classes.filter((entry) => entry.kind === 'patchset-edited');
    if (changed.length > 0) {
        return { kind: 'patchset-side', text: patchsetSideText(changed) };
    }
    // No map: fall back to the evidence the fingerprint gives (a tree file that
    // exists only in the tree is unextracted work whatever the fingerprint says).
    if (mark === null || mark.deltaFingerprint === fingerprint) {
        return { kind: 'unextracted' };
    }
    if (drift.own.some((divergence) => divergence.kind === 'tree-only')) {
        return { kind: 'unextracted' };
    }
    const unknown = drift.own.filter((divergence) => divergence.kind === 'both');
    if (unknown.length === 0) {
        return { kind: 'unextracted' };
    }
    return { kind: 'patchset-side', text: patchsetSideText(unknown) };
}
/**
 * The dirt the guard sees is the commits and nothing else (D11's boundary): no
 * upstream path, no own divergence that carries work. Only then may `--discard`
 * answer the refusal, because everything it did not ask about is clean.
 */
function commitsOnlyDirt(drift) {
    return (drift.upstream.length === 0 &&
        drift.own.every((divergence) => divergence.kind === 'patchset-only') &&
        drift.extensions.every((divergence) => divergence.kind === 'patchset-only'));
}
/**
 * The discard's precondition (the D6 discipline, phrased for D11): the rebuild
 * is about to make the commits unreachable, so the set judged droppable must
 * still be exactly the set present. A commit that appeared in between is work
 * nobody asked to drop, and burying it is the failure mode the flag exists to
 * make impossible.
 */
function assertDiscardSetHeld(selected, current) {
    const held = new Set(current.commits.map((commit) => commit.sha));
    const same = selected.commits.length === current.commits.length && selected.commits.every((commit) => held.has(commit.sha));
    if (same) {
        return;
    }
    throw ckError('INTERNAL', `the fork tree changed during load --discard: ${current.commits.length} commit(s) not in patchset now, ${selected.commits.length} when the run started`, 'nothing was rebuilt and nothing was discarded; re-run codkit load --discard over the new state');
}
/**
 * The paths of a diagnostic about own code are paths in the delta, and the delta
 * addresses an owned directory by its role (##OWN-ROOTS-IN-THE-DELTA): the own
 * root is `delta/own/`, every other owned directory is `delta/own-roots/<role>/`.
 * A message that spelled the first one for all of them sent the reader to a
 * directory that does not hold the file.
 */
function deltaPathOf(entry) {
    return `${entry.owned.deltaDir}/${entry.relative}`;
}
function patchsetSideText(changed) {
    const names = changed.map(deltaPathOf).join(', ');
    return `own code was edited in patchset since this tree was last synced (${names}); the patchset version is being applied over the tree`;
}
/** The one diagnostic both `load` and `save` raise for a two-sided own edit. */
export function bothSidesError(entry) {
    return ckError('BOTH-SIDES-EDITED', 'own code was edited in patchset and in the fork tree, in different ways', 'resolve manually: keep one side, then codkit load/save', deltaPathOf(entry));
}
/**
 * The branch-relative paths this build supplies from the own layer, extensions
 * included. `ci` uses them to recognise its own generated own-code findings
 * (##OWN-EXTENSION-UNIT: an own extension is committed on the generated branch
 * exactly like own code).
 */
function generatedOwnPathsOf(evidence) {
    return [...evidence.ownTargets, ...evidence.extensionTargets];
}
function reportOwn(out, own) {
    out.info(`own code: ${own.total} file(s), ${own.copied} copied, ${own.removed} removed`);
}
/**
 * ##OWN-EXTENSION-UNIT: said only when the layer is in use. A patchset without
 * own extensions would otherwise get a line about nothing on every load.
 */
function reportOwnExtensions(out, report) {
    if (report.total === 0 && report.removed === 0) {
        return;
    }
    out.info(`own extensions: ${report.total} file(s), ${report.copied} copied, ${report.removed} removed`);
}
/**
 * The extensions the manifest declares. Read at the point of use rather than
 * carried through the option types: the manifest is already parsed by the
 * ownership preflight of this run, so a broken one has stopped it long before.
 */
function declaredOwnExtensions(patchesDir) {
    return loadOwnManifest(patchesDir).extensions;
}
/**
 * The `isStrandedExtension` predicate of the guard, in the shape the guard asks
 * in (##DRIFT-GUARD-PREDICATE, the stranded exception).
 *
 * A manifest that does not parse declares nothing here rather than throwing:
 * the guard runs before the plan is built and has to reach a verdict even over
 * a repository somebody left half-edited, exactly as the rest of the predicate
 * does; the parse failure is named a few steps later by the code whose subject
 * it is.
 */
function strandedExtensionHook(materializer, patchesDir, treeDir, pinSha) {
    let declared = [];
    try {
        declared = declaredOwnExtensions(patchesDir);
    }
    catch {
        declared = [];
    }
    const classify = strandedExtensionClassifier(materializer, treeDir, pinSha, declared);
    return (entry) => classify(entry.path);
}
/**
 * The variable context of the config-overlay layer (PROP-005 ##OVERLAY-VARS).
 * Exported because `overlay apply|check` materializes the same values outside a
 * load, and two definitions of `build.date` would be one too many.
 */
export function overlayVarContext(config, pinDateIso, patchSetCommit) {
    return {
        pinTag: config.pin.tag ?? '',
        pinSha: config.pin.sha,
        pinDate: config.pin.date,
        patchSetCommit,
        // Deterministic by construction: the wall clock would make the dev
        // channel differ between two runs of the same load.
        buildDate: pinDateIso
    };
}
function result(status, exitCode, parts) {
    const changedPaths = parts.changedPaths ?? [];
    return {
        exitCode,
        status,
        branch: parts.branch,
        branchTip: parts.branchTip ?? null,
        artifacts: parts.artifacts ?? 0,
        own: parts.own ?? NO_OWN,
        cleaned: parts.cleaned ?? 0,
        changedFiles: changedPaths.length,
        changedPaths,
        nonPatchTargets: parts.nonPatchTargets ?? [],
        generatedOwnPaths: parts.generatedOwnPaths ?? [],
        dirtyFiles: parts.dirtyFiles ?? [],
        broken: parts.broken ?? [],
        discarded: parts.discarded ?? [],
        discardedRef: parts.discardedRef ?? null,
        discardedPaths: parts.discardedPaths ?? [],
        fastPathReason: parts.fastPathReason ?? null,
        restoredBytes: parts.restoredBytes ?? [],
        inputs: parts.inputs ?? []
    };
}
/** git takes forward slashes on every platform; paths in argv are converted. */
export function toPosix(path) {
    return path.split('\\').join('/');
}
/** The generated branch of a pin; the command names it in its output. */
export function generatedBranchName(config) {
    return `${config.generatedBranchPrefix}${pinKey(config.pin)}`;
}
