/** @scope spec://codkit/modules/codkit/PROP-008#PATCHSET-SIDE-EDIT-RULE */
// Which side of an own file moved (PROP-008 ##PATCHSET-SIDE-EDIT-RULE), and the
// per-file evidence the tree mark carries to answer it (PROP-006 ##TREE-MARK).
//
// The copy itself is `ownCopy.ts`; this is the half that decides. The two sides
// of an owned directory are identical by construction right after a load, so
// the map recorded then is what lets a later run say, file by file, whether the
// delta moved, the tree moved, or both - which is the difference between a
// silent overwrite and an extraction. Every owned directory of the patch set
// keeps its own map (PROP-016 ##TYPE-AREA-LAYOUT).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertContainedOwnRoot, assertSafeOwnRoot, isDeliveredOwnFile, listOwnFiles, OWN_SOURCE_DIR, ownSourceRoot, ownTargetRoot } from './ownCopy.js';
import { ownCodeFilter } from './ownedRoots.js';
/** Version of the canonical string of ownFingerprint; part of the hashed input. */
const OWN_FINGERPRINT_SCHEMA_VERSION = 1;
/**
 * The own state as patchset holds it. Recorded in the tree mark by every load and
 * save (PROP-006 ##TREE-MARK) so that the next run can tell, file by file, which
 * side moved: a file equal to the mark did not change on that side.
 *
 * It is taken from `delta/own/` and not from the tree, because immediately after
 * the copy the two sides are identical by construction and patchset is the source
 * of truth (PROP-005 ##OWN-SOURCE-OF-TRUTH).
 */
export function ownStateOfPatchSet(patchesDir, owned, includeMetadata = false) {
    const deltaDir = owned?.deltaDir ?? OWN_SOURCE_DIR;
    assertContainedOwnRoot(patchesDir, deltaDir, 'own source');
    return ownStateOf(ownSourceRoot(patchesDir, deltaDir), owned === undefined ? undefined : ownCodeFilter(owned), includeMetadata);
}
export function ownStateOfTree(treeDir, owned, includeMetadata = false) {
    assertSafeOwnRoot(owned.path);
    assertContainedOwnRoot(treeDir, owned.path, 'materialized own target');
    return ownStateOf(ownTargetRoot(treeDir, owned.path), ownCodeFilter(owned), includeMetadata);
}
/**
 * The state of one side. Both sides are read through the same filter: a file
 * that is not delivered is not part of the comparison on either side, so it can
 * never be classified as "one of the sides moved it".
 */
function ownStateOf(root, keep, includeMetadata = false) {
    const relatives = listOwnFiles(root, { refuseSymlinks: true, keep }).filter((relative) => includeMetadata || isDeliveredOwnFile(relative));
    const files = {};
    const hash = createHash('sha256');
    for (const relative of relatives) {
        const sha = sha256File(join(root, relative));
        Object.defineProperty(files, relative, { value: sha, enumerable: true, configurable: true, writable: true });
        hash.update(`${relative}\n${sha}\n`, 'utf8');
    }
    hash.update(`schema ${OWN_FINGERPRINT_SCHEMA_VERSION}\n`, 'utf8');
    return { files, fingerprint: hash.digest('hex') };
}
function sha256File(absolute) {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}
/**
 * The maps the tree mark keeps for the owned directories, from the delta side
 * (PROP-006 ##TREE-MARK). The own root keeps the historical two fields, so a
 * mark of a patch set that owns one directory is byte for byte what it always
 * was; every other owned directory is one entry of `ownRootFiles`, keyed by its
 * role.
 */
export function ownMarkState(patchesDir, roots) {
    const first = roots[0];
    const own = first === undefined ? ownStateOfPatchSet(patchesDir) : ownStateOfPatchSet(patchesDir, first);
    const others = {};
    for (const owned of roots.slice(1)) {
        others[owned.role] = ownStateOfPatchSet(patchesDir, owned).files;
    }
    return {
        ownFingerprint: own.fingerprint,
        ownFiles: own.files,
        ownRootFiles: Object.keys(others).length === 0 ? undefined : others
    };
}
/**
 * The map the mark kept for one owned directory, or null when it kept none.
 * `null` is the honest answer of a mark written before this directory was
 * owned, and the classifier turns it into `unknown` rather than a guess.
 */
export function ownMarkFilesOf(mark, owned) {
    if (mark === null) {
        return null;
    }
    return (owned.role === 'own' ? mark.ownFiles : mark.ownRootFiles?.[owned.role]) ?? null;
}
/**
 * Classify every own file by which side moved. `markFiles` is the map the tree
 * mark recorded at the last load; null means "the map is unknown" - migration
 * from a mark written before the map existed - and every difference then falls
 * into `unknown` rather than being guessed at.
 */
export function classifyOwn(patchesDir, treeDir, owned, markFiles, includeMetadata = false) {
    const patchset = ownStateOfPatchSet(patchesDir, owned, includeMetadata).files;
    const tree = ownStateOfTree(treeDir, owned, includeMetadata).files;
    const paths = [...new Set([...Object.keys(patchset), ...Object.keys(tree)])].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    const out = [];
    for (const relative of paths) {
        const inPatchSet = Object.hasOwn(patchset, relative) ? (patchset[relative] ?? null) : null;
        const inTree = Object.hasOwn(tree, relative) ? (tree[relative] ?? null) : null;
        out.push({ relative, kind: classifyOne(inPatchSet, inTree, markFiles, relative), patchset: inPatchSet, tree: inTree, owned });
    }
    return out;
}
/**
 * Every owned directory classified, each against the map the mark kept for it
 * (PROP-006 ##TREE-MARK). A directory the mark says nothing about is classified
 * with a null map, which is the conservative "unknown" answer and not a guess.
 */
export function classifyAllOwn(patchesDir, treeDir, roots, markFiles) {
    return roots.flatMap((owned) => classifyOwn(patchesDir, treeDir, owned, markFiles(owned)));
}
function classifyOne(inPatchSet, inTree, markFiles, relative) {
    if (inPatchSet === inTree) {
        return 'same';
    }
    if (markFiles === null) {
        return 'unknown';
    }
    const marked = Object.hasOwn(markFiles, relative) ? (markFiles[relative] ?? null) : null;
    const patchsetMoved = inPatchSet !== marked;
    const treeMoved = inTree !== marked;
    if (patchsetMoved && treeMoved) {
        return 'both-edited';
    }
    return patchsetMoved ? 'patchset-edited' : 'tree-edited';
}
