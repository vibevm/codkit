/** @scope spec://codkit/modules/codkit/PROP-007#root */
import { pinKey, pinData } from '../lib/pinIdentity.js';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.js';
import { forecastUpgrade } from '../lib/forecast.js';
import { ckError } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { checkTree, formatCheckLine } from '../lib/treeIdentity.js';
const REF = '--ref';
async function run(ctx) {
    const config = requireConfig(ctx.config);
    const requestedRef = commandFlagValue(ctx.commandFlags, REF);
    if (ctx.flags.ci && requestedRef === null) {
        throw ckError('CONFIG', 'forecast --ci requires an explicit --ref', 'pass an immutable target explicitly, for example: codkit forecast --ci --ref <commit>');
    }
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    if (resolution.warning !== null)
        ctx.out.warn(resolution.warning);
    const identity = checkTree(resolution, config, { mode: 'read', type: requireProjectType(ctx) });
    if (ctx.flags.verbose) {
        for (const check of identity.checks)
            ctx.out.diag(formatCheckLine(check));
    }
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    const result = forecastUpgrade({
        patchesDir: ctx.patchesDir,
        treeDir: resolution.path,
        config,
        type: requireProjectType(ctx),
        ref: requestedRef
    });
    render(ctx, result.report);
    ctx.out.setData(reportData(result.report));
    return result.exitCode === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
function render(ctx, report) {
    ctx.out.info(`forecast: ${pinKey(report.sourcePin)}@${report.sourcePin.sha.slice(0, 8)} -> ${report.ref.input} (${report.ref.sha.slice(0, 8)})`);
    ctx.out.info(`outcomes: ${outcomeCounts(report)}`);
    if (report.owners.length === 0) {
        ctx.out.info('forecast: no non-clean artifacts');
        return;
    }
    for (const group of report.owners) {
        ctx.out.info(`${group.owner}: ${group.artifacts.length} non-clean artifact(s)`);
        for (const artifact of group.artifacts)
            ctx.out.info(`  ${renderArtifact(artifact)}`);
    }
}
function outcomeCounts(report) {
    return Object.entries(report.counts.byOutcome)
        .map(([outcome, count]) => `${outcome} ${count}`)
        .join(', ');
}
function renderArtifact(artifact) {
    const approximate = artifact.cause.approx ? '~' : '';
    return `${artifact.outcome} ${artifact.id} [${artifact.layer}] ${artifact.target} cause ${approximate}${artifact.cause.sha.slice(0, 8)} (${artifact.artifact})`;
}
function reportData(report) {
    return {
        sourcePin: pinData(report.sourcePin),
        ref: { ...report.ref },
        counts: { total: report.counts.total, nonClean: report.counts.nonClean, byOutcome: { ...report.counts.byOutcome } },
        owners: report.owners.map((group) => ({
            owner: group.owner,
            artifacts: group.artifacts.map((artifact) => ({
                id: artifact.id,
                artifact: artifact.artifact,
                layer: artifact.layer,
                target: artifact.target,
                outcome: artifact.outcome,
                cause: { ...artifact.cause }
            }))
        }))
    };
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: forecast needs the current pin', 'run forecast from a patchset checkout that carries codkit.json');
    }
    return config;
}
export const forecastCommand = {
    name: 'forecast',
    summary: 'classify the complete delta against a local future upstream ref',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [REF],
    run
};
