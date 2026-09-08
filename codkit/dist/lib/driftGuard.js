/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The drift guard (PROP-008 ##DRIFT-GUARD-PREDICATE).
//
// Destructive commands (`load`, `cycle start`, `ci`, `publish`, `clone` over an
// existing tree, `restart`) refuse to run over work that was never extracted
// back into patchset. The predicate has three halves, and it needs all of them:
//
//   (a) `git status --porcelain` outside the own directory - edits to upstream
//       files, which git can see because those files are tracked;
//   (b) a byte comparison of the tree's own directory against `delta/own/` -
//       edits to own code, which git cannot see, because locally the own
//       directory is excluded (##OWN-EXCLUDED-LOCALLY: the managed block of
//       info/exclude in a single-worktree repository, the worktree-local
//       exclude file in a multi-worktree one);
//   (c) the foreign commits of ##TREE-COMMITS-ARE-WORK - commits of the tree's
//       first-parent line above the last generated tip, which both other halves
//       are blind to: git status reports a clean tree over a commit, and own
//       code says nothing about upstream files.
//
// Half (b) is not an optimization: without it every change to own code in the
// tree would be silently overwritten by the next load. Neither is half (c):
// without it the next load would rebuild the branch over a commit and leave the
// work reachable only through the reflog.
//
// One refinement of the literal predicate: an own file that exists in patchset and
// not in the tree is *not* dirt. It is own code that has not been materialized
// yet - the state of every tree before its first load - and nothing in the tree
// can be lost by writing it. Only the two classes that carry work (a file the
// tree has and patchset does not, and a file both sides have with different bytes)
// stop a destructive command.
//
// A second refinement (##OVERLAY-KNOWN-MATERIALIZATION): a *tracked* path the
// caller can certify as a state codkit itself wrote - today the strict overlay
// composition of `overlay apply` - is not unextracted work either, provided the
// calling run is the one that replaces it. The guard itself stays generic: it
// accepts a predicate and asks it about tracked paths only, so the classification
// lives with the layer that can actually prove it. `load --fresh` is the only
// caller (an ordinary `load` may answer the fast path "up to date" and leave the
// bytes in place, which is exactly what a silent exemption must not do); `ci`
// deliberately passes none (see the sync engine).
//
// A third refinement, the other way round (##OWN-EXTENSION-STRANDED): an
// *untracked* top-level directory under `extensions/` that no manifest record
// declares and the pin does not ship is the materialization of an own extension
// somebody withdrew. A plain `load` neither writes into it nor removes it, so
// refusing over it guarded nothing and locked the daily command after a legal
// change of the patch set; `status` names the directory instead, with the
// `--fresh` pass that removes it. Again a predicate, again supplied by exactly
// one caller: every other guarded command keeps the rule about a new file in
// the upstream zone.
import { runGit } from './gitx.js';
import { EXTENSIONS_TREE_DIR, OWN_EXTENSIONS_DIR, compareOwnExtensions, ownExtensionTreePrefixes } from './layers/ownExtensions.js';
import { loadOwnManifest } from './layers/ownManifest.js';
import { ckError } from './messages.js';
import { OWN_SOURCE_DIR, compareOwn, ownTargetRelativeDir } from './ownCopy.js';
import { foreignCommits } from './treeCommits.js';
/** Marker appended to own-code entries of the list. */
export const OWN_DIVERGENCE_NOTE = 'own code differs from';
export function driftDirty(treeDir, ownDirName, patchesDir, options) {
    const declared = declaredExtensions(patchesDir);
    const upstream = upstreamDirt(treeDir, ownDirName, { ...options, ownedPrefixes: ownExtensionTreePrefixes(declared) });
    const own = compareOwn(patchesDir, treeDir, ownDirName);
    const extensions = compareOwnExtensions(patchesDir, treeDir, declared);
    const treeCommits = foreignCommits(treeDir, options.generated.pinSha, options.generated.branch);
    const ownPrefix = ownTargetRelativeDir(ownDirName);
    const files = [...upstream];
    for (const divergence of own) {
        if (divergence.kind === 'patchset-only') {
            continue;
        }
        const note = divergence.kind === 'tree-only'
            ? `own code is not in ${OWN_SOURCE_DIR}/${divergence.relative}`
            : `${OWN_DIVERGENCE_NOTE} ${OWN_SOURCE_DIR}/${divergence.relative}`;
        files.push(`${ownPrefix}/${divergence.relative} (${note})`);
    }
    for (const divergence of extensions) {
        if (divergence.kind === 'patchset-only') {
            continue;
        }
        const note = divergence.kind === 'tree-only'
            ? `own extension file is not in ${OWN_EXTENSIONS_DIR}/${divergence.relative}`
            : `${OWN_DIVERGENCE_NOTE} ${OWN_EXTENSIONS_DIR}/${divergence.relative}`;
        files.push(`extensions/${divergence.relative} (${note})`);
    }
    for (const commit of treeCommits.commits) {
        files.push(`commit ${commit.sha.slice(0, 8)} "${commit.subject}" (not in patchset)`);
    }
    return { dirty: files.length > 0, files, upstream, own, extensions, commits: treeCommits.commits, treeCommits };
}
/**
 * The extensions the delta declares, or none when the manifest cannot be read.
 *
 * A manifest that does not parse is a failure of its own - `verify` names it,
 * and every writing command stops on it before it touches the tree - and the
 * guard has no verdict to add. What it must not do is throw here: the guard is
 * the step that decides whether work is at risk, and it has to reach that
 * decision even over a repository somebody left half-edited.
 */
function declaredExtensions(patchesDir) {
    try {
        return loadOwnManifest(patchesDir).extensions;
    }
    catch {
        return [];
    }
}
/**
 * Half (a): what git sees, minus the own directory it is not allowed to judge,
 * minus the tracked paths the caller certified as its own known materialization,
 * minus the tracked paths the caller was told by name to throw away.
 */
export function upstreamDirt(treeDir, ownDirName, options = {}) {
    const status = runGit({ args: ['status', '--porcelain'], cwd: treeDir });
    if (status.status !== 0) {
        throw ckError('NOT-A-REPO', `git status failed in ${treeDir}: ${firstLine(status.stderr)}`, 'check that the fork tree is a healthy git work tree');
    }
    const untrackedIsDirt = options.untrackedIsDirt ?? true;
    const classify = options.isKnownMaterialization;
    const discardable = options.isDiscardable;
    const stranded = options.isStrandedExtension;
    const ownPrefix = `${ownTargetRelativeDir(ownDirName)}/`;
    const owned = [ownPrefix, ...(options.ownedPrefixes ?? [])];
    // The stranded question is asked per top-level directory of `extensions/`,
    // and a wholly untracked `extensions/` is one collapsed entry that hides
    // exactly those names - so the caller that can answer them gets the listing
    // opened up, the way a declared extension opens up its own prefix.
    const opened = [...(options.ownedPrefixes ?? []), ...(stranded === undefined ? [] : [`${EXTENSIONS_TREE_DIR}/`])];
    return (expandCollapsedUntracked(treeDir, porcelainEntries(status.stdout), opened)
        .filter((entry) => untrackedIsDirt || entry.status !== '??')
        // The known-state question is about tracked bytes only: an untracked
        // path carries no HEAD to differ from (and with `--fresh` it is the
        // whitelist, not an overlay, that speaks for it).
        .filter((entry) => classify === undefined || entry.status === '??' || !classify(entry.path))
        .filter((entry) => !owned.some((prefix) => entry.path.startsWith(prefix)))
        // The stranded question, over what the prefixes above left: a
        // declared extension is never asked about, and only an untracked
        // entry can be a materialization nobody owns any more.
        .filter((entry) => stranded === undefined || entry.status !== '??' || !stranded(entry))
        // The discard question comes last, and over what is left: a path the
        // own layer supplies is never the operator's to give up here, and an
        // untracked one has no tip version to be returned to.
        .filter((entry) => discardable === undefined || entry.status === '??' || !discardable(entry))
        .map((entry) => entry.path));
}
/**
 * Untracked paths git collapsed to a directory, opened up where they hide a
 * path another layer owns.
 *
 * `git status --porcelain` reports one line for a wholly untracked directory -
 * `extensions/` rather than `extensions/<name>/package.json` - and a prefix
 * filter cannot see through that: the materialized own extension would read as
 * unextracted work in the upstream zone (PROP-005 ##OWN-EXTENSION-UNIT). Only
 * an entry that is an ancestor of an owned prefix is re-listed, so a tree with
 * no own extensions gets exactly the listing it got before, and litter beside
 * the owned path keeps its own name and stays dirt.
 */
export function expandCollapsedUntracked(treeDir, entries, ownedPrefixes) {
    if (ownedPrefixes.length === 0) {
        return entries;
    }
    const out = [];
    for (const entry of entries) {
        if (entry.status !== '??' || !entry.path.endsWith('/') || !ownedPrefixes.some((prefix) => prefix.startsWith(entry.path))) {
            out.push(entry);
            continue;
        }
        const listed = runGit({ args: ['status', '--porcelain', '-z', '-uall', '--', entry.path], cwd: treeDir });
        if (listed.status !== 0) {
            out.push(entry);
            continue;
        }
        out.push(...porcelainZEntries(listed.stdout));
    }
    return out;
}
/**
 * `git status --porcelain` v1. For a rename the new path is the one that
 * matters; `core.quotepath=false` (forced by gitx) keeps non-ASCII names
 * unquoted.
 */
export function porcelainEntries(stdout) {
    const entries = [];
    for (const line of stdout.split('\n')) {
        if (line.length < 4) {
            continue;
        }
        const rest = line.slice(3);
        const arrow = rest.indexOf(' -> ');
        entries.push({ status: line.slice(0, 2), path: unquote(arrow === -1 ? rest : rest.slice(arrow + 4)) });
    }
    return entries;
}
export function porcelainPaths(stdout) {
    return porcelainEntries(stdout).map((entry) => entry.path);
}
/**
 * `git status --porcelain -z`: records are NUL-terminated and never quoted, so
 * a path with a space, a quote or a newline in it survives the round trip. A
 * rename or copy is two records - the new path first, the old one right after -
 * and only the new path is a subject for `save`.
 *
 * This is the form the writing commands use; the plain parser above stays for
 * the guard, which only ever looks at names.
 */
export function porcelainZEntries(stdout) {
    const fields = stdout.split('\0');
    const entries = [];
    for (let index = 0; index < fields.length; index += 1) {
        const record = fields[index];
        if (record === undefined || record.length < 4) {
            continue;
        }
        const status = record.slice(0, 2);
        entries.push({ status, path: record.slice(3) });
        if (status.startsWith('R') || status.startsWith('C')) {
            // The source path of the rename follows in its own field.
            index += 1;
        }
    }
    return entries;
}
function unquote(path) {
    return path.length >= 2 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}
function firstLine(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
        return 'no output';
    }
    const [line] = trimmed.split('\n');
    return line ?? 'no output';
}
