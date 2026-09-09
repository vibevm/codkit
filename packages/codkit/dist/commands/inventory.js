/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit inventory - generate the inventory, and diff it against another state
// of patchset. Contract: PROP-007 sec. 10 (##CMD-INVENTORY); content: PROP-006 sec. 3-4.
//
// The document is written to .codkit/out/, never committed: it is derived from
// delta/ and regenerating it is always cheaper than trusting a stale copy
// (##INVENTORY-IS-GENERATED). What review reads is this file and, for a change,
// its diff - which is why `--diff <ref>` builds the inventory of another commit
// of patchset without checking that commit out.
//
// Exit code 1 does not mean the inventory failed to build. It means the delta
// it describes is inconsistent: the same checks `verify` runs, in report mode.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_CHECK_FAILED, EXIT_OK, commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.js';
import { INVENTORY_JSON_PATH, INVENTORY_MD_PATH, buildInventory, diffInventoryAgainstRef, renderInventoryMarkdown, serializeInventory } from '../lib/inventory.js';
import { ckError, serializeErrorPayload } from '../lib/messages.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { checkTree } from '../lib/treeIdentity.js';
import { runVerify } from '../lib/verifyEngine.js';
const DIFF = '--diff';
const MD = '--md';
async function run(ctx) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    const config = requireConfig(ctx.config);
    // ##IB-SPEED: building the inventory never touches the fork tree. The tree is
    // consulted only for the cross-checks, and a tree that cannot be used costs
    // the checks, not the document.
    const identity = checkTree(resolution, config, { mode: 'read' });
    const treeUsable = identity.fatal === null;
    let inventory;
    let findings = [];
    let warnings = [];
    if (treeUsable) {
        const verified = runVerify({ patchesDir: ctx.patchesDir, resolution, config, type: requireProjectType(ctx) });
        inventory = verified.inventory ?? buildInventory(ctx.patchesDir, requireProjectType(ctx), { config });
        findings = verified.findings;
        warnings = verified.warnings;
    }
    else {
        inventory = buildInventory(ctx.patchesDir, requireProjectType(ctx), { config });
        ctx.out.warn(`the fork tree at ${resolution.path} cannot be used (${identity.fatal?.message ?? 'unusable'}), ` +
            'so the inventory was generated without the cross-checks; run codkit verify once the tree is available');
    }
    const wantMarkdown = commandFlagGiven(ctx.commandFlags, MD);
    writeInventory(ctx.patchesDir, inventory, wantMarkdown, ctx.out);
    printSummary(ctx.out, inventory);
    const ref = commandFlagValue(ctx.commandFlags, DIFF);
    // The inventory of another commit of patchset, built from a scratch checkout of
    // it: shared with `ci --effective-diff`, which reports the same document.
    const diff = ref === null ? null : diffInventoryAgainstRef(ctx.patchesDir, requireProjectType(ctx), inventory, ref).diff;
    if (diff !== null) {
        printDiff(ctx.out, ref ?? '', diff);
    }
    for (const warning of warnings) {
        ctx.out.warn(warning);
    }
    for (const item of findings) {
        ctx.out.addError(item);
    }
    ctx.out.setData(dataOf(inventory, findings, ref, diff));
    if (findings.length > 0) {
        ctx.out.info(`inventory: generated, but ${findings.length} consistency violation(s) were found; run codkit verify for the detail`);
        return EXIT_CHECK_FAILED;
    }
    return EXIT_OK;
}
// ---------------------------------------------------------------------------
// Writing and printing
// ---------------------------------------------------------------------------
function writeInventory(patchesDir, inventory, markdown, out) {
    const jsonPath = join(patchesDir, ...INVENTORY_JSON_PATH.split('/'));
    mkdirSync(join(jsonPath, '..'), { recursive: true });
    writeFileSync(jsonPath, serializeInventory(inventory), 'utf8');
    out.info(`wrote ${INVENTORY_JSON_PATH}`);
    if (!markdown) {
        return;
    }
    writeFileSync(join(patchesDir, ...INVENTORY_MD_PATH.split('/')), renderInventoryMarkdown(inventory), 'utf8');
    out.info(`wrote ${INVENTORY_MD_PATH}`);
}
function printSummary(out, inventory) {
    const metrics = inventory.metrics;
    const coverage = metrics.contractCoverage;
    out.info(`pin ${inventory.pin}, patchset ${inventory.patchSetCommit}`);
    out.info(`${inventory.entries.length} intervention(s): ${renderCounts(metrics.byLayer)}`);
    out.info(`by subsystem: ${renderCounts(metrics.bySubsystem)}`);
    out.info(`patch + rewrite-rule: ${metrics.patchAndRuleCount}; hunks: ${metrics.hunks}; lines added: ${metrics.patchLineTotal}`);
    out.info(`guard tests: ${coverage.covered} entry(ies) covered; ${coverage.requiredCovered}/${coverage.requiredTotal} required`);
}
function renderCounts(counts) {
    const parts = Object.entries(counts).map(([key, value]) => `${key} ${value}`);
    return parts.length === 0 ? 'none' : parts.join(', ');
}
function printDiff(out, ref, diff) {
    out.info(`diff against ${ref}: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}`);
    for (const entry of diff.added) {
        out.info(`  + ${entry.id.padEnd(18)} ${entry.layer.padEnd(16)} ${entry.files.join(', ')}`);
    }
    for (const entry of diff.removed) {
        out.info(`  - ${entry.id.padEnd(18)} ${entry.layer.padEnd(16)} ${entry.files.join(', ')}`);
    }
    for (const entry of diff.changed) {
        out.info(`  ~ ${entry.id.padEnd(18)} ${entry.after.layer.padEnd(16)} ${entry.fields.join(', ')}`);
    }
    if (diff.metrics.length === 0) {
        out.info('  metrics: unchanged');
        return;
    }
    out.info('  metric                             before   after');
    for (const delta of diff.metrics) {
        out.info(`  ${delta.name.padEnd(34)} ${String(delta.before).padStart(6)}  ${String(delta.after).padStart(6)}`);
    }
}
// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
function dataOf(inventory, findings, ref, diff) {
    const data = {
        inventory: inventory,
        path: INVENTORY_JSON_PATH,
        findings: findings.map((item) => serializeErrorPayload(item))
    };
    if (ref !== null && diff !== null) {
        data['diff'] = {
            ref,
            added: diff.added.map((entry) => briefOf(entry)),
            removed: diff.removed.map((entry) => briefOf(entry)),
            changed: diff.changed.map((entry) => ({ id: entry.id, fields: [...entry.fields] })),
            metrics: diff.metrics.map((delta) => ({ name: delta.name, before: delta.before, after: delta.after }))
        };
    }
    return data;
}
function briefOf(entry) {
    return { id: entry.id, layer: entry.layer, subsystem: entry.subsystem, files: [...entry.files], artifact: entry.artifact };
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: the inventory states the pin the delta is written against', 'run inventory from a patchset checkout that carries codkit.json');
    }
    return config;
}
export const inventoryCommand = {
    name: 'inventory',
    summary: 'generate the inventory of the delta, and diff it against another state of patchset',
    configMode: 'load',
    maxArgs: 0,
    commandFlags: [DIFF, MD],
    run
};
