/** @scope spec://codkit/modules/codkit/PROP-008#PATCHSET-MOVED-RULE */
// The patch-set side of a loaded tree: what it was loaded from, and whether
// the delta moved under it (PROP-008 ##LINEAGE-CHECK, ##PATCHSET-MOVED-RULE;
// campaign TREE-COMMITS-SAVE, decisions D16-D18).
//
// A tree is loaded from one state of patchset and stays honest only while
// patchset still carries that state. When it stops - somebody edited an
// artifact, or switched the branch - `save` would extract the tree's work
// into a delta that no longer describes the tree: the rebuild then rewrites
// tree files from the shifted artifacts (the H1 defect, spike S0.7: a
// CK-E-INTERNAL after the ref had already moved and a file had been
// rewritten), or buries a patchset-side edit under an artifact regenerated
// from the tree. Both halves of the question are answerable before anything
// is written:
//
//   * lineage (D17) - the `Codkit-Patchset-Commit` trailer of the base commit
//     names the patchset state the load represented; a sha that stopped being
//     an ancestor of patchset HEAD belongs to a state the checkout no longer
//     carries;
//   * bytes (D16) - the mark's artifact map records every delta file outside
//     `delta/own/` as of the load; a *patch* artifact whose bytes differ moved
//     on the patchset side, whatever commit - or lack of one - explains it.
//     (The other layers are authored in patchset alone and materialize into
//     the tree by design, so their movement is not a refusal - see
//     classifyTargets.)
//
// One thing a byte difference alone cannot say is who moved the artifact:
// codkit's own earlier partial extraction (a scoped save, an interrupted
// replay) also writes artifacts without rewriting the mark. Those writes are
// recognized by what they are - bytes that reproduce one of the tree's own
// states - and do not count as movement against the tree; everything else
// does. A mark without the map (written before it existed) cannot answer the
// byte question at all and says so instead of guessing (R13).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesEqual, encodeUtf8 } from './bytes.js';
import { applyUnified } from './applyUnified.js';
import { loadConventions } from './conventionsFile.js';
import { deltaArtifactMap, deltaFingerprint, listDeltaFiles } from './fingerprint.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
import { encodePatchName, parseCkpatch } from './patchFormat.js';
import { bytesOf, changesSince } from './treeState.js';
/** Where the patch artifacts live, relative to the patchset root (PROP-004 sec. 4). */
const PATCHES_DIR = 'delta/patches';
/** The trailer of a generated commit: the patchset state it was built from (F13). */
const PATCHSET_COMMIT_TRAILER = 'Codkit-Patchset-Commit';
/** How many moved artifacts a refusal lists before summarizing the rest. */
const MOVED_LIST_LIMIT = 5;
/**
 * The patchset state this tree was loaded from. ##TREE-IS-TRUTH: the branch,
 * not the mark, is the record, so the trailer of the base commit answers
 * first; the mark field speaks only when there is no generated commit at all
 * (the empty patchset of a first load, F19), where no trailer exists to read.
 */
export function loadedFrom(input) {
    const { treeDir, base, pinSha, mark } = input;
    const raw = base === pinSha ? (mark?.patchSetCommit ?? null) : baseTrailer(treeDir, base);
    if (raw === 'dirty') {
        return { kind: 'dirty' };
    }
    if (raw === 'none') {
        return { kind: 'none' };
    }
    if (raw !== null && /^[0-9a-f]{40}$/.test(raw)) {
        return { kind: 'sha', sha: raw };
    }
    return { kind: 'unnamed' };
}
/** The label of the status line (D10): short sha, `dirty`, `none`, `unknown`. */
export function loadedFromLabel(from) {
    switch (from.kind) {
        case 'sha':
            return from.sha.slice(0, 8);
        case 'dirty':
            return 'dirty';
        case 'none':
            return 'none';
        default:
            return 'unknown';
    }
}
/**
 * D17: the loaded-from sha must still be an ancestor of patchset HEAD. Any
 * exit but 0 - a different line, or a sha this checkout does not even carry -
 * means the tree's work belongs to a state patchset no longer has.
 */
export function checkLineage(patchesDir, sha) {
    const verdict = runGit({ args: ['merge-base', '--is-ancestor', sha, 'HEAD'], cwd: patchesDir });
    if (verdict.status === 0) {
        return { ok: true };
    }
    const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: patchesDir });
    return { ok: false, head: head.status === 0 ? head.stdout.trim() : null };
}
// ---------------------------------------------------------------------------
// The artifact map and its classification (D16)
// ---------------------------------------------------------------------------
/**
 * sha256 of every delta file outside `delta/own/`, by its patchset-relative
 * path - the mark's `artifacts` map read off the current patchset. The filter
 * itself is the single definition the mark's writer uses (##TREE-MARK), so
 * the two sides of the comparison can never disagree about what counts.
 */
export function artifactMapOf(patchesDir) {
    const files = {};
    for (const file of listDeltaFiles(patchesDir)) {
        files[file.path] = file.sha256;
    }
    return deltaArtifactMap(files);
}
export function classifyTargets(input) {
    const marked = input.mark?.artifacts ?? null;
    if (marked === null) {
        return {
            treeOnly: [],
            patchsetOnly: [],
            both: [],
            unknown: true,
            fingerprintMatches: input.mark !== null && input.mark.deltaFingerprint === deltaFingerprint(input.patchesDir, input.pinSha)
        };
    }
    const current = artifactMapOf(input.patchesDir);
    // Only the patch layer can move "under" a save. The other delta layers are
    // authored in patchset alone and reach the tree by materialization, which
    // the rebuild performs by design (##SAVE-EXTRACTS-TWO-LAYERS): a
    // hand-written resource between two saves is the documented procedure, and
    // its rewrite of the tree is explained, not foreign. A shifted *patch*
    // artifact is the dangerous case - the rebuild would apply it to a file the
    // tree's work belongs to (the H1 defect) - so that is the refusal set.
    const moved = new Set([...new Set([...Object.keys(current), ...Object.keys(marked)])]
        .filter((path) => path.startsWith(`${PATCHES_DIR}/`))
        .filter((path) => (current[path] ?? null) !== (marked[path] ?? null)));
    // The tree side, as the selection of a save reads it (D4): the worktree's
    // final state against the same base, target paths keyed by their artifact.
    const targetByArtifact = new Map();
    for (const change of changesSince(input.treeDir, input.base, { kind: 'worktree' }, input.roots)) {
        targetByArtifact.set(`${PATCHES_DIR}/${encodePatchName(change.path)}`, change.path);
    }
    const treeOnly = [];
    const patchsetOnly = [];
    const both = [];
    for (const path of moved) {
        const target = targetByArtifact.get(path) ?? null;
        if (target === null) {
            // No patch artifact of a tree-changed target sits here: the overlay,
            // resource, rule and registry layers are authored in patchset only
            // (D16), and a patch whose target the tree did not touch moved on the
            // patchset side alone.
            patchsetOnly.push(path);
            continue;
        }
        if (reproducesTreeState(input, target, path)) {
            // Codkit's own earlier extraction: a scoped save or an interrupted
            // replay wrote these bytes from this very tree without rewriting the
            // mark. Movement of the tree, not against it.
            treeOnly.push(path);
            continue;
        }
        both.push(path);
    }
    // The rest of the tree's side: targets the selection names whose artifacts
    // still match the mark - the ordinary extraction set of the run to come.
    for (const [artifact] of targetByArtifact) {
        if (!moved.has(artifact) && (artifact in current || artifact in marked)) {
            treeOnly.push(artifact);
        }
    }
    return {
        treeOnly: byteSorted(treeOnly),
        patchsetOnly: byteSorted(patchsetOnly),
        both: byteSorted(both),
        unknown: false,
        fingerprintMatches: true
    };
}
/** The refusal set of D18: everything the patch set moved under the tree. */
export function movedArtifactsOf(classes) {
    if (classes.unknown) {
        return [];
    }
    return byteSorted([...classes.patchsetOnly, ...classes.both]);
}
/** The CK-E-PATCHSET-MOVED refusal: sha of the load, moved artifacts, recipe (D18). */
export function patchsetMovedError(input) {
    const lines = [];
    if (input.lineageHead !== null && input.loaded.kind === 'sha') {
        lines.push(`the tree was loaded from patchset commit ${input.loaded.sha.slice(0, 8)}, which is not an ancestor of patchset HEAD ` +
            (input.lineageHead === null ? 'that no longer resolves' : input.lineageHead.slice(0, 8)) +
            "; the tree's work belongs to that state");
    }
    if (input.moved.length > 0) {
        const listed = input.moved.slice(0, MOVED_LIST_LIMIT).join(', ');
        const more = input.moved.length > MOVED_LIST_LIMIT ? ` +${input.moved.length - MOVED_LIST_LIMIT} more` : '';
        lines.push(`${input.moved.length} patch artifact(s) differ from the state the tree was loaded from (${loadedPhrase(input.loaded)}): ${listed}${more}`);
    }
    return ckError('PATCHSET-MOVED', lines.join('; '), recipeHint(input.loaded));
}
/** How a message names the loaded state: the sha when there is one. */
function loadedPhrase(loaded) {
    switch (loaded.kind) {
        case 'sha':
            return `patchset commit ${loaded.sha.slice(0, 8)}`;
        case 'dirty':
            return 'an uncommitted patchset state';
        case 'none':
            return 'a patchset without a HEAD';
        default:
            return 'a state the mark does not name';
    }
}
/**
 * The CK-E-BOTH-SIDES-EDITED refusal of the two-way `sync` (PROP-008 sec. 5a
 * ##SYNC-TWO-PASS; the generalization of F20's own-code refusal to the whole
 * patch layer): the file, both its sides, and the manual recipe that chooses
 * one - never a merge. Taking the tree means restoring the artifact to the
 * loaded state and letting `save` regenerate it; taking the patch set means
 * reverting the tree edit.
 */
export function bothSidesConflictError(sides, restoreRef) {
    const list = sides.map((side) => `${side.artifact} (target ${side.target})`).join(', ');
    const first = sides[0];
    return ckError('BOTH-SIDES-EDITED', `the fork tree and the patch set both changed ${sides.length} target(s) since the last load: ${list}`, 'choose a side by hand - take the tree: ' +
        `git checkout ${restoreRef} -- ${first?.artifact ?? '<artifact>'} in the patchset, then codkit save; ` +
        `take the patch set: revert the tree's edit of ${first?.target ?? '<target>'}, then codkit sync`, first?.artifact);
}
/** How many paths each dry-run list prints before summarizing the rest. */
const PLAN_LIST_LIMIT = 5;
/**
 * The classification a `codkit sync --dry-run` prints (D15): what each side
 * would contribute. The tree side is named by its selection - the changed
 * paths, whether or not an artifact exists for them yet - because that is the
 * set the run extracts.
 */
export function reportSyncPlan(out, classes, treeCommitCount, changedPaths) {
    out.info(`sync plan: ${treeCommitCount} tree commit(s) to replay, ${changedPaths.length} changed file(s) to extract, ` +
        `${classes.patchsetOnly.length} patchset-side artifact(s) to apply, ${classes.both.length} on both sides`);
    planList(out, 'extract from the tree', changedPaths);
    planList(out, 'apply from the patch set', classes.patchsetOnly);
    planList(out, 'materialize (both sides)', classes.both);
}
function planList(out, label, paths) {
    if (paths.length === 0) {
        out.info(`  ${label}: none`);
        return;
    }
    out.info(`  ${label}: ${paths.slice(0, PLAN_LIST_LIMIT).join(', ')}${paths.length > PLAN_LIST_LIMIT ? ` +${paths.length - PLAN_LIST_LIMIT} more` : ''}`);
}
/**
 * The manual merge recipe of D18, exactly the four steps: return the delta to
 * the loaded state, save, bring the shift back, load - and, since Phase 8 of
 * the campaign, the one-command form that performs all four: the two-way
 * `codkit sync`, which accepts the shift instead of refusing it.
 */
function recipeHint(loaded) {
    const restore = loaded.kind === 'sha'
        ? `git stash, or git switch <branch>, or git checkout ${loaded.sha} -- delta/`
        : 'git stash, or git switch <branch>, or git checkout <sha> -- delta/';
    return (`manual merge: (1) return the delta to the loaded state (${restore}); ` +
        '(2) codkit save; (3) bring the shift back (git stash pop, git merge, or git rebase); (4) codkit load; ' +
        'codkit sync performs all four in one command');
}
// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
/** The `Codkit-Patchset-Commit` trailer of one commit, or null when there is none. */
function baseTrailer(treeDir, base) {
    const result = runGit({
        args: ['log', '-1', `--format=%(trailers:key=${PATCHSET_COMMIT_TRAILER},valueonly)`, base],
        cwd: treeDir
    });
    if (result.status !== 0) {
        return null;
    }
    const value = result.stdout.trim();
    return value === '' ? null : value;
}
/**
 * Whether the artifact on disk reproduces one of the tree's own states of its
 * target: the worktree's final state, or the state one of the foreign commits
 * holds. Those are exactly the bytes codkit's extraction writes; bytes that
 * match none of them were authored on the patchset side.
 */
function reproducesTreeState(input, target, artifactPath) {
    let bytes;
    try {
        bytes = readFileSync(join(input.patchesDir, ...artifactPath.split('/')));
    }
    catch {
        // The artifact is gone from patchset (a removal half of the movement):
        // absent bytes reproduce nothing.
        return false;
    }
    let applied;
    try {
        applied = applyUnified(pinBytesOf(input.treeDir, input.pinSha, target) ?? new Uint8Array(0), parseCkpatch(bytes, loadConventions(input.type, input.patchesDir), artifactPath));
    }
    catch {
        // An artifact that does not even apply against the pin is not a state
        // this tree produced; whatever moved it, it moved.
        return false;
    }
    const states = [
        { kind: 'worktree' },
        ...input.commits.map((commit) => ({ kind: 'commit', sha: commit.sha }))
    ];
    for (const state of states) {
        try {
            if (bytesEqual(applied, bytesOf(input.treeDir, state, target))) {
                return true;
            }
        }
        catch {
            // The path is absent from this state (a deletion half, a not-yet
            // file): it simply cannot be the match.
            continue;
        }
    }
    return false;
}
/** The target as the pin carries it, or null when the pin does not have it. */
export function pinBytesOf(treeDir, pinSha, target) {
    const shown = runGit({ args: ['show', `${pinSha}:${target}`], cwd: treeDir });
    return shown.status === 0 ? encodeUtf8(shown.stdout) : null;
}
/** UTF-8 byte order, the ordering every path list in codkit uses. */
function byteSorted(paths) {
    return [...paths].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}
