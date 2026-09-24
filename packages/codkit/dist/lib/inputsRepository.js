/** @scope spec://codkit/modules/codkit/PROP-007#CMD-INPUTS-PIN */
// The repository of an input as it stands next to its pin (PROP-007
// ##CMD-INPUTS-PIN, ##CMD-STATUS-INPUTS): its HEAD, how far the pin is behind
// it, and what its working tree has that no commit has; and the one writer of
// `ref` in codkit.json, which moves pins to HEAD. Read-only against the input
// repository; the patch set's codkit.json is replaced canonically, under the
// lock of the patch set's configuration, against the bytes it was read from.
import { existsSync } from 'node:fs';
import { bytesEqual, encodeUtf8 } from './bytes.js';
import { CONFIG_FILE_NAME, parseBaseConfig, parseConfigBytes, serializeBaseConfig } from './configFile.js';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.js';
import { porcelainZEntries } from './driftGuard.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
/** Where the repository of an input stands against its pin, without writing anything. */
export function inputRepositoryState(input) {
    const absent = { present: false, head: null, pin: null, behind: null, uncommitted: [] };
    if (!existsSync(input.repository))
        return absent;
    if (runGit({ args: ['rev-parse', '--git-dir'], cwd: input.repository }).status !== 0)
        return absent;
    const headResult = runGit({ args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd: input.repository });
    const head = headResult.status === 0 ? headResult.stdout.trim() : null;
    const status = runGit({ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: input.repository });
    const uncommitted = status.status === 0 ? porcelainZEntries(status.stdout).map((entry) => entry.path) : [];
    if (head === null)
        return { present: true, head, pin: null, behind: null, uncommitted };
    if (head === input.ref)
        return { present: true, head, pin: 'at-head', behind: 0, uncommitted };
    if (runGit({ args: ['cat-file', '-e', `${input.ref}^{commit}`], cwd: input.repository }).status !== 0) {
        return { present: true, head, pin: 'missing-commit', behind: null, uncommitted };
    }
    if (runGit({ args: ['merge-base', '--is-ancestor', input.ref, head], cwd: input.repository }).status !== 0) {
        return { present: true, head, pin: 'diverged', behind: null, uncommitted };
    }
    const counted = runGit({ args: ['rev-list', '--count', `${input.ref}..${head}`], cwd: input.repository });
    return { present: true, head, pin: 'behind', behind: Number.parseInt(counted.stdout.trim(), 10) || null, uncommitted };
}
/**
 * Replace the `ref` of the named inputs in codkit.json, canonically; false when
 * every one is already there. The file is read, rewritten and compared again
 * right before the replace, so an edit that lands in between survives.
 */
export function writeInputRefs(patchesDir, refs) {
    const read = readContainedFile(patchesDir, CONFIG_FILE_NAME, { what: CONFIG_FILE_NAME });
    if (read.state !== 'ok')
        throw ckError('CONFIG', `${CONFIG_FILE_NAME} does not exist`, 'run from a configured patch set', CONFIG_FILE_NAME);
    const base = parseBaseConfig(parseConfigBytes(read.bytes), CONFIG_FILE_NAME);
    const inputs = (base.inputs ?? []).map((input) => ({ ...input, ref: refs.get(input.name) ?? input.ref }));
    const next = encodeUtf8(serializeBaseConfig({ ...base, inputs }));
    if (bytesEqual(read.bytes, next))
        return false;
    const current = readContainedFile(patchesDir, CONFIG_FILE_NAME, { what: CONFIG_FILE_NAME });
    if (current.state !== 'ok' || !bytesEqual(current.bytes, read.bytes)) {
        throw ckError('LOCKED', `${CONFIG_FILE_NAME} changed while the pins were prepared`, 'run the command again; the newer content was kept', CONFIG_FILE_NAME);
    }
    writeContainedFileAtomic(patchesDir, CONFIG_FILE_NAME, { bytes: next, what: CONFIG_FILE_NAME });
    return true;
}
