/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW */
// The preview engine: show a person the product by launching a host application
// over the loaded fork tree, in a profile isolated from the person's own, and
// leave it running.
// Contract: PROP-007 sec. 29 (##CMD-PREVIEW); the host: previewHost.ts
// (##CMD-PREVIEW-HOST); the isolation and the record: previewIsolation.ts
// (##CMD-PREVIEW-ISOLATION, ##CMD-PREVIEW-RECORD); the answer it runs: PROP-016
// ##TYPE-AREA-PREVIEW.
//
// The type owns the recipe - the executable name of the family's default host,
// what prepares the tree, the exact argv the host takes and the two directories
// that keep it out of the person's own profile - and the engine owns everything
// around it: the drift guard, the state directory under the patch set's runtime
// state, the overlay materialization and its restore, the resolution of the
// host, the refusal of a recipe that breaks the isolation rule, the detached
// spawn and the record of what it spawned. The engine names no host, no flag of
// a host and no artifact of a family (PROP-016 ##TYPE-ENGINE-IS-BLIND): it
// spawns exactly what the recipe hands it.
//
// The building blocks are the package engine's, because a preview is the same
// transaction with a launch at the end: the guard of `load` with the one
// exemption of a known materialization, the materialization of the overlay
// targets - the host reads the manifest from the tree - the package build for a
// mode that needs the distributable, and the restore of exactly what this run
// materialized. The restore runs at the end of `--wait`, and after a refusal
// that happens before the launch; a run that returns while the host runs leaves
// the materialization in the tree on purpose, because the host is reading it
// (##CMD-PREVIEW step 8).
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_ENVIRONMENT, EXIT_OK } from './command.js';
import { treeId } from './fingerprint.js';
import { applyOverlaysToTree, loadOverlays } from './layers/overlay.js';
import { ckError, isCkError } from './messages.js';
import { guardStep, overlayTargets, packageStamps, restoreOverlayTargets, restoreScratch } from './packageEngine.js';
import { packageOutputPaths } from './packagePaths.js';
import { runCommands } from './packageRuntime.js';
import { hostCandidate, hostRefusal, resolveHost, sourceLabel } from './previewHost.js';
import { PREVIEW_DIR, PREVIEW_RECORD_SCHEMA_VERSION, isolationProblem, isolationRefusal, previewStateDir, spawnPreviewHost, writePreviewRecord } from './previewIsolation.js';
import { overlayVarContext, patchSetCommitId, pinCommitDate } from './syncEngine.js';
/** A mode is one path segment of the state directory, so its name is kept to the characters of one. */
const MODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/**
 * The steps of one run, in the order ##CMD-PREVIEW fixes, stated before any of
 * them is taken so that a test can read the order: the guard before any write,
 * the host before the tree is touched, the overlay before the recipe that
 * launches over it, the isolation check before anything is built or spawned,
 * the artifact before the preparation that may install it, and the restore only
 * at the end of `--wait`. The artifact step is always in the plan and is skipped
 * by a mode that runs from the tree, so that the plan is fixed before the recipe
 * has been asked.
 */
export function previewStepPlan(wait) {
    return ['drift guard', 'host', 'overlay apply', 'recipe', 'artifact', 'prepare', 'launch', ...(wait ? ['restore'] : [])];
}
/** The mode of one run: `--mode` when given, else the type's default; an unknown or unsafe name is `CK-E-CONFIG`. */
export function requireMode(area, type, requested) {
    const mode = requested ?? area.defaultMode;
    if (!area.modes.includes(mode)) {
        throw ckError('CONFIG', `unknown preview mode ${mode}; the project type ${type.id} answers: ${area.modes.join(', ')}`, `usage: --mode <${area.modes.join('|')}>`);
    }
    if (!MODE_NAME.test(mode)) {
        throw ckError('CONFIG', `the project type ${type.id} names a preview mode that is not a path segment: ${JSON.stringify(mode)}`, `this is a defect of the type package; a mode is one directory name under ${PREVIEW_DIR}/`);
    }
    return mode;
}
/** The newest of the existing package outputs, by modification time; null when none exists. */
export function newestArtifact(treeDir, outputs) {
    let newest = null;
    for (const output of outputs) {
        const trimmed = output.endsWith('/') ? output.slice(0, -1) : output;
        const path = join(treeDir, ...trimmed.split('/'));
        let mtimeMs;
        try {
            mtimeMs = statSync(path).mtimeMs;
        }
        catch {
            continue;
        }
        if (newest === null || mtimeMs > newest.mtimeMs) {
            newest = { path, mtimeMs };
        }
    }
    return newest?.path ?? null;
}
/**
 * Steps 1 to 7 of one run, over an already loaded tree; the caller holds the
 * tree lock and releases it when this returns, because what follows is a
 * person's session. A refusal before the launch puts back what this run
 * materialized; a launch leaves it, since the host reads it.
 */
export function preparePreview(options) {
    const { out, config, patchesDir, type, area, flags } = options;
    const tree = options.resolution.path;
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const stateDir = previewStateDir(patchesDir, flags.mode);
    const steps = [];
    const materialized = [];
    const commands = [];
    let restored = [];
    let host = null;
    let artifact = null;
    let launch = null;
    let record = null;
    let spawned = null;
    const result = (exitCode) => ({
        exitCode,
        mode: flags.mode,
        host,
        stateDir,
        workspace: flags.workspaceDir,
        artifact,
        steps,
        materialized,
        restored,
        launch,
        record,
        spawned
    });
    const step = (name, state, detail) => {
        steps.push({ name, state, detail });
        out.info(`preview ${name}: ${state}${detail === '' ? '' : ` (${detail})`}`);
    };
    const refuse = (name, error, exitCode) => {
        step(name, 'failed', error.message);
        out.addError(error);
        return exitCode;
    };
    const failedCommands = (name, outcome) => {
        step(name, 'failed', outcome.detail);
        if (outcome.error !== null) {
            out.addError(outcome.error);
        }
        return outcome.exitCode;
    };
    out.info(`preview plan: ${previewStepPlan(flags.wait).join(' -> ')}`);
    const packageOptions = packageOptionsOf(options, env);
    const overlays = loadOverlays(patchesDir, type);
    const context = overlayVarContext(config, pinCommitDate(tree, config.pin.sha), patchSetCommitId(patchesDir));
    // 1. The guard of `load`, before any write (##CMD-PACKAGE step 1).
    const guard = guardStep(packageOptions, overlays, context);
    if (guard !== null) {
        step('drift guard', 'failed', guard.detail);
        out.addError(guard.error);
        return result(guard.exitCode);
    }
    step('drift guard', 'ok', 'the fork tree carries no unextracted work');
    // 2. The host, and the state directory of the mode.
    const candidate = hostCandidate(flags.host, env, config.typeConfig, area.defaultHost);
    const resolution = resolveHost(candidate, { platform, env, cwd: options.cwd ?? process.cwd() });
    if (!resolution.ok) {
        return result(refuse('host', hostRefusal(resolution.tried), EXIT_ENVIRONMENT));
    }
    host = resolution.path;
    if (flags.clean) {
        rmSync(stateDir, { recursive: true, force: true });
    }
    mkdirSync(stateDir, { recursive: true });
    step('host', 'ok', `${host} (${sourceLabel(candidate.source)}); state ${stateDir}${flags.clean ? ', wiped first' : ''}`);
    const request = (built) => ({
        treeDir: tree,
        mode: flags.mode,
        host: resolution.path,
        stateDir,
        workspaceDir: flags.workspaceDir,
        artifact: built
    });
    const runSteps = () => {
        // 3. The overlay targets, materialized the way `package` does it: the
        // host reads the target file itself (##CMD-PACKAGE step 2).
        for (const group of overlayTargets(overlays)) {
            if (applyOverlaysToTree(group.overlays, tree, config.pin.sha, context).changed) {
                materialized.push(group.target);
            }
        }
        step('overlay apply', 'ok', materialized.length === 0 ? 'every target was already materialized' : materialized.join(', '));
        // 4. The recipe, asked once without the artifact - what it needs is its
        // answer - and checked before anything is built or spawned.
        let recipe = askRecipe(area, type, request(null));
        const problem = isolationProblem(recipe, stateDir);
        if (problem !== null) {
            return refuse('recipe', isolationRefusal(type, problem), EXIT_ENVIRONMENT);
        }
        step('recipe', 'ok', `${recipe.prepare.length} preparation command(s); ${recipe.needsArtifact ? 'the mode needs the distributable' : `the mode ${flags.mode} runs from the tree`}`);
        // 5. The distributable, for a mode that needs one: `packageBuild` then
        // `packageDistributable` with the stamps of the type, as ##CMD-PACKAGE
        // steps 3-5 run them, and the newest of the outputs is handed over. The
        // recipe is asked again with it, because its launch may carry it.
        if (recipe.needsArtifact) {
            const built = buildArtifact(packageOptions, env, commands);
            if (built.failed !== null) {
                return failedCommands('artifact', built.failed);
            }
            if (built.artifact === null) {
                return refuse('artifact', {
                    code: 'CONFIG',
                    message: `the mode ${flags.mode} needs the distributable, and no artifact of the package outputs of ${type.id} exists in the tree after the package build`,
                    hint: 'run codkit package and read where its artifacts land; the project type names them as build.packageOutputs'
                }, EXIT_ENVIRONMENT);
            }
            artifact = built.artifact;
            step('artifact', 'ok', `${built.artifact}${built.scratchRestored.length === 0 ? '' : `; ${built.scratchRestored.join(', ')} put back`}`);
            recipe = askRecipe(area, type, request(built.artifact));
        }
        else {
            step('artifact', 'skipped', `the mode ${flags.mode} runs from the tree`);
        }
        // 6. The preparation of the tree, each command's output printed.
        if (flags.noBuild) {
            step('prepare', 'skipped', `--no-build: ${recipe.prepare.length} preparation command(s) not run`);
        }
        else if (recipe.prepare.length === 0) {
            step('prepare', 'ok', 'the recipe names no preparation command');
        }
        else {
            const outcome = runCommands(packageOptions, recipe.prepare, {}, commands);
            if (outcome.error !== null) {
                return failedCommands('prepare', outcome);
            }
            step('prepare', 'ok', outcome.detail);
        }
        // 7. The launch, detached over the tree, and its record.
        const again = isolationProblem(recipe, stateDir);
        if (again !== null) {
            return refuse('launch', isolationRefusal(type, again), EXIT_ENVIRONMENT);
        }
        const spawner = options.spawnHost ?? ((toLaunch, cwd, wait) => spawnPreviewHost(toLaunch, cwd, wait, env));
        let started;
        try {
            started = spawner(recipe.launch, tree, flags.wait);
        }
        catch (error) {
            if (isCkError(error)) {
                return refuse('launch', error.toPayload(), EXIT_ENVIRONMENT);
            }
            throw error;
        }
        spawned = started;
        launch = recipe.launch;
        const startedAt = new Date().toISOString();
        const path = writePreviewRecord(patchesDir, flags.mode, {
            codkitPreview: PREVIEW_RECORD_SCHEMA_VERSION,
            mode: flags.mode,
            host: resolution.path,
            pid: started.pid,
            startedAt,
            treeId: treeId(tree),
            workspace: flags.workspaceDir,
            artifact,
            launch: { command: recipe.launch.command, args: [...recipe.launch.args] }
        });
        record = { pid: started.pid, startedAt, path };
        step('launch', 'ok', `pid ${started.pid}: ${renderLaunch(recipe.launch)}; record ${path}`);
        return EXIT_OK;
    };
    // From here on the tree carries bytes this run wrote. A refusal before the
    // launch puts them back, exactly as a package run that fails halfway does; a
    // launch leaves them, because the host is reading them (##CMD-PREVIEW step 8).
    let exitCode = EXIT_OK;
    try {
        exitCode = runSteps();
    }
    catch (error) {
        if (!isCkError(error)) {
            throw error;
        }
        out.addError(error.toPayload());
        exitCode = EXIT_ENVIRONMENT;
    }
    finally {
        if (spawned === null && materialized.length > 0) {
            restored = restoreOverlayTargets(packageOptions, overlays, context, materialized);
            out.info(`${restored.join(', ')}: put back, since nothing was launched`);
        }
    }
    return result(exitCode);
}
/**
 * The end of `--wait`: the overlay targets this run materialized are put back
 * and the dev channel rewritten, exactly as `codkit package` step 7 does; a
 * target somebody else materialized is left alone (##CMD-PREVIEW step 8). The
 * caller holds the tree lock again.
 */
export function restorePreviewTargets(options, result) {
    const tree = options.resolution.path;
    const overlays = loadOverlays(options.patchesDir, options.type);
    const context = overlayVarContext(options.config, pinCommitDate(tree, options.config.pin.sha), patchSetCommitId(options.patchesDir));
    const restored = restoreOverlayTargets(packageOptionsOf(options, options.env ?? process.env), overlays, context, result.materialized);
    const detail = restored.length === 0 ? 'this run materialized nothing to put back' : restored.join(', ');
    options.out.info(`preview restore: ok (${detail})`);
    return { ...result, restored, steps: [...result.steps, { name: 'restore', state: 'ok', detail }] };
}
/** The package engine's view of this run: no flag of `package` is set, and nothing is bounded by a timeout. */
function packageOptionsOf(options, env) {
    return {
        patchesDir: options.patchesDir,
        resolution: options.resolution,
        config: options.config,
        type: options.type,
        out: options.out,
        flags: { keepOverlay: false, skipTypeBuild: false },
        timeoutMs: null,
        env,
        ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand })
    };
}
/** The recipe of the type for one request; a recipe that throws is a defect of the type, reported as `CK-E-CONFIG` naming it. */
function askRecipe(area, type, request) {
    try {
        return area.recipe(request);
    }
    catch (error) {
        throw ckError('CONFIG', `the project type ${type.id} refused the preview recipe of the mode ${request.mode}: ${error instanceof Error ? error.message : String(error)}`, 'this is a defect of the type package; pass --mode to select another mode of the type');
    }
}
/**
 * `packageBuild` then `packageDistributable`, with the stamps of the type in
 * their environment, and the residue the packager rewrote put back whatever the
 * verdict - the two ends of ##CMD-PACKAGE steps 3 to 6a. The newest existing
 * output is the artifact.
 * REVIEW: ##CMD-PREVIEW step 5 names only steps 4-5 of package; the stamps (step 3) and the scratch restore (6a) are taken along because a packager without its stamps does not build, and residue left in the tree would make the next load refuse.
 */
function buildArtifact(packageOptions, env, commands) {
    const { type, config, out } = packageOptions;
    const tree = packageOptions.resolution.path;
    const stamps = packageStamps(type, config, tree, env);
    const stampValues = Object.fromEntries(stamps.map((stamp) => [stamp.name, stamp.value]));
    for (const stamp of stamps) {
        out.info(`stamp ${stamp.name}=${stamp.value}${stamp.fromEnvironment ? ' (from environment)' : ''}`);
    }
    let failed = null;
    for (const half of [type.build.packageBuild, type.build.packageDistributable]) {
        if (half.length === 0) {
            continue;
        }
        const outcome = runCommands(packageOptions, half, stampValues, commands);
        if (outcome.error !== null) {
            failed = outcome;
            break;
        }
    }
    const scratch = restoreScratch(packageOptions);
    if (failed !== null) {
        return { artifact: null, scratchRestored: scratch.paths, failed };
    }
    const outputs = packageOutputPaths(tree, type.build.packageOutputs, (text) => {
        out.warn(text);
    });
    for (const output of outputs) {
        out.info(`artifact ${output}`);
    }
    return { artifact: newestArtifact(tree, outputs), scratchRestored: scratch.paths, failed: null };
}
function renderLaunch(launch) {
    return [launch.command, ...launch.args].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ');
}
