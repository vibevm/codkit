/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW-HOST */
// The host of a preview: one executable, resolved once, in a fixed order.
// Contract: PROP-007 ##CMD-PREVIEW-HOST.
//
// The sources are `--host`, the environment variable `CODKIT_PREVIEW_HOST`, the
// host the patch set's `typeConfig` names, and the type's default host looked
// up on PATH with the platform's executable suffixes. The first source that
// speaks is the host, and a value that does not resolve is a refusal - never a
// fall-through to a host nobody asked for. A shell wrapper is resolved to the
// executable it starts when the engine can read that from its shape, because a
// wrapper that exits after spawning the application leaves no process to
// record (PROP-010 ##DAEMON-ORPHAN-GUARD is the precedent).
//
// Nothing here names a host of any family: the default host is the type's
// answer, and the engine only looks it up (PROP-016 ##TYPE-ENGINE-IS-BLIND).
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
/** The environment variable that names the host when `--host` does not. */
export const PREVIEW_HOST_VARIABLE = 'CODKIT_PREVIEW_HOST';
/** The executable suffixes a bare name may carry on Windows when PATHEXT says nothing. */
const DEFAULT_WINDOWS_SUFFIXES = ['.COM', '.EXE', '.BAT', '.CMD'];
/**
 * The first source that names a host, in the fixed order of ##CMD-PREVIEW-HOST:
 * `--host`, `CODKIT_PREVIEW_HOST`, the host the patch set's `typeConfig` names,
 * the type's default.
 */
export function hostCandidate(flag, env, typeConfig, defaultHost) {
    if (flag !== null && flag !== '') {
        return { source: 'flag', value: flag };
    }
    const exported = env[PREVIEW_HOST_VARIABLE];
    if (exported !== undefined && exported !== '') {
        return { source: 'environment', value: exported };
    }
    const configured = configuredPreviewHost(typeConfig);
    if (configured !== null) {
        return { source: 'configuration', value: configured };
    }
    return { source: 'default', value: defaultHost };
}
/**
 * `typeConfig.preview.host`, read as an opaque string. The engine knows the
 * section by this one field and validates nothing else of it: what the section
 * means is the type's business (PROP-016 ##TYPE-CONFIG-FIELD).
 */
export function configuredPreviewHost(typeConfig) {
    if (typeof typeConfig !== 'object' || typeConfig === null || !('preview' in typeConfig)) {
        return null;
    }
    const preview = typeConfig.preview;
    if (typeof preview !== 'object' || preview === null || !('host' in preview)) {
        return null;
    }
    const host = preview.host;
    return typeof host === 'string' && host !== '' ? host : null;
}
/**
 * One executable out of the candidate: a value that is a path must exist, a
 * name must be found on PATH with the platform's executable suffixes, and a
 * wrapper is resolved to what it starts. `tried` is what the refusal names.
 */
export function resolveHost(candidate, lookup) {
    const label = sourceLabel(candidate.source);
    if (looksLikePath(candidate.value)) {
        const path = resolve(lookup.cwd, candidate.value);
        const tried = [`${label}: ${path}`];
        return isExecutableFile(path, lookup.platform)
            ? { ok: true, path: resolveWrapper(path, lookup.platform), tried }
            : { ok: false, tried };
    }
    const directories = pathDirectories(lookup);
    const suffixes = executableSuffixes(lookup, candidate.value);
    const shownSuffixes = suffixes.filter((suffix) => suffix !== '');
    const tried = [
        `${label}: ${candidate.value} on PATH (${directories.length} director${directories.length === 1 ? 'y' : 'ies'}` +
            `${shownSuffixes.length === 0 ? '' : `, suffixes ${shownSuffixes.join(' ')}`})`
    ];
    const found = findOnPath(candidate.value, directories, suffixes, lookup.platform);
    return found === null ? { ok: false, tried } : { ok: true, path: resolveWrapper(found, lookup.platform), tried };
}
/** What a refusal calls the source a host came from. */
export function sourceLabel(source) {
    switch (source) {
        case 'flag':
            return '--host';
        case 'environment':
            return PREVIEW_HOST_VARIABLE;
        case 'configuration':
            return 'typeConfig.preview.host';
        default:
            return 'the default host of the project type';
    }
}
/** A value with a path separator is a path; a bare word is a name to find on PATH. */
export function looksLikePath(value) {
    return value.includes('/') || value.includes('\\');
}
/**
 * The first `<directory>/<name><suffix>` on PATH that is an executable file, in
 * PATH order and then suffix order; Windows compares names without case and
 * answers with the entry's own spelling.
 */
export function findOnPath(name, directories, suffixes, platform) {
    const fold = (text) => (platform === 'win32' ? text.toLowerCase() : text);
    for (const directory of directories) {
        const entries = readEntries(directory);
        for (const suffix of suffixes) {
            const wanted = fold(`${name}${suffix}`);
            const match = entries.find((entry) => fold(entry) === wanted);
            if (match !== undefined && isExecutableFile(join(directory, match), platform)) {
                return join(directory, match);
            }
        }
    }
    return null;
}
/**
 * A shell wrapper resolved to the executable it starts, when the engine can
 * read that from its shape: on Windows a `bin/<name>.cmd` whose parent
 * directory holds `<name>.exe` (compared without case) is that executable.
 */
export function resolveWrapper(path, platform) {
    if (platform !== 'win32' || !/\.cmd$/iu.test(path)) {
        return path;
    }
    const binDir = dirname(path);
    if (basename(binDir).toLowerCase() !== 'bin') {
        return path;
    }
    const applicationDir = dirname(binDir);
    const wanted = `${basename(path).slice(0, -'.cmd'.length)}.exe`.toLowerCase();
    const match = readEntries(applicationDir).find((entry) => entry.toLowerCase() === wanted);
    return match === undefined ? path : join(applicationDir, match);
}
/** The refusal of ##CMD-PREVIEW-HOST: what was tried, and the hint to pass `--host`. */
export function hostRefusal(tried) {
    return {
        code: 'PREVIEW-HOST',
        message: `no host executable for the preview; tried ${tried.join('; ')}`,
        hint: `pass --host <executable> (a path, or a name on PATH), or export ${PREVIEW_HOST_VARIABLE}; nothing was launched`
    };
}
function isExecutableFile(path, platform) {
    try {
        if (!statSync(path).isFile()) {
            return false;
        }
        if (platform !== 'win32') {
            accessSync(path, constants.X_OK);
        }
        return true;
    }
    catch {
        return false;
    }
}
function pathDirectories(lookup) {
    const raw = lookup.env['PATH'] ?? lookup.env['Path'] ?? '';
    return raw.split(lookup.platform === 'win32' ? ';' : ':').filter((entry) => entry !== '');
}
/**
 * The suffixes a name is looked up with. On Windows a bare name is found only
 * with one of the executable suffixes: `bin/code` beside `bin/code.cmd` is the
 * shell script of the same host, which the platform cannot spawn (finding of
 * 2026-11-01); a name that already carries a suffix is found as it is.
 */
function executableSuffixes(lookup, name) {
    if (lookup.platform !== 'win32') {
        return [''];
    }
    const raw = lookup.env['PATHEXT'];
    const listed = raw === undefined || raw === '' ? DEFAULT_WINDOWS_SUFFIXES : raw.split(';').filter((entry) => entry !== '');
    const lowered = name.toLowerCase();
    return listed.some((suffix) => lowered.endsWith(suffix.toLowerCase())) ? [''] : listed;
}
function readEntries(directory) {
    try {
        return readdirSync(directory);
    }
    catch {
        return [];
    }
}
