/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit overlay apply|check - the second channel of the config-overlay layer.
// Contract: PROP-007 sec. 12 (##CMD-OVERLAY); format and channels: PROP-005 sec. 5.
//
// An everyday developer never needs these: `load` writes the dev channel and
// leaves the upstream file alone. Packaging does need them, because a packaged
// build reads product.json itself, and that is what `apply` rewrites - from the
// clean file at the pin, so running it twice writes the same bytes.
//
// `check` is the read-only half: it asks whether the artifact still describes
// the upstream it was written against (expectUpstream against the pin), whether
// any operation writes a key the packaging step stamps by itself, and - when the
// target is already materialized - whether the file in the tree really is "the
// pin plus these operations" and not something a hand edit left behind.
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, forkResolution } from '../lib/command.js';
import { treeId } from '../lib/fingerprint.js';
import { OVERLAYS_DIR, OVERLAY_FILE_SUFFIX, applyOverlaysToTree, checkOverlayTarget, loadOverlays, nonProductTargetViolations, overlayDriftErrors } from '../lib/layers/overlay.js';
import { withLock } from '../lib/lock.js';
import { ckError, isCkError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { overlayVarContext, pinCommitDate, toPosix, patchSetCommitId } from '../lib/syncEngine.js';
import { checkTree } from '../lib/treeIdentity.js';
async function run(ctx, mode) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    const config = requireConfig(ctx.config, mode);
    const overlays = loadOverlays(ctx.patchesDir);
    const selected = selectTarget(overlays, ctx.args[0]);
    const identity = checkTree(resolution, config, { mode: mode === 'apply' ? 'write' : 'read' });
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    const tree = resolution.path;
    const context = overlayVarContext(config, pinCommitDate(tree, config.pin.sha), patchSetCommitId(ctx.patchesDir));
    let report;
    try {
        report = checkOverlayTarget(selected.overlays, { treeDir: tree, pinSha: config.pin.sha, context });
    }
    catch (error) {
        // An artifact that no longer describes the tree is a check that did not
        // pass (exit 1); a schema failure never reaches here - it is raised when
        // the overlays are read, and that is a startup failure (exit 2).
        if (!isCkError(error) || error.code !== 'ARTIFACT-BROKEN') {
            throw error;
        }
        ctx.out.addError(error.toPayload());
        return EXIT_CHECK_FAILED;
    }
    for (const warning of report.warnings) {
        ctx.out.warn(warning);
    }
    // ##OVERLAY-NON-PRODUCT-TARGETS: a target without a dev channel may only gain
    // npm scripts, and materializing anything else would rewrite an upstream file
    // the fork has no business rewriting - so `apply` refuses it too.
    const outOfBounds = selected.overlays.flatMap((overlay) => nonProductTargetViolations(overlay));
    if (report.drift.length > 0 || outOfBounds.length > 0) {
        for (const error of [...overlayDriftErrors(report.drift), ...outOfBounds]) {
            ctx.out.addError(error.toPayload());
        }
        ctx.out.setData(buildData(mode, selected, report, null));
        return EXIT_CHECK_FAILED;
    }
    if (mode === 'check') {
        return reportCheck(ctx, selected, report);
    }
    return applyTarget(ctx, config, tree, selected, report, context);
}
/**
 * The argument names a target (`product.json`) or the overlay file itself
 * (`delta/overlays/product.json.overlay.json`, or any path ending in it). Both
 * are accepted: the command is used from scripts, where the artifact path is at
 * hand, and by people, who think in targets.
 */
function selectTarget(overlays, given) {
    if (given === undefined || given === '') {
        throw ckError('CONFIG', 'overlay apply|check needs the target to materialize or check', `usage: codkit overlay check <target|overlay file>   (targets in this delta: ${knownTargets(overlays)})`);
    }
    const byTarget = overlays.filter((overlay) => overlay.target === given);
    if (byTarget.length > 0) {
        return { target: given, overlays: byTarget };
    }
    const wanted = toPosix(given).replace(/^\.\//, '');
    const name = wanted.slice(wanted.lastIndexOf('/') + 1);
    const byFile = overlays.filter((overlay) => overlay.artifactPath === wanted || overlay.artifactPath.endsWith(`/${name}`));
    const first = byFile[0];
    if (first !== undefined) {
        // A file names one artifact, but the target it changes may be shared, and
        // the materialized file is the sum of all of them.
        return { target: first.target, overlays: overlays.filter((overlay) => overlay.target === first.target) };
    }
    throw ckError('CONFIG', `no overlay of this delta targets "${given}"`, `name a target or an overlay file under ${OVERLAYS_DIR}/ (targets in this delta: ${knownTargets(overlays)})`);
}
function knownTargets(overlays) {
    const targets = [...new Set(overlays.map((overlay) => overlay.target))];
    return targets.length === 0 ? `none, there is no ${OVERLAYS_DIR}/*${OVERLAY_FILE_SUFFIX}` : targets.join(', ');
}
/**
 * `check`: the pin side already agreed, so what is left is the tree side. A
 * materialized target that is not "the pin plus the operations" is a file
 * somebody edited by hand, and the layer cannot own it any more.
 */
function reportCheck(ctx, selected, report) {
    ctx.out.setData(buildData('check', selected, report, null));
    if (report.materialization?.matches === false) {
        ctx.out.addError({
            code: 'OVERLAY-DRIFT',
            message: `${report.target} in the fork tree is not the pin plus the operations of ${selected.overlays.map((overlay) => overlay.id).join(', ')}`,
            hint: 'restore the file (git checkout -- <target>) and run codkit overlay apply, or extract the edit into the overlay',
            file: selected.overlays[0]?.artifactPath ?? report.target
        });
        return EXIT_CHECK_FAILED;
    }
    const state = report.materialization?.differsFromPin === true ? 'materialized' : 'at the pin';
    ctx.out.info(`${selected.target}: ${selected.overlays.length} overlay(s) agree with the pin; the file in the tree is ${state}`);
    return EXIT_OK;
}
/** `apply`: rewrite the target in the tree. A writing command, so it locks. */
function applyTarget(ctx, config, tree, selected, report, context) {
    return withLock(ctx.patchesDir, treeId(tree), 'overlay apply', () => {
        const applied = applyOverlaysToTree(selected.overlays, tree, config.pin.sha, context);
        ctx.out.info(applied.changed
            ? `${applied.target}: materialized ${selected.overlays.length} overlay(s) from the pin`
            : `${applied.target}: already materialized, left untouched`);
        ctx.out.setData(buildData('apply', selected, report, applied.changed));
        return EXIT_OK;
    }, (text) => {
        ctx.out.warn(text);
    });
}
function buildData(mode, selected, report, changed) {
    const data = {
        mode,
        target: selected.target,
        overlays: selected.overlays.map((overlay) => overlay.id),
        drift: report.drift.map((entry) => ({
            overlay: entry.overlayId,
            path: [...entry.path],
            expected: entry.expectedAbsent ? null : (entry.expected ?? null),
            expectedAbsent: entry.expectedAbsent,
            actual: entry.actual ?? null,
            actualAbsent: entry.actual === undefined
        })),
        warnings: [...report.warnings],
        materialized: report.materialization?.differsFromPin === true,
        matchesOperations: report.materialization?.matches !== false
    };
    if (changed !== null) {
        data['changed'] = changed;
    }
    return data;
}
function requireConfig(config, mode) {
    if (config === null) {
        throw ckError('CONFIG', `codkit.json was not found in the patchset root: overlay ${mode} needs the pin and the overlays of this repository`, `run overlay ${mode} from a patchset checkout that carries codkit.json`);
    }
    return config;
}
export const overlayApplyCommand = {
    name: 'overlay apply',
    summary: 'materialize an overlay target into the fork tree (packaging, CI, publish)',
    configMode: 'load',
    maxArgs: 1,
    run: (ctx) => run(ctx, 'apply')
};
export const overlayCheckCommand = {
    name: 'overlay check',
    summary: 'check an overlay against the pin and against the file in the tree',
    configMode: 'load',
    maxArgs: 1,
    run: (ctx) => run(ctx, 'check')
};
