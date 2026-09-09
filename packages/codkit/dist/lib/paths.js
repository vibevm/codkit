/** @scope spec://codkit/modules/codkit/PROP-008#root */
/** Independent patch-set and fork-tree location resolution. */
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { ckError } from './messages.js';
/** Path length beyond which Windows needs core.longpaths. */
const WINDOWS_PATH_WARN_LENGTH = 200;
export function resolveLocations(flags, env, settings, cwd = process.cwd()) {
    return {
        patchesDir: resolveOne('patches', flags.patchesDir, env['CODKIT_PATCHES_DIR'], settings.patchesDir, cwd),
        forkDir: resolveOne('fork', flags.forkDir, env['CODKIT_FORK_DIR'], settings.forkDir, cwd)
    };
}
/** Reject every overlap among the immutable install and the two data roots. */
export function assertDisjointRoots(toolRoot, locations) {
    const roots = [
        { name: 'tool', path: canonicalizePotentialPath(resolve(toolRoot)).path },
        ...(locations.patchesDir === null ? [] : [{ name: 'patches', path: locations.patchesDir.path }]),
        ...(locations.forkDir === null ? [] : [{ name: 'fork', path: locations.forkDir.path }])
    ];
    for (let left = 0; left < roots.length; left += 1) {
        for (let right = left + 1; right < roots.length; right += 1) {
            const first = roots[left];
            const second = roots[right];
            if (first !== undefined && second !== undefined && pathsOverlap(first.path, second.path)) {
                throw ckError('CONFIG', `${first.name} directory and ${second.name} directory must not be the same or nested (${first.path}; ${second.path})`, 'configure disjoint tool, patch-set, and fork directories; cleanup is allowed inside managed roots');
            }
        }
    }
}
export function requirePatchesDir(locations) {
    if (locations.patchesDir !== null)
        return locations.patchesDir;
    throw ckError('CONFIG', 'patches directory is not configured', 'pass --patches-dir, set CODKIT_PATCHES_DIR, or set patchesDir in ~/.codkit/settings.json');
}
export function requireForkDir(locations) {
    if (locations.forkDir !== null)
        return locations.forkDir;
    throw ckError('CONFIG', 'fork directory is not configured', 'pass --fork-dir, set CODKIT_FORK_DIR, or set forkDir in ~/.codkit/settings.json');
}
export function formatForkTreeLine(resolution) {
    return `fork tree: ${resolution.path} (source: ${resolution.source})`;
}
export function formatPatchesLine(resolution) {
    return `patches: ${resolution.path} (source: ${resolution.source})`;
}
/** Re-probe an already selected location after a command creates it. */
export function refreshResolution(resolution) {
    let path = resolution.path;
    let exists = false;
    try {
        path = realpathSync(path);
        if (!statSync(path).isDirectory()) {
            throw ckError('CONFIG', `configured path is not a directory: ${path}`, 'configure an existing directory or a path that can be created');
        }
        exists = true;
    }
    catch (error) {
        if (!isMissingPathError(error))
            throw error;
        // Keep the normalized selected path when it still does not exist.
    }
    return { path, source: resolution.source, exists, warning: pathWarning(path) };
}
function resolveOne(kind, cli, env, settings, cwd) {
    const picked = pick(cli, env, settings);
    if (picked === null)
        return null;
    if (picked.raw === '') {
        throw ckError('CONFIG', `${kind} directory from ${picked.source} is empty`, `provide a non-empty ${kind} directory path`);
    }
    if (picked.source === 'settings' && !isAbsolute(picked.raw)) {
        throw ckError('CONFIG', `${kind} directory in settings must be absolute`, `fix ${kind}Dir in ~/.codkit/settings.json`);
    }
    const absolute = isAbsolute(picked.raw) ? resolve(picked.raw) : resolve(cwd, picked.raw);
    const canonical = canonicalizePotentialPath(absolute);
    const path = canonical.path;
    const exists = canonical.exists;
    return { path, source: picked.source, exists, warning: pathWarning(path) };
}
/**
 * Resolve every existing prefix so that a missing path below a symlink cannot
 * evade the root-overlap guard. The unresolved suffix is then appended to the
 * canonical prefix without touching the filesystem.
 */
function canonicalizePotentialPath(absolute) {
    let cursor = absolute;
    const suffix = [];
    const filesystemRoot = parse(absolute).root;
    while (true) {
        try {
            const canonical = resolve(realpathSync(cursor), ...suffix.reverse());
            if (suffix.length === 0 && !statSync(canonical).isDirectory()) {
                throw ckError('CONFIG', `configured path is not a directory: ${canonical}`, 'configure an existing directory or a path that can be created');
            }
            return { path: canonical, exists: suffix.length === 0 };
        }
        catch (error) {
            if (!isMissingPathError(error))
                throw error;
            if (cursor === filesystemRoot)
                return { path: absolute, exists: false };
            suffix.push(relative(dirname(cursor), cursor));
            cursor = dirname(cursor);
        }
    }
}
function isMissingPathError(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
function pathsOverlap(left, right) {
    const comparableLeft = process.platform === 'win32' ? left.toLowerCase() : left;
    const comparableRight = process.platform === 'win32' ? right.toLowerCase() : right;
    return isWithin(comparableLeft, comparableRight) || isWithin(comparableRight, comparableLeft);
}
function isWithin(parent, candidate) {
    const distance = relative(parent, candidate);
    return distance === '' || (distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance));
}
function pick(cli, env, settings) {
    if (cli !== null && cli !== undefined)
        return { raw: cli, source: 'flag' };
    if (env !== undefined)
        return { raw: env, source: 'env' };
    if (settings !== undefined)
        return { raw: settings, source: 'settings' };
    return null;
}
function pathWarning(path) {
    if (process.platform === 'win32' && path.length > WINDOWS_PATH_WARN_LENGTH) {
        return (`path is ${path.length} characters long; Windows needs long path support for a tree this deep ` +
            `(set core.longpaths=true in the tree and enable LongPathsEnabled in the OS)`);
    }
    return null;
}
