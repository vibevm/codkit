/** @scope spec://codkit/modules/codkit/PROP-007#root */
// The git hooks codkit installs in the patchset repository (PROP-007 sec. 19).
//
// Two hooks, and each has one job:
//
//   * pre-commit runs the fast checks over the delta files this commit stages,
//     so a patch edited outside its marker block never reaches a branch;
//   * commit-msg stamps the cycle trailer while a cycle is running, and refuses
//     a malformed `Cause:` trailer - CI checks the trailers of a cycle
//     independently, and a trailer nobody validates never takes hold.
//
// They are sh scripts that call codkit, and every one of them fails open: no
// node, no launcher, or an environment codkit cannot work in means the hook
// prints why and lets the commit through. A hook that locks a checkout without
// node_modules would be uninstalled by the first person who hits it, and then
// it protects nobody.
//
// Ownership is declared on the second line of the file (`# codkit-hook v1`,
// under the shebang the kernel needs first). A hook file without that line
// belongs to somebody else and is never overwritten.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeUtf8 } from './bytes.js';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.js';
import { sameEffectivePath } from './containedPath.js';
import { readCycleState } from './cycleState.js';
import { runGitUserPathResolution } from './gitx.js';
import { gitCommonDirOf, gitDirOf } from './treeCache.js';
/** The line that marks a hook file as codkit's. */
export const HOOK_MARKER = '# codkit-hook v1';
export const HOOK_NAMES = ['pre-commit', 'commit-msg'];
/** Where the codkit launcher lives, derived from this module's own location. */
const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'codkit.mjs');
/** `<git dir>/hooks`, which is where git looks unless core.hooksPath says otherwise. */
export function hooksDir(patchesDir) {
    return join(gitDirOf(patchesDir), 'hooks');
}
export function hookPath(patchesDir, name) {
    return join(hooksDir(patchesDir), name);
}
/** The exact bytes codkit would install for one hook. */
export function hookScript(name, parameters) {
    const launcher = parameters.launcher ?? LAUNCHER;
    const preamble = [
        '#!/bin/sh',
        HOOK_MARKER,
        `# Installed by "codkit hooks install"; regenerate it with the same command.`,
        '# Edits are lost: "codkit hooks check" compares this file byte for byte.',
        '',
        `CODKIT_ROOT=${shellQuote(parameters.patchesDir)}`,
        `CODKIT_FORK=${shellQuote(parameters.forkDir)}`,
        `CODKIT_LAUNCHER=${shellQuote(launcher)}`,
        '',
        '# Fail open: a checkout without node or without codkit still commits.',
        'if ! command -v node >/dev/null 2>&1; then',
        `\techo "codkit ${name}: node is not on PATH, skipping the codkit checks" >&2`,
        '\texit 0',
        'fi',
        'if [ ! -f "$CODKIT_LAUNCHER" ]; then',
        `\techo "codkit ${name}: $CODKIT_LAUNCHER is missing, skipping the codkit checks" >&2`,
        '\texit 0',
        'fi',
        'if [ -z "${CODKIT_FORK_DIR:-}" ]; then unset CODKIT_FORK_DIR; fi',
        ''
    ];
    const body = name === 'pre-commit' ? PRE_COMMIT_BODY : COMMIT_MSG_BODY;
    return `${[...preamble, ...body].join('\n')}\n`;
}
/**
 * The staged delta files are checked by codkit itself, so the hook stays a
 * dozen lines of sh. Exit 1 is the delta being wrong and refuses the commit;
 * exit 2 is codkit not being able to run, which is not the commit's fault.
 */
const PRE_COMMIT_BODY = [
    'node "$CODKIT_LAUNCHER" --patches-dir "$CODKIT_ROOT" --fork-dir "$CODKIT_FORK" verify --staged-fast',
    'status=$?',
    'if [ "$status" -eq 1 ]; then',
    '\techo "codkit pre-commit: the staged delta does not pass; commit refused" >&2',
    '\techo "hint: fix what is listed above, or commit with --no-verify if you know why" >&2',
    '\texit 1',
    'fi',
    'if [ "$status" -ne 0 ]; then',
    '\techo "codkit pre-commit: codkit could not run the checks (exit $status), letting the commit through" >&2',
    'fi',
    'exit 0'
];
const COMMIT_MSG_BODY = [
    'node "$CODKIT_LAUNCHER" --patches-dir "$CODKIT_ROOT" --fork-dir "$CODKIT_FORK" hooks commit-msg "$1"',
    'status=$?',
    'if [ "$status" -eq 1 ]; then',
    '\texit 1',
    'fi',
    'if [ "$status" -ne 0 ]; then',
    '\techo "codkit commit-msg: codkit could not run (exit $status), leaving the message alone" >&2',
    'fi',
    'exit 0'
];
/** What the hook files of this checkout look like right now. */
export function inspectHooks(parameters) {
    return HOOK_NAMES.map((name) => inspectHook(name, parameters));
}
export function inspectHook(name, parameters) {
    const path = hookPath(parameters.patchesDir, name);
    const activation = hookActivation(parameters.patchesDir, name, path);
    if (!activation.active) {
        return { name, path, state: 'inactive', detail: activation.detail };
    }
    // The contained read: a symlinked hook leaf is unreadable and therefore
    // foreign - codkit never touches what it cannot prove is its own file.
    let current;
    try {
        const read = readContainedFile(gitDirOf(parameters.patchesDir), `hooks/${name}`, {
            what: path,
            ...(parameters.afterOpen === undefined ? {} : { afterOpen: parameters.afterOpen })
        });
        if (read.state === 'absent') {
            return { name, path, state: 'missing' };
        }
        current = Buffer.from(read.bytes).toString('utf8');
    }
    catch {
        return { name, path, state: 'foreign' };
    }
    if (!isOurs(current)) {
        return { name, path, state: 'foreign' };
    }
    return { name, path, state: current === hookScript(name, parameters) ? 'ok' : 'stale' };
}
/**
 * A hook is ours when the marker line is in its header. The shebang has to be
 * the first line for the kernel to run the file at all, so the marker is the
 * line under it; the first few lines are searched so that a hook written by an
 * older codkit is still recognized as ours rather than destroyed as foreign.
 */
export function isOurs(content) {
    return content
        .split('\n')
        .slice(0, 4)
        .some((line) => line.trim() === HOOK_MARKER);
}
/**
 * Install both hooks. A foreign hook is left exactly as it is: somebody put it
 * there on purpose, and losing it to a tool that "knows better" is not a trade
 * anybody agreed to.
 */
export function installHooks(parameters) {
    const reports = inspectHooks(parameters);
    return reports.map((report) => {
        const name = report.name;
        if (report.state === 'inactive') {
            return { ...report, action: 'refused' };
        }
        if (report.state === 'foreign') {
            return { ...report, action: 'refused' };
        }
        if (report.state === 'ok') {
            return { ...report, action: 'unchanged' };
        }
        writeContainedFileAtomic(gitDirOf(parameters.patchesDir), `hooks/${name}`, {
            bytes: encodeUtf8(hookScript(name, parameters)),
            mode: 0o755,
            what: report.path
        });
        return { name, path: report.path, state: 'ok', action: 'written' };
    });
}
/** A patch-set hook is valid only when the user's Git demonstrably executes it. */
function hookActivation(patchesDir, name, ownedPath) {
    if (!sameEffectivePath(gitDirOf(patchesDir), gitCommonDirOf(patchesDir))) {
        return { active: false, detail: 'linked worktree hooks are shared by sibling worktrees' };
    }
    const effective = runGitUserPathResolution({ cwd: patchesDir, relative: `hooks/${name}` });
    const path = effective.stdout.trim();
    if (effective.status !== 0 || path === '') {
        return { active: false, detail: 'Git could not resolve the effective hooks path' };
    }
    if (!sameEffectivePath(path, ownedPath)) {
        return { active: false, detail: `Git executes ${path} because core.hooksPath is configured` };
    }
    return { active: true };
}
// ---------------------------------------------------------------------------
// commit-msg (PROP-007 ##CMD-HOOKS)
// ---------------------------------------------------------------------------
export const CYCLE_TRAILER = 'Codkit-Cycle';
export const CAUSE_TRAILER = 'Cause';
/** An upstream sha: forty hexadecimal digits, and nothing else. */
const SHA_40 = /^[0-9a-f]{40}$/;
/** A trailer line: `Name: value` with a name of letters, digits and dashes. */
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*:\s/;
/**
 * Stamp the cycle trailer and validate the cause trailer.
 *
 * The cycle tag comes from the canonical cycle-state reader. The hook remains
 * fail-open: malformed or unsafe state is ignored rather than blocking a
 * commit, while a valid state has exactly the same meaning everywhere.
 */
export function runCommitMsg(patchesDir, message) {
    const messages = [];
    const cause = badCause(message);
    if (cause !== null) {
        return {
            exitCode: 1,
            messages: [
                `codkit commit-msg: the ${CAUSE_TRAILER}: trailer must be a 40-character upstream sha, got "${cause}"`,
                `hint: write "${CAUSE_TRAILER}: <40 hex>" for the upstream commit that forced this change, or drop the trailer`
            ],
            rewritten: null
        };
    }
    const tag = cycleTag(patchesDir);
    if (tag === null || hasTrailer(message, CYCLE_TRAILER)) {
        return { exitCode: 0, messages, rewritten: null };
    }
    messages.push(`codkit commit-msg: stamped ${CYCLE_TRAILER}: ${tag}`);
    return { exitCode: 0, messages, rewritten: appendTrailer(message, `${CYCLE_TRAILER}: ${tag}`) };
}
/** The target tag of the running cycle, or null when no cycle is running. */
export function cycleTag(patchesDir) {
    try {
        return readCycleState(patchesDir)?.targetPin.tag ?? null;
    }
    catch {
        return null;
    }
}
/** The malformed cause value, or null when there is none to complain about. */
export function badCause(message) {
    for (const line of messageLines(message)) {
        if (!line.startsWith(`${CAUSE_TRAILER}:`)) {
            continue;
        }
        const value = line.slice(CAUSE_TRAILER.length + 1).trim();
        if (!SHA_40.test(value)) {
            return value;
        }
    }
    return null;
}
function hasTrailer(message, name) {
    return messageLines(message).some((line) => line.startsWith(`${name}:`));
}
/** The lines git will keep: comments are stripped before the message is used. */
function messageLines(message) {
    return message.split('\n').filter((line) => !line.startsWith('#'));
}
/**
 * Put the trailer after the last line of the message and before whatever git
 * left at the end of the file, with a blank line separating it from prose so it
 * forms a trailer block rather than a last sentence.
 */
export function appendTrailer(message, trailer) {
    const lines = message.split('\n');
    let last = -1;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (line.trim() !== '' && !line.startsWith('#')) {
            last = index;
        }
    }
    if (last === -1) {
        return `${message.trimEnd()}\n\n${trailer}\n`;
    }
    const previous = lines[last] ?? '';
    const insertion = TRAILER_LINE.test(previous) ? [trailer] : ['', trailer];
    lines.splice(last + 1, 0, ...insertion);
    return lines.join('\n');
}
/** POSIX single-quoting, so a path with a space or a quote survives. */
function shellQuote(value) {
    return `'${value.split("'").join(`'\\''`)}'`;
}
