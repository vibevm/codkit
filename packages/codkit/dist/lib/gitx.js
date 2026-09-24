/** @scope spec://codkit/modules/codkit/PROP-002#root */
// git wrapper: isolated environment, no shell, explicit network policy.
//
// PROP-002 sec. 2 (##GIT-ENV-ISOLATION) is the contract: every git invocation runs
// with GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null,
// GIT_CONFIG_NOSYSTEM=1, LC_ALL=C, TZ=UTC and with explicit
// `-c core.autocrlf=false -c core.eol=lf -c core.quotepath=false`.
// Repository-selection and config-injection variables inherited from the parent
// are removed before the child starts. Machine-level git configuration must
// never change what codkit computes, and neither may the platform: `core.eol`
// defaults to `native`, which is CRLF on Windows (##GIT-ENV-EOL).
import { spawnSync } from 'node:child_process';
import { ckError } from './messages.js';
/**
 * Environment variables that pin git's view of the world. Applied last, so a
 * caller-supplied env can never weaken the isolation.
 */
const ISOLATION_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    // Local refs/replace are mutable machine state: exact pin/object reads must
    // never be silently redirected through them.
    GIT_NO_REPLACE_OBJECTS: '1',
    LC_ALL: 'C',
    TZ: 'UTC'
};
/**
 * Deterministic byte/path options shared with the narrow human-commit seam.
 * `core.eol=lf`: a checkout writes a text file with its blob's line endings on
 * every OS, as it does on Linux - left at `native`, a checkout on Windows writes
 * CRLF for every `text=auto` file it touches (##GIT-ENV-EOL). It changes only
 * what git writes; what it reads is normalized as before.
 */
const BASE_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.quotepath=false'];
/** Extra isolation that must not suppress hooks on gitLocal human commits. */
const ISOLATED_CONFIG = [...BASE_CONFIG, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
/**
 * Parent variables that can make `cwd` cease to identify the repository Git
 * operates on. The first three have legitimate, narrow callers, so they may be
 * supplied explicitly through RunGitOptions.env; the others are never needed
 * by codkit and remain blocked there too.
 */
const REPOSITORY_ENV = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_QUARANTINE_PATH',
    'GIT_SHALLOW_FILE',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
    'GIT_ATTR_SOURCE',
    'GIT_GRAFT_FILE',
    'GIT_REPLACE_REF_BASE',
    'GIT_NO_REPLACE_OBJECTS'
]);
const EXPLICIT_REPOSITORY_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']);
/** Config passed through the environment has higher precedence than files. */
const CONFIG_INJECTION_ENV = new Set(['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG']);
/** Environment hooks into the diff machinery; command flags below replace them. */
const DIFF_ENV = new Set(['GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS']);
/** Porcelain that may invoke external diff commands or textconv drivers. */
const DIFF_COMMANDS = new Set(['diff', 'show', 'log', 'whatchanged', 'format-patch']);
/** Subcommands that reach the network. */
const NETWORK_SUBCOMMANDS = ['fetch', 'clone', 'pull', 'push', 'ls-remote'];
/** `git lfs <op>` operations that reach the network. */
const NETWORK_LFS_OPERATIONS = ['pull', 'fetch'];
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * GIT_CONFIG_GLOBAL for every isolated call that does not name one itself.
 * null means /dev/null, which is what every command uses. Only `ci` replaces it,
 * once, at the start of a run whose tree reported dubious ownership: after that
 * the rest of the run - engines that never heard of the option - reads the
 * safe.directory entries it just wrote (PROP-011 sec. 5, the safe.directory rule).
 */
let runConfigGlobal = null;
/** Point every later isolated git call at `path`; null restores /dev/null. */
export function useGitConfigGlobal(path) {
    runConfigGlobal = path;
}
/** What `useGitConfigGlobal` last set; null when the isolation is untouched. */
export function currentGitConfigGlobal() {
    return runConfigGlobal;
}
/**
 * Run git. Returns the raw outcome; a non-zero status is a value, not a throw.
 * Throws CkError only for a refused network call or a failure to start git.
 */
export function runGit(options) {
    return textResult(spawnGit(options, true));
}
/**
 * Run isolated git while preserving stdout byte-for-byte. Use this only for
 * blobs or other binary plumbing; diagnostics remain decoded text.
 */
export function runGitBytes(options) {
    const result = spawnGit(options, true);
    return {
        status: result.status,
        stdout: new Uint8Array(result.stdout),
        stderr: result.stderr.toString('utf8')
    };
}
/**
 * Resolve one administrative path the way the user's own git resolves it -
 * global and system configuration visible, execution-isolation flags dropped
 * (a `-c core.hooksPath=/dev/null` would break `--git-path hooks/*` for real
 * machines too). The narrow machine-config exception to ##GIT-ENV-ISOLATION:
 * read-only path resolution, nothing else (see RunGitOptions.machineConfig).
 */
export function runGitUserPathResolution(relative) {
    return runGit({
        args: ['rev-parse', '--path-format=absolute', '--git-path', relative.relative],
        cwd: relative.cwd,
        pathResolution: true,
        machineConfig: true
    });
}
/**
 * git WITHOUT the configuration isolation - the machine's global and system
 * configuration are visible. **Only for patchset-side commits**: the isolation
 * exists so that what codkit computes about the fork *tree* is the same on
 * every machine, while a commit in the patchset repository is an ordinary commit
 * by the person running the command and has to find their name and address
 * where git normally keeps them. Nothing that touches the tree may use this.
 */
export function gitLocal(options) {
    return textResult(spawnGit(options, false));
}
function spawnGit(options, isolate) {
    const netAllowed = options.netAllowed ?? false;
    if (!netAllowed) {
        const refusal = networkRefusal(options.args);
        if (refusal !== null) {
            // Refuse before spawning: the process must not start at all.
            throw ckError('NET-FORBIDDEN', `network git command is not allowed here: git ${refusal.join(' ')}`, `codkit never reaches the network in this mode; run it yourself and re-try: git -C ${options.cwd} ${refusal.join(' ')}`);
        }
    }
    if (options.machineConfig === true && options.pathResolution !== true) {
        throw ckError('INTERNAL', 'machineConfig is legal only for read-only path resolution', 'pass pathResolution with it or drop it');
    }
    const isolateForRun = options.machineConfig === true ? false : isolate;
    const env = childEnv(options.env, isolateForRun);
    if (isolateForRun) {
        Object.assign(env, ISOLATION_ENV);
        const configGlobal = options.gitConfigGlobal ?? runConfigGlobal;
        if (configGlobal !== null && configGlobal !== undefined) {
            env['GIT_CONFIG_GLOBAL'] = configGlobal;
        }
    }
    const isolatedConfig = isolateForRun && options.pathResolution !== true ? ISOLATED_CONFIG : BASE_CONFIG;
    const result = spawnSync('git', [...isolatedConfig, ...hardenDiffArgs(options.args)], {
        cwd: options.cwd,
        env,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        shell: false,
        windowsHide: true,
        ...(options.input === undefined ? {} : { input: options.input })
    });
    if (result.error !== undefined) {
        throw ckError('INTERNAL', `failed to run git in ${options.cwd}: ${result.error.message}`, 'install git >= 2.40 and make sure it is on PATH');
    }
    return {
        status: result.status ?? 1,
        stdout: result.stdout ?? Buffer.alloc(0),
        stderr: result.stderr ?? Buffer.alloc(0)
    };
}
function textResult(result) {
    return {
        status: result.status,
        stdout: result.stdout.toString('utf8'),
        stderr: result.stderr.toString('utf8')
    };
}
/**
 * Start with the useful parent environment (PATH, HOME, credential helpers,
 * locale support) but never inherit a variable that can redirect Git away
 * from options.cwd or inject configuration. A caller has to name the three
 * supported repository overrides itself; this is how load's temporary index
 * remains possible without trusting a stale GIT_INDEX_FILE in the shell.
 */
function childEnv(explicit, isolate) {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !stripInheritedEnv(key, isolate)) {
            env[key] = value;
        }
    }
    if (explicit !== undefined) {
        for (const [key, value] of Object.entries(explicit)) {
            if (!stripExplicitEnv(key, isolate)) {
                env[key] = value;
            }
        }
    }
    return env;
}
function stripInheritedEnv(key, isolate) {
    const normalized = key.toUpperCase();
    return (REPOSITORY_ENV.has(normalized) ||
        isConfigInjectionEnv(normalized) ||
        DIFF_ENV.has(normalized) ||
        (isolate && Object.prototype.hasOwnProperty.call(ISOLATION_ENV, normalized)));
}
function stripExplicitEnv(key, isolate) {
    const normalized = key.toUpperCase();
    if (REPOSITORY_ENV.has(normalized)) {
        return !EXPLICIT_REPOSITORY_ENV.has(normalized);
    }
    return (isConfigInjectionEnv(normalized) ||
        DIFF_ENV.has(normalized) ||
        (isolate && Object.prototype.hasOwnProperty.call(ISOLATION_ENV, normalized)));
}
function isConfigInjectionEnv(key) {
    return CONFIG_INJECTION_ENV.has(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key);
}
/**
 * `-c diff.external` cannot disable an external diff (an empty value is treated
 * as a command). Git's command flags are the safe mechanism. They leave clean,
 * smudge and process filters alone, which is required for LFS checkout.
 */
function hardenDiffArgs(args) {
    const commandIndex = subcommandIndex(args);
    if (commandIndex === null || !DIFF_COMMANDS.has(args[commandIndex] ?? '')) {
        return args;
    }
    const safety = [];
    if (!args.includes('--no-ext-diff')) {
        safety.push('--no-ext-diff');
    }
    if (!args.includes('--no-textconv')) {
        safety.push('--no-textconv');
    }
    if (safety.length === 0) {
        return args;
    }
    return [...args.slice(0, commandIndex + 1), ...safety, ...args.slice(commandIndex + 1)];
}
/** Locate the subcommand after the global options codkit itself uses. */
function subcommandIndex(args) {
    let index = 0;
    while (index < args.length) {
        const arg = args[index];
        if (arg === undefined) {
            return null;
        }
        if (arg === '-c' || arg === '-C' || arg === '--config-env' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
            index += 2;
            continue;
        }
        if (arg.startsWith('-')) {
            index += 1;
            continue;
        }
        return index;
    }
    return null;
}
/**
 * Run git and turn a non-zero status into a CkError carrying the caller's
 * domain code, so call sites do not each re-invent the diagnostic.
 */
export function gitOk(options, failure) {
    const result = runGit(options);
    if (result.status !== 0) {
        const detail = firstLine(result.stderr) ?? firstLine(result.stdout) ?? `git exited with status ${result.status}`;
        throw ckError(failure.code, `${failure.message}: ${detail}`, failure.hint);
    }
    return result;
}
/** Returns the offending argv when the command would reach the network. */
function networkRefusal(args) {
    const first = args[0];
    if (first === undefined) {
        return null;
    }
    if (NETWORK_SUBCOMMANDS.includes(first)) {
        return args;
    }
    const second = args[1];
    if (first === 'lfs' && second !== undefined && NETWORK_LFS_OPERATIONS.includes(second)) {
        return args;
    }
    return null;
}
function firstLine(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
        return null;
    }
    const [line] = trimmed.split('\n');
    return line ?? null;
}
