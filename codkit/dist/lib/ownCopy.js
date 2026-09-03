/** @scope spec://codkit/modules/codkit/PROP-008#root */
// Copying own code between patchset and the fork tree (PROP-008 ##OWN-COPY-ALGORITHM).
//
// `delta/own/**` is the source of truth; `<tree>/src/vs/<ownDirName>/**` is a
// materialization of it (PROP-005 ##OWN-SOURCE-OF-TRUTH). The copy is rsync-like
// and content-addressed on purpose:
//
//   * a file is written only when its bytes differ, so mtime of untouched files
//     never moves and the watch daemons do not restart a build for nothing
//     (##MTIME-DISCIPLINE);
//   * mtime is never a criterion for "changed" - a checkout rewrites mtimes
//     without changing content, and trusting it would copy the whole tree;
//   * files missing on the source side are deleted on the target side, and the
//     directories they emptied are removed.
//
// The same listing is used by the drift guard, which compares the two sides
// without writing: locally the own directory is excluded from git, so byte
// comparison is the only thing that can see a change in it.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bytesEqual } from './bytes.js';
import { OWN_MANIFEST_NAME } from './layers/ownManifest.js';
import { ckError } from './messages.js';
import { resolveContainedPath, safeBasenameProblem } from './pathSafety.js';
/** Own code inside patchset, relative to the patchset root. */
export const OWN_SOURCE_DIR = 'delta/own';
/** Placeholder that only exists to keep an empty directory in git. */
export const GITKEEP_NAME = '.gitkeep';
/**
 * Whether a file under `delta/own/` is own code that the tree receives.
 *
 * Two kinds of file live there and are not delivered: the placeholders git
 * needs to carry an empty directory, and the unit manifest. The manifest is a
 * statement of patchset *about* own code, not a module of it (PROP-005 sec. 3), and
 * mirroring it would materialize it in `src/vs/<ownDirName>/`, from where the
 * transpiler of the tree carries it into `out/` as if it were product code.
 *
 * The same predicate governs the comparison of the two sides: a file that is
 * never copied must never be missed in the tree either, or the drift guard
 * would read its absence as unextracted work.
 */
export function isDeliveredOwnFile(relative) {
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    return name !== GITKEEP_NAME && name !== OWN_MANIFEST_NAME;
}
export function ownSourceRoot(patchesDir) {
    return join(patchesDir, ...OWN_SOURCE_DIR.split('/'));
}
export function ownTargetRelativeDir(ownDirName) {
    return `src/vs/${ownDirName}`;
}
export function ownTargetRoot(treeDir, ownDirName) {
    return join(treeDir, 'src', 'vs', ownDirName);
}
/**
 * Relative POSIX paths of every file under `root`, sorted.
 *
 * `refuseSymlinks` is set for the patchset side: a symlink in own code would make
 * the delta depend on something outside the repository, so it is refused rather
 * than followed. The listing is raw - everything that is there, including the
 * files `isDeliveredOwnFile` excludes - because `verify` and the inventory read
 * the manifest and the placeholders as content of patchset.
 */
export function listOwnFiles(root, options) {
    const out = [];
    walk(root, '', out, options.refuseSymlinks);
    out.sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    return out;
}
/** Byte equality with a size fast path; mtime is deliberately not consulted. */
export function fileContentEqual(left, right) {
    let leftSize;
    let rightSize;
    try {
        leftSize = statSync(left).size;
        rightSize = statSync(right).size;
    }
    catch {
        return false;
    }
    if (leftSize !== rightSize) {
        return false;
    }
    return bytesEqual(readFileSync(left), readFileSync(right));
}
/** Paths (relative to the own root) that differ between patchset and the tree. */
export function compareOwn(patchesDir, treeDir, ownDirName) {
    const source = ownSourceRoot(patchesDir);
    const target = ownTargetRoot(treeDir, ownDirName);
    assertOwnRootsSafe(patchesDir, treeDir, ownDirName);
    const sourceFiles = listOwnFiles(source, { refuseSymlinks: true }).filter(isDeliveredOwnFile);
    const targetFiles = listOwnFiles(target, { refuseSymlinks: true }).filter(isDeliveredOwnFile);
    const diverged = [];
    const targetSet = new Set(targetFiles);
    for (const relative of sourceFiles) {
        if (!targetSet.has(relative)) {
            diverged.push({ relative, kind: 'patchset-only' });
            continue;
        }
        if (!fileContentEqual(join(source, relative), join(target, relative))) {
            diverged.push({ relative, kind: 'both' });
        }
    }
    const sourceSet = new Set(sourceFiles);
    for (const relative of targetFiles) {
        if (!sourceSet.has(relative)) {
            diverged.push({ relative, kind: 'tree-only' });
        }
    }
    diverged.sort((left, right) => Buffer.from(left.relative, 'utf8').compare(Buffer.from(right.relative, 'utf8')));
    return diverged;
}
/**
 * patchset -> tree, the direction `sync` uses.
 *
 * The target side is listed raw, so that a file the tree carries and patchset does
 * not is removed. That is also how a manifest an older sync materialized leaves
 * the tree: it is no longer copied, so the next run finds it in the mirror
 * without a source and deletes it like any other leftover.
 */
export function syncOwnCode(patchesDir, treeDir, ownDirName) {
    const source = ownSourceRoot(patchesDir);
    const target = ownTargetRoot(treeDir, ownDirName);
    // Validate both complete trees before the first copy/delete. In particular, a
    // symlink on the materialized side must not redirect a later write outside the
    // fork tree, and a symlink found after one copy must not leave a partial sync.
    assertOwnRootsSafe(patchesDir, treeDir, ownDirName);
    const sourceFiles = listOwnFiles(source, { refuseSymlinks: true }).filter(isDeliveredOwnFile);
    const targetFiles = listOwnFiles(target, { refuseSymlinks: true });
    let copied = 0;
    for (const relative of sourceFiles) {
        const from = join(source, relative);
        const to = join(target, relative);
        if (fileContentEqual(from, to)) {
            continue;
        }
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
        copied += 1;
    }
    let removed = 0;
    const keep = new Set(sourceFiles);
    const emptied = new Set();
    for (const relative of targetFiles) {
        if (keep.has(relative)) {
            continue;
        }
        rmSync(join(target, relative), { force: true });
        removed += 1;
        collectAncestors(relative, emptied);
    }
    pruneEmptyDirectories(target, emptied);
    return { copied, removed, total: sourceFiles.length };
}
/** Version of the canonical string of ownFingerprint; part of the hashed input. */
const OWN_FINGERPRINT_SCHEMA_VERSION = 1;
/**
 * The own state as patchset holds it. Recorded in the tree mark by every sync and
 * save (PROP-006 ##TREE-MARK) so that the next run can tell, file by file, which
 * side moved: a file equal to the mark did not change on that side.
 *
 * It is taken from `delta/own/` and not from the tree, because immediately after
 * the copy the two sides are identical by construction and patchset is the source
 * of truth (PROP-005 ##OWN-SOURCE-OF-TRUTH).
 */
export function ownStateOfPatchSet(patchesDir) {
    assertContainedOwnRoot(patchesDir, OWN_SOURCE_DIR, 'own source');
    return ownStateOf(ownSourceRoot(patchesDir));
}
export function ownStateOfTree(treeDir, ownDirName) {
    assertSafeOwnDirName(ownDirName);
    assertContainedOwnRoot(treeDir, ownTargetRelativeDir(ownDirName), 'materialized own target');
    return ownStateOf(ownTargetRoot(treeDir, ownDirName));
}
/**
 * The state of one side. Both sides are read through the same filter: a file
 * that is not delivered is not part of the comparison on either side, so it can
 * never be classified as "one of the sides moved it".
 */
function ownStateOf(root) {
    const relatives = listOwnFiles(root, { refuseSymlinks: true }).filter(isDeliveredOwnFile);
    const files = {};
    const hash = createHash('sha256');
    for (const relative of relatives) {
        const sha = sha256File(join(root, relative));
        files[relative] = sha;
        hash.update(`${relative}\n${sha}\n`, 'utf8');
    }
    hash.update(`schema ${OWN_FINGERPRINT_SCHEMA_VERSION}\n`, 'utf8');
    return { files, fingerprint: hash.digest('hex') };
}
function sha256File(absolute) {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}
/**
 * Classify every own file by which side moved. `markFiles` is the map the tree
 * mark recorded at the last sync; null means "the map is unknown" - migration
 * from a mark written before the map existed - and every difference then falls
 * into `unknown` rather than being guessed at.
 */
export function classifyOwn(patchesDir, treeDir, ownDirName, markFiles) {
    const patchset = ownStateOfPatchSet(patchesDir).files;
    const tree = ownStateOfTree(treeDir, ownDirName).files;
    const paths = [...new Set([...Object.keys(patchset), ...Object.keys(tree)])].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    const out = [];
    for (const relative of paths) {
        const inPatchSet = patchset[relative] ?? null;
        const inTree = tree[relative] ?? null;
        out.push({ relative, kind: classifyOne(inPatchSet, inTree, markFiles, relative), patchset: inPatchSet, tree: inTree });
    }
    return out;
}
function classifyOne(inPatchSet, inTree, markFiles, relative) {
    if (inPatchSet === inTree) {
        return 'same';
    }
    if (markFiles === null) {
        return 'unknown';
    }
    const marked = markFiles[relative] ?? null;
    const patchsetMoved = inPatchSet !== marked;
    const treeMoved = inTree !== marked;
    if (patchsetMoved && treeMoved) {
        return 'both-edited';
    }
    return patchsetMoved ? 'patchset-edited' : 'tree-edited';
}
/**
 * tree -> patchset, the direction `save` uses (##OWN-COPY-ALGORITHM, reversed).
 *
 * Only the files the tree moved are mirrored: `save` extracts work out of the
 * tree, and a file that only patchset changed would otherwise be overwritten by a
 * tree that is simply out of date. A file both sides changed never reaches this
 * function - the caller stops at CK-E-BOTH-SIDES-EDITED before anything is
 * written.
 */
export function mirrorOwnBack(patchesDir, treeDir, ownDirName, classes) {
    const source = ownTargetRoot(treeDir, ownDirName);
    const target = ownSourceRoot(patchesDir);
    let copied = 0;
    let removed = 0;
    let kept = 0;
    const emptied = new Set();
    for (const entry of classes) {
        if (entry.kind === 'same') {
            continue;
        }
        if (entry.kind === 'patchset-edited') {
            kept += 1;
            continue;
        }
        // 'tree-edited', and 'unknown': without a map the tree is what `save` is
        // asked to extract, which is the behaviour codkit had before the map.
        if (entry.tree === null) {
            rmSync(join(target, entry.relative), { force: true });
            removed += 1;
            collectAncestors(entry.relative, emptied);
            continue;
        }
        const from = join(source, entry.relative);
        const to = join(target, entry.relative);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
        copied += 1;
    }
    // The own root of patchset is a directory of the repository; only the
    // directories a removal emptied are pruned, never the root itself.
    pruneEmptyDirectoriesBelow(target, emptied);
    const total = classes.filter((entry) => (entry.kind === 'patchset-edited' ? entry.patchset !== null : entry.tree !== null)).length;
    return { copied, removed, kept, total };
}
function walk(absoluteDir, relativeDir, into, refuseSymlinks) {
    let entries;
    try {
        entries = readdirSync(absoluteDir, { withFileTypes: true });
    }
    catch {
        // An absent own directory on either side is a legal state: patchset may not
        // have own code yet, and the tree may never have been synced.
        return;
    }
    for (const entry of entries) {
        const absolute = join(absoluteDir, entry.name);
        const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isSymbolicLink()) {
            if (refuseSymlinks) {
                throw ckError('ARTIFACT-BROKEN', `symlinks are not allowed in own code: ${OWN_SOURCE_DIR}/${relative}`, 'replace the symlink with the file itself; own code must be self-contained in patchset', `${OWN_SOURCE_DIR}/${relative}`);
            }
            if (isDirectory(absolute)) {
                walk(absolute, relative, into, refuseSymlinks);
                continue;
            }
            into.push(relative);
            continue;
        }
        if (entry.isDirectory()) {
            walk(absolute, relative, into, refuseSymlinks);
            continue;
        }
        into.push(relative);
    }
}
function isDirectory(absolute) {
    try {
        return statSync(absolute).isDirectory();
    }
    catch {
        return false;
    }
}
function assertOwnRootsSafe(patchesDir, treeDir, ownDirName) {
    assertSafeOwnDirName(ownDirName);
    assertContainedOwnRoot(patchesDir, OWN_SOURCE_DIR, 'own source');
    assertContainedOwnRoot(treeDir, ownTargetRelativeDir(ownDirName), 'materialized own target');
}
function assertSafeOwnDirName(ownDirName) {
    const problem = safeBasenameProblem(ownDirName);
    if (problem !== null) {
        throw ckError('CONFIG', `ownDirName "${ownDirName}" is unsafe: ${problem}`, 'set ownDirName to one directory basename, normally "patchset"');
    }
}
function assertContainedOwnRoot(repositoryRoot, relative, label) {
    const resolved = resolveContainedPath(repositoryRoot, relative, { allowMissing: true });
    if (!resolved.ok) {
        throw ckError('ARTIFACT-BROKEN', `${label} ${relative} is unsafe: ${resolved.reason}`, 'remove symlinks from own code and keep it inside its repository root', relative);
    }
}
function collectAncestors(relative, into) {
    let at = relative;
    for (;;) {
        const slash = at.lastIndexOf('/');
        if (slash === -1) {
            return;
        }
        at = at.slice(0, slash);
        into.add(at);
    }
}
/** Deepest first, so a directory tree that became empty disappears entirely. */
function pruneEmptyDirectories(root, candidates) {
    pruneEmptyDirectoriesBelow(root, candidates);
    removeIfEmpty(root);
}
function pruneEmptyDirectoriesBelow(root, candidates) {
    const ordered = [...candidates].sort((left, right) => right.split('/').length - left.split('/').length);
    for (const relative of ordered) {
        removeIfEmpty(join(root, relative));
    }
}
function removeIfEmpty(absolute) {
    try {
        if (lstatSync(absolute).isDirectory() && readdirSync(absolute).length === 0) {
            rmdirSync(absolute);
        }
    }
    catch {
        // Already gone, or not ours to remove: nothing to report.
    }
}
