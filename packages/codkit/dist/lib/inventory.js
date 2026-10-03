/** @scope spec://codkit/modules/codkit/PROP-006#root */
import { pinKey } from './pinIdentity.js';
// The inventory: every intervention of the delta, as one generated document.
// Contract: PROP-006 sec. 3-4.
//
// The inventory is generated, never maintained by hand and never the source of
// truth (##INVENTORY-IS-GENERATED): the artifacts under delta/ are, and this
// module reads all of them and states what they add up to. What review looks at
// is this document and its diff between two states of patchset, not the patch files
// themselves.
//
// Two properties are load-bearing:
//
//   * it is fast, because nothing here touches the fork tree (##IB-SPEED) - the
//     headers, the manifests and the maps carry everything an entry needs, and
//     the cross-checks that do need the tree live in `verify`;
//   * it is deterministic - entries sorted by id, map keys sorted by bytes, two
//     spaces of indentation - so a diff of two inventories shows what changed in
//     the delta and never how the two runs were ordered.
import { declaredDiscipline } from './discipline.js';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isCallExpression, isIdentifier, isNoSubstitutionTemplateLiteral, isStringLiteral } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { loadConfig } from './configFile.js';
import { loadConventions } from './conventionsFile.js';
import { gitOk, runGit } from './gitx.js';
import { loadOverlays } from './layers/overlay.js';
import { isSafeExtensionName, listExtensionFiles, materializerOf, ownExtensionSourceRoot } from './layers/ownExtensions.js';
import { OWN_MANIFEST_PATH, loadOwnManifest, ownManifestPath } from './layers/ownManifest.js';
import { loadRemoved } from './layers/removed.js';
import { RESOURCE_MAP_PATH, loadResourceMap } from './layers/resource.js';
import { loadRules } from './layers/rule.js';
import { statIfPresent } from './containedPath.js';
import { RUNTIME_PREFIX } from './licenceNotice.js';
import { ckError } from './messages.js';
import { OWN_SOURCE_DIR, listOwnFiles, ownSourceRoot } from './ownCopy.js';
import { ownCodeFilter, ownedRootsOf } from './ownedRoots.js';
import { readVersionLiteral } from './runtimePackage.js';
import { PATCH_FILE_SUFFIX, parseCkpatch } from './patchFormat.js';
import { PATCHES_DIR, patchSetCommitId } from './syncEngine.js';
export const INVENTORY_SCHEMA_VERSION = 2;
/** Where the generated document is written, relative to the patchset root. */
export const INVENTORY_JSON_PATH = '.codkit/out/inventory.json';
export const INVENTORY_MD_PATH = '.codkit/out/inventory.md';
/** The layers an entry can belong to, in the priority order of PROP-005 sec. 1. */
export const INVENTORY_LAYERS = [
    'own',
    'service-override',
    'entry-module',
    'config-overlay',
    'resource-file',
    'rewrite-rule',
    'patch'
];
/**
 * Layers the shrink metric counts (PROP-005 ##LAYER-METRIC): the two bottom
 * layers, the ones that touch upstream text. `entry-module` is a patch by file
 * format but a layer of its own, and is deliberately not counted here.
 */
const METRIC_LAYERS = ['rewrite-rule', 'patch'];
/**
 * Layers whose records must carry a guard test, whatever their category
 * (PROP-005 ##CROSS-CUTTING-MECHANISMS): both are blind zones, where nothing the
 * compiler or the marker discipline sees can notice the intervention going away.
 */
export const GUARDED_LAYERS = ['config-overlay', 'resource-file'];
/** The category that requires a guard test in any layer (##HIDE-MECHANISMS). */
export const GUARDED_CATEGORY = 'hide';
/**
 * A service override replaces an upstream registration (`modify`) with code
 * patchset owns (`own`). The manifest record carries neither field - the layer is
 * defined by the mechanism, not by a choice the author makes - so the inventory
 * derives them, the same way for every override.
 */
const SERVICE_OVERRIDE_TYPE = 'modify';
const SERVICE_OVERRIDE_CATEGORY = 'own';
/**
 * ##OWN-EXTENSION-UNIT: an own extension adds a built-in extension the pin does
 * not ship, so its type is fixed at `extend`, and its category names the layer -
 * the record carries neither field, exactly like a service override.
 */
const OWN_EXTENSION_TYPE = 'extend';
export const OWN_EXTENSION_CATEGORY = 'own-extension';
/** The literal an artifact writes when a field has no value. */
const NONE = 'none';
/** ##RT-INVENTORY-ENTRY: the one record that stands for the delivered library. */
export const DELIVERED_RUNTIME_ID = 'CK-codkit-runtime';
/** ##OWN-DELIVERED-BY-CODKIT: the category of a record nobody in the product wrote. */
export const DELIVERED_CATEGORY = 'delivered';
/**
 * Build the inventory of one patchset checkout.
 *
 * Every artifact is parsed through its own schema, so a delta that does not
 * describe itself correctly fails here rather than producing a plausible-looking
 * document (##IB-READ-ARTIFACTS).
 */
export function buildInventory(patchesDir, type, options = {}) {
    const conventions = loadConventions(type, patchesDir);
    const patches = loadPatches(patchesDir, conventions);
    const overlays = loadOverlays(patchesDir, type);
    const rules = loadRules(patchesDir);
    const manifest = loadOwnManifest(patchesDir);
    const removed = loadRemoved(patchesDir);
    const resources = loadResourceMap(patchesDir);
    // The owned directories the units live in; the configuration is read here
    // when the caller did not hand one over, exactly as the pin is.
    const config = configOf(patchesDir, options.config);
    const roots = ownedRootsOf(type, config.typeConfig);
    const discipline = declaredDiscipline(config);
    const entries = [
        ...patches.map((entry) => patchEntry(entry)),
        ...overlays.map((overlay) => overlayEntry(overlay)),
        ...(resources?.entries ?? []).map((entry) => ({
            id: entry.id,
            layer: 'resource-file',
            type: entry.type,
            category: entry.category,
            subsystem: subsystemOf(entry.id),
            files: [entry.target],
            owner: entry.owner,
            reason: entry.reason,
            link: entry.link,
            cause: causeOf(entry.cause),
            pin: entry.pin,
            contractTests: entry.contractTests,
            artifact: RESOURCE_MAP_PATH
        })),
        ...rules.map((rule) => ruleEntry(rule)),
        ...ownEntries(patchesDir, type, manifest, roots),
        ...deliveredRuntimeEntry(patchesDir)
    ];
    entries.sort((left, right) => compareBytes(left.id, right.id));
    const testIds = ownTestIds(patchesDir);
    return {
        codkitInventory: INVENTORY_SCHEMA_VERSION,
        ...(discipline === undefined ? {} : { discipline }),
        patchSetCommit: options.patchSetCommit ?? patchSetCommitId(patchesDir),
        pin: pinOf(patchesDir, options.config),
        entries,
        metrics: metricsOf(entries, patches.map((entry) => entry.patch), removed.entries, testIds)
    };
}
/** Whether every contract test a record names is declared by an own test. */
export function isCovered(contractTests, testIds) {
    return contractTests.length > 0 && contractTests.every((id) => testIds.has(id));
}
/**
 * The test ids own code declares: direct `suite('<id>', ...)`,
 * `test('<id>', ...)`, `describe('<id>', ...)` and `it('<id>', ...)` calls in
 * .ts/.js files under delta/own/ (PROP-010 ##CONTRACT-TESTS-MANDATE). Both
 * interfaces of the same runner are accepted, because which one a family writes
 * its tests in is the family's habit and not the tool's: the TDD names come
 * from one upstream, the BDD names from another. The compiler parser separates
 * executable syntax from comments and string/template text; property calls such
 * as `test.skip` are deliberately not declarations of enabled coverage.
 */
export function ownTestIds(patchesDir) {
    const root = ownSourceRoot(patchesDir);
    const ids = new Set();
    const sources = [];
    for (const relative of listOwnFiles(root, { refuseSymlinks: true })) {
        if (!relative.endsWith('.ts') && !relative.endsWith('.js')) {
            continue;
        }
        let text;
        try {
            text = readFileSync(join(root, ...relative.split('/')), 'utf8');
        }
        catch {
            continue;
        }
        sources.push({ relative, text });
    }
    for (const id of declaredTestIdsInSources(sources)) {
        ids.add(id);
    }
    return ids;
}
const TEST_SCAN_ROOT = '/codkit-guard-scan';
/** Test ids declared in one file of own code. Exposed so tests need no file. */
export function declaredTestIds(text) {
    return declaredTestIdsInSources([{ relative: 'source.ts', text }]);
}
/** Parse a batch with one compiler process: real inventories usually carry several test files. */
function declaredTestIdsInSources(sources) {
    if (sources.length === 0) {
        return [];
    }
    const virtualFiles = {};
    const paths = [];
    for (const [index, source] of sources.entries()) {
        const extension = source.relative.endsWith('.js') ? '.js' : '.ts';
        const path = `${TEST_SCAN_ROOT}/source-${index}${extension}`;
        virtualFiles[path] = source.text;
        paths.push(path);
    }
    const api = new API({ cwd: TEST_SCAN_ROOT, fs: createVirtualFileSystem(virtualFiles) });
    try {
        const snapshot = api.updateSnapshot({ openFiles: paths });
        try {
            const ids = [];
            for (const path of paths) {
                const project = snapshot.getDefaultProjectForFile(path);
                const sourceFile = project?.program.getSourceFile(path);
                if (sourceFile !== undefined) {
                    collectDirectTestCalls(sourceFile, ids);
                }
            }
            return ids;
        }
        finally {
            snapshot.dispose();
        }
    }
    finally {
        api.close();
    }
}
/** The names of a test declaration, in both interfaces of the runner. */
const TEST_DECLARATION_CALLEES = new Set(['suite', 'test', 'describe', 'it']);
function collectDirectTestCalls(sourceFile, ids) {
    const visit = (node) => {
        if (isCallExpression(node) && node.questionDotToken === undefined && isIdentifier(node.expression)) {
            const callee = node.expression.text;
            const first = node.arguments[0];
            if (TEST_DECLARATION_CALLEES.has(callee) && first !== undefined) {
                if ((isStringLiteral(first) || isNoSubstitutionTemplateLiteral(first)) && first.text !== '') {
                    ids.push(first.text);
                }
            }
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
}
/** Serialize deterministically: schema key order, two spaces, trailing LF. */
export function serializeInventory(inventory) {
    return `${JSON.stringify(inventory, null, 2)}\n`;
}
// ---------------------------------------------------------------------------
// Rendering for people
// ---------------------------------------------------------------------------
/** The `--md` document: the same content as the JSON, laid out for reading. */
export function renderInventoryMarkdown(inventory) {
    const lines = [
        '# codkit inventory',
        '',
        `* pin: \`${inventory.pin}\``,
        `* patchset: \`${inventory.patchSetCommit}\``,
        `* interventions: ${inventory.entries.length}`,
        '',
        '## Entries',
        '',
        '| id | layer | subsystem | category | owner | files | guard tests |',
        '| --- | --- | --- | --- | --- | --- | --- |'
    ];
    for (const entry of inventory.entries) {
        lines.push(`| ${entry.id} | ${entry.layer} | ${entry.subsystem} | ${entry.category} | ${entry.owner} | ` +
            `${cell(entry.files.join('<br>'))} | ${cell(entry.contractTests.join('<br>'))} |`);
    }
    if (inventory.entries.length === 0) {
        lines.push('| _(none)_ | | | | | | |');
    }
    const coverage = inventory.metrics.contractCoverage;
    lines.push('', '## Metrics', '', '| metric | value |', '| --- | --- |', `| patch + rewrite-rule artifacts | ${inventory.metrics.patchAndRuleCount} |`, `| hunks | ${inventory.metrics.hunks} |`, `| lines added by patches | ${inventory.metrics.patchLineTotal} |`, `| entries with a resolved guard test | ${coverage.covered} |`, `| guarded records covered | ${coverage.requiredCovered} / ${coverage.requiredTotal} |`, '', '### By layer', '', '| layer | count |', '| --- | --- |');
    for (const [layer, count] of Object.entries(inventory.metrics.byLayer)) {
        lines.push(`| ${layer} | ${count} |`);
    }
    lines.push('', '### By subsystem', '', '| subsystem | count |', '| --- | --- |');
    for (const [subsystem, count] of Object.entries(inventory.metrics.bySubsystem)) {
        lines.push(`| ${subsystem} | ${count} |`);
    }
    return `${lines.join('\n')}\n`;
}
/** A table cell that cannot break the table. */
function cell(text) {
    return text === '' ? '-' : text.split('|').join('\\|');
}
/** Fields compared when deciding whether an entry changed, in schema order. */
const COMPARED_FIELDS = [
    'layer',
    'type',
    'category',
    'subsystem',
    'files',
    'owner',
    'reason',
    'link',
    'cause',
    'pin',
    'contractTests',
    'artifact'
];
export function diffInventories(before, after) {
    const beforeById = new Map(before.entries.map((entry) => [entry.id, entry]));
    const afterById = new Map(after.entries.map((entry) => [entry.id, entry]));
    const added = after.entries.filter((entry) => !beforeById.has(entry.id));
    const removed = before.entries.filter((entry) => !afterById.has(entry.id));
    const changed = [];
    for (const entry of after.entries) {
        const previous = beforeById.get(entry.id);
        if (previous === undefined) {
            continue;
        }
        const fields = COMPARED_FIELDS.filter((field) => !sameField(previous[field], entry[field]));
        if (fields.length > 0) {
            changed.push({ id: entry.id, fields, before: previous, after: entry });
        }
    }
    return { added, removed, changed, metrics: metricDeltas(before.metrics, after.metrics) };
}
function sameField(left, right) {
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    return left === right;
}
function metricDeltas(before, after) {
    const deltas = [];
    const scalar = [
        ['entries', totalOf(before.byLayer), totalOf(after.byLayer)],
        ['patchAndRuleCount', before.patchAndRuleCount, after.patchAndRuleCount],
        ['hunks', before.hunks, after.hunks],
        ['patchLineTotal', before.patchLineTotal, after.patchLineTotal],
        ['contractCoverage.covered', before.contractCoverage.covered, after.contractCoverage.covered],
        ['contractCoverage.requiredCovered', before.contractCoverage.requiredCovered, after.contractCoverage.requiredCovered],
        ['contractCoverage.requiredTotal', before.contractCoverage.requiredTotal, after.contractCoverage.requiredTotal]
    ];
    for (const [name, from, to] of scalar) {
        if (from !== to) {
            deltas.push({ name, before: from, after: to });
        }
    }
    for (const [prefix, left, right] of [
        ['byLayer', before.byLayer, after.byLayer],
        ['bySubsystem', before.bySubsystem, after.bySubsystem]
    ]) {
        for (const key of unionKeys(left, right)) {
            const from = left[key] ?? 0;
            const to = right[key] ?? 0;
            if (from !== to) {
                deltas.push({ name: `${prefix}.${key}`, before: from, after: to });
            }
        }
    }
    return deltas;
}
function totalOf(counts) {
    return Object.values(counts).reduce((sum, value) => sum + value, 0);
}
function unionKeys(left, right) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) => compareBytes(a, b));
}
/**
 * Materialize a commit of the patchset repository into a scratch directory: the
 * ref's tree goes into a temporary index and out again through
 * `checkout-index`, so the working checkout is never moved and the binary
 * sources of the resource layer arrive as bytes rather than as decoded strings.
 *
 * `inventory --diff` reads the result as a second patchset root; `ci
 * --effective-diff` also builds the generated commits of that state from it.
 */
export function checkoutPatchSetRef(patchesDir, ref) {
    const sha = resolvePatchSetRef(patchesDir, ref);
    const scratch = join(patchesDir, '.codkit', 'tmp', `patchset-${sha.slice(0, 12)}`);
    const indexFile = `${scratch}.index`;
    const release = () => {
        rmSync(scratch, { recursive: true, force: true });
        rmSync(indexFile, { force: true });
    };
    release();
    mkdirSync(scratch, { recursive: true });
    try {
        const env = { GIT_INDEX_FILE: indexFile };
        gitOk({ args: ['read-tree', sha], cwd: patchesDir, env }, { code: 'CONFIG', message: `cannot read the tree of ${ref}`, hint: 'name a commit of this patchset repository' });
        gitOk({ args: ['checkout-index', '--all', `--prefix=${scratch}/`], cwd: patchesDir, env }, { code: 'INTERNAL', message: `cannot materialize ${ref} into ${scratch}`, hint: 're-run with --verbose' });
    }
    catch (error) {
        release();
        throw error;
    }
    rmSync(indexFile, { force: true });
    return { sha, dir: scratch, release };
}
/** A commit of the patchset repository, named by ref, tag or sha. */
export function resolvePatchSetRef(patchesDir, ref) {
    const result = runGit({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd: patchesDir });
    const sha = result.stdout.trim();
    if (result.status !== 0 || sha === '') {
        throw ckError('CONFIG', `${ref} is not a commit of this patchset repository`, 'name a branch, a tag or a sha that this repository carries; codkit reads it through git, without checking it out');
    }
    return sha;
}
/**
 * The inventory of `ref` against the inventory in hand. The shared half of
 * `inventory --diff <ref>` and `ci --effective-diff <base-ref>`, which report
 * the same document in two places and must not compute it in two ways.
 */
export function diffInventoryAgainstRef(patchesDir, type, current, ref) {
    const checkout = checkoutPatchSetRef(patchesDir, ref);
    try {
        return { sha: checkout.sha, diff: diffInventories(buildInventory(checkout.dir, type, { patchSetCommit: checkout.sha }), current) };
    }
    finally {
        checkout.release();
    }
}
/** The inventory diff as the file CI keeps beside the effective diff. */
export function renderInventoryDiffMarkdown(ref, diff) {
    const lines = [
        '# codkit inventory diff',
        '',
        `* base: \`${ref}\``,
        `* added: ${diff.added.length}, removed: ${diff.removed.length}, changed: ${diff.changed.length}`,
        '',
        '## Entries',
        '',
        '| change | id | layer | owner | files |',
        '| --- | --- | --- | --- | --- |'
    ];
    for (const entry of diff.added) {
        lines.push(`| added | ${entry.id} | ${entry.layer} | ${entry.owner} | ${cell(entry.files.join('<br>'))} |`);
    }
    for (const entry of diff.removed) {
        lines.push(`| removed | ${entry.id} | ${entry.layer} | ${entry.owner} | ${cell(entry.files.join('<br>'))} |`);
    }
    for (const entry of diff.changed) {
        lines.push(`| changed | ${entry.id} | ${entry.after.layer} | ${entry.after.owner} | ${cell(entry.fields.join(', '))} |`);
    }
    if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
        lines.push('| _(no entry changed)_ | | | | |');
    }
    lines.push('', '## Metrics', '', '| metric | before | after |', '| --- | --- | --- |');
    for (const delta of diff.metrics) {
        lines.push(`| ${delta.name} | ${delta.before} | ${delta.after} |`);
    }
    if (diff.metrics.length === 0) {
        lines.push('| _(unchanged)_ | | |');
    }
    return `${lines.join('\n')}\n`;
}
/** Every .ckpatch of the repository, in the byte order of their file names. */
export function loadPatches(patchesDir, conventions) {
    const dir = join(patchesDir, ...PATCHES_DIR.split('/'));
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => name.endsWith(PATCH_FILE_SUFFIX))
        .sort((left, right) => compareBytes(left, right))
        .map((name) => {
        const artifact = `${PATCHES_DIR}/${name}`;
        return { artifact, patch: parseCkpatch(readFileSync(join(dir, name)), conventions, artifact) };
    });
}
function patchEntry(entry) {
    const header = entry.patch.header;
    return {
        id: header.id,
        // ##PH-LAYER: the header carries the layer, and a patch generated by a rule
        // belongs to the rule layer even though the file is an ordinary patch.
        layer: header.layer,
        type: header.type,
        category: header.category,
        subsystem: subsystemOf(header.id),
        files: [entry.patch.targetPath],
        owner: header.owner,
        reason: header.reason,
        link: header.link,
        cause: causeOf(header.cause),
        pin: header.pin,
        contractTests: header.contractTests,
        artifact: entry.artifact
    };
}
/**
 * One entry per overlay *file*, not per target: several files may change one
 * target (##OVERLAY-MANY-TO-ONE), and each is a separate intervention with its
 * own owner, reason and guard test.
 */
function overlayEntry(overlay) {
    return {
        id: overlay.id,
        layer: 'config-overlay',
        type: overlay.type,
        category: overlay.category,
        subsystem: subsystemOf(overlay.id),
        files: [overlay.target],
        owner: overlay.owner,
        reason: overlay.reason,
        link: overlay.link,
        cause: causeOf(overlay.cause),
        pin: overlay.pin,
        contractTests: overlay.contractTests,
        artifact: overlay.artifactPath
    };
}
function ruleEntry(rule) {
    return {
        id: rule.id,
        layer: 'rewrite-rule',
        type: rule.type,
        category: rule.category,
        subsystem: subsystemOf(rule.id),
        files: [rule.target],
        owner: rule.owner,
        reason: rule.reason,
        link: rule.link,
        cause: causeOf(rule.cause),
        pin: rule.pin,
        contractTests: rule.contractTests,
        artifact: rule.artifactPath
    };
}
/**
 * Units and service overrides. A unit declares roots, and the entry names the
 * files those roots actually cover today - the point of the record is what own
 * code exists, not what a prefix could match.
 */
function ownEntries(patchesDir, type, manifest, roots) {
    const entries = [];
    // One pass per owned directory: the own root reads the manifest the caller
    // already loaded, every other owned directory reads its own
    // (PROP-016 ##TYPE-AREA-LAYOUT, PROP-005 ##OWN-ROOTS-IN-THE-DELTA).
    for (const [index, owned] of roots.entries()) {
        const ownedManifest = index === 0 ? manifest : loadOwnManifest(patchesDir, owned.deltaDir);
        const ownFiles = listOwnFiles(ownSourceRoot(patchesDir, owned.deltaDir), { refuseSymlinks: true, keep: ownCodeFilter(owned) });
        for (const unit of ownedManifest.units) {
            entries.push({
                id: unit.id,
                layer: 'own',
                type: unit.type,
                category: unit.category,
                subsystem: subsystemOf(unit.id),
                files: expandRoots(unit.roots, ownFiles),
                owner: unit.owner,
                reason: unit.reason,
                link: unit.link,
                cause: causeOf(unit.cause),
                pin: unit.pin,
                contractTests: unit.contractTests,
                artifact: ownManifestPath(owned.deltaDir)
            });
        }
    }
    // ##OWN-EXTENSION-UNIT: one record per extension, in the own layer, naming the
    // files the directory holds today - the same rule the units follow.
    const materializer = materializerOf(type);
    for (const extension of manifest.extensions) {
        const files = materializer !== null && isSafeExtensionName(materializer, extension.name)
            ? listExtensionFiles(ownExtensionSourceRoot(materializer, patchesDir, extension.name)).map((relative) => `${extension.name}/${relative}`)
            : [];
        entries.push({
            id: extension.id,
            layer: 'own',
            type: OWN_EXTENSION_TYPE,
            category: OWN_EXTENSION_CATEGORY,
            subsystem: subsystemOf(extension.id),
            files,
            owner: extension.owner,
            reason: extension.reason,
            link: NONE,
            cause: null,
            pin: extension.pin,
            contractTests: extension.contractTests,
            artifact: OWN_MANIFEST_PATH
        });
    }
    for (const override of manifest.serviceOverrides) {
        entries.push({
            id: override.id,
            layer: 'service-override',
            type: SERVICE_OVERRIDE_TYPE,
            category: SERVICE_OVERRIDE_CATEGORY,
            subsystem: subsystemOf(override.id),
            files: [override.module],
            owner: override.owner,
            reason: override.reason,
            link: override.link,
            cause: causeOf(override.cause),
            pin: override.pin,
            contractTests: override.contractTests,
            artifact: OWN_MANIFEST_PATH
        });
    }
    return entries;
}
/**
 * ##RT-INVENTORY-ENTRY: the runtime library is one line of the inventory, not
 * two hundred. It is a managed copy under codkit's control, so what a reader
 * needs is that it is installed and which version - the files themselves are
 * proven byte for byte by `verify` and `runtime check`.
 */
function deliveredRuntimeEntry(patchesDir) {
    const root = join(patchesDir, ...RUNTIME_PREFIX.split('/'));
    if (statIfPresent(join(root, 'common', 'version.ts')) === null) {
        return [];
    }
    let version;
    try {
        version = readVersionLiteral(root).version;
    }
    catch {
        // A copy without a readable literal is drift; `verify` says so, and the
        // inventory does not invent a version for it.
        return [];
    }
    return [
        {
            id: DELIVERED_RUNTIME_ID,
            layer: 'own',
            type: 'extend',
            category: DELIVERED_CATEGORY,
            subsystem: subsystemOf(DELIVERED_RUNTIME_ID),
            files: [`${RUNTIME_PREFIX.slice(`${OWN_SOURCE_DIR}/`.length)}/`],
            owner: 'codkit',
            reason: `Codkit runtime ${version}`,
            link: 'none',
            cause: null,
            pin: 'none',
            contractTests: [],
            artifact: RUNTIME_PREFIX,
            synthetic: true
        }
    ];
}
/**
 * The files a unit's roots cover, sorted. A root ending in `/` is a directory
 * prefix; anything else names one file, and is kept even when the file is gone
 * so that the record still says what it claims (`verify` is where the missing
 * file becomes a finding).
 */
export function expandRoots(roots, ownFiles) {
    const files = new Set();
    for (const root of roots) {
        const clean = root.startsWith('./') ? root.slice(2) : root;
        if (!clean.endsWith('/')) {
            files.add(clean);
            continue;
        }
        for (const file of ownFiles) {
            if (file.startsWith(clean)) {
                files.add(file);
            }
        }
    }
    return [...files].sort((left, right) => compareBytes(left, right));
}
// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
function metricsOf(entries, patches, removed, testIds) {
    const byLayer = countBy(entries.map((entry) => entry.layer));
    const bySubsystem = countBy(entries.map((entry) => entry.subsystem));
    let hunks = 0;
    let patchLineTotal = 0;
    for (const patch of patches) {
        hunks += patch.hunks.length;
        for (const hunk of patch.hunks) {
            for (const line of hunk.lines) {
                if (line.kind === '+') {
                    patchLineTotal += 1;
                }
            }
        }
    }
    let covered = 0;
    let requiredCovered = 0;
    let requiredTotal = 0;
    for (const entry of entries) {
        const isCoveredEntry = isCovered(entry.contractTests, testIds);
        if (isCoveredEntry) {
            covered += 1;
        }
        if (!requiresGuard(entry)) {
            continue;
        }
        requiredTotal += 1;
        if (isCoveredEntry) {
            requiredCovered += 1;
        }
    }
    for (const entry of removed) {
        requiredTotal += 1;
        if (isCovered(entry.contractTests, testIds)) {
            requiredCovered += 1;
        }
    }
    return {
        byLayer,
        bySubsystem,
        patchAndRuleCount: entries.filter((entry) => METRIC_LAYERS.includes(entry.layer)).length,
        hunks,
        patchLineTotal,
        contractCoverage: { covered, requiredCovered, requiredTotal }
    };
}
/** Whether a guard test is mandatory for this entry (##CROSS-CUTTING-MECHANISMS). */
export function requiresGuard(entry) {
    return GUARDED_LAYERS.includes(entry.layer) || entry.category === GUARDED_CATEGORY;
}
/** Counts by key, with the keys in byte order so the document is stable. */
function countBy(values) {
    const counts = new Map();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const out = {};
    for (const key of [...counts.keys()].sort((left, right) => compareBytes(left, right))) {
        out[key] = counts.get(key) ?? 0;
    }
    return out;
}
// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------
/** `CK-<subsystem>-001` -> `<subsystem>` (##IB-MAKE-ENTRIES). */
export function subsystemOf(id) {
    return id.split('-')[1] ?? '';
}
function causeOf(value) {
    return value === undefined || value === NONE || value === '' ? null : value;
}
/**
 * The pin the delta is written against. The caller usually already holds the
 * config; when it does not, it is read here, and a checkout without one is a
 * checkout whose inventory cannot state a pin at all.
 */
function pinOf(patchesDir, given) {
    const config = configOf(patchesDir, given);
    return `${pinKey(config.pin)}@${config.pin.sha}`;
}
/** The configuration of the checkout: the caller's, or the file's. */
function configOf(patchesDir, given) {
    const config = given ?? loadConfig(patchesDir);
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: the inventory states the pin the delta is written against', 'build the inventory from a patchset checkout that carries codkit.json');
    }
    return config;
}
function compareBytes(left, right) {
    return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}
