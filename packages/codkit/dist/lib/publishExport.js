/** @scope spec://codkit/modules/codkit/PROP-007#PUBLISH-EXPORT */
// `publish --export-bare <dir>` and `--export-repo <dir>` (PROP-007
// ##PUBLISH-EXPORT): the release written into a new local repository the
// command creates, instead of pushed into `publishRemoteUrl`.
//
// The repository starts from an empty template, so no hook and no file of a
// template of the machine goes in; its objects are one pack that
// `pack-objects --revs` writes from the disposable fork straight into its
// object directory - exactly what the tip reaches, with no alternates and no
// remote; its refs are written without a reflog, so no identity of the machine
// goes in either. The git-lfs objects of the tip come along unless --no-lfs
// left them out (##PUBLISH-EXPORT-LFS). Nothing here reaches the network: no
// git call below is one `gitx` counts as a network call.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { messageOf } from './configFile.js';
import { gitOk } from './gitx.js';
import { ckError } from './messages.js';
import { configureLfsFilters, copyLfsObjects, tipLfsObjects } from './publishExportLfs.js';
/** The configuration a working tree of an export needs to be the bytes of the release on any machine. */
const WORKING_TREE_CONFIG = [
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf']
];
/** The machine's attribute files stay out of the checkout of an export. */
const CHECKOUT_CONFIG = ['-c', 'core.attributesFile=/dev/null'];
const CHECKOUT_ENV = { GIT_ATTR_NOSYSTEM: '1' };
const NO_REFLOG = ['-c', 'core.logAllRefUpdates=false'];
const REMOVE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
/** ##PUBLISH-EXPORT: `--export-bare` and `--export-repo` exclude each other; both is refused before any gate. */
export function exportFlagsRefusal() {
    return ckError('CONFIG', '--export-bare and --export-repo exclude each other', 'give one: --export-bare <dir> for a bare repository, --export-repo <dir> for a repository with a working tree');
}
/** `--export-bare <dir>` or `--export-repo <dir>` as given: absolute, or relative to the current directory. */
export function exportRequestOf(kind, given, cwd) {
    return { kind, path: resolve(cwd, given) };
}
/**
 * ##PUBLISH-EXPORT: the directory does not exist or is empty, its parent
 * exists, and it is neither the patch-set directory nor the fork tree nor
 * inside either of them - on their real paths, ignoring case on Windows.
 */
export function assertExportTarget(request, patchesDir, forkTree) {
    const parent = dirname(request.path);
    if (!isDirectory(parent)) {
        throw ckError('CONFIG', `the parent of the export directory does not exist: ${parent}`, 'create it, or name a directory whose parent exists');
    }
    if (existsSync(request.path)) {
        if (!isDirectory(request.path)) {
            throw ckError('CONFIG', `the export path is not a directory: ${request.path}`, 'name a new directory, or an empty one');
        }
        if (readdirSync(request.path).length > 0) {
            throw ckError('CONFIG', `the export directory is not empty: ${request.path}`, 'an export creates a new repository: name a new or an empty directory; a second export into the same one is refused');
        }
    }
    const target = existsSync(request.path) ? realpathSync(request.path) : join(realpathSync(parent), basename(request.path));
    for (const [owner, root] of [
        ['patch-set directory', patchesDir],
        ['fork tree', forkTree]
    ]) {
        if (contains(realOrResolved(root), target)) {
            throw ckError('CONFIG', `the export directory ${request.path} is inside the ${owner} ${root}`, 'name a directory outside the patch set and the fork tree');
        }
    }
}
/**
 * The new repository of an export, created and filled; a failure removes what
 * this run created and leaves a directory that existed empty as it was.
 */
export function writeExport(options) {
    const { request } = options;
    if (existsSync(request.path) && readdirSync(request.path).length > 0) {
        throw ckError('CONFIG', `the export directory is not empty any more: ${request.path}`, 'name a new or an empty directory and run again');
    }
    // Every git-lfs object is found and checked before the repository exists.
    const lfs = options.keepLfs
        ? tipLfsObjects({
            forkDir: options.forkDir,
            scratchDir: join(options.scratchDir, 'lfs'),
            tip: options.tip,
            forkTree: options.forkTree,
            pinSha: options.pinSha
        })
        : [];
    const existed = existsSync(request.path);
    try {
        const gitDir = createRepository(options);
        options.created?.();
        git(options.forkDir, ['pack-objects', '--revs', '--delta-base-offset', '-q', join(gitDir, 'objects', 'pack', 'pack')], 'cannot write the objects of the release into the export', `${options.tip}\n`);
        const refs = [options.branchRef, ...(options.tagRef === null ? [] : [options.tagRef])];
        git(request.path, [...NO_REFLOG, 'update-ref', '--stdin'], 'cannot write the refs of the export', refs.map((ref) => `create ${ref} ${options.tip}\n`).join(''));
        if (lfs.length > 0) {
            const storage = copyLfsObjects(lfs, gitDir);
            options.out.info(`export: ${lfs.length} git-lfs object(s) of the tip copied into ${storage} and checked`);
        }
        if (request.kind === 'repository') {
            const smudged = lfs.length > 0 && configureLfsFilters(request.path);
            // The checkout runs no hook. git-lfs, which its smudge starts, installs
            // its hooks into core.hooksPath, and it reads the /dev/null of codkit's
            // isolated git as a directory of the working tree on Windows: the
            // repository's own hooks directory is named instead.
            const hooks = ['-c', `core.hooksPath=${join(gitDir, 'hooks')}`];
            gitOk({ args: [...CHECKOUT_CONFIG, ...hooks, 'read-tree', '-m', '-u', 'HEAD'], cwd: request.path, env: CHECKOUT_ENV }, { code: 'CONFIG', message: `cannot check out the release in ${request.path}` });
            if (lfs.length > 0 && !smudged) {
                const paths = lfs.reduce((count, object) => count + object.paths.length, 0);
                options.out.warn(`git-lfs is not installed: the working tree of ${request.path} holds the git-lfs pointers of ${paths} path(s); their objects are in its lfs storage`);
            }
        }
        return { kind: request.kind, path: request.path, lfsObjects: lfs.length };
    }
    catch (error) {
        removeCreated(request.path, existed, options.out);
        throw error;
    }
}
/** `git init` from an empty template, in the object format of the fork, the release branch as HEAD. */
function createRepository(options) {
    const { request } = options;
    const template = join(options.scratchDir, 'export-template');
    mkdirSync(template, { recursive: true });
    const format = git(options.forkDir, ['rev-parse', '--show-object-format'], 'cannot read the object format of the disposable fork');
    const branch = options.branchRef.slice('refs/heads/'.length);
    git(dirname(request.path), [
        'init',
        '--quiet',
        ...(request.kind === 'bare' ? ['--bare'] : []),
        `--template=${template}`,
        `--object-format=${format}`,
        `--initial-branch=${branch}`,
        request.path
    ], `cannot create the export repository ${request.path}`);
    const config = [
        ['core.longpaths', 'true'],
        ...(request.kind === 'repository' ? WORKING_TREE_CONFIG : [])
    ];
    for (const [key, value] of config)
        git(request.path, ['config', key, value], `cannot configure the export repository ${request.path}`);
    return request.kind === 'bare' ? request.path : join(request.path, '.git');
}
function removeCreated(path, existed, out) {
    try {
        if (!existed)
            rmSync(path, REMOVE);
        else
            for (const entry of readdirSync(path))
                rmSync(join(path, entry), REMOVE);
    }
    catch (error) {
        out.warn(`the export ${path} of the failed run could not be removed: ${messageOf(error)}`);
    }
}
function contains(root, path) {
    const fold = (text) => (process.platform === 'win32' ? text.toLowerCase() : text);
    const base = fold(root.endsWith(sep) ? root.slice(0, -1) : root);
    const candidate = fold(path);
    return candidate === base || candidate.startsWith(`${base}${sep}`);
}
function realOrResolved(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
function isDirectory(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function git(cwd, args, message, input) {
    return gitOk(input === undefined ? { args, cwd } : { args, cwd, input }, { code: 'CONFIG', message }).stdout.trim();
}
