/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
// Checkout-form reads for an object-only rebase tree. Canonical object identity
// remains separate from bytes produced by the fork repository's local filters.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGit, runGitBytes } from './gitx.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
const OPTIONAL_LOCKS_OFF = { GIT_OPTIONAL_LOCKS: '0' };
export function createRebaseCheckoutContext(objectCwd, worktreeRoot) {
    const gitDirResult = runGit({ args: ['rev-parse', '--absolute-git-dir'], cwd: objectCwd, env: OPTIONAL_LOCKS_OFF });
    const gitDir = gitDirResult.stdout.trim();
    if (gitDirResult.status !== 0 || !isAbsolute(gitDir))
        checkoutError('cannot locate the object repository for checkout filters');
    const config = runGit({ args: ['config', '--local', '--null', '--list'], cwd: worktreeRoot, env: OPTIONAL_LOCKS_OFF });
    if (config.status !== 0)
        checkoutError('cannot read isolated fork filter configuration');
    const args = [];
    for (const item of config.stdout.split('\0').filter(Boolean)) {
        const separator = item.indexOf('\n');
        if (separator < 1)
            checkoutError('fork filter configuration is malformed');
        const key = item.slice(0, separator);
        if (!/^(?:filter\.|core\.checkroundtripencoding$)/.test(key))
            continue;
        args.push('-c', `${key}=${item.slice(separator + 1)}`);
    }
    const lfs = runGit({ args: ['lfs', 'env'], cwd: worktreeRoot, env: OPTIONAL_LOCKS_OFF });
    const storageMatch = /^LfsStorageDir=(.+)$/m.exec(lfs.stdout);
    const lfsStorageDir = lfs.status === 0 && storageMatch !== null ? (storageMatch[1]?.trim() ?? null) : null;
    const offlineLfsUrl = pathToFileURL(join(gitDir, 'codkit-offline-lfs-remote')).href;
    const semantics = readRebaseWorktreeSemantics(worktreeRoot);
    args.push('-c', `core.filemode=${semantics.fileMode ? 'true' : 'false'}`, '-c', `core.symlinks=${semantics.symlinks ? 'true' : 'false'}`);
    const checkoutRoot = mkdtempSync(join(tmpdir(), 'codkit-rebase-checkout-'));
    return {
        objectCwd,
        checkoutRoot,
        args,
        env: {
            GIT_DIR: gitDir,
            GIT_WORK_TREE: checkoutRoot,
            GIT_LFS_SKIP_SMUDGE: '0',
            GIT_LFS_SKIP_DOWNLOAD_ERRORS: '0',
            ...OPTIONAL_LOCKS_OFF
        },
        lfsStorageDir,
        offlineLfsUrl,
        semantics,
        trees: new Map()
    };
}
export function releaseRebaseCheckoutContext(context) {
    rmSync(context.checkoutRoot, { recursive: true, force: true });
}
export function readRebaseWorktreeSemantics(worktreeRoot) {
    return {
        fileMode: booleanConfig(worktreeRoot, 'core.filemode', true),
        symlinks: booleanConfig(worktreeRoot, 'core.symlinks', true)
    };
}
export function rebaseTreeEntry(context, tree, path) {
    const object = rebaseTreeObject(context.objectCwd, tree, path);
    if (object === null)
        return null;
    const blob = runGitBytes({ args: ['cat-file', 'blob', object.oid], cwd: context.objectCwd, env: OPTIONAL_LOCKS_OFF });
    if (blob.status !== 0)
        checkoutError(`cannot read ${path} at ${tree}`);
    const bytes = object.mode === '120000' ? blob.stdout : filteredBlob(context, tree, path, blob.stdout);
    return { digest: { sha256: hash(bytes), mode: checkoutMode(object.mode, context.semantics) }, object, bytes };
}
/** Exact tree-seeded index plus the tree's checkout attributes and local filters. */
export function rebaseCheckoutIndex(context, tree) {
    const treeContext = contextForTree(context, tree);
    const lfsArgs = context.lfsStorageDir === null ? [] : ['-c', `lfs.storage=${context.lfsStorageDir}`, '-c', `lfs.url=${context.offlineLfsUrl}`];
    return {
        cwd: treeContext.worktree,
        args: [...context.args, ...lfsArgs],
        env: {
            ...context.env,
            GIT_INDEX_FILE: treeContext.index,
            GIT_WORK_TREE: treeContext.worktree,
            GIT_OPTIONAL_LOCKS: '0'
        }
    };
}
export function rebaseTreeObject(cwd, tree, path) {
    const listed = runGit({ args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', tree, '--', path], cwd, env: OPTIONAL_LOCKS_OFF });
    if (listed.status !== 0 || (listed.stdout !== '' && !listed.stdout.endsWith('\0')))
        checkoutError(`cannot inspect ${path} at ${tree}`);
    if (listed.stdout === '')
        return null;
    const directory = /^040000 tree [0-9a-f]{40}\t(.+)\0$/.exec(listed.stdout);
    if (directory?.[1] === path)
        return null;
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)\0$/.exec(listed.stdout);
    if (match === null || match[3] !== path)
        checkoutError(`${path} is not one supported blob at ${tree}`);
    return { oid: match[2] ?? '', mode: match[1] };
}
function filteredBlob(context, tree, path, raw) {
    const treeContext = contextForTree(context, tree);
    const env = { ...context.env, GIT_INDEX_FILE: treeContext.index, GIT_WORK_TREE: treeContext.worktree };
    const attribute = runGit({
        args: [...context.args, 'check-attr', '-z', 'filter', '--', path],
        cwd: treeContext.worktree,
        env
    });
    const fields = attribute.stdout.split('\0');
    if (attribute.status !== 0 || fields[0] !== path || fields[1] !== 'filter' || fields.length !== 4) {
        checkoutError(`${path}: cannot resolve checkout filter attributes at ${tree}`);
    }
    const filter = fields[2] ?? '';
    const pointer = filter === 'lfs' ? lfsPointer(raw) : null;
    if (filter === 'lfs' && pointer === null)
        checkoutError(`${path}: LFS filter is attached to a non-pointer canonical blob`);
    if (pointer !== null)
        assertLocalLfsObject(context, path, pointer);
    const lfsArgs = pointer === null || context.lfsStorageDir === null
        ? []
        : ['-c', `lfs.storage=${context.lfsStorageDir}`, '-c', `lfs.url=${context.offlineLfsUrl}`];
    const materialized = runGitBytes({
        args: [...context.args, ...lfsArgs, 'cat-file', '--filters', `--path=${path}`, `${tree}:${path}`],
        cwd: treeContext.worktree,
        env,
        maxBuffer: 1024 * 1024 * 1024
    });
    if (materialized.status !== 0) {
        checkoutError(`${path}: checkout filter failed without network access: ${materialized.stderr.trim() || 'git filter error'}`);
    }
    if (pointer !== null && (materialized.stdout.byteLength !== pointer.size || hash(materialized.stdout) !== pointer.oid)) {
        checkoutError(`${path}: LFS filter did not produce the required local object`);
    }
    return materialized.stdout;
}
function contextForTree(context, tree) {
    const existing = context.trees.get(tree);
    if (existing !== undefined)
        return existing;
    if (!/^[0-9a-f]{40}$/.test(tree))
        checkoutError(`cannot bind checkout attributes to invalid tree ${tree}`);
    const index = join(context.checkoutRoot, `${tree}.index`);
    const worktree = join(context.checkoutRoot, tree);
    mkdirSync(worktree);
    const loaded = runGit({ args: ['read-tree', tree], cwd: context.checkoutRoot, env: { ...context.env, GIT_INDEX_FILE: index } });
    if (loaded.status !== 0)
        checkoutError(`cannot bind checkout attributes to tree ${tree}`);
    materializeAttributes(context, tree, worktree);
    const created = { index, worktree };
    context.trees.set(tree, created);
    return created;
}
function materializeAttributes(context, tree, worktree) {
    const listed = runGit({ args: ['ls-tree', '-r', '-z', '--full-tree', tree], cwd: context.objectCwd, env: OPTIONAL_LOCKS_OFF });
    if (listed.status !== 0 || (listed.stdout !== '' && !listed.stdout.endsWith('\0'))) {
        checkoutError(`cannot enumerate checkout attributes at tree ${tree}`);
    }
    for (const record of listed.stdout.split('\0').filter(Boolean)) {
        const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
        if (match === null)
            continue;
        const path = match[3] ?? '';
        if (path !== '.gitattributes' && !path.endsWith('/.gitattributes'))
            continue;
        const target = resolveContainedPath(worktree, path, { allowMissing: true });
        if (!target.ok)
            checkoutError(`${path}: unsafe attribute path at tree ${tree}: ${target.reason}`);
        const blob = runGitBytes({ args: ['cat-file', 'blob', match[2] ?? ''], cwd: context.objectCwd, env: OPTIONAL_LOCKS_OFF });
        if (blob.status !== 0)
            checkoutError(`${path}: cannot read checkout attributes at tree ${tree}`);
        mkdirSync(dirname(target.absolute), { recursive: true });
        writeFileSync(target.absolute, blob.stdout, { flag: 'wx' });
    }
}
function checkoutMode(mode, semantics) {
    if (mode === '120000' && !semantics.symlinks)
        return '100644';
    if (mode === '100755' && !semantics.fileMode)
        return '100644';
    return mode;
}
function booleanConfig(cwd, key, fallback) {
    const result = runGit({
        args: ['config', '--type=bool', `--default=${fallback ? 'true' : 'false'}`, '--get', key],
        cwd,
        env: OPTIONAL_LOCKS_OFF
    });
    const value = result.stdout.trim();
    if (result.status !== 0 || (value !== 'true' && value !== 'false'))
        checkoutError(`cannot read isolated ${key} checkout setting`);
    return value === 'true';
}
function lfsPointer(bytes) {
    const text = Buffer.from(bytes).toString('utf8');
    const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize ([0-9]+)\n$/.exec(text);
    if (match === null)
        return null;
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0)
        return null;
    return { oid: match[1] ?? '', size };
}
function assertLocalLfsObject(context, path, pointer) {
    if (context.lfsStorageDir === null)
        checkoutError(`${path}: git-lfs is unavailable for a required checkout filter`);
    const object = join(context.lfsStorageDir, 'objects', pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
    try {
        const stat = lstatSync(object);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== pointer.size) {
            checkoutError(`${path}: required local LFS object is invalid`);
        }
    }
    catch (error) {
        if (error.code === 'ENOENT')
            checkoutError(`${path}: required local LFS object is unavailable`);
        throw error;
    }
}
function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function checkoutError(reason) {
    throw ckError('DIRTY-TREE', `cannot materialize rebase target: ${reason}`, 'remove unrelated work or retry the exact pending rebase transaction');
}
