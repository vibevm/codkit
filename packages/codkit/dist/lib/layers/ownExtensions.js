/** @scope spec://codkit/modules/vscode/PROP-002#OWN-EXTENSION-UNIT */
// own-extension: a built-in extension of the product carried as a unit of the
// own layer (PROP-005 sec. 13).
//
// The mechanism is the own layer's, applied to a second pair of roots:
// `delta/own-extensions/<name>/**` is the source of truth and
// `<tree>/extensions/<name>/**` is its materialization, mirrored by content the
// way ##OWN-SOURCE-OF-TRUTH prescribes - `load` into the tree, `save` back,
// `ci` into the aggregate own commit of the generated branch.
//
// What is different from `delta/own/` is the declaration. An own unit names
// roots inside one directory, so a file can fall outside every unit or inside
// two; an extension *is* a directory, so the record names it and nothing else,
// and the only questions left are the ones a directory can answer: is the name
// well formed, is it unique, does the directory carry the `package.json` that
// makes the upstream build see an extension at all, and does the name already
// belong to an extension upstream ships. Each of those is
// CK-E-OWN-EXTENSION-MANIFEST; a tree that stopped matching the delta is
// CK-E-OWN-EXTENSION-DRIFT.
import { mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGit } from '../gitx.js';
import { ckError } from '../messages.js';
import { fileContentEqual } from '../ownCopy.js';
import { resolveContainedPath } from '../pathSafety.js';
import { OWN_MANIFEST_PATH } from './ownManifest.js';
/** Own extensions inside patchset, relative to the patchset root. */
export const OWN_EXTENSIONS_DIR = 'delta/own-extensions';
/** Where the upstream build looks for built-in extensions, from the tree root. */
export const EXTENSIONS_TREE_DIR = 'extensions';
/** The file without which the upstream build does not see an extension at all. */
export const EXTENSION_PACKAGE_NAME = 'package.json';
/** ##OWN-EXTENSION-UNIT: the form of an extension directory name. */
export const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export function ownExtensionsSourceRoot(patchesDir) {
    return join(patchesDir, ...OWN_EXTENSIONS_DIR.split('/'));
}
export function ownExtensionSourceRoot(patchesDir, name) {
    return join(ownExtensionsSourceRoot(patchesDir), name);
}
/** `extensions/<name>`, the materialized directory, relative to the tree root. */
export function ownExtensionTargetRelativeDir(name) {
    return `${EXTENSIONS_TREE_DIR}/${name}`;
}
export function ownExtensionTargetRoot(treeDir, name) {
    return join(treeDir, EXTENSIONS_TREE_DIR, name);
}
/**
 * The tree prefixes the own-extension layer supplies, with a trailing slash.
 *
 * Everything that judges "an upstream file changed" filters them out for the
 * same reason it filters `src/vs/<ownDirName>/`: these paths come from the
 * delta, so they are neither upstream text nor a new file somebody added in the
 * upstream zone.
 */
export function ownExtensionTreePrefixes(extensions) {
    return extensions
        .filter((extension) => isSafeExtensionName(extension.name))
        .map((extension) => `${ownExtensionTargetRelativeDir(extension.name)}/`);
}
/** ##OWN-EXTENSION-UNIT: a name that may be turned into a path at all. */
export function isSafeExtensionName(name) {
    return EXTENSION_NAME_PATTERN.test(name);
}
/** Relative POSIX paths under one extension directory, byte-sorted. */
export function listExtensionFiles(root) {
    const out = [];
    walk(root, '', out);
    out.sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    return out;
}
/**
 * Every file the declared extensions consist of, in declaration order and
 * byte-sorted inside each extension. A record whose name is unusable as a path
 * contributes nothing: `verify` refuses it, and no writer may act on it.
 */
export function ownExtensionFiles(patchesDir, extensions) {
    const files = [];
    for (const extension of extensions) {
        if (!isSafeExtensionName(extension.name)) {
            continue;
        }
        const root = ownExtensionSourceRoot(patchesDir, extension.name);
        for (const relative of listExtensionFiles(root)) {
            files.push({
                name: extension.name,
                relative: `${extension.name}/${relative}`,
                source: join(root, ...relative.split('/')),
                target: `${ownExtensionTargetRelativeDir(extension.name)}/${relative}`
            });
        }
    }
    return files;
}
/**
 * ##OWN-EXTENSION-UNIT: everything the `extensions` section has to satisfy.
 *
 * `upstreamHas` answers "does the pin already ship `extensions/<name>`". It is
 * a callback rather than a path because the check itself is answered from
 * patchset alone; a caller with no tree to ask passes one that always answers
 * false and keeps the other three checks. The probe that reads the answer out
 * of a real tree is `pinShipsExtension` below.
 *
 * Every problem is returned rather than raised: `verify` prints them all in one
 * pass, like every other layer.
 */
export function checkOwnExtensions(patchesDir, extensions, upstreamHas) {
    const problems = [];
    const seen = new Map();
    // Every name a record mentions, well formed or not: a directory whose record
    // is broken has a record, and saying "nobody declared it" on top of the real
    // problem would send the reader after the wrong fix.
    const claimed = new Set(extensions.map((extension) => extension.name));
    for (const extension of extensions) {
        if (!isSafeExtensionName(extension.name)) {
            problems.push({
                message: `${extension.id}: extension name ${JSON.stringify(extension.name)} is not of the form ${EXTENSION_NAME_PATTERN.source}`,
                hint: 'a built-in extension directory is named in lower-case letters, digits and hyphens, starting with a letter or a digit',
                file: OWN_MANIFEST_PATH
            });
            continue;
        }
        const previous = seen.get(extension.name);
        if (previous !== undefined) {
            problems.push({
                message: `${extension.id}: extension name ${extension.name} is already declared by ${previous}`,
                hint: 'one directory is one extension: give the second record its own name, or remove it',
                file: OWN_MANIFEST_PATH
            });
            continue;
        }
        seen.set(extension.name, extension.id);
        if (upstreamHas(extension.name)) {
            problems.push({
                message: `${extension.id}: name collides with an upstream extension (${ownExtensionTargetRelativeDir(extension.name)} exists at the pin)`,
                hint: 'materializing over an upstream extension would replace it silently: rename the own extension, or change the upstream one through a patch',
                file: OWN_MANIFEST_PATH
            });
            continue;
        }
        const manifest = join(ownExtensionSourceRoot(patchesDir, extension.name), EXTENSION_PACKAGE_NAME);
        if (statOrNull(manifest) === null) {
            problems.push({
                message: `${extension.id}: ${OWN_EXTENSIONS_DIR}/${extension.name}/${EXTENSION_PACKAGE_NAME} is missing`,
                hint: 'the upstream build finds a built-in extension by its package.json; add one, or remove the record',
                file: `${OWN_EXTENSIONS_DIR}/${extension.name}/${EXTENSION_PACKAGE_NAME}`
            });
        }
    }
    for (const name of undeclaredDirectories(patchesDir, claimed)) {
        problems.push({
            message: `${OWN_EXTENSIONS_DIR}/${name}/ is declared by no record of the extensions section`,
            hint: `add an extensions record for ${name} in ${OWN_MANIFEST_PATH}, or remove the directory; an undeclared extension is never materialized`,
            file: `${OWN_EXTENSIONS_DIR}/${name}`
        });
    }
    return problems;
}
/** Directories under delta/own-extensions/ that no record claims, byte-sorted. */
function undeclaredDirectories(patchesDir, declared) {
    let entries;
    try {
        entries = readdirSync(ownExtensionsSourceRoot(patchesDir), { withFileTypes: true });
    }
    catch {
        // No own-extension directory at all is the state of every patchset that
        // does not use the layer.
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && !declared.has(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}
// ---------------------------------------------------------------------------
// The materializations nobody declares any more (##OWN-EXTENSION-STRANDED)
// ---------------------------------------------------------------------------
/**
 * Whether the pin already carries `extensions/<name>`. Read from git objects, so
 * a dirty tree answers exactly like a clean one; a tree that cannot answer at
 * all (no repository, unreachable pin) answers "no" and leaves that failure to
 * the checks whose subject it is.
 *
 * A name that is not an extension name is answered "no" without asking git: it
 * would go into a rev-spec, where `extensions/../x` resolves to `x` at the root
 * and the answer would be about a different path entirely.
 */
export function pinShipsExtension(treeDir, pinSha, name) {
    if (!isSafeExtensionName(name)) {
        return false;
    }
    const shown = runGit({ args: ['cat-file', '-t', `${pinSha}:${ownExtensionTargetRelativeDir(name)}`], cwd: treeDir });
    return shown.status === 0 && shown.stdout.trim() === 'tree';
}
/**
 * ##OWN-EXTENSION-STRANDED: the first-level directories of `extensions/` that
 * are a materialization nobody owns any more, as `extensions/<name>/`.
 *
 * Taking the declaration away does not take the directory away: `load`
 * mirrors the declared extensions and nothing else, so the retired one simply
 * stays in the tree, untracked, until `load --fresh` sweeps it. Two facts
 * decide, and neither of them is the content of the directory: no record of
 * the manifest claims the name, and the pin does not ship an extension of that
 * name. A directory without a `package.json` is therefore stranded exactly like
 * a complete extension - it may be somebody's local experiment, which is
 * precisely why no command but `load --fresh` removes it.
 *
 * `untracked` is what git reports as untracked under `extensions/`, either as
 * whole directories or as single files; the order of that report is kept, so
 * the caller lists the paths in the order `git status` names them. `pinShips`
 * is asked at most once per name.
 */
export function strandedMaterializations(untracked, declared, pinShips) {
    const prefix = `${EXTENSIONS_TREE_DIR}/`;
    // Every name a record mentions, well formed or not: a declared extension is
    // somebody's, and a broken record is a problem `verify` names on its own.
    const claimed = new Set(declared.map((extension) => extension.name));
    const decided = new Set();
    const stranded = [];
    for (const path of untracked) {
        if (!path.startsWith(prefix)) {
            continue;
        }
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        // A loose file straight under `extensions/` is litter in the upstream
        // zone, not a materialization: only a directory can be one.
        if (slash <= 0) {
            continue;
        }
        const name = rest.slice(0, slash);
        if (decided.has(name) || claimed.has(name)) {
            continue;
        }
        decided.add(name);
        if (!pinShips(name)) {
            stranded.push(`${ownExtensionTargetRelativeDir(name)}/`);
        }
    }
    return stranded;
}
/**
 * The same verdict for one path at a time, as the drift guard asks it
 * (PROP-008 ##DRIFT-GUARD-PREDICATE, the stranded exception).
 *
 * It is the classification above and not a second copy of the rule: the command
 * that passes over the directory and the command that names it must never be
 * able to disagree about which directory that is. The pin is asked once per
 * name for the life of the returned predicate, which is one run of the guard.
 */
export function strandedExtensionClassifier(treeDir, pinSha, declared) {
    const answered = new Map();
    const pinShips = (name) => {
        const known = answered.get(name);
        if (known !== undefined) {
            return known;
        }
        const ships = pinShipsExtension(treeDir, pinSha, name);
        answered.set(name, ships);
        return ships;
    };
    return (path) => strandedMaterializations([path], declared, pinShips).length > 0;
}
export const NO_OWN_EXTENSIONS = { copied: 0, removed: 0, total: 0 };
/**
 * patchset -> tree, the direction `load` uses. Content-addressed like own code:
 * a file whose bytes already match is not rewritten, so its mtime does not move
 * and the watch daemons of the tree stay quiet.
 */
export function syncOwnExtensions(patchesDir, treeDir, extensions) {
    let copied = 0;
    let removed = 0;
    let total = 0;
    for (const extension of extensions) {
        if (!isSafeExtensionName(extension.name)) {
            continue;
        }
        const source = ownExtensionSourceRoot(patchesDir, extension.name);
        const target = assertContained(treeDir, ownExtensionTargetRelativeDir(extension.name), 'materialized own-extension target');
        const report = mirror(source, target);
        copied += report.copied;
        removed += report.removed;
        total += report.total;
    }
    return { copied, removed, total };
}
/**
 * tree -> patchset, the direction `save` uses.
 *
 * An extension the tree does not carry at all is skipped rather than emptied:
 * that is a tree which was never loaded, and "the tree has nothing" must not
 * read as "delete the delta".
 */
export function mirrorOwnExtensionsBack(patchesDir, treeDir, extensions) {
    let copied = 0;
    let removed = 0;
    let total = 0;
    for (const extension of extensions) {
        if (!isSafeExtensionName(extension.name)) {
            continue;
        }
        const source = ownExtensionTargetRoot(treeDir, extension.name);
        if (statOrNull(source) === null) {
            total += listExtensionFiles(ownExtensionSourceRoot(patchesDir, extension.name)).length;
            continue;
        }
        const target = assertContained(patchesDir, `${OWN_EXTENSIONS_DIR}/${extension.name}`, 'own-extension source');
        const report = mirror(source, target);
        copied += report.copied;
        removed += report.removed;
        total += report.total;
    }
    return { copied, removed, total };
}
/**
 * Paths that differ between patchset and the tree. An extension the tree has
 * not materialized at all reports nothing: a load has simply not happened yet,
 * and reporting every file of it as drift would make the first `verify` of a
 * fresh checkout red for no reason.
 */
export function compareOwnExtensions(patchesDir, treeDir, extensions) {
    const diverged = [];
    for (const extension of extensions) {
        if (!isSafeExtensionName(extension.name)) {
            continue;
        }
        const source = ownExtensionSourceRoot(patchesDir, extension.name);
        const target = ownExtensionTargetRoot(treeDir, extension.name);
        if (statOrNull(target) === null) {
            continue;
        }
        const sourceFiles = listExtensionFiles(source);
        const targetFiles = listExtensionFiles(target);
        const targetSet = new Set(targetFiles);
        for (const relative of sourceFiles) {
            if (!targetSet.has(relative)) {
                diverged.push({ relative: `${extension.name}/${relative}`, kind: 'patchset-only' });
                continue;
            }
            if (!fileContentEqual(join(source, ...relative.split('/')), join(target, ...relative.split('/')))) {
                diverged.push({ relative: `${extension.name}/${relative}`, kind: 'both' });
            }
        }
        const sourceSet = new Set(sourceFiles);
        for (const relative of targetFiles) {
            if (!sourceSet.has(relative)) {
                diverged.push({ relative: `${extension.name}/${relative}`, kind: 'tree-only' });
            }
        }
    }
    diverged.sort((left, right) => Buffer.from(left.relative, 'utf8').compare(Buffer.from(right.relative, 'utf8')));
    return diverged;
}
// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------
function mirror(source, target) {
    const sourceFiles = listExtensionFiles(source);
    const targetFiles = listExtensionFiles(target);
    let copied = 0;
    for (const relative of sourceFiles) {
        const from = join(source, ...relative.split('/'));
        const to = join(target, ...relative.split('/'));
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
        rmSync(join(target, ...relative.split('/')), { force: true });
        removed += 1;
        collectAncestors(relative, emptied);
    }
    pruneEmptyDirectories(target, emptied);
    return { copied, removed, total: sourceFiles.length };
}
function walk(absoluteDir, relativeDir, into) {
    let entries;
    try {
        entries = readdirSync(absoluteDir, { withFileTypes: true });
    }
    catch {
        // An absent directory on either side is a legal state: the delta may not
        // carry the extension yet, and the tree may never have been loaded.
        return;
    }
    for (const entry of entries) {
        const absolute = join(absoluteDir, entry.name);
        const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
        if (entry.isSymbolicLink()) {
            throw ckError('ARTIFACT-BROKEN', `symlinks are not allowed in an own extension: ${relative}`, 'replace the symlink with the file itself; an own extension must be self-contained in patchset', `${OWN_EXTENSIONS_DIR}/${relative}`);
        }
        if (entry.isDirectory()) {
            walk(absolute, relative, into);
            continue;
        }
        into.push(relative);
    }
}
function assertContained(repositoryRoot, relative, label) {
    const resolved = resolveContainedPath(repositoryRoot, relative, { allowMissing: true });
    if (!resolved.ok) {
        throw ckError('ARTIFACT-BROKEN', `${label} ${relative} is unsafe: ${resolved.reason}`, 'remove symlinks from the extension directory and keep it inside its repository root', relative);
    }
    return resolved.absolute;
}
function statOrNull(absolute) {
    try {
        return statSync(absolute);
    }
    catch {
        return null;
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
    const ordered = [...candidates].sort((left, right) => right.split('/').length - left.split('/').length);
    for (const relative of ordered) {
        removeIfEmpty(join(root, ...relative.split('/')));
    }
    removeIfEmpty(root);
}
function removeIfEmpty(absolute) {
    try {
        if (statSync(absolute).isDirectory() && readdirSync(absolute).length === 0) {
            rmdirSync(absolute);
        }
    }
    catch {
        // Already gone, or not ours to remove: nothing to report.
    }
}
