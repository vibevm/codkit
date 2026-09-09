/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Exact patchset-side cycle commits. The object is built through an isolated
// temporary index, proved, then installed with a compare-and-swap ref update.
// The checkout index is locked throughout and is never an input to the object.
import { closeSync, copyFileSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { gitLocal, runGit } from './gitx.js';
import { CAUSE_TRAILER, CYCLE_TRAILER } from './hooksPatchSet.js';
import { ckError, isCkError } from './messages.js';
import { repoRelativePathProblem, resolveContainedPath, safeBasenameProblem } from './pathSafety.js';
const FULL_SHA = /^[0-9a-f]{40}$/;
const FALLBACK_NAME = 'codkit cycle';
const FALLBACK_EMAIL = 'codkit-cycle@localhost.invalid';
export function commitCycleAtom(options) {
    const git = options.git ?? runGit;
    const localGit = options.localGit ?? gitLocal;
    const paths = validateInputs(options);
    const identity = commitIdentity(options.patchesDir, localGit);
    const epoch = canonicalEpoch(options.timestamp);
    const message = cycleCommitMessage(options.subject, options.targetTag, options.cause);
    assertRepositoryRoot(options.patchesDir, git);
    assertBranch(options.patchesDir, options.expectedBranch, git);
    const transaction = acquireIndexTransaction(options.patchesDir, git);
    try {
        const dirt = readDirt(options.patchesDir, git);
        const head = readSha(options.patchesDir, 'HEAD', 'commit', git);
        if (head !== options.expectedParent) {
            assertAbsolutelyClean(dirt, 'while resuming an installed cycle commit');
            const installedIdentity = receiptIdentity(options.patchesDir, head, epoch, git);
            if (isCanonicalCommit(options, head, paths, message, installedIdentity, epoch, git)) {
                return { status: 'resumed', sha: head };
            }
            throw ckError('CONFIG', `cycle commit expected parent ${options.expectedParent}, but HEAD is ${head}`);
        }
        assertRealIndexClean(dirt);
        assertNoUnexpectedWorktreeDirt(dirt, paths);
        const tempEnv = { GIT_INDEX_FILE: transaction.temporaryPath };
        mustGit(git, { args: ['read-tree', options.expectedParent], cwd: options.patchesDir, env: tempEnv }, 'cannot seed cycle index');
        const snapshots = snapshotPaths(options.patchesDir, paths, tempEnv, git);
        stageSnapshots(options.patchesDir, snapshots, tempEnv, git);
        const tree = mustSha(mustGit(git, { args: ['write-tree'], cwd: options.patchesDir, env: tempEnv }, 'cannot write exact cycle tree'), 'cycle tree');
        const parentTree = readSha(options.patchesDir, options.expectedParent, 'tree', git);
        if (tree === parentTree) {
            if (options.allowNoop === true) {
                return { status: 'noop', sha: null };
            }
            throw ckError('DIRTY-TREE', 'the exact cycle commit paths are unchanged', 'allow this no-op explicitly');
        }
        const created = mustGit(git, {
            args: ['commit-tree', tree, '-p', options.expectedParent, '-m', message],
            cwd: options.patchesDir,
            env: commitEnvironment(identity, epoch)
        }, 'cannot create exact cycle commit object');
        const sha = mustSha(created, 'cycle commit');
        if (!isCanonicalCommit(options, sha, paths, message, identity, epoch, git)) {
            throw ckError('INTERNAL', `Git created ${sha}, but its object is not the requested cycle atom`);
        }
        assertSnapshotsCurrent(options.patchesDir, snapshots, git);
        const ref = `refs/heads/${options.expectedBranch}`;
        const swapped = git({ args: ['update-ref', ref, sha, options.expectedParent], cwd: options.patchesDir });
        if (swapped.status !== 0) {
            throw ckError('LOCKED', `cycle branch changed before CAS: ${gitDetail(swapped)}`);
        }
        try {
            assertBranch(options.patchesDir, options.expectedBranch, git);
            assertSnapshotsCurrent(options.patchesDir, snapshots, git);
            promoteIndex(transaction);
        }
        catch (error) {
            const rolledBack = git({ args: ['update-ref', ref, options.expectedParent, sha], cwd: options.patchesDir });
            if (rolledBack.status !== 0) {
                throw ckError('INTERNAL', `cycle CAS rollback lost after reconciliation failure: ${messageOf(error)}`);
            }
            throw error;
        }
        if (readSha(options.patchesDir, 'HEAD', 'commit', git) !== sha) {
            throw ckError('INTERNAL', 'cycle branch changed immediately after installation');
        }
        assertAbsolutelyClean(readDirt(options.patchesDir, git), 'after installing the cycle commit');
        return { status: 'committed', sha };
    }
    finally {
        cleanupIndexTransaction(transaction);
    }
}
export function cycleCommitMessage(subject, targetTag, cause) {
    validateMessageInputs(subject, targetTag, cause);
    const trailers = cause === undefined ? [] : [`${CAUSE_TRAILER}: ${cause}`];
    trailers.push(`${CYCLE_TRAILER}: ${targetTag}`);
    return `${subject}\n\n${trailers.join('\n')}\n`;
}
export function validateCycleCommitReceipt(options) {
    if (!FULL_SHA.test(options.commitSha))
        throw ckError('ARTIFACT-BROKEN', 'cycle commit receipt sha is not one full commit id');
    const git = options.git ?? runGit;
    const paths = validateInputs(options);
    const epoch = canonicalEpoch(options.timestamp);
    const identity = receiptIdentity(options.patchesDir, options.commitSha, epoch, git);
    const message = cycleCommitMessage(options.subject, options.targetTag, options.cause);
    assertRepositoryRoot(options.patchesDir, git);
    if (!isCanonicalCommit(options, options.commitSha, paths, message, identity, epoch, git)) {
        throw ckError('ARTIFACT-BROKEN', `cycle commit ${options.commitSha} is not the exact recorded atom`);
    }
}
function receiptIdentity(patchesDir, sha, epoch, git) {
    const object = commitObject(patchesDir, sha, git);
    const author = parseReceiptIdentity(object.author, 'author', epoch);
    const committer = parseReceiptIdentity(object.committer, 'committer', epoch);
    if (author.name !== committer.name || author.email !== committer.email)
        throw ckError('ARTIFACT-BROKEN', `cycle commit ${sha} author and committer identities differ`);
    return author;
}
function parseReceiptIdentity(header, kind, epoch) {
    const match = new RegExp(`^${kind} (.+) <([^<>\\s]+)> ([0-9]+) \\+0000$`).exec(header);
    if (match === null || Number(match[3]) !== epoch)
        throw ckError('ARTIFACT-BROKEN', `cycle commit ${kind} identity or timestamp differs`);
    return { name: match[1] ?? '', email: match[2] ?? '' };
}
export function validateCycleCommitHistory(options) {
    if (!FULL_SHA.test(options.fromExclusive) || safeBasenameProblem(options.targetTag) !== null) {
        throw ckError('CONFIG', 'cycle history needs a full base sha and one portable target tag');
    }
    const git = options.git ?? runGit;
    assertRepositoryRoot(options.patchesDir, git);
    const end = readSha(options.patchesDir, options.toInclusive ?? 'HEAD', 'commit', git);
    if (git({ args: ['merge-base', '--is-ancestor', options.fromExclusive, end], cwd: options.patchesDir }).status !== 0) {
        throw ckError('LOG-INCOMPLETE', `${end} does not descend from cycle base ${options.fromExclusive}`);
    }
    const listed = mustGit(git, { args: ['rev-list', '--first-parent', '--reverse', `${options.fromExclusive}..${end}`], cwd: options.patchesDir }, 'cannot read first-parent cycle history');
    const commits = listed.stdout.split('\n').filter((line) => FULL_SHA.test(line));
    const fixCommits = [];
    for (const sha of commits) {
        if (commitParents(options.patchesDir, sha, git).length !== 1) {
            historyError(sha, 'is not a single-parent cycle commit');
        }
        const message = commitObject(options.patchesDir, sha, git).message;
        const fix = /^fix(?:\([^\n()]+\))?!?:\s/.test(message.split('\n', 1)[0] ?? '');
        assertCanonicalHistoryTrailers(sha, message, options.targetTag, fix);
        if (fix) {
            fixCommits.push(sha);
        }
    }
    return { commits, fixCommits };
}
function validateInputs(options) {
    if (!FULL_SHA.test(options.expectedParent)) {
        throw ckError('CONFIG', `cycle commit parent is not a full commit sha: ${options.expectedParent}`);
    }
    if (options.expectedBranch === '' || /[\r\n]/.test(options.expectedBranch)) {
        throw ckError('CONFIG', 'cycle commit expected branch is empty or multiline');
    }
    validateMessageInputs(options.subject, options.targetTag, options.cause);
    canonicalEpoch(options.timestamp);
    if (options.paths.length === 0) {
        throw ckError('CONFIG', 'cycle commit requires at least one explicit patchset-relative path');
    }
    const seen = new Set();
    for (const path of options.paths) {
        const problem = repoRelativePathProblem(path);
        if (problem !== null || path === '.git' || path.startsWith('.git/')) {
            throw ckError('CONFIG', `unsafe cycle commit path ${JSON.stringify(path)}${problem === null ? '' : `: ${problem}`}`);
        }
        if (seen.has(path)) {
            throw ckError('CONFIG', `cycle commit path is duplicated: ${path}`);
        }
        seen.add(path);
        const contained = resolveContainedPath(options.patchesDir, path, { allowMissing: true });
        if (!contained.ok) {
            throw ckError('CONFIG', `unsafe cycle commit path ${path}: ${contained.reason}`);
        }
    }
    return byteSort([...seen]);
}
function validateMessageInputs(subject, targetTag, cause) {
    if (subject === '' || subject.trim() !== subject || /[\r\n]/.test(subject)) {
        throw ckError('CONFIG', 'cycle commit subject must be one non-empty canonical line');
    }
    if (safeBasenameProblem(targetTag) !== null) {
        throw ckError('CONFIG', `cycle commit tag is not one portable basename: ${targetTag}`);
    }
    if (cause !== undefined && !FULL_SHA.test(cause)) {
        throw ckError('CONFIG', `${CAUSE_TRAILER} must be one full lowercase 40-hex sha, got ${JSON.stringify(cause)}`);
    }
}
function canonicalEpoch(timestamp) {
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp || milliseconds % 1000 !== 0) {
        throw ckError('CONFIG', `cycle commit timestamp is not canonical whole-second UTC: ${JSON.stringify(timestamp)}`);
    }
    return milliseconds / 1000;
}
function commitIdentity(patchesDir, localGit) {
    const identity = {
        name: localConfig(patchesDir, 'user.name', localGit) ?? FALLBACK_NAME,
        email: localConfig(patchesDir, 'user.email', localGit) ?? FALLBACK_EMAIL
    };
    if (identity.name.trim() === '' || /[\r\n<>]/.test(identity.name) || identity.email.trim() === '' || /[\s<>]/.test(identity.email)) {
        throw ckError('CONFIG', 'local Git identity is unsafe for an exact cycle commit');
    }
    return identity;
}
function localConfig(patchesDir, key, localGit) {
    const result = localGit({ args: ['config', '--get', key], cwd: patchesDir });
    const value = result.stdout.trim();
    return result.status === 0 && value !== '' ? value : null;
}
function acquireIndexTransaction(patchesDir, git) {
    const shown = mustGit(git, { args: ['rev-parse', '--git-path', 'index'], cwd: patchesDir }, 'cannot locate patchset index').stdout.trim();
    const indexPath = isAbsolute(shown) ? shown : resolve(patchesDir, shown);
    const lockPath = `${indexPath}.lock`;
    try {
        closeSync(openSync(lockPath, 'wx', 0o600));
    }
    catch (error) {
        throw ckError('LOCKED', `cannot lock patchset index: ${messageOf(error)}`);
    }
    return { indexPath, lockPath, temporaryPath: join(dirname(indexPath), `.codkit-cycle-index-${randomSuffix()}`), ownedLock: true };
}
function promoteIndex(transaction) {
    copyFileSync(transaction.temporaryPath, transaction.lockPath);
    renameSync(transaction.lockPath, transaction.indexPath);
    transaction.ownedLock = false;
}
function cleanupIndexTransaction(transaction) {
    removeIfPresent(transaction.temporaryPath);
    if (transaction.ownedLock) {
        removeIfPresent(transaction.lockPath);
    }
}
function removeIfPresent(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}
function snapshotPaths(patchesDir, paths, env, git) {
    return paths.map((path) => {
        const contained = resolveContainedPath(patchesDir, path, { allowMissing: true });
        if (!contained.ok) {
            throw ckError('CONFIG', `unsafe cycle commit path ${path}: ${contained.reason}`);
        }
        let stat;
        try {
            stat = lstatSync(contained.absolute);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return { path, oid: null, mode: null };
            }
            throw error;
        }
        if (!stat.isFile()) {
            throw ckError('CONFIG', `cycle commit path is not a regular file: ${path}`);
        }
        const baseMode = indexMode(patchesDir, path, env, git);
        const mode = process.platform === 'win32' && baseMode !== null ? baseMode : stat.mode & 0o111 ? '100755' : '100644';
        return { path, oid: rawPathOid(patchesDir, path, false, git), mode };
    });
}
function stageSnapshots(patchesDir, snapshots, env, git) {
    for (const snapshot of snapshots) {
        if (snapshot.oid === null || snapshot.mode === null) {
            mustGit(git, { args: ['update-index', '--force-remove', '--', snapshot.path], cwd: patchesDir, env }, `cannot stage deletion ${snapshot.path}`);
            continue;
        }
        const written = rawPathOid(patchesDir, snapshot.path, true, git);
        if (written !== snapshot.oid) {
            throw ckError('DIRTY-TREE', `cycle path changed while captured: ${snapshot.path}`);
        }
        mustGit(git, { args: ['update-index', '--add', '--cacheinfo', `${snapshot.mode},${snapshot.oid},${snapshot.path}`], cwd: patchesDir, env }, `cannot stage raw cycle path ${snapshot.path}`);
    }
}
function assertSnapshotsCurrent(patchesDir, snapshots, git) {
    for (const snapshot of snapshots) {
        const current = currentSnapshot(patchesDir, snapshot, git);
        if (current.oid !== snapshot.oid || current.mode !== snapshot.mode)
            throw ckError('DIRTY-TREE', `cycle path content or mode changed during commit CAS: ${snapshot.path}`);
    }
}
function rawPathOid(patchesDir, path, write, git) {
    const args = ['hash-object', ...(write ? ['-w'] : []), '--no-filters', '--', path];
    return mustSha(mustGit(git, { args, cwd: patchesDir }, `cannot hash raw cycle path ${path}`), `blob for ${path}`);
}
function currentSnapshot(patchesDir, expected, git) {
    try {
        const contained = resolveContainedPath(patchesDir, expected.path, { allowMissing: true });
        if (!contained.ok)
            throw ckError('DIRTY-TREE', `cycle path became unsafe during commit CAS: ${expected.path}`);
        const stat = lstatSync(contained.absolute);
        if (!stat.isFile())
            throw ckError('DIRTY-TREE', `cycle path stopped being a regular file: ${expected.path}`);
        const mode = process.platform === 'win32' ? expected.mode : stat.mode & 0o111 ? '100755' : '100644';
        return { oid: rawPathOid(patchesDir, expected.path, false, git), mode };
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { oid: null, mode: null };
        }
        throw error;
    }
}
function indexMode(patchesDir, path, env, git) {
    const shown = mustGit(git, { args: ['ls-files', '--stage', '--', path], cwd: patchesDir, env }, `cannot inspect mode ${path}`).stdout;
    return /^(100644|100755) [0-9a-f]{40} 0\t/.exec(shown)?.[1] ?? null;
}
function commitEnvironment(identity, epoch) {
    const date = `@${epoch} +0000`;
    return {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_COMMITTER_DATE: date
    };
}
function isCanonicalCommit(options, sha, paths, message, identity, epoch, git) {
    if (!FULL_SHA.test(sha) || commitParents(options.patchesDir, sha, git).join('') !== options.expectedParent) {
        return false;
    }
    const object = commitObject(options.patchesDir, sha, git);
    if (object.message !== message ||
        !sameIdentity(object.author, 'author', identity, epoch) ||
        !sameIdentity(object.committer, 'committer', identity, epoch)) {
        return false;
    }
    const changed = gitPaths(options.patchesDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha], git, `cannot inspect cycle commit ${sha}`);
    return samePaths(changed, paths);
}
function commitObject(patchesDir, sha, git) {
    const object = mustGit(git, { args: ['cat-file', 'commit', sha], cwd: patchesDir }, `cannot inspect commit ${sha}`).stdout;
    const separator = object.indexOf('\n\n');
    if (separator === -1) {
        throw ckError('INTERNAL', `commit ${sha} has no message separator`);
    }
    const headers = object.slice(0, separator).split('\n');
    return {
        message: object.slice(separator + 2),
        author: headers.find((line) => line.startsWith('author ')) ?? '',
        committer: headers.find((line) => line.startsWith('committer ')) ?? ''
    };
}
function sameIdentity(header, kind, identity, epoch) {
    return header === `${kind} ${identity.name} <${identity.email}> ${epoch} +0000`;
}
function assertCanonicalHistoryTrailers(sha, message, tag, fix) {
    const lines = message.endsWith('\n') ? message.slice(0, -1).split('\n') : message.split('\n');
    const reserved = lines.map((line, index) => ({ line, index })).filter(({ line }) => /(?:^|\s)(?:codkit-cycle|cause)\s*:/i.test(line));
    const cycleLine = `${CYCLE_TRAILER}: ${tag}`;
    const cycles = reserved.filter(({ line }) => /(?:^|\s)codkit-cycle\s*:/i.test(line));
    const causes = reserved.filter(({ line }) => /(?:^|\s)cause\s*:/i.test(line));
    if (cycles.length !== 1 || cycles[0]?.line !== cycleLine || cycles[0]?.index !== lines.length - 1) {
        historyError(sha, `must end in exactly one canonical ${cycleLine} trailer`);
    }
    if (causes.length > 1 || (fix && causes.length !== 1)) {
        historyError(sha, `has the wrong number of canonical ${CAUSE_TRAILER} trailers`);
    }
    const cause = causes[0];
    if (cause !== undefined && (!/^Cause: [0-9a-f]{40}$/.test(cause.line) || cause.index !== lines.length - 2)) {
        historyError(sha, `has a noncanonical ${CAUSE_TRAILER} trailer`);
    }
    const blockStart = cause === undefined ? lines.length - 1 : lines.length - 2;
    if (blockStart < 1 || lines[blockStart - 1] !== '' || reserved.length !== (cause === undefined ? 1 : 2)) {
        historyError(sha, 'does not have one isolated canonical terminal trailer block');
    }
}
function assertRepositoryRoot(patchesDir, git) {
    const top = mustGit(git, { args: ['rev-parse', '--show-toplevel'], cwd: patchesDir }, 'cannot identify patchset repository').stdout.trim();
    try {
        if (realpathSync(top) !== realpathSync(patchesDir)) {
            throw ckError('NOT-A-REPO', `${patchesDir} is not the root of its Git work tree`);
        }
    }
    catch (error) {
        if (isCkError(error)) {
            throw error;
        }
        throw ckError('NOT-A-REPO', `cannot resolve patchset repository: ${messageOf(error)}`);
    }
}
function assertBranch(patchesDir, expected, git) {
    const result = git({ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: patchesDir });
    const actual = result.stdout.trim();
    if (result.status !== 0 || actual !== expected) {
        throw ckError('CONFIG', `cycle commit requires branch ${expected}; current branch is ${actual || '(detached)'}`);
    }
}
function readDirt(patchesDir, git) {
    return {
        staged: gitPaths(patchesDir, ['diff', '--cached', '--name-only', '-z'], git, 'cannot inspect staged paths'),
        unstaged: gitPaths(patchesDir, ['diff', '--name-only', '-z'], git, 'cannot inspect unstaged paths'),
        untracked: gitPaths(patchesDir, ['ls-files', '--others', '--exclude-standard', '-z'], git, 'cannot inspect untracked paths')
    };
}
function assertRealIndexClean(dirt) {
    if (dirt.staged.length !== 0) {
        throw ckError('DIRTY-TREE', `cycle commit requires a clean real index; staged: ${showPaths(dirt.staged)}`);
    }
}
function assertNoUnexpectedWorktreeDirt(dirt, expected) {
    const allowed = new Set(expected);
    const unexpected = byteSort([...dirt.unstaged, ...dirt.untracked].filter((path) => !allowed.has(path)));
    if (unexpected.length !== 0) {
        throw ckError('DIRTY-TREE', `cycle commit found unexpected worktree dirt: ${showPaths(unexpected)}`);
    }
}
function assertAbsolutelyClean(dirt, context) {
    const paths = byteSort([...dirt.staged, ...dirt.unstaged, ...dirt.untracked]);
    if (paths.length !== 0) {
        throw ckError('DIRTY-TREE', `patchset must be absolutely clean ${context}: ${showPaths(paths)}`);
    }
}
function gitPaths(patchesDir, args, git, failure) {
    const result = mustGit(git, { args, cwd: patchesDir }, failure);
    if (result.stdout !== '' && !result.stdout.endsWith('\0')) {
        throw ckError('INTERNAL', `${failure}: output is not NUL-terminated`);
    }
    return byteSort(result.stdout === '' ? [] : result.stdout.slice(0, -1).split('\0'));
}
function commitParents(patchesDir, sha, git) {
    const line = mustGit(git, { args: ['rev-list', '--parents', '-n', '1', sha], cwd: patchesDir }, `cannot inspect parents of ${sha}`).stdout.trim();
    const fields = line.split(' ');
    return fields[0] === sha ? fields.slice(1) : [];
}
function readSha(patchesDir, ref, kind, git) {
    return mustSha(mustGit(git, { args: ['rev-parse', '--verify', `${ref}^{${kind}}`], cwd: patchesDir }, `cannot resolve ${ref}`), ref);
}
function mustSha(result, label) {
    const sha = result.stdout.trim();
    if (!FULL_SHA.test(sha)) {
        throw ckError('INTERNAL', `Git returned a malformed ${label} sha`);
    }
    return sha;
}
function mustGit(git, options, failure) {
    const result = git(options);
    if (result.status !== 0) {
        throw ckError('INTERNAL', `${failure}: ${gitDetail(result)}`);
    }
    return result;
}
function byteSort(paths) {
    return [...new Set(paths)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}
function samePaths(left, right) {
    return left.length === right.length && left.every((path, index) => path === right[index]);
}
function showPaths(paths) {
    return paths.length === 0 ? '(none)' : paths.map((path) => JSON.stringify(path)).join(', ');
}
function randomSuffix() {
    return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function gitDetail(result) {
    return (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? `git exited ${result.status}`;
}
function historyError(sha, problem) {
    throw ckError('LOG-INCOMPLETE', `cycle history commit ${sha} ${problem}`);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
