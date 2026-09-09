/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUtf8Strict } from './bytes.js';
import { runGit, runGitBytes } from './gitx.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
import { z } from 'zod';
const SHA = /^[0-9a-f]{40}$/;
const repositorySnapshotSchema = z
    .object({
    head: z.string().regex(SHA),
    ref: z.string().min(1).nullable(),
    dirty: z.boolean(),
    statusDigest: z.string().regex(/^[0-9a-f]{64}$/),
    contentDigest: z.string().regex(/^[0-9a-f]{64}$/)
})
    .strict();
export const cycleLiveSnapshotSchema = z
    .object({
    patchset: repositorySnapshotSchema,
    fork: repositorySnapshotSchema.extend({ targetCommit: z.string().regex(SHA), targetTree: z.string().regex(SHA) }).strict()
})
    .strict();
export function captureCycleLiveSnapshot(patchesDir, forkDir, targetSha, options = {}) {
    const targetCommit = requiredGit(forkDir, ['rev-parse', '--verify', `${targetSha}^{commit}`], 'target commit');
    if (targetCommit !== targetSha)
        throw broken(`target pin resolved to ${targetCommit}, not ${targetSha}`);
    return {
        patchset: repositorySnapshot(patchesDir, true, options),
        fork: {
            ...repositorySnapshot(forkDir, false, options),
            targetCommit,
            targetTree: requiredGit(forkDir, ['rev-parse', `${targetSha}^{tree}`], 'target tree')
        }
    };
}
function repositorySnapshot(cwd, excludeReport, options) {
    assertNoTrackedRuntime(cwd);
    const head = requiredGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'HEAD');
    const symbolic = runGit({ args: ['symbolic-ref', '--quiet', 'HEAD'], cwd });
    if (symbolic.status !== 0 && symbolic.status !== 1)
        throw broken(`cannot inspect ref in ${cwd}: ${diagnostic(symbolic.stderr)}`);
    const paths = ['--', '.', ':(exclude).codkit/**', ...(excludeReport ? [':(exclude)cycle/report/stabilize.json'] : [])];
    const status = requiredBytes(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...paths], 'status');
    const unstaged = requiredBytes(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', ...paths], 'unstaged diff');
    const staged = requiredBytes(cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', ...paths], 'staged diff');
    const untracked = requiredBytes(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...paths], 'untracked paths');
    assertNoUntrackedSpecials(cwd, excludeReport);
    return {
        head,
        ref: symbolic.status === 0 ? symbolic.stdout.trim() : null,
        dirty: status.length !== 0,
        statusDigest: createHash('sha256').update(status).digest('hex'),
        contentDigest: contentDigest(cwd, unstaged, staged, untracked, options)
    };
}
function assertNoTrackedRuntime(cwd) {
    const tracked = requiredBytes(cwd, ['ls-files', '-z', '--', '.codkit/**'], 'tracked codkit runtime paths');
    if (tracked.length !== 0)
        throw broken('tracked content exists under reserved runtime namespace .codkit/');
}
function assertNoUntrackedSpecials(cwd, excludeReport, directory = cwd, prefix = '') {
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' });
    }
    catch (error) {
        throw broken(`cannot inspect repository directory ${JSON.stringify(prefix || '.')}: ${messageOf(error)}`);
    }
    for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (path === '.git' || path === '.codkit' || (excludeReport && path === 'cycle/report/stabilize.json'))
            continue;
        if (entry.isDirectory()) {
            assertNoUntrackedSpecials(cwd, excludeReport, join(directory, entry.name), path);
            continue;
        }
        if (entry.isFile())
            continue;
        const tracked = runGit({ args: ['ls-files', '--error-unmatch', '--', path], cwd });
        if (tracked.status === 0)
            continue;
        if (tracked.status !== 1)
            throw broken(`cannot inspect whether special path ${JSON.stringify(path)} is tracked`);
        const ignored = runGit({ args: ['check-ignore', '--quiet', '--', path], cwd });
        if (ignored.status === 0)
            continue;
        if (ignored.status !== 1)
            throw broken(`cannot inspect whether special path ${JSON.stringify(path)} is ignored`);
        throw broken(`untracked special path is not a regular file: ${JSON.stringify(path)}`);
    }
}
function contentDigest(cwd, unstaged, staged, untrackedBytes, options) {
    const hash = createHash('sha256');
    hashPart(hash, 'unstaged', unstaged);
    hashPart(hash, 'staged', staged);
    const paths = nulPaths(untrackedBytes).sort(compareBytes);
    for (const path of paths) {
        const { stat, bytes } = readUntrackedFile(cwd, path, options);
        hashPart(hash, `untracked-path:${path}`, new Uint8Array());
        hashPart(hash, `untracked-mode:${(stat.mode & 0o7777).toString(8).padStart(4, '0')}`, bytes);
    }
    return hash.digest('hex');
}
function readUntrackedFile(cwd, path, options) {
    const resolved = resolveContainedPath(cwd, path);
    if (!resolved.ok)
        throw broken(`unsafe untracked path ${JSON.stringify(path)}: ${resolved.reason}`);
    const nonblock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
    const nofollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : null;
    let fd = null;
    try {
        const before = strictRegularLstat(resolved.absolute, path);
        options.beforeUntrackedOpen?.(cwd, path);
        fd = openSync(resolved.absolute, constants.O_RDONLY | nonblock | (nofollow ?? 0));
        const opened = fstatSync(fd);
        if (!opened.isFile())
            throw new Error('opened object is not a regular file');
        const after = strictRegularLstat(resolved.absolute, path);
        if (!sameInode(before, opened) || !sameInode(opened, after))
            throw new Error('path or an ancestor changed while it was opened');
        return { stat: opened, bytes: readFileSync(fd) };
    }
    catch (error) {
        throw broken(`cannot safely read untracked regular file ${JSON.stringify(path)}: ${messageOf(error)}`);
    }
    finally {
        if (fd !== null)
            closeSync(fd);
    }
}
function strictRegularLstat(absolute, path) {
    const stat = lstatSync(absolute);
    if (!stat.isFile())
        throw new Error(`${path} is not a regular file`);
    return stat;
}
function sameInode(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function nulPaths(bytes) {
    if (bytes.length === 0)
        return [];
    if (bytes.at(-1) !== 0)
        throw broken('untracked path list is not NUL-terminated');
    const paths = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== 0)
            continue;
        const path = decodeUtf8Strict(bytes.slice(start, index));
        if (path === null || path === '')
            throw broken('untracked path is empty or not UTF-8');
        paths.push(path);
        start = index + 1;
    }
    if (new Set(paths).size !== paths.length)
        throw broken('untracked path list contains duplicates');
    return paths;
}
function hashPart(hash, label, bytes) {
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(BigInt(bytes.length));
    hash
        .update(label)
        .update(new Uint8Array([0]))
        .update(header)
        .update(bytes);
}
function requiredBytes(cwd, args, label) {
    const result = runGitBytes({ args, cwd });
    if (result.status !== 0)
        throw broken(`cannot inspect ${label} in ${cwd}: ${diagnostic(result.stderr)}`);
    return result.stdout;
}
function compareBytes(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function requiredGit(cwd, args, label) {
    const result = runGit({ args, cwd });
    const value = result.stdout.trim();
    if (result.status !== 0 || !SHA.test(value))
        throw broken(`cannot inspect ${label} in ${cwd}: ${diagnostic(result.stderr)}`);
    return value;
}
function diagnostic(stderr) {
    return stderr.trim().split(/\r?\n/, 1)[0] || 'git returned no diagnosis';
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function broken(message) {
    return ckError('CONFIG', message, 'restore both cycle repositories to the expected live state and retry');
}
