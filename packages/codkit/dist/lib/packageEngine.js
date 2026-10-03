/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE */
// The package engine: build the product's distributable out of the managed
// tree, and put the tree back the way it was found.
// Contract: PROP-007 sec. 27 (##CMD-PACKAGE); the answers it runs: PROP-016
// ##TYPE-AREA-BUILD.
//
// `ci --profile build` stops at the compile channels and the tests, so until
// this engine existed the `packageBuild` of every type was a field nothing read
// and the packaging of a fork was a sequence of commands typed by hand. The
// sequence is short and its two ends are what people got wrong:
//
//   * before the build, the overlay targets have to be materialized - a packaged
//     product reads the target file itself, not the dev-channel sidecar
//     (PROP-005 sec. 5) - and the stamps the family names have to be in the
//     environment;
//   * after the build, the tree has to come back to dev mode, or the next
//     ordinary `load` refuses over bytes codkit itself wrote.
//
// Both ends are this engine's, and the second one runs in a `finally`: a build
// that fails halfway is exactly the run whose tree nobody wants to repair by
// hand. What it puts back is only what it materialized itself - a target that
// was already materialized when the run started belongs to whoever left it
// there - and it never touches a build output or a dependency directory: this
// is not a fresh pass, and the artifact it just produced is the point of it.
//
// The drift guard is the one `load` uses, with the one exemption `load --fresh`
// makes (##OVERLAY-KNOWN-MATERIALIZATION): unextracted work still stops the run,
// and `--discard` is not a flag of this command - giving up somebody's edits is
// never a side effect of packaging.
//
// A target of a catalog runs on the route its type answers for this host
// (##CMD-PACKAGE-HOST-ROUTES): natively in the tree, or in the type's container
// over a read-only view of it (packageContainer.ts). What its build downloads is
// checked first, before any write, so that an offline run with a missing input
// is refused while nothing has happened yet (packageInputs.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './command.js';
import { driftDirty } from './driftGuard.js';
import { treeId } from './fingerprint.js';
import { ckError } from './messages.js';
import { applyOverlaysToTree, loadOverlays, writeDevChannel } from './layers/overlay.js';
import { materializerOf } from './layers/ownExtensions.js';
import { ownedRootsOf } from './ownedRoots.js';
import { DEFAULT_CONTAINER_PREFIX, containerCommands, containerInputEnvironment, containerMounts, containerNames, containerRunArgs, containerShim, containerTreeInputs, dockerPlatform, imageBuildArgs, passedEnvironment, recipeHash, takeContainerOutputs, treeArguments, treeModes, writeContainerIo } from './packageContainer.js';
import { checkInputs, inputLines, inputsOf, missingInputsRefusal, nativeInputEnvironment } from './packageInputs.js';
import { packageOutputPaths, packageScratchPaths } from './packagePaths.js';
import { processInvocation } from './processInvocation.js';
import { overlayMaterializationClassifier, overlayVarContext, pinCommitDate, patchSetCommitId, restoreToTip } from './syncEngine.js';
import { revParse } from './treeCache.js';
import { treeHeadError } from './treeCommits.js';
/** How many dirty paths the guard lists before summarizing. */
const DIRTY_LIST_LIMIT = 20;
/** Output of one packaging command that is kept for the diagnostic. */
const FAILURE_TAIL_LINES = 20;
/**
 * The steps a run with these flags will take, before it takes any of them.
 *
 * The order is the contract, and it is stated here rather than being implicit
 * in the control flow of `runPackage` so that a test can read it: the guard
 * before any write, the overlay before the build (a packaged product reads the
 * target), the stamps before the commands that need them, and the restore last
 * and unconditionally - `--keep-overlay` is the one thing that removes it. The
 * inputs come before all of it when the selected targets declare any
 * (##CMD-PACKAGE-INPUTS): the check only reads, and an offline run that misses
 * one is refused before the guard has even looked at the tree.
 */
export function packageStepPlan(type, flags, packageBuild = type.build.packageBuild, hasInputs = false) {
    const steps = [...(hasInputs ? ['inputs'] : []), 'drift guard', 'overlay apply', 'stamps'];
    if (!flags.skipTypeBuild && packageBuild.length > 0) {
        steps.push('package build');
    }
    if (type.build.packageDistributable.length > 0) {
        steps.push('package distributable');
    }
    steps.push('outputs');
    // The residue of the packager is not the overlay, so `--keep-overlay` does
    // not keep it: nobody asked for those bytes, and the flag was asked to keep
    // the materialization for a hand check of the package.
    if (type.build.packageScratch.length > 0) {
        steps.push('scratch restore');
    }
    if (!flags.keepOverlay) {
        steps.push('restore');
    }
    return steps;
}
/** The route of a target on a host: native, in the type's container, or none (##CMD-PACKAGE-HOST-ROUTES). */
export function routeOf(target, host) {
    if (target.supportedHosts.includes(host)) {
        return 'native';
    }
    if (target.container?.hosts.includes(host) === true) {
        return 'container';
    }
    return null;
}
export function packageTargetsFor(type, selector, host) {
    const catalog = type.build.packageTargets ?? [];
    if (catalog.length === 0) {
        if (selector !== null)
            throw ckError('CONFIG', `the project type ${type.id} has no selectable package target catalog`, 'omit the selector or choose a type that declares package targets');
        return [];
    }
    const ids = selector === null
        ? (type.build.defaultPackageTargets ?? [])
        : selector === 'all'
            ? catalog.filter((candidate) => routeOf(candidate, host) !== null).map((candidate) => candidate.id)
            : ['windows', 'linux', 'macos'].includes(selector)
                ? catalog
                    .filter((candidate) => candidate.platform === selector && routeOf(candidate, host) !== null)
                    .map((candidate) => candidate.id)
                : [selector];
    const unique = [...new Set(ids)];
    const targets = unique
        .map((id) => catalog.find((candidate) => candidate.id === id))
        .filter((candidate) => candidate !== undefined);
    if (targets.length !== unique.length)
        throw ckError('CONFIG', `unknown package target: ${unique.find((id) => !catalog.some((candidate) => candidate.id === id))}`, `choose one of: ${catalog.map((target) => target.id).join(', ')}, a platform family, or all`);
    const unsupported = targets.find((candidate) => routeOf(candidate, host) === null);
    if (unsupported !== undefined) {
        const reason = unsupported.hostRefusal?.reason;
        const hosts = [...unsupported.supportedHosts, ...(unsupported.container?.hosts ?? [])];
        throw ckError('CONFIG', `package target ${unsupported.id} is not supported on host ${host}${reason === undefined ? '' : `: ${reason}`}`, unsupported.hostRefusal?.hint ?? `run this target on one of: ${hosts.join(', ')}`);
    }
    if (targets.length === 0)
        throw ckError('CONFIG', `package selector ${selector ?? '(default)'} has no targets supported on host ${host}`, 'choose an exact target supported by this host');
    return targets;
}
/** One package run over an already loaded tree. The caller holds the tree lock. */
export function runPackage(options) {
    const { out, config, patchesDir, type } = options;
    const tree = options.resolution.path;
    const env = options.env ?? process.env;
    const offline = options.offline ?? false;
    const inputsDir = options.inputsDir ?? null;
    const host = options.host ?? process.platform;
    const steps = [];
    const materialized = [];
    const commands = [];
    let restored = [];
    let scratchRestored = [];
    let outputs = [];
    const selectedTargets = packageTargetsFor(type, options.targetSelector ?? null, host);
    const routed = selectedTargets.map((target) => routedTarget(options, target, host));
    const packageBuild = selectedTargets.length === 0 ? type.build.packageBuild : selectedTargets.flatMap((target) => target.build);
    const targets = selectedTargets.map((target) => target.id);
    const routes = routed.map((entry) => ({
        target: entry.target.id,
        route: entry.route,
        image: entry.container?.names.image ?? null,
        volume: entry.container?.names.volume ?? null
    }));
    const checked = checkInputs(inputsOf(selectedTargets, tree), inputsDir);
    const inputs = checked.map((entry) => ({ name: entry.input.name, path: entry.input.path, from: entry.input.from, state: entry.state }));
    const record = (name, state, detail) => {
        steps.push({ name, state, detail });
        out.info(`package ${name}: ${state}${detail === '' ? '' : ` (${detail})`}`);
    };
    out.info(`package targets: ${targets.length === 0 ? 'legacy' : routed.map((entry) => `${entry.target.id} (${entry.route})`).join(', ')}`);
    out.info(`package plan: ${packageStepPlan(type, options.flags, packageBuild, checked.length > 0).join(' -> ')}`);
    const overlays = loadOverlays(patchesDir, type);
    const context = overlayVarContext(config, pinCommitDate(tree, config.pin.sha), patchSetCommitId(patchesDir));
    const stamps = packageStamps(type, config, tree, env);
    const stampValues = Object.fromEntries(stamps.map((stamp) => [stamp.name, stamp.value]));
    const stampsFromEnvironment = stamps.filter((stamp) => stamp.fromEnvironment).map((stamp) => stamp.name);
    const result = (exitCode) => ({
        exitCode,
        steps,
        materialized,
        restored,
        scratchRestored,
        stamps: stampValues,
        stampsFromEnvironment,
        commands,
        outputs,
        targets,
        routes,
        inputs
    });
    // The checks that only read come before any write: the inputs, and what the
    // container route needs of the host (##CMD-PACKAGE-INPUTS,
    // ##CMD-PACKAGE-CONTAINER).
    if (checked.length > 0) {
        for (const line of inputLines(checked)) {
            out.info(line);
        }
        const missing = checked.filter((entry) => entry.state === 'missing');
        if (offline && missing.length > 0) {
            record('inputs', 'failed', `${missing.length} of ${checked.length} input(s) are not pre-provisioned`);
            out.addError(missingInputsRefusal(missing, inputsDir).toPayload());
            return result(EXIT_ENVIRONMENT);
        }
        record('inputs', 'ok', `${checked.length - missing.length} of ${checked.length} input(s) pre-provisioned${offline ? ', offline' : ''}`);
    }
    const preflight = containerPreflight(options, routed, offline);
    if (preflight !== null) {
        out.addError(preflight.error);
        return result(preflight.exitCode);
    }
    const guard = guardStep(options, overlays, context);
    if (guard !== null) {
        record('drift guard', 'failed', guard.detail);
        out.addError(guard.error);
        return result(guard.exitCode);
    }
    record('drift guard', 'ok', 'the fork tree carries no unextracted work');
    // From here on the tree carries bytes this run wrote, so the restore is a
    // `finally`: a build that fails halfway must not leave a developer's tree in
    // packaging state (R14 - what was announced is what happens).
    let exitCode = EXIT_OK;
    let runDir = null;
    try {
        for (const group of overlayTargets(overlays)) {
            if (applyOverlaysToTree(group.overlays, tree, config.pin.sha, context).changed) {
                materialized.push(group.target);
            }
        }
        record('overlay apply', 'ok', materialized.length === 0 ? 'every target was already materialized' : materialized.join(', '));
        record('stamps', 'ok', stamps.length === 0 ? `the project type ${type.id} stamps nothing` : stamps.map((stamp) => stamp.name).join(', '));
        for (const stamp of stamps) {
            out.info(`stamp ${stamp.name}=${stamp.value}${stamp.fromEnvironment ? ' (from environment)' : ''}`);
        }
        if (options.flags.skipTypeBuild) {
            out.info(`skip-type-build: the application build of ${type.id} is not run; the tree is taken as already built`);
        }
        if (!options.flags.skipTypeBuild && packageBuild.length > 0) {
            // The inputs are wired once per run, and only for a native target that
            // runs: the container route wires them inside its container.
            let wired = null;
            const nativeEnvironment = () => {
                if (!offline && !checked.some((entry) => entry.state === 'provisioned')) {
                    return stampValues;
                }
                if (wired === null) {
                    runDir = mkdtempSync(join(tmpdir(), 'codkit-package-'));
                    wired = { ...stampValues, ...nativeInputEnvironment(checked, runDir, tree, offline, env['PATH'] ?? env['Path'] ?? '') };
                }
                return wired;
            };
            const outcome = routed.length === 0
                ? runCommands(options, packageBuild, stampValues, commands)
                : runRoutedTargets(options, routed, stampValues, nativeEnvironment, checked, commands);
            record('package build', outcome.state, outcome.detail);
            if (outcome.error !== null) {
                out.addError(outcome.error);
                exitCode = outcome.exitCode;
            }
        }
        if (exitCode === EXIT_OK && type.build.packageDistributable.length > 0) {
            const outcome = runCommands(options, type.build.packageDistributable, stampValues, commands);
            record('package distributable', outcome.state, outcome.detail);
            if (outcome.error !== null) {
                out.addError(outcome.error);
                exitCode = outcome.exitCode;
            }
        }
        if (exitCode === EXIT_OK) {
            const patterns = outputPatterns(type, selectedTargets);
            outputs = packageOutputPaths(tree, patterns, (text) => {
                out.warn(text);
            });
            record('outputs', 'ok', outputsDetail(type, patterns, outputs));
            for (const path of outputs) {
                out.info(`artifact ${path}`);
            }
        }
    }
    finally {
        // The packager's own leftovers first, the overlay after it: the overlay
        // restore is what rewrites the dev channel, and it has to be the last
        // thing that touches the tree.
        const scratch = restoreScratch(options);
        scratchRestored = scratch.paths;
        if (type.build.packageScratch.length > 0) {
            record('scratch restore', 'ok', scratch.detail);
        }
        restored = restoreOverlayTargets(options, overlays, context, materialized);
        if (options.flags.keepOverlay) {
            out.info(`keep-overlay: ${materialized.length} materialized target(s) stay in the fork tree; codkit load --fresh returns them`);
        }
        else {
            record('restore', 'ok', restored.length === 0 ? 'this run materialized nothing to put back' : restored.join(', '));
        }
        if (runDir !== null) {
            rmSync(runDir, { recursive: true, force: true });
        }
    }
    return result(exitCode);
}
/** The route of a selected target and, for the container route, the names of its image and volume. */
function routedTarget(options, target, host) {
    const route = routeOf(target, host) ?? 'native';
    const container = target.container;
    if (route === 'native' || container === undefined) {
        return { target, route: 'native', container: null };
    }
    const tree = options.resolution.path;
    const args = treeArguments(container, tree);
    const names = containerNames(options.containerPrefix ?? DEFAULT_CONTAINER_PREFIX, options.type.id, target, recipeHash(container.recipe, args), treeId(tree));
    return { target, route: 'container', container: { names, args } };
}
/**
 * What the container route needs of the host, asked before any write: a docker
 * that starts, and - for an offline run, which cannot build one - the image.
 */
function containerPreflight(options, routed, offline) {
    const inContainer = routed.filter((entry) => entry.container !== null);
    if (inContainer.length === 0) {
        return null;
    }
    const run = options.runCommand ?? defaultPackageCommandRunner;
    const probe = runQuietly(run, options, ['version', '--format', '{{.Server.Version}}']);
    if (probe.status !== EXIT_OK || probe.error !== undefined) {
        return {
            error: {
                code: 'PACKAGE-FAILED',
                message: `docker could not be started for the container route of ${inContainer.map((entry) => entry.target.id).join(', ')}: ${probe.error?.message ?? (lastLine(probe.stderr) || `docker version exited ${probe.status}`)}`,
                hint: 'the container route needs a running Docker engine and the docker command on PATH'
            },
            exitCode: EXIT_ENVIRONMENT
        };
    }
    if (!offline) {
        return null;
    }
    for (const entry of inContainer) {
        const image = entry.container?.names.image ?? '';
        if (runQuietly(run, options, ['image', 'inspect', image]).status !== EXIT_OK) {
            return {
                error: {
                    code: 'NET-FORBIDDEN',
                    message: `an offline run fetches nothing, and the image ${image} of the container route of ${entry.target.id} is not there: building it needs the network`,
                    hint: 'run the same codkit package once without --ci, or load the image into docker under that name'
                },
                exitCode: EXIT_ENVIRONMENT
            };
        }
    }
    return null;
}
/** The build commands of every selected target, each on its route, stopping at the first that fails. */
function runRoutedTargets(options, routed, stamps, nativeEnvironment, checked, into) {
    const details = [];
    for (const entry of routed) {
        const outcome = entry.container === null
            ? runCommands(options, entry.target.build, nativeEnvironment(), into)
            : runContainerTarget(options, entry.target, entry.container, stamps, checked, into);
        if (outcome.error !== null) {
            return outcome;
        }
        details.push(`${entry.target.id}: ${outcome.detail}`);
    }
    return { state: 'ok', detail: details.join('; '), error: null, exitCode: EXIT_OK };
}
/**
 * One target on the container route (##CMD-PACKAGE-CONTAINER): the image when it
 * is not there, the volume, the files of the protocol, the run, and the
 * artifacts back into the tree. The run's directory goes whatever the verdict.
 */
function runContainerTarget(options, target, container, stamps, checked, into) {
    const recipe = target.container;
    if (recipe === undefined) {
        throw new Error(`package target ${target.id} has no container`);
    }
    const env = options.env ?? process.env;
    const tree = options.resolution.path;
    const offline = options.offline ?? false;
    const platform = dockerPlatform(target.arch);
    const run = options.runCommand ?? defaultPackageCommandRunner;
    const { names, args } = container;
    const valuesOf = (namesOfVariables) => Object.fromEntries(namesOfVariables.map((name) => [name, env[name] ?? '']));
    if (runQuietly(run, options, ['image', 'inspect', names.image]).status !== EXIT_OK) {
        const buildEnvironment = passedEnvironment(recipe.buildEnvironment, env);
        const buildArgs = imageBuildArgs(recipe, names, platform, args, buildEnvironment);
        const built = runOne(options, `container image ${names.image}`, 'docker', buildArgs, valuesOf(buildEnvironment), into);
        if (built.error !== null) {
            return {
                ...built,
                error: {
                    ...built.error,
                    hint: `build the image yourself under the name ${names.image}, with the options your network needs, and run again: docker ${buildArgs.join(' ')}`
                }
            };
        }
    }
    const volume = runOne(options, `container volume ${names.volume}`, 'docker', ['volume', 'create', names.volume], {}, into);
    if (volume.error !== null) {
        return volume;
    }
    const ioDir = mkdtempSync(join(tmpdir(), 'codkit-package-'));
    try {
        writeContainerIo(ioDir, {
            commands: containerCommands(target.build, { ...stamps, ...containerInputEnvironment(checked) }),
            outputs: target.outputs ?? [],
            modes: treeModes(tree),
            treeInputs: containerTreeInputs(checked),
            shim: containerShim(checked, offline)
        });
        const runEnvironment = passedEnvironment(recipe.runEnvironment, env);
        const runArgs = containerRunArgs({
            names,
            platform,
            mounts: containerMounts(tree, names.volume, ioDir, options.inputsDir ?? null, checked),
            offline,
            runEnvironment
        });
        const outcome = runOne(options, `package ${target.id} in the container`, 'docker', runArgs, valuesOf(runEnvironment), into);
        if (outcome.error !== null) {
            // A container that --timeout stopped outlives its docker client.
            runQuietly(run, options, ['rm', '--force', names.volume]);
            return outcome;
        }
        const arrived = takeContainerOutputs(ioDir, tree, target.outputs ?? [], (text) => {
            options.out.warn(text);
        });
        for (const path of arrived) {
            options.out.info(`container artifact ${path} copied into the fork tree`);
        }
        return { ...outcome, detail: `in the container ${names.image}, ${arrived.length} artifact(s) copied into the fork tree` };
    }
    finally {
        rmSync(ioDir, { recursive: true, force: true });
    }
}
/** A docker command whose output nobody reads: a probe, or a cleanup. */
function runQuietly(run, options, args) {
    try {
        return run({ label: 'docker', command: 'docker', args: [...args], cwd: options.resolution.path, env: {}, timeoutMs: null });
    }
    catch (error) {
        return { status: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) };
    }
}
function lastLine(text) {
    return outputLines(text).at(-1) ?? '';
}
/** The output patterns of the selected targets and then the type's own, each once. */
function outputPatterns(type, targets) {
    return [...new Set([...targets.flatMap((target) => target.outputs ?? []), ...type.build.packageOutputs])];
}
/** What the outputs step says when it found something, and when it did not. */
function outputsDetail(type, patterns, outputs) {
    if (outputs.length > 0) {
        return outputs.join(', ');
    }
    return patterns.length === 0
        ? `the project type ${type.id} names no package output inside the tree`
        : 'no declared output exists in the tree';
}
/** The drift guard of `load`, with the exemption `load --fresh` makes. */
function guardStep(options, overlays, context) {
    const { config, out, patchesDir, type } = options;
    const tree = options.resolution.path;
    const branch = `${config.generatedBranchPrefix}${config.pin.tag}`;
    const known = [];
    const drift = driftDirty(materializerOf(type), tree, ownedRootsOf(type, config.typeConfig, { treeDir: tree, pinSha: config.pin.sha }), patchesDir, {
        generated: { pinSha: config.pin.sha, branch },
        isKnownMaterialization: overlayMaterializationClassifier(overlays, tree, config.pin.sha, context, known)
    });
    const head = treeHeadError(drift.treeCommits, branch);
    if (head !== null) {
        return {
            detail: 'HEAD of the tree is not on the generated branch while it carries commits',
            error: head.toPayload(),
            exitCode: EXIT_CHECK_FAILED
        };
    }
    if (known.length > 0) {
        out.info(`${known.join(', ')} already carries the exact overlay materialization; this run keeps it`);
    }
    if (!drift.dirty) {
        return null;
    }
    for (const path of drift.files.slice(0, DIRTY_LIST_LIMIT)) {
        out.info(`  dirty: ${path}`);
    }
    if (drift.files.length > DIRTY_LIST_LIMIT) {
        out.info(`  ... and ${drift.files.length - DIRTY_LIST_LIMIT} more`);
    }
    const commits = drift.commits.length;
    return {
        detail: commits > 0
            ? `${commits} commit(s) in the fork tree are not in patchset`
            : `${drift.files.length} path(s) differ from what patchset carries`,
        error: {
            code: 'DIRTY-TREE',
            message: commits > 0
                ? `${commits} commit(s) in the fork tree since the last codkit apply are not in patchset yet`
                : `${drift.files.length} path(s) in the fork tree carry changes that are not in patchset yet`,
            hint: 'run codkit save, or codkit status; packaging never gives up work of the tree on its own'
        },
        exitCode: EXIT_CHECK_FAILED
    };
}
/** The overlays of the delta, grouped by target, in target order. */
function overlayTargets(overlays) {
    const byTarget = new Map();
    for (const overlay of overlays) {
        const bucket = byTarget.get(overlay.target);
        if (bucket === undefined) {
            byTarget.set(overlay.target, [overlay]);
            continue;
        }
        bucket.push(overlay);
    }
    return [...byTarget.keys()].sort().map((target) => ({ target, overlays: byTarget.get(target) ?? [] }));
}
/**
 * Put back exactly the targets this run materialized, and rewrite the dev
 * channel over them - which is what a tree in dev mode carries
 * (PROP-005 ##OVERLAY-TWO-CHANNELS). A target somebody else materialized is
 * left alone: this run did not write it, and `load --fresh` is the command that
 * owns that state.
 */
function restoreOverlayTargets(options, overlays, context, materialized) {
    if (options.flags.keepOverlay || materialized.length === 0) {
        return [];
    }
    const tree = options.resolution.path;
    restoreToTip(tree, materialized);
    writeDevChannel(options.type, tree, overlays, context, options.config.pin.sha, (text) => {
        options.out.warn(text);
    });
    return [...materialized];
}
/**
 * Put back the paths the packager rewrote as a side effect of running.
 *
 * Only the paths the type named, and only to the tip of the loaded tree - the
 * same `git checkout HEAD --` the overlay restore uses. The guard at the start
 * of the run proved the tree carried no unextracted work, so a named path that
 * differs now differs because the packaging changed it; a path nothing changed
 * is not touched and is not reported. Untracked files are left alone: removing
 * a file nobody tracked is what `load --fresh` does, and it is not a side
 * effect of packaging.
 */
function restoreScratch(options) {
    const tree = options.resolution.path;
    const paths = packageScratchPaths(tree, options.type.build.packageScratch, (text) => {
        options.out.warn(text);
    });
    if (paths.length === 0) {
        return { paths, detail: 'the packaging changed none of the paths the project type names' };
    }
    restoreToTip(tree, paths);
    return { paths, detail: paths.join(', ') };
}
/**
 * The environment the family asks for, and where each value came from.
 *
 * A name the operator already exported keeps the operator's value
 * (##TYPE-STAMPS-FILL-A-GAP): the stamps of a type exist because a packager
 * reads a variable nobody remembers to set, not because the tool has an opinion
 * about a variable somebody set deliberately. An exported name whose value is
 * empty is an empty value and not an answer, so the type still fills it - which
 * is also what keeps `FOO= codkit package` from silently packaging with an
 * empty channel.
 */
export function packageStamps(type, config, treeDir, env = process.env) {
    return type.build.packageStamps.map((stamp) => {
        const exported = env[stamp.name];
        if (exported !== undefined && exported !== '') {
            return { name: stamp.name, value: exported, fromEnvironment: true };
        }
        return { name: stamp.name, value: valueOfStamp(stamp, config, treeDir), fromEnvironment: false };
    });
}
/** What the run itself, or the type's own configuration, fills a stamp with. */
function valueOfStamp(stamp, config, treeDir) {
    switch (stamp.source) {
        case 'tree-head':
            return revParse(treeDir, 'HEAD') ?? '';
        case 'pin-tag':
            return config.pin.tag;
        case 'pin-date':
            return config.pin.date;
        default:
            return stamp.value;
    }
}
function runCommands(options, build, stamps, into) {
    for (const declared of build) {
        let targetEnvironment = {};
        try {
            targetEnvironment = declared.environment?.({ ...process.env, ...stamps }) ?? {};
        }
        catch (error) {
            return {
                state: 'failed',
                detail: `${declared.label}: ${error instanceof Error ? error.message : String(error)}`,
                error: {
                    code: 'PACKAGE-FAILED',
                    message: `${declared.label}: ${error instanceof Error ? error.message : String(error)}`,
                    hint: 'install the target toolchain or add its executable directory to PATH'
                },
                exitCode: EXIT_ENVIRONMENT
            };
        }
        const outcome = runOne(options, declared.label, declared.command === 'npm' ? npmCommand() : declared.command, declared.args, { ...targetEnvironment, ...stamps }, into);
        if (outcome.error !== null) {
            return outcome;
        }
    }
    return { state: 'ok', detail: `${build.length} command(s) passed`, error: null, exitCode: EXIT_OK };
}
/** One command in the tree: announced, run, its whole output printed, its failure turned into the refusal. */
function runOne(options, label, executable, args, env, into) {
    const run = options.runCommand ?? defaultPackageCommandRunner;
    const command = {
        label,
        command: executable,
        args: [...args],
        cwd: options.resolution.path,
        env,
        timeoutMs: options.timeoutMs
    };
    const rendered = renderCommand(command);
    options.out.info(`--- ${command.label}: ${rendered}`);
    into.push(rendered);
    let result;
    try {
        result = run(command);
    }
    catch (error) {
        result = { status: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) };
    }
    const lines = [...outputLines(result.stdout), ...outputLines(result.stderr)];
    for (const line of lines) {
        options.out.info(`[${command.label}] ${line}`);
    }
    if (result.status === EXIT_OK && result.error === undefined) {
        return { state: 'ok', detail: '1 command(s) passed', error: null, exitCode: EXIT_OK };
    }
    const couldNotRun = result.status === null || result.error !== undefined;
    const why = couldNotRun ? failureReason(result) : `exited ${result.status}`;
    const tail = lines.slice(-FAILURE_TAIL_LINES);
    return {
        state: 'failed',
        detail: `${command.label}: ${why}`,
        error: {
            code: 'PACKAGE-FAILED',
            message: `${command.label}: ${why}${tail.length === 0 ? '' : `; last output: ${tail.join(' | ')}`}`,
            hint: `run the command in the fork tree to see it fail on its own: ${rendered}`
        },
        exitCode: couldNotRun ? EXIT_ENVIRONMENT : EXIT_CHECK_FAILED
    };
}
function defaultPackageCommandRunner(command) {
    const invocation = processInvocation(command.command, command.args);
    const result = spawnSync(invocation.command, [...invocation.args], {
        cwd: command.cwd,
        env: { ...process.env, ...command.env },
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
        ...(command.timeoutMs === null ? {} : { timeout: command.timeoutMs })
    });
    const base = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    return result.error === undefined ? base : { ...base, error: result.error };
}
function npmCommand() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
function outputLines(text) {
    const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
    const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
    return lines.length === 1 && lines[0] === '' ? [] : lines;
}
function failureReason(result) {
    if (result.error !== undefined) {
        return result.error.message;
    }
    return 'the command did not finish (killed by a signal or by --timeout)';
}
function renderCommand(command) {
    return [command.command, ...command.args].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ');
}
