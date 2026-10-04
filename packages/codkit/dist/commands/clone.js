/** @scope spec://codkit/modules/codkit/PROP-007#root */
import { pinKey } from '../lib/pinIdentity.js';
// codkit clone - bring the fork tree into an empty directory and set it to the pin.
// Contract: PROP-007 sec. 4 (##CMD-CLONE).
//
// This is the only command in codkit allowed to reach the network, and only
// through the two steps that need it: `git clone` and `git lfs pull`. In --ci
// mode it refuses before doing anything at all: a container run must never
// download gigabytes because a path was mistyped.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { EXIT_ENVIRONMENT, EXIT_OK, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.js';
import { gitOk, runGit } from '../lib/gitx.js';
import { ckError } from '../lib/messages.js';
import { formatForkTreeLine, refreshResolution } from '../lib/paths.js';
import { checkTree, formatCheckLine, treeUsesLfs } from '../lib/treeIdentity.js';
const FROM = '--from';
async function run(ctx) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    if (resolution.warning !== null) {
        ctx.out.warn(resolution.warning);
    }
    // Before the source, before the target, before any git call at all.
    if (ctx.flags.ci) {
        ctx.out.addError({
            code: 'NET-FORBIDDEN',
            message: 'clone needs the network and --ci forbids it',
            hint: `clone the tree outside CI and mount it: codkit clone --fork-dir ${resolution.path}`
        });
        return EXIT_ENVIRONMENT;
    }
    const config = requireConfig(ctx.config);
    const source = pickSource(ctx, config);
    const state = inspectTarget(resolution.path);
    if (state === 'not-a-directory') {
        ctx.out.addError({
            code: 'NOT-A-REPO',
            message: `${resolution.path} exists and is not a directory`,
            hint: 'point --fork-dir at a directory that is empty or absent'
        });
        return EXIT_ENVIRONMENT;
    }
    if (state === 'occupied') {
        return reportExisting(ctx, resolution, config);
    }
    ctx.out.info(`cloning ${source} into ${resolution.path}`);
    const failure = cloneForkTree({ path: resolution.path, source, config, out: ctx.out });
    if (failure !== null) {
        ctx.out.addError(failure);
        return EXIT_ENVIRONMENT;
    }
    // Final verdict on the tree we just produced.
    const after = refreshResolution(resolution);
    ctx.out.setForkTree(after.path, after.source);
    return report(ctx, checkTree(after, config, { mode: 'read', type: requireProjectType(ctx) }), 'cloned');
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: clone needs the pin to check out', 'run clone from a patchset checkout that carries codkit.json');
    }
    return config;
}
/** `--from` outranks the configured publishing remote; neither is a config error. */
function pickSource(ctx, config) {
    const fromFlag = commandFlagValue(ctx.commandFlags, FROM);
    if (fromFlag !== null && fromFlag !== '') {
        return fromFlag;
    }
    const configured = config.publishRemoteUrl;
    if (configured !== null && configured !== '') {
        return configured;
    }
    throw ckError('CONFIG', 'no clone source: --from was not given and publishRemoteUrl is null in codkit.json', 'run: codkit clone --from <url|path>   (or set "publishRemoteUrl" in codkit.json)');
}
function inspectTarget(path) {
    if (!existsSync(path)) {
        return 'absent';
    }
    if (!statSync(path).isDirectory()) {
        return 'not-a-directory';
    }
    return readdirSync(path).length === 0 ? 'empty' : 'occupied';
}
/**
 * Idempotency (##CMD-CLONE): a directory that already holds a usable tree is a
 * success, anything else in the way is a fatal environment error.
 */
function reportExisting(ctx, resolution, config) {
    ctx.out.info(`${resolution.path} is not empty; checking what is in it`);
    return report(ctx, checkTree(resolution, config, { mode: 'read', type: requireProjectType(ctx) }), 'already-present');
}
function report(ctx, result, outcome) {
    for (const check of result.checks) {
        ctx.out.info(formatCheckLine(check));
    }
    ctx.out.setData({
        checks: result.checks.map((check) => ({ id: check.id, name: check.name, ok: check.ok })),
        outcome
    });
    if (result.fatal !== null) {
        ctx.out.addError(result.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    ctx.out.info(outcome === 'cloned' ? 'clone complete' : 'already present');
    return EXIT_OK;
}
/**
 * Clone, check out the pin, fetch LFS content. Shared with `load
 * --clone-if-missing` so that there is one implementation of "materialize the
 * fork tree", not two. Returns the diagnosis when it fails, null on success.
 */
export function cloneForkTree(options) {
    const { path, source, config, out } = options;
    cloneInto(path, source);
    // A source that does not carry this history leaves the pin outside the
    // clone; say so here rather than letting `checkout` fail with git's wording.
    if (runGit({ args: ['cat-file', '-e', config.pin.sha], cwd: path }).status !== 0) {
        return {
            code: 'PIN-UNREACHABLE',
            message: `the clone does not contain pin ${pinKey(config.pin)}@${config.pin.sha}`,
            hint: `check that ${source} carries the upstream history this patchset tracks`
        };
    }
    gitOk({ args: ['checkout', '--detach', config.pin.sha], cwd: path }, {
        code: 'PIN-UNREACHABLE',
        message: `cannot check out pin ${pinKey(config.pin)}@${config.pin.sha}`,
        hint: `run: git -C ${path} checkout --detach ${config.pin.sha}`
    });
    out.info(`checked out ${pinKey(config.pin)}@${config.pin.sha.slice(0, 8)} (detached)`);
    pullLfs(path, config, out);
    return null;
}
/**
 * The clone is always full: the identity of the tree is decided by reachability
 * of the upstream anchor commit (PROP-008 ##ID-CHECK-ORIGIN), and a shallow
 * clone has no root commit to reach, so no shallow window is offered at all
 * (PROP-007 sec. 4).
 */
function cloneInto(path, source) {
    // git creates the leaf directory but not its parents.
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    gitOk({ args: ['clone', '--no-checkout', '--', source, path], cwd: parent, netAllowed: true }, {
        code: 'NOT-UPSTREAM',
        message: `cannot clone ${source}`,
        hint: 'check the source URL or path, and that you have access to it'
    });
}
/** LFS is only set up when the tree actually tracks paths with it. */
function pullLfs(path, config, out) {
    if (!treeUsesLfs(path, config.pin.sha)) {
        out.info('git-lfs: nothing tracked in this tree, skipping');
        return;
    }
    gitOk({ args: ['lfs', 'install', '--local', '--skip-repo'], cwd: path }, {
        code: 'LFS',
        message: `cannot configure git-lfs in ${path}`,
        hint: 'install git-lfs (https://git-lfs.com) and re-run codkit clone'
    });
    gitOk({ args: ['lfs', 'pull'], cwd: path, netAllowed: true }, {
        code: 'LFS',
        message: `cannot fetch git-lfs content into ${path}`,
        hint: `run: git -C ${path} lfs pull`
    });
    out.info('git-lfs: content fetched');
}
export const cloneCommand = {
    name: 'clone',
    summary: 'clone the upstream fork tree into the resolved path and check out the pin',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [FROM],
    run
};
