/** @scope spec://codkit/modules/codkit/PROP-011#root */
import { statSync } from 'node:fs';
import { findOnWindows } from './inputsBuild.js';
/** A command that already names its kind: a batch launcher, or a native executable. */
const KNOWN_SUFFIX = /\.(?:cmd|bat|exe|com)$/iu;
const BATCH = /\.(?:cmd|bat)$/iu;
/**
 * Node cannot execute Windows batch launchers directly with `shell: false`.
 * Route only those launchers through cmd.exe; native executables and every
 * non-Windows platform keep the direct argv-preserving path.
 *
 * A bare name is first found along PATH with the PATHEXT suffixes, the way
 * `##INPUTS-BUILD-PORTABLE` finds the program of an input (PROP-007): the
 * package manager a project type names is a `.cmd` shim on Windows, and a
 * spawn of its bare name would fail with ENOENT (finding of 2026-11-01). A
 * name that is not found is left as it was, so the spawn reports it.
 */
export function processInvocation(command, args, platform = process.platform, comspec = process.env['ComSpec'], env = process.env, cwd = process.cwd()) {
    if (platform !== 'win32') {
        return { command, args };
    }
    const found = KNOWN_SUFFIX.test(command) ? command : (findOnWindows(command, { platform, env, cwd, isFile }) ?? command);
    if (!BATCH.test(found)) {
        return { command: found, args };
    }
    return {
        command: comspec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', found, ...args]
    };
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
