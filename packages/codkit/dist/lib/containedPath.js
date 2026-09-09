/** @scope spec://codkit/modules/codkit/PROP-002#CONTAINED-FILE-IO */
// The containment primitives every contained file operation is built from:
// what a refusal looks like, how an administrative directory path is proven
// real, how a directory or file is recognised across a rename (dev/ino, never
// a pathname string), how a descriptor write is driven to completion, and how
// two effective Git paths compare on each platform.
//
// Nothing here opens a caller's file or decides policy. Splitting it out keeps
// `containedFile.ts` at the grain of one cell: the operations, not the ground
// they stand on.
import { lstatSync, mkdirSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { ckError } from './messages.js';
import { repoRelativePathProblem } from './pathSafety.js';
/** O_NOFOLLOW where the platform has it; 0 (and lstat fallbacks) where not. */
export const NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
/**
 * O_NONBLOCK where the platform has it; 0 where not.
 *
 * Opening a FIFO blocks until a peer appears, so a named pipe planted at a leaf
 * would hang the whole tool with no error and no timeout - the post-open
 * `isFile()` refusal never runs because the open never returns. Every contained
 * open therefore asks not to block. On a regular file - which is the only shape
 * these functions accept - the flag has no effect.
 */
export const NONBLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;
/**
 * Refuse an existing leaf that is not a regular file before it is opened.
 *
 * `O_NOFOLLOW` makes a symlink leaf fail at the open, but a FIFO, socket or
 * device node opens (or blocks) happily, so type is proven before the syscall
 * as well as after it. An absent leaf is not a problem here: the open reports
 * it, and callers turn that into `absent`.
 */
export function refuseNonRegularLeaf(path, options) {
    const leaf = lstatIfPresent(path);
    if (leaf === null || leaf.isFile())
        return;
    if (leaf.isSymbolicLink()) {
        refuse(options, 'must be a regular non-symlink file', 'replace the symlink with a real file; codkit never reads or writes through one');
    }
    refuse(options, 'must be a regular file', 'replace the entry with a real regular file; codkit never opens a pipe, socket or device');
}
export function refuse(options, detail, hint) {
    throw ckError(options.code ?? 'CONFIG', `${options.what}: ${detail}`, hint);
}
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export function errnoOf(error) {
    return error.code;
}
/**
 * Verify (and create, when missing) one directory path below an administrative
 * root, refusing any component that is a symlink or a non-directory. Returns
 * the path built from the canonical root, so an atomic write into it cannot be
 * redirected through a link. With `create: false` nothing is created: missing
 * components are accepted (the caller may only be planning a read), while every
 * component that does exist must still be a real directory.
 */
export function ensureAdminDirectory(root, segments, options) {
    const create = options.create !== false;
    let current;
    try {
        current = realpathSync(root);
    }
    catch (error) {
        refuse(options, `cannot resolve the administrative root ${root}: ${messageOf(error)}`, 'check that the git directory exists');
    }
    for (const segment of segments) {
        if (repoRelativePathProblem(segment) !== null) {
            refuse(options, `unsafe administrative path component ${JSON.stringify(segment)}`, 'this is a bug in codkit unless the git directory is damaged');
        }
        current = join(current, segment);
        let stat;
        try {
            stat = lstatSync(current);
        }
        catch (error) {
            if (errnoOf(error) !== 'ENOENT') {
                refuse(options, `cannot inspect ${current}: ${messageOf(error)}`, 'check the git directory');
            }
            stat = null;
        }
        if (stat === null) {
            if (!create) {
                continue;
            }
            options.beforeCreate?.();
            try {
                mkdirSync(current);
            }
            catch (error) {
                // Two commands on one patch set race to create the same
                // administrative component on a fresh checkout. A peer that won is
                // not a failure - but the component it created still has to pass
                // the same shape proof, so fall through to it instead of trusting
                // the errno.
                if (errnoOf(error) !== 'EEXIST') {
                    refuse(options, `cannot create ${current}: ${messageOf(error)}`, 'check the permissions of the git directory');
                }
                stat = lstatIfPresent(current);
                if (stat === null) {
                    refuse(options, `cannot create ${current}: it disappeared while being created`, 'retry after inspecting the git directory');
                }
            }
            if (stat === null)
                continue;
        }
        if (stat.isSymbolicLink()) {
            refuse(options, `${current} is a symlink, not a real directory`, 'remove the link; codkit writes only inside real git directories');
        }
        if (!stat.isDirectory()) {
            refuse(options, `${current} is not a directory`, 'the administrative path must descend through directories only');
        }
    }
    return current;
}
export function lstatIfPresent(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (errnoOf(error) === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
export function statIfPresent(path) {
    try {
        return statSync(path);
    }
    catch (error) {
        if (errnoOf(error) === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
export function realpathIfPresent(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
/** Platform-aware equality for effective Git paths (case-insensitive on Windows). */
export function sameEffectivePath(left, right, platform = process.platform) {
    if (platform === 'win32') {
        const normalize = (value) => win32.normalize(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
        return normalize(left) === normalize(right);
    }
    return (realpathIfPresent(left) ?? resolve(left)) === (realpathIfPresent(right) ?? resolve(right));
}
export function unlinkIfPresent(path) {
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (errnoOf(error) !== 'ENOENT') {
            throw error;
        }
    }
}
export function writeAll(handle, options) {
    const write = options.writeChunk ?? ((fd, bytes, offset, length) => writeSync(fd, bytes, offset, length));
    let offset = 0;
    while (offset < options.bytes.length) {
        const written = write(handle, options.bytes, offset, options.bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0 || written > options.bytes.length - offset) {
            throw new Error(`short write made no valid progress at byte ${offset}`);
        }
        offset += written;
    }
}
/** dev/ino identity; on filesystems without stable ino the pair still matches self. */
export function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
export function isWithin(root, candidate) {
    const fromRoot = relative(root, candidate);
    return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}
