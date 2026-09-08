/** @scope spec://codkit/modules/codkit/PROP-014#STD-PACKAGE-LOCATION */
// Finding the packages that ship with this codkit (PROP-014 sec. 1).
//
// ##STD-SHIPPED-PACKAGES: the tool ships a set, not a single package - the
// edition of norms and the agent skills - and every one of them lives under
// `toolRoot/vibevm/vibepacks/org.vibevm.codkit/<name>/`.
//
// ##STD-PACKAGE-LOCATION: exactly one `v*` directory lives under each of them,
// and its name is the version its manifest states. Anything else means the
// installation is damaged, which is `CK-E-INTERNAL` and not something a person
// can fix by rerunning.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ensureAdminDirectory, lstatIfPresent, statIfPresent } from './containedPath.js';
import { ckError } from './messages.js';
/** Where every package codkit ships sits, relative to toolRoot. */
export const SHIPPED_PACKAGES_PARENT = 'vibevm/vibepacks/org.vibevm.codkit';
/** Group and name of the package; its identity together with the version. */
export const STANDARDS_PACKAGE_GROUP = 'org.vibevm.codkit';
export const STANDARDS_PACKAGE_NAME = 'standards';
/** ##STD-SKILLS-PACKAGE-IDENTITY: the second package of the set. */
export const SKILLS_PACKAGE_NAME = 'agent-skills';
/** Where the standards package sits, relative to toolRoot. */
export const STANDARDS_PACKAGE_PARENT = `${SHIPPED_PACKAGES_PARENT}/${STANDARDS_PACKAGE_NAME}`;
/** ##STD-PACKAGE-LOCATION: `[package] version` of the package manifest. */
const MANIFEST_VERSION = /^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/mu;
/** Directories a run of `standards load` leaves behind when it is interrupted. */
export const SCRATCH_PREFIX = '.codkit-load-';
/**
 * ##STD-SHIPPED-PACKAGES: every package under the group directory, in the order
 * every surface prints them - `standards` first, because it is the edition of
 * norms every other package refers to, then the rest by name.
 *
 * `standardsOverride` is the test seam of ##STD-LOAD-STEP-SOURCE. It relocates
 * the standards package alone, which is what the seam has always meant: the
 * licence gate of the first package refuses the whole run, so a fixture that
 * breaks it never reaches the others.
 */
export function shippedPackages(toolRoot, standardsOverride) {
    const group = join(toolRoot, ...SHIPPED_PACKAGES_PARENT.split('/'));
    const shape = statIfPresent(group);
    if (shape === null || !shape.isDirectory()) {
        throw ckError('INTERNAL', `no shipped packages under ${SHIPPED_PACKAGES_PARENT}`, 'restore the codkit installation from the approved supply', SHIPPED_PACKAGES_PARENT);
    }
    const names = readdirSync(group, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    const found = names.map((name) => readShippedPackage(name, name === STANDARDS_PACKAGE_NAME && standardsOverride ? standardsOverride : join(group, name)));
    return [...found].sort(byShippedOrder);
}
/** `standards` first, then by name: the order of the manifest block and of every summary. */
function byShippedOrder(left, right) {
    if (left.name === right.name)
        return 0;
    if (left.name === STANDARDS_PACKAGE_NAME)
        return -1;
    if (right.name === STANDARDS_PACKAGE_NAME)
        return 1;
    return left.name < right.name ? -1 : 1;
}
/**
 * The shipped standards package. `CODKIT_TEST_STANDARDS_SOURCE` replaces its
 * location, but only under the test build condition, the same seam
 * `CODKIT_TEST_SAVE_REPLAY_CRASH_AT` uses (##STD-LOAD-STEP-SOURCE).
 */
export function shippedStandardsPackage(toolRoot, override) {
    return readShippedPackage(STANDARDS_PACKAGE_NAME, override ?? join(toolRoot, ...STANDARDS_PACKAGE_PARENT.split('/')));
}
/**
 * ##STD-PACKAGE-LOCATION: exactly one `v*` directory whose name is the version
 * its manifest states. Anything else means the installation is damaged.
 */
function readShippedPackage(name, parent) {
    const where = `${SHIPPED_PACKAGES_PARENT}/${name}`;
    const shape = statIfPresent(parent);
    if (shape === null || !shape.isDirectory()) {
        throw ckError('INTERNAL', `shipped package not found under ${where}`, RESTORE_HINT, where);
    }
    const versions = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
        .map((entry) => entry.name)
        .sort();
    const only = versions[0];
    if (versions.length !== 1 || only === undefined) {
        throw ckError('INTERNAL', `${versions.length} version directories under ${where}, expected exactly one`, RESTORE_HINT, where);
    }
    const directory = join(parent, only);
    const version = only.slice(1);
    const manifest = readManifest(directory, where);
    if (manifest.version !== version) {
        throw ckError('INTERNAL', `the package directory says ${version} and its manifest says ${manifest.version}`, RESTORE_HINT, `${where}/${only}/vibe.toml`);
    }
    return { directory, version, name, kind: kindOf(name), declaresSkills: manifest.declaresSkills };
}
const RESTORE_HINT = 'restore the codkit installation from the approved supply';
function kindOf(name) {
    if (name === STANDARDS_PACKAGE_NAME)
        return 'standards';
    if (name === SKILLS_PACKAGE_NAME)
        return 'agent-skills';
    return 'other';
}
/**
 * The two facts the manifest has to give up: the version, read by the literal
 * of ##STD-PACKAGE-LOCATION, and whether the package declares skills. The
 * second needs a TOML reader, because `[[skill]]` is an array of tables and a
 * regular expression would count one inside a string as well.
 */
function readManifest(directory, where) {
    let text;
    try {
        text = readFileSync(join(directory, 'vibe.toml'), 'utf8');
    }
    catch (error) {
        throw ckError('INTERNAL', `cannot read the package manifest: ${error instanceof Error ? error.message : String(error)}`, RESTORE_HINT, `${where}/vibe.toml`);
    }
    const stated = MANIFEST_VERSION.exec(text);
    if (stated === null || stated[1] === undefined) {
        throw ckError('INTERNAL', 'the package manifest states no [package] version', RESTORE_HINT, `${where}/vibe.toml`);
    }
    let document;
    try {
        document = parseToml(text);
    }
    catch (error) {
        throw ckError('INTERNAL', `the package manifest is not TOML: ${error instanceof Error ? error.message : String(error)}`, RESTORE_HINT, `${where}/vibe.toml`);
    }
    const skills = document.skill;
    return { version: stated[1], declaresSkills: Array.isArray(skills) && skills.length > 0 };
}
/** Every file under `dir`, POSIX-relative, sorted; a symlink is reported too. */
function listTree(dir) {
    const files = [];
    const symlinks = [];
    const visit = (absolute, prefix) => {
        for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isSymbolicLink()) {
                symlinks.push(relative);
                continue;
            }
            if (entry.isDirectory()) {
                visit(join(absolute, entry.name), relative);
                continue;
            }
            files.push(relative);
        }
    };
    visit(dir, '');
    return { files, symlinks };
}
/**
 * ##STD-LOAD-STEP-TARGET-STATE: the same relative paths and the same bytes, or
 * the exact list of what differs. A symlink in the target is drift: codkit
 * wrote regular files, so a link is somebody's edit.
 */
export function compareTrees(source, target, options = {}) {
    const shape = statIfPresent(target);
    if (shape === null)
        return { state: 'absent' };
    if (!shape.isDirectory())
        return { state: 'drift', modified: [], extra: [''], missing: [] };
    const ignored = new Set(options.ignoreInTarget ?? []);
    const from = listTree(source);
    const listed = listTree(target);
    const to = { files: listed.files.filter((relative) => !ignored.has(relative)), symlinks: listed.symlinks };
    const targetFiles = new Set(to.files);
    const modified = [];
    const missing = [];
    for (const relative of from.files) {
        if (!targetFiles.has(relative)) {
            missing.push(relative);
            continue;
        }
        const left = readFileSync(join(source, ...relative.split('/')));
        const right = readFileSync(join(target, ...relative.split('/')));
        if (!left.equals(right))
            modified.push(relative);
    }
    const sourceFiles = new Set(from.files);
    const extra = [...to.files.filter((relative) => !sourceFiles.has(relative)), ...to.symlinks].sort();
    if (modified.length === 0 && extra.length === 0 && missing.length === 0)
        return { state: 'identical' };
    return { state: 'drift', modified, extra, missing };
}
/** Every regular file under `dir`, POSIX-relative and sorted; empty when it does not exist. */
export function listTreeFiles(dir) {
    return statIfPresent(dir)?.isDirectory() === true ? listTree(dir).files : [];
}
/** Whether two files hold the same bytes; an absent target is not identical. */
export function fileIsIdentical(source, target) {
    const shape = lstatIfPresent(target);
    if (shape === null || !shape.isFile())
        return false;
    return readFileSync(source).equals(readFileSync(target));
}
/** Scratch directories a previous interrupted run left behind. */
export function listScratchDirs(parent) {
    const shape = statIfPresent(parent);
    if (shape === null || !shape.isDirectory())
        return [];
    return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX))
        .map((entry) => entry.name)
        .sort();
}
export function writeTreeViaScratch(source, root, parentSegments, versionDirName, options) {
    // The parent components are created here, each proven a real directory: a
    // symlink component is refused rather than followed (PROP-002, the rule for
    // administrative directories).
    const parent = ensureAdminDirectory(root, parentSegments, { what: options.what });
    const scratch = `${SCRATCH_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
    const scratchPath = join(parent, scratch);
    mkdirSync(scratchPath);
    for (const relative of listTree(source).files) {
        const segments = relative.split('/');
        const name = segments.pop() ?? '';
        const directory = ensureAdminDirectory(scratchPath, segments, { what: options.what });
        writeFileSync(join(directory, name), readFileSync(join(source, ...relative.split('/'))));
    }
    const target = join(parent, versionDirName);
    const standing = statIfPresent(target);
    if (standing !== null && options.replace !== true) {
        // The target appeared between the classification and the rename. Whoever
        // wrote it owns it now: identical means our work is already done, anything
        // else is drift for the caller to refuse.
        rmSync(scratchPath, { recursive: true, force: true });
        throw ckError('STANDARDS-DRIFT', `${versionDirName} appeared while the package was being written`, 'run codkit standards load again to classify the directory that is now there', versionDirName);
    }
    for (const relative of standing === null ? [] : (options.preserve ?? [])) {
        const from = join(target, ...relative.split('/'));
        if (statIfPresent(from) === null)
            continue;
        const segments = relative.split('/');
        const name = segments.pop() ?? '';
        writeFileSync(join(ensureAdminDirectory(scratchPath, segments, { what: options.what }), name), readFileSync(from));
    }
    if (standing === null) {
        renameSync(scratchPath, target);
        return scratch;
    }
    // Two renames rather than a delete and a rename: the old directory is only
    // unlinked after the new one is fully in place, so an interruption leaves
    // either the old library or the new one, never half of either.
    const retired = join(parent, `${SCRATCH_PREFIX}old-${process.pid}-${randomBytes(4).toString('hex')}`);
    renameSync(target, retired);
    renameSync(scratchPath, target);
    rmSync(retired, { recursive: true, force: true });
    return scratch;
}
