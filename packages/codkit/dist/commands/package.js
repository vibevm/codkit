/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE */
// codkit package - build the product's distributable out of the managed tree.
// Contract: PROP-007 sec. 27 (##CMD-PACKAGE); the engine: lib/packageEngine.ts.
//
// This is the verb that was missing: `ci --profile build` ends at the compile
// channels and the tests, so the last step of a release - materialize the
// overlay targets, stamp what the family asks for, run the packager, put the
// tree back - was a sequence people typed by hand and got wrong at both ends.
//
// It is not a daemon and not a container run, so it needs no wrapper of
// PROP-007 sec. 13: one synchronous command after another, their whole output
// printed, and `--timeout` bounding each of them. It holds the per-tree lock
// like every writing command, and it refuses over a dirty tree exactly as
// `load` does - there is no `--discard` here, because giving up somebody's
// edits is never a side effect of packaging.
import { EXIT_ENVIRONMENT, commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.js';
import { treeId } from '../lib/fingerprint.js';
import { withLock } from '../lib/lock.js';
import { ckError } from '../lib/messages.js';
import { runPackage } from '../lib/packageEngine.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { checkTree } from '../lib/treeIdentity.js';
const KEEP_OVERLAY = '--keep-overlay';
const SKIP_TYPE_BUILD = '--skip-type-build';
const TIMEOUT = '--timeout';
async function run(ctx) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    if (resolution.warning !== null) {
        ctx.out.warn(resolution.warning);
    }
    const config = requireConfig(ctx.config);
    const type = requireProjectType(ctx);
    const timeoutMs = requireTimeout(commandFlagValue(ctx.commandFlags, TIMEOUT));
    const identity = checkTree(resolution, config, { mode: 'write', type });
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    return withLock(ctx.patchesDir, treeId(resolution.path), 'package', () => {
        const result = runPackage({
            patchesDir: ctx.patchesDir,
            resolution,
            config,
            type,
            out: ctx.out,
            flags: {
                keepOverlay: commandFlagGiven(ctx.commandFlags, KEEP_OVERLAY),
                skipTypeBuild: commandFlagGiven(ctx.commandFlags, SKIP_TYPE_BUILD)
            },
            timeoutMs
        });
        ctx.out.setData(dataOf(result));
        return result.exitCode;
    }, (text) => {
        ctx.out.warn(text);
    });
}
function dataOf(result) {
    return {
        steps: result.steps.map((step) => ({ name: step.name, state: step.state, detail: step.detail })),
        materialized: [...result.materialized],
        restored: [...result.restored],
        stamps: { ...result.stamps },
        stampsFromEnvironment: [...result.stampsFromEnvironment],
        commands: [...result.commands],
        outputs: [...result.outputs]
    };
}
/** `--timeout <seconds>` for one packaging command; null leaves it unbounded. */
function requireTimeout(raw) {
    if (raw === null) {
        return null;
    }
    if (!/^\d+$/u.test(raw) || Number.parseInt(raw, 10) <= 0) {
        throw ckError('CONFIG', `${TIMEOUT} expects a positive number of seconds`, `usage: ${TIMEOUT} <seconds>`);
    }
    return Number.parseInt(raw, 10) * 1000;
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: package needs the pin, the delta and the project type of this repository', 'run package from a patchset checkout that carries codkit.json');
    }
    return config;
}
export const packageCommand = {
    name: 'package',
    summary: 'build the distributable from the loaded tree and put the tree back',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [KEEP_OVERLAY, SKIP_TYPE_BUILD, TIMEOUT],
    run
};
