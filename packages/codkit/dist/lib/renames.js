/** @scope spec://codkit/modules/codkit/PROP-008#renames */
// Read-only rename discovery and a portable plan for moving one patch artifact.
// Detection reads git objects as bytes; planning returns serializable data only.
import { posix } from 'node:path';
import { decodeUtf8Strict } from './bytes.js';
import { runGitBytes } from './gitx.js';
import { ckError } from './messages.js';
import { repoRelativePathProblem } from './pathSafety.js';
import { encodePatchName } from './patchFormat.js';
const DEFAULT_THRESHOLD = 50;
const FULL_SHA = /^[0-9a-f]{40}$/;
const RENAME_STATUS = /^R([0-9]{3})$/;
const COPY_STATUS = /^C([0-9]{3})$/;
const SINGLE_PATH_STATUS = /^[ADMTUXB]$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\ufffd]/;
const SKIPPED_RENAME_WARNING = /(?:rename detection was skipped|skipping (?:inexact|exhaustive) rename detection)/i;
/** Discover every rename between two commits without consulting the work tree. */
export function detectRenames(options, git = runGitBytes) {
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    validateThreshold(threshold);
    validateRef(options.oldPin, 'oldPin');
    validateRef(options.newPin, 'newPin');
    const fromTargets = validateFromTargets(options.fromTargets);
    const oldSha = resolveCommit(options.cwd, options.oldPin, 'oldPin', git);
    const newSha = resolveCommit(options.cwd, options.newPin, 'newPin', git);
    const result = git({
        args: ['diff', '--name-status', '-z', `-M${threshold}%`, '-l0', oldSha, newSha],
        cwd: options.cwd
    });
    if (SKIPPED_RENAME_WARNING.test(result.stderr)) {
        throw ckError('INTERNAL', `git reported incomplete rename detection despite -l0: ${firstLine(result.stderr) ?? 'rename detection was skipped'}`, 'upgrade git and retry; codkit will not accept a partial rename map');
    }
    if (result.status !== 0) {
        throw gitFailure(`detect renames between ${oldSha} and ${newSha}`, result);
    }
    const renames = parseRenameNameStatus(result.stdout);
    return fromTargets === null ? renames : renames.filter((rename) => fromTargets.has(rename.from));
}
/** Parse the byte-exact NUL protocol emitted by `git diff --name-status -z`. */
export function parseRenameNameStatus(stdout) {
    const decoded = decodeUtf8Strict(stdout);
    if (decoded === null) {
        throw ckError('ENCODING', 'git rename output is not valid UTF-8', 'rename targets must be valid UTF-8 repository paths; rename or remove the offending upstream path');
    }
    if (decoded === '') {
        return [];
    }
    if (!decoded.endsWith('\0')) {
        throw malformed('output is not NUL-terminated');
    }
    const fields = decoded.split('\0');
    fields.pop();
    const renames = [];
    for (let index = 0; index < fields.length;) {
        const status = requiredField(fields, index, 'status');
        index += 1;
        const match = RENAME_STATUS.exec(status);
        if (match !== null) {
            const similarity = Number(requiredField(match, 1, 'rename similarity'));
            if (similarity > 100) {
                throw malformed(`rename similarity is outside 000..100: ${status}`);
            }
            const from = requiredGitPath(fields, index, status);
            const to = requiredGitPath(fields, index + 1, status);
            index += 2;
            renames.push({ from, to, similarity, needsReview: similarity < 100 });
            continue;
        }
        const copy = COPY_STATUS.exec(status);
        if (copy !== null) {
            const similarity = Number(requiredField(copy, 1, 'copy similarity'));
            if (similarity > 100) {
                throw malformed(`copy similarity is outside 000..100: ${status}`);
            }
            requiredGitPath(fields, index, status);
            requiredGitPath(fields, index + 1, status);
            index += 2;
            continue;
        }
        if (SINGLE_PATH_STATUS.test(status)) {
            requiredGitPath(fields, index, status);
            index += 1;
            continue;
        }
        throw malformed(`unknown name-status record: ${JSON.stringify(status)}`);
    }
    return renames;
}
/** Build a checked, ordered, serializable proposal; this function performs no I/O. */
export function planPatchArtifactRename(options) {
    const { rename } = options;
    validateRename(rename);
    const patchesDir = options.patchesDir ?? 'delta/patches';
    validateRepoPath(patchesDir, 'patches directory');
    const oldArtifactPath = posix.join(patchesDir, encodePatchName(rename.from));
    const newArtifactPath = posix.join(patchesDir, encodePatchName(rename.to));
    if (oldArtifactPath === newArtifactPath) {
        throw planError(`patch move has the same source and destination: ${oldArtifactPath}`);
    }
    const referenceReplacements = options.referenceReplacements ?? [];
    for (const replacement of referenceReplacements) {
        if (replacement.area !== 'contract-test' && replacement.area !== 'own-import') {
            throw planError(`reference replacement has invalid area: ${String(replacement.area)}`);
        }
    }
    const replacements = [
        { area: 'patch-header', file: oldArtifactPath, from: `--- a/${rename.from}`, to: `--- a/${rename.to}` },
        { area: 'patch-header', file: oldArtifactPath, from: `+++ b/${rename.from}`, to: `+++ b/${rename.to}` },
        ...referenceReplacements
    ];
    validateReplacements(replacements, oldArtifactPath, newArtifactPath);
    const operations = [
        ...replacements.map((replacement) => ({
            kind: 'replace',
            area: replacement.area,
            file: replacement.file,
            from: replacement.from,
            to: replacement.to
        })),
        { kind: 'move', from: oldArtifactPath, to: newArtifactPath }
    ];
    return {
        fromTarget: rename.from,
        toTarget: rename.to,
        similarity: rename.similarity,
        needsReview: rename.needsReview,
        oldArtifactPath,
        newArtifactPath,
        preconditions: [{ kind: 'destination-absent', path: newArtifactPath }],
        operations
    };
}
function resolveCommit(cwd, ref, name, git) {
    const result = git({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd });
    if (result.status !== 0) {
        throw ckError('PIN-UNREACHABLE', `${name} ${ref} does not resolve to one commit in the upstream repository`, 'fetch the commit outside codkit, then pass a commit sha, commit tag, or single commit revision');
    }
    const decoded = decodeUtf8Strict(result.stdout);
    if (decoded === null) {
        throw ckError('ENCODING', `git returned non-UTF-8 bytes while resolving ${name} ${ref}`, 'repair the repository and retry');
    }
    const sha = decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded;
    if (!FULL_SHA.test(sha)) {
        throw ckError('PIN-UNREACHABLE', `${name} ${ref} did not resolve to exactly one commit sha`, 'pass one commit, not a blob, tree, range, or revision set');
    }
    return sha;
}
function validateFromTargets(fromTargets) {
    if (fromTargets === undefined) {
        return null;
    }
    const targets = new Set();
    for (const target of fromTargets) {
        validateRepoPath(target, 'rename source filter');
        if (targets.has(target)) {
            throw ckError('CONFIG', `duplicate rename source filter: ${target}`, 'list each exact old target once');
        }
        targets.add(target);
    }
    return targets;
}
function validateReplacements(replacements, oldArtifactPath, newArtifactPath) {
    const byAddress = new Map();
    for (const replacement of replacements) {
        if (!['patch-header', 'contract-test', 'own-import'].includes(replacement.area)) {
            throw planError(`unknown replacement area: ${String(replacement.area)}`);
        }
        validateRepoPath(replacement.file, `${replacement.area} replacement file`);
        validateReplacementText(replacement.from, 'replacement source');
        validateReplacementText(replacement.to, 'replacement destination');
        if (replacement.from === replacement.to) {
            throw planError(`replacement in ${replacement.file} has identical source and destination`);
        }
        if (replacement.file === newArtifactPath) {
            throw planError(`replacement collides with destination-absent path ${newArtifactPath}`);
        }
        if (replacement.area !== 'patch-header' && replacement.file === oldArtifactPath) {
            throw planError(`reference replacement collides with patch artifact ${oldArtifactPath}`);
        }
        const address = `${replacement.file}\0${replacement.from}`;
        const previous = byAddress.get(address);
        if (previous !== undefined) {
            const kind = previous.to === replacement.to ? 'duplicate' : 'colliding';
            throw planError(`${kind} replacements for ${replacement.file}: ${JSON.stringify(replacement.from)}`);
        }
        for (const other of byAddress.values()) {
            if (other.file === replacement.file && (other.to === replacement.from || replacement.to === other.from)) {
                throw planError(`chained replacements collide in ${replacement.file}`);
            }
        }
        byAddress.set(address, replacement);
    }
}
function validateRename(rename) {
    validateRepoPath(rename.from, 'old rename target');
    validateRepoPath(rename.to, 'new rename target');
    if (rename.from === rename.to) {
        throw planError(`rename source and destination are identical: ${rename.from}`);
    }
    if (!Number.isInteger(rename.similarity) || rename.similarity < 0 || rename.similarity > 100) {
        throw planError(`invalid rename similarity: ${rename.similarity}`);
    }
    if (rename.needsReview !== rename.similarity < 100) {
        throw planError(`rename review flag disagrees with similarity ${rename.similarity}`);
    }
}
function validateThreshold(threshold) {
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
        throw ckError('CONFIG', `invalid rename similarity threshold: ${threshold}`, 'use an integer percentage from 0 to 100');
    }
}
function validateRef(ref, name) {
    if (ref === '' || ref !== ref.trim() || ref.startsWith('-') || /\s/u.test(ref) || UNSAFE_TEXT.test(ref)) {
        throw ckError('CONFIG', `invalid ${name} for rename detection: ${JSON.stringify(ref)}`, 'use a commit sha, tag, or single revision without control characters');
    }
}
function validateRepoPath(path, label) {
    const problem = repoRelativePathProblem(path);
    if (problem !== null || UNSAFE_TEXT.test(path)) {
        throw ckError('CONFIG', `invalid ${label}: ${JSON.stringify(path)}${problem === null ? '' : ` ${problem}`}`, 'use a portable non-empty POSIX path relative to the repository root');
    }
}
function validateReplacementText(text, label) {
    if (text === '' || UNSAFE_TEXT.test(text)) {
        throw planError(`${label} is empty or contains a control/replacement character`);
    }
}
function requiredGitPath(fields, index, status) {
    const path = fields[index];
    if (path === undefined || path === '') {
        throw malformed(`${status} record is missing a path`);
    }
    if (UNSAFE_TEXT.test(path)) {
        const replacement = path.includes('\ufffd');
        throw ckError(replacement ? 'ENCODING' : 'ARTIFACT-BROKEN', `git rename path contains ${replacement ? 'a replacement character' : 'a control character'}: ${JSON.stringify(path)}`, 'rename the upstream path to portable UTF-8 text before upgrading');
    }
    const problem = repoRelativePathProblem(path);
    if (problem !== null) {
        throw ckError('ARTIFACT-BROKEN', `git rename path ${JSON.stringify(path)} ${problem}`, 'rename the upstream path to a portable repository-relative name before upgrading');
    }
    return path;
}
function requiredField(fields, index, label) {
    const field = fields[index];
    if (field === undefined || field === '') {
        throw malformed(`missing ${label}`);
    }
    return field;
}
function gitFailure(action, result) {
    const decoded = decodeUtf8Strict(result.stdout);
    if (decoded === null) {
        throw ckError('ENCODING', `git returned non-UTF-8 bytes while trying to ${action}`, 'repair the repository and retry');
    }
    const detail = firstLine(result.stderr) ?? firstLine(decoded) ?? `git exited with status ${result.status}`;
    return ckError('PIN-UNREACHABLE', `cannot ${action}: ${detail}`, 'check that both resolved commits are readable in the upstream repository');
}
function malformed(reason) {
    return ckError('INTERNAL', `malformed git rename output: ${reason}`, 'git --name-status -z must emit complete NUL-delimited records');
}
function planError(reason) {
    return ckError('ARTIFACT-BROKEN', `cannot plan patch rename: ${reason}`, 'repair the rename inputs before applying any filesystem changes');
}
function firstLine(text) {
    const trimmed = text.trim();
    return trimmed === '' ? null : (trimmed.split('\n')[0] ?? null);
}
