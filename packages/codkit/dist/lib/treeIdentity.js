/** @scope spec://codkit/modules/codkit/PROP-008#root */
// Fork-tree identity and fitness checks (PROP-008 sec. 2, the check order is normative).
//
// The tree codkit works on is not "some directory": it must be a git work tree
// carrying the upstream history this patchset tracks. The checks run in a
// fixed order and the first fatal one stops the sequence, so a wrong path is
// diagnosed as a wrong path and never as a mysterious later failure.
//
// Nothing here writes to the tree in 'read' mode, and nothing here reaches the
// network: every git call goes through gitx with netAllowed left at false.
import { accessSync, constants, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readContainedFile } from './containedFile.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
/** First bytes of a git-lfs pointer file (PROP-008 ##ID-CHECK-LFS). */
export const LFS_POINTER_MARKER = 'version https://git-lfs.github.com/spec/v1';
/** How many LFS paths are sampled for pointer content. */
const LFS_SAMPLE_SIZE = 3;
const CHECK_NAMES = {
    repo: 'git repository',
    upstream: 'upstream origin',
    pin: 'pin reachable',
    fingerprints: 'family fingerprints',
    lfs: 'git-lfs content',
    write: 'write access',
    clean: 'clean working tree'
};
/**
 * Run the identity checks against an already-resolved fork tree path.
 * Returns a report; it never throws for a diagnosed condition, so the caller
 * decides the exit code (PROP-007 sec. 3: fatal is 2, dirty is 1).
 */
export function checkTree(resolution, config, options) {
    const checks = [];
    const tree = resolution.path;
    // 1. It is a git work tree at all.
    const repo = openRepo(tree);
    if (repo === null) {
        checks.push(makeCheck('repo', false));
        return {
            checks,
            fatal: ckError('NOT-A-REPO', `${tree} is not a git work tree`, `run: codkit clone --fork-dir ${tree}   (or point --fork-dir at an existing fork tree)`)
        };
    }
    checks.push(makeCheck('repo', true, `git dir: ${repo.gitDir}`));
    // 2. Origin, by reachability of the anchor commit - remote names are only a hint.
    const anchor = config.upstreamAnchorCommit;
    if (!objectExists(tree, anchor)) {
        checks.push(makeCheck('upstream', false));
        return {
            checks,
            fatal: ckError('NOT-UPSTREAM', `the upstream anchor commit ${anchor} is not present in ${tree}`, 'this is a git repository, but not a clone of the upstream history patchset tracks; ' +
                'point --fork-dir at the fork tree, or run: codkit clone')
        };
    }
    checks.push(makeCheck('upstream', true, `anchor ${shortSha(anchor)} present`));
    // 3. The pin is present and belongs to that history.
    const pinFatal = checkPin(tree, config, checks);
    if (pinFatal !== null) {
        return { checks, fatal: pinFatal };
    }
    // 4. The tree really carries a checkout of this family (the type's answer).
    const familyFatal = checkFingerprints(repo.topLevel, options.type, checks);
    if (familyFatal !== null) {
        return { checks, fatal: familyFatal };
    }
    // 5. git-lfs: pointer files must never be mistaken for real content.
    const lfsFatal = checkLfs(repo.topLevel, config.pin.sha, checks);
    if (lfsFatal !== null) {
        return { checks, fatal: lfsFatal };
    }
    // 6. Write access, only for callers that are about to write.
    if (options.mode === 'write') {
        const writeFatal = checkWritable(tree, repo.gitDir, checks);
        if (writeFatal !== null) {
            return { checks, fatal: writeFatal };
        }
    }
    // 7. Cleanliness, only when the command requires it.
    if (options.requireClean === true) {
        return checkClean(repo.topLevel, config, checks);
    }
    return { checks, fatal: null };
}
/**
 * Does this tree carry LFS-tracked paths at all? `clone` uses it to decide
 * whether the lfs steps are needed; a tree without them skips them entirely.
 */
export function treeUsesLfs(tree, pinSha) {
    const probe = probeLfs(tree, pinSha);
    return probe.available ? probe.paths.length > 0 : probe.trackedByAttributes;
}
/** Render one check the way `check-tree` prints it. */
export function formatCheckLine(check) {
    const verdict = check.ok ? 'ok  ' : 'fail';
    return check.info === undefined ? `${verdict} - ${check.name}` : `${verdict} - ${check.name} (${check.info})`;
}
/**
 * `git rev-parse --absolute-git-dir --show-toplevel` in one call: it proves the
 * path is a repository (ID-CHECK-REPO) and hands back the two locations the
 * later checks need. A bare repository has no work tree and fails here, which
 * is the right answer: codkit needs files on disk.
 */
function openRepo(tree) {
    if (!existsSync(tree)) {
        return null;
    }
    const result = runGit({ args: ['rev-parse', '--absolute-git-dir', '--show-toplevel'], cwd: tree });
    if (result.status !== 0) {
        return null;
    }
    const lines = result.stdout.split('\n').map((line) => line.trim());
    const gitDir = lines[0];
    const topLevel = lines[1];
    if (gitDir === undefined || gitDir === '' || topLevel === undefined || topLevel === '') {
        return null;
    }
    return { gitDir, topLevel };
}
function objectExists(tree, object) {
    return runGit({ args: ['cat-file', '-e', object], cwd: tree }).status === 0;
}
function checkPin(tree, config, checks) {
    const { tag, sha } = config.pin;
    if (!objectExists(tree, sha)) {
        checks.push(makeCheck('pin', false));
        return ckError('PIN-UNREACHABLE', `pin ${tag}@${sha} is not present in ${tree}`, `codkit never fetches by itself; run: git -C ${tree} fetch origin tag ${tag}`);
    }
    const descends = runGit({
        args: ['merge-base', '--is-ancestor', config.upstreamAnchorCommit, sha],
        cwd: tree
    });
    if (descends.status !== 0) {
        checks.push(makeCheck('pin', false));
        return ckError('PIN-UNREACHABLE', `pin ${tag}@${sha} exists in ${tree} but does not descend from the upstream anchor ` + `${config.upstreamAnchorCommit}`, 'the pin does not belong to the history in this tree; check codkit.json against the tree you point at');
    }
    checks.push(makeCheck('pin', true, `${tag}@${shortSha(sha)}`));
    return null;
}
/**
 * ##ID-CHECK-FINGERPRINTS: what the project type says proves a healthy tree of
 * its family - a manifest under a known name, a marker directory, two files
 * that have to agree on a version. The engine reads the paths and hands over
 * the bytes; every word of what they must contain is the type's answer, and a
 * type that names none has this check pass vacuously.
 */
function checkFingerprints(topLevel, type, checks) {
    if (type === undefined) {
        return null;
    }
    const fingerprints = type.identity.fingerprints;
    if (fingerprints.length === 0) {
        checks.push(makeCheck('fingerprints', true, `the project type ${type.id} names none`));
        return null;
    }
    const files = fingerprintFiles(topLevel, fingerprints);
    const problems = [];
    for (const fingerprint of fingerprints) {
        const problem = fingerprintProblem(topLevel, fingerprint, files);
        if (problem !== null) {
            problems.push(problem);
        }
    }
    if (problems.length > 0) {
        checks.push(makeCheck('fingerprints', false, problems[0]));
        return ckError('NOT-UPSTREAM', `${topLevel} does not carry the tree of the project type ${type.id}: ${problems.join('; ')}`, `point --fork-dir at a fork of the upstream family ${type.id} describes, or declare in codkit.json the type this tree really is`);
    }
    checks.push(makeCheck('fingerprints', true, `${fingerprints.length} path(s) of ${type.id}`));
    return null;
}
/** The text of every file fingerprint of this family; unreadable arrives as null. */
function fingerprintFiles(topLevel, fingerprints) {
    const files = new Map();
    for (const fingerprint of fingerprints) {
        if (fingerprint.kind !== 'file') {
            continue;
        }
        files.set(fingerprint.path, readFingerprintText(topLevel, fingerprint.path));
    }
    return files;
}
function readFingerprintText(topLevel, path) {
    try {
        const read = readContainedFile(topLevel, path, { what: path });
        return read.state === 'absent' ? null : Buffer.from(read.bytes).toString('utf8');
    }
    catch {
        // A path that is a symlink, a directory or otherwise not a plain file of
        // the tree is a missing fingerprint, not a crash of check-tree.
        return null;
    }
}
/** What is wrong with one fingerprint, or null when the tree satisfies it. */
function fingerprintProblem(topLevel, fingerprint, files) {
    const absolute = join(topLevel, ...fingerprint.path.split('/'));
    let stats;
    try {
        stats = statSync(absolute);
    }
    catch {
        return `${fingerprint.path} is missing (${fingerprint.why})`;
    }
    if (fingerprint.kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
        return `${fingerprint.path} is not a ${fingerprint.kind} (${fingerprint.why})`;
    }
    if (fingerprint.kind !== 'file' || fingerprint.contentProblem === undefined) {
        return null;
    }
    let detail;
    try {
        detail = fingerprint.contentProblem(files);
    }
    catch (error) {
        detail = `cannot be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    return detail === null ? null : `${fingerprint.path}: ${detail}`;
}
/**
 * Generalized LFS detection (PROP-008 ##ID-CHECK-LFS): no path list is hard-coded.
 * `git lfs ls-files -n` is the primary source; when git-lfs itself is missing,
 * `filter=lfs` in `.gitattributes` at the pin decides whether it is required.
 */
function probeLfs(tree, pinSha) {
    const available = runGit({ args: ['lfs', 'version'], cwd: tree }).status === 0;
    if (!available) {
        const attributes = runGit({ args: ['show', `${pinSha}:.gitattributes`], cwd: tree });
        const trackedByAttributes = attributes.status === 0 && attributes.stdout.includes('filter=lfs');
        return { available: false, paths: [], trackedByAttributes };
    }
    const listed = runGit({ args: ['lfs', 'ls-files', '-n'], cwd: tree });
    if (listed.status !== 0) {
        return { available: true, paths: [], trackedByAttributes: false };
    }
    const paths = listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
    return { available: true, paths, trackedByAttributes: paths.length > 0 };
}
function checkLfs(topLevel, pinSha, checks) {
    const probe = probeLfs(topLevel, pinSha);
    if (!probe.available) {
        if (!probe.trackedByAttributes) {
            // A tree that tracks nothing with lfs does not need lfs: the check
            // passes vacuously (this is the fixture case).
            checks.push(makeCheck('lfs', true, 'no LFS-tracked paths and no git-lfs; not required'));
            return null;
        }
        checks.push(makeCheck('lfs', false));
        return ckError('LFS', `the tree at ${topLevel} tracks paths with git-lfs (filter=lfs in .gitattributes at the pin), ` + 'but git-lfs is not installed', 'install git-lfs (https://git-lfs.com), then run: git -C ' + topLevel + ' lfs install --local && git -C ' + topLevel + ' lfs pull');
    }
    if (probe.paths.length === 0) {
        checks.push(makeCheck('lfs', true, 'no LFS-tracked paths in this tree; check passes vacuously'));
        return null;
    }
    const sample = probe.paths.slice(0, LFS_SAMPLE_SIZE);
    const pointers = [];
    let missing = 0;
    for (const relative of sample) {
        const state = classifyLfsFile(join(topLevel, relative));
        if (state === 'pointer') {
            pointers.push(relative);
        }
        else if (state === 'absent') {
            missing += 1;
        }
    }
    if (pointers.length > 0) {
        checks.push(makeCheck('lfs', false, `${pointers.length} of ${sample.length} sampled path(s) are pointer files`));
        return ckError('LFS', `git-lfs content is not present in ${topLevel}: ${pointers.join(', ')} ` +
            `${pointers.length === 1 ? 'is a' : 'are'} pointer file${pointers.length === 1 ? '' : 's'}, not the real content`, `run: git -C ${topLevel} lfs install --local && git -C ${topLevel} lfs pull`);
    }
    const detail = missing === 0 ? '' : `, ${missing} not checked out`;
    checks.push(makeCheck('lfs', true, `${probe.paths.length} tracked path(s), ${sample.length} sampled${detail}`));
    return null;
}
/** Is the file on disk real content, an lfs pointer, or not there at all? */
function classifyLfsFile(absolutePath) {
    // Only the first bytes are read: LFS targets are routinely tens of megabytes.
    const head = Buffer.alloc(LFS_POINTER_MARKER.length);
    let handle;
    try {
        handle = openSync(absolutePath, 'r');
    }
    catch {
        return 'absent';
    }
    try {
        const read = readSync(handle, head, 0, head.length, 0);
        return read === head.length && head.toString('utf8') === LFS_POINTER_MARKER ? 'pointer' : 'content';
    }
    finally {
        closeSync(handle);
    }
}
function checkWritable(tree, gitDir, checks) {
    const scratch = join(gitDir, 'codkit');
    const probe = join(scratch, '.write-probe');
    try {
        accessSync(tree, constants.W_OK);
        mkdirSync(scratch, { recursive: true });
        writeFileSync(probe, '');
        rmSync(probe, { force: true });
    }
    catch (error) {
        checks.push(makeCheck('write', false));
        return ckError('TREE-READONLY', `cannot write into ${scratch}: ${error instanceof Error ? error.message : String(error)}`, `give the current user write access to ${tree} (codkit writes its scratch state under ${scratch})`);
    }
    checks.push(makeCheck('write', true, `${scratch} is writable`));
    return null;
}
function checkClean(topLevel, config, checks) {
    const status = runGit({ args: ['status', '--porcelain'], cwd: topLevel });
    if (status.status !== 0) {
        checks.push(makeCheck('clean', false));
        return {
            checks,
            fatal: ckError('NOT-A-REPO', `git status failed in ${topLevel}: ${firstLine(status.stderr)}`, 'check that the fork tree is a healthy git work tree')
        };
    }
    // Own code lives in the tree but is owned by patchset: it is expected to differ
    // from the upstream pin and is never "dirt" (PROP-008 ##ID-CHECK-CLEAN).
    const ownPrefix = `${config.typeConfig.ownRoot}/`;
    const dirtyFiles = parsePorcelain(status.stdout).filter((path) => !path.startsWith(ownPrefix));
    const ok = dirtyFiles.length === 0;
    checks.push(makeCheck('clean', ok, ok ? `no changes outside ${ownPrefix}` : `${dirtyFiles.length} path(s) changed outside ${ownPrefix}`));
    return { checks, fatal: null, dirtyFiles };
}
/**
 * Paths out of `git status --porcelain` v1. For a rename the target path is the
 * one that matters here; `core.quotepath=false` (forced by gitx) keeps non-ASCII
 * paths unquoted, so only genuinely exotic names arrive quoted.
 */
function parsePorcelain(stdout) {
    const paths = [];
    for (const line of stdout.split('\n')) {
        if (line.length < 4) {
            continue;
        }
        const rest = line.slice(3);
        const arrow = rest.indexOf(' -> ');
        paths.push(unquote(arrow === -1 ? rest : rest.slice(arrow + 4)));
    }
    return paths;
}
function unquote(path) {
    return path.length >= 2 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}
function makeCheck(id, ok, info) {
    // exactOptionalPropertyTypes: the key is absent, never an explicit undefined.
    return info === undefined ? { id, name: CHECK_NAMES[id], ok } : { id, name: CHECK_NAMES[id], ok, info };
}
function shortSha(sha) {
    return sha.slice(0, 8);
}
function firstLine(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
        return 'no output';
    }
    const [line] = trimmed.split('\n');
    return line ?? 'no output';
}
