/** @scope spec://codkit/modules/codkit/PROP-014#STD-PACKAGE-LOCATION */
// Finding the standards package that ships with this codkit (PROP-014 sec. 1).
//
// ##STD-PACKAGE-LOCATION: exactly one `v*` directory lives under
// `toolRoot/vibevm/vibepacks/org.vibevm.codkit/standards/`, and its name is the
// version its manifest states. Anything else means the installation is damaged,
// which is `CK-E-INTERNAL` and not something a person can fix by rerunning.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureAdminDirectory, lstatIfPresent, statIfPresent } from './containedPath.js';
import { ckError } from './messages.js';
/** Where the shipped package sits, relative to toolRoot. */
export const STANDARDS_PACKAGE_PARENT = 'vibevm/vibepacks/org.vibevm.codkit/standards';
/** Group and name of the package; its identity together with the version. */
export const STANDARDS_PACKAGE_GROUP = 'org.vibevm.codkit';
export const STANDARDS_PACKAGE_NAME = 'standards';
/** ##STD-PACKAGE-LOCATION: `[package] version` of the package manifest. */
const MANIFEST_VERSION = /^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/mu;
/** Directories a run of `standards load` leaves behind when it is interrupted. */
export const SCRATCH_PREFIX = '.codkit-load-';
/**
 * The shipped package. `CODKIT_TEST_STANDARDS_SOURCE` replaces its location,
 * but only under the test build condition, the same seam
 * `CODKIT_TEST_SAVE_REPLAY_CRASH_AT` uses (##STD-LOAD-STEP-SOURCE).
 */
export function shippedStandardsPackage(toolRoot, override) {
    const parent = override ?? join(toolRoot, ...STANDARDS_PACKAGE_PARENT.split('/'));
    const shape = statIfPresent(parent);
    if (shape === null || !shape.isDirectory()) {
        throw ckError('INTERNAL', `shipped standards package not found under ${STANDARDS_PACKAGE_PARENT}`, 'restore the codkit installation from the approved supply', STANDARDS_PACKAGE_PARENT);
    }
    const versions = readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
        .map((entry) => entry.name)
        .sort();
    const only = versions[0];
    if (versions.length !== 1 || only === undefined) {
        throw ckError('INTERNAL', `${versions.length} version directories under ${STANDARDS_PACKAGE_PARENT}, expected exactly one`, 'restore the codkit installation from the approved supply', STANDARDS_PACKAGE_PARENT);
    }
    const directory = join(parent, only);
    const version = only.slice(1);
    const manifest = readManifest(directory);
    if (manifest !== version) {
        throw ckError('INTERNAL', `the package directory says ${version} and its manifest says ${manifest}`, 'restore the codkit installation from the approved supply', `${STANDARDS_PACKAGE_PARENT}/${only}/vibe.toml`);
    }
    return { directory, version };
}
function readManifest(directory) {
    let text;
    try {
        text = readFileSync(join(directory, 'vibe.toml'), 'utf8');
    }
    catch (error) {
        throw ckError('INTERNAL', `cannot read the package manifest: ${error instanceof Error ? error.message : String(error)}`, 'restore the codkit installation from the approved supply', `${STANDARDS_PACKAGE_PARENT}/vibe.toml`);
    }
    const stated = MANIFEST_VERSION.exec(text);
    if (stated === null || stated[1] === undefined) {
        throw ckError('INTERNAL', 'the package manifest states no [package] version', 'restore the codkit installation from the approved supply', `${STANDARDS_PACKAGE_PARENT}/vibe.toml`);
    }
    return stated[1];
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
export function compareTrees(source, target) {
    const shape = statIfPresent(target);
    if (shape === null)
        return { state: 'absent' };
    if (!shape.isDirectory())
        return { state: 'drift', modified: [], extra: [''], missing: [] };
    const from = listTree(source);
    const to = listTree(target);
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
/**
 * ##DECISION-STD-TEMP-DIR-RENAME: write every file into a scratch directory and
 * rename it into place in one step, so the classification above never sees a
 * half-written version directory. Returns the scratch name that was renamed.
 *
 * `renameContainedFile` refuses a non-regular source, so the directory rename is
 * done here, with the same shape proof: the parent components are real
 * directories (a symlink component is refused by `ensureAdminDirectory`) and the
 * target must not exist.
 */
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
    if (statIfPresent(target) !== null) {
        // The target appeared between the classification and the rename. Whoever
        // wrote it owns it now: identical means our work is already done, anything
        // else is drift for the caller to refuse.
        rmSync(scratchPath, { recursive: true, force: true });
        throw ckError('STANDARDS-DRIFT', `${versionDirName} appeared while the package was being written`, 'run codkit standards load again to classify the directory that is now there', versionDirName);
    }
    renameSync(scratchPath, target);
    return scratch;
}
