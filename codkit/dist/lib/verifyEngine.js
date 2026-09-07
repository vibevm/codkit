/** @scope spec://codkit/modules/codkit/PROP-006#root */
// The verify engine: every integrity check of the delta, without a build.
// Contract: PROP-007 sec. 11 (##CMD-VERIFY); the cross-checks themselves are
// PROP-006 sec. 5-6 and the layer rules of PROP-005.
//
// Three properties shape it:
//
//   * it is read-only and lock-free - `verify` is what CI and a reviewer run,
//     including while somebody else holds the tree;
//   * it reads the pin from git objects and never from the working files, so a
//     dirty tree verifies exactly like a clean one;
//   * it reports everything it finds. One finding per line, each with its code
//     and its file, because an upgrade that broke five artifacts is not five
//     runs of work.
//
// The verdict is the caller's: this module returns findings, and `verify`,
// `inventory` and the pre-commit hook each decide what to do with them.
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { isCallExpression, isIdentifier, isImportDeclaration, isNamedImports } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { applyUnified } from './applyUnified.js';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { CONFIG_FILE_NAME, loadBaseConfig, serializeBaseConfig } from './configFile.js';
import { loadConventions } from './conventionsFile.js';
import { runGit } from './gitx.js';
import { checkHunksInsideMarkers, checkMarkerArtifactConsistency } from './hunksInMarkers.js';
import { buildInventory, loadPatches, ownTestIds, requiresGuard } from './inventory.js';
import { OVERLAYS_DIR, OVERLAY_FILE_SUFFIX, PRODUCT_JSON_TARGET, checkOverlay, devChannelIgnoreWarning, loadOverlays, nonProductTargetViolations, overlayDriftErrors, parseOverlay, serializeOverlay } from './layers/overlay.js';
import { OWN_EXTENSIONS_DIR, checkOwnExtensions, compareOwnExtensions, isSafeExtensionName, ownExtensionTargetRelativeDir, ownExtensionTreePrefixes } from './layers/ownExtensions.js';
import { OWN_CODKIT_ROOT, OWN_MANIFEST_PATH, checkServiceOverrideModules, checkUnitCoverage, isNotOwnCode, isUnderCodkitRoot, loadOwnManifest, parseOwnManifest, serializeOwnManifest } from './layers/ownManifest.js';
import { REMOVED_PATH, loadRemoved, parseRemoved, serializeRemoved } from './layers/removed.js';
import { RESOURCE_MAP_PATH, loadResourceMap, parseResourceMap, resourceSourcePath, serializeResourceMap } from './layers/resource.js';
import { RULES_DIR, RULE_FILE_SUFFIX, countRuleMatches, loadRules, parseRule, serializeRule } from './layers/rule.js';
import { BEGIN_TOKEN, END_TOKEN, parseMarkers } from './markers.js';
import { ckError, isCkError } from './messages.js';
import { OWNERS_PATH, loadOwnerKeys, ownerKeysOf } from './owners.js';
import { OWN_SOURCE_DIR, listOwnFiles, ownSourceRoot, ownTargetRelativeDir } from './ownCopy.js';
import { PATCH_FILE_SUFFIX, parseCkpatch } from './patchFormat.js';
import { CODKIT_TOOL_ROOT, shippedRuntime } from './runtimePackage.js';
import { RUNTIME_TARGET_PATH } from './runtimeLoad.js';
import { NOTICE_NAME } from './licenceNotice.js';
import { compareTrees } from './standardsPackage.js';
import { PATCHES_DIR, generatedBranchName, toPosix } from './syncEngine.js';
import { revParse } from './treeCache.js';
import { checkTree } from './treeIdentity.js';
/**
 * The whole check list of ##CMD-VERIFY, in the order a reviewer reads it: the
 * artifacts first, then what they say about each other, then what the tree says
 * about all of them.
 */
export function runVerify(options) {
    const { patchesDir, config } = options;
    const tree = options.resolution.path;
    const conventions = loadConventions(patchesDir);
    // (a) Everything parses. A schema failure is raised, not collected: an
    // artifact that does not describe itself cannot be cross-checked at all.
    const patches = loadPatches(patchesDir, conventions);
    const overlays = loadOverlays(patchesDir);
    const rules = loadRules(patchesDir);
    const manifest = loadOwnManifest(patchesDir);
    const removed = loadRemoved(patchesDir);
    const resourceMap = loadResourceMap(patchesDir);
    const resources = resourceMap?.entries ?? [];
    const inventory = buildInventory(patchesDir, { config });
    const findings = [];
    const warnings = [];
    const testIds = ownTestIds(patchesDir);
    // (a) The cycle consumes canonical metadata bytes. Verify uses the same
    // serializers here, so a semantic no-op reformat cannot pass the PR gate and
    // then fail only after cycle start.
    checkCanonicalMetadata(patchesDir, overlays, resourceMap, rules, manifest, removed, findings);
    // (b) and (c): the two properties every record has to have on its own.
    checkUniqueIds(inventory.entries, removed.entries, findings);
    checkOwners(patchesDir, inventory.entries, removed.entries, findings);
    // (d) Markers, against the pin.
    checkPatchMarkers(tree, config, conventions, patches, findings);
    // (e) and (k): the records that are invisible to compiler and marker alike.
    checkGuards(inventory.entries, removed.entries, testIds, findings);
    // (f) Rules: the counter still agrees with the file at the pin.
    checkRules(tree, config, rules, findings);
    // (g) Overlays: the pin side, and the rule for the non-product targets.
    checkOverlays(tree, config, overlays, findings);
    // (h) Own code: declared, not overlapping, and not overriding a bootstrap
    // service.
    checkOwn(patchesDir, conventions, manifest, findings);
    // (h2) What codkit delivered into the own layer: the installed runtime
    // library is byte-equal to the shipped one, and no record of the product
    // claims a path inside the root that belongs to codkit (PROP-015 sec. 4,
    // PROP-005 ##OWN-CODKIT-PREFIX-RESERVED).
    checkDeliveredRuntime(patchesDir, options.toolRoot ?? CODKIT_TOOL_ROOT, findings);
    checkCodkitRootIsReserved(manifest, findings);
    // (h4) The own-extension layer: the section describes materializable
    // extensions, and what the tree carries is what the delta holds
    // (PROP-005 ##OWN-EXTENSION-UNIT).
    checkOwnExtensionLayer(patchesDir, tree, config, manifest, findings);
    // (h3) The graft budget: a patch of type `hook` creates a seam and nothing
    // more (PROP-005 ##PATCH-HOOK-BUDGET).
    checkHookBudget(config, patches, findings);
    // (i) "No intervention outside the inventory", against the generated branch.
    checkCompleteness(patchesDir, tree, config, patches, overlays, resources, findings, warnings);
    // (l) The dev channel has to stay invisible to the tree's git.
    if (overlays.some((overlay) => overlay.target === PRODUCT_JSON_TARGET)) {
        const warning = devChannelIgnoreWarning(tree);
        if (warning !== null) {
            warnings.push(warning);
        }
    }
    return { findings, warnings, counts: countByCode(findings), inventory, checked: inventory.entries.length };
}
/**
 * What the pre-commit hook runs: the staged artifacts only, and only the checks
 * that are cheap enough to run on every commit (PROP-012 ##NFR-PRECOMMIT-SPEED).
 *
 * The blobs are read from the index, not from the working files: what is about
 * to be committed is what has to be correct.
 *
 * A tree that cannot be used is not a failure here. The hook must not lock a
 * repository whose fork tree is missing, on a laptop or in a container that has
 * only patchset; the full `verify` is where a missing tree is an error.
 */
export function runStagedFast(options) {
    const { patchesDir, config } = options;
    const conventions = loadConventions(patchesDir);
    const staged = stagedDeltaPaths(patchesDir);
    const findings = [];
    const warnings = [];
    if (staged.length === 0) {
        return { findings, warnings, counts: {}, inventory: null, checked: 0, staged, treeUsable: true };
    }
    const identity = options.resolution === null ? null : checkTree(options.resolution, config, { mode: 'read' });
    const treeUsable = identity !== null && identity.fatal === null;
    if (!treeUsable) {
        warnings.push((options.resolution === null
            ? 'the fork tree is not configured, '
            : `the fork tree at ${options.resolution.path} cannot be used (${identity?.fatal?.message ?? 'unusable'}), `) +
            'so the staged patches were checked for their format only; run codkit verify once the tree is available');
    }
    for (const path of staged) {
        // Own code and resource blobs carry no schema of their own; reading them
        // here would buy nothing and would decode a binary as text.
        if (!hasSchema(path)) {
            continue;
        }
        const bytes = stagedBytes(patchesDir, path);
        if (bytes === null) {
            continue;
        }
        parseStagedArtifact(path, bytes, conventions, findings);
        if (!treeUsable || options.resolution === null || !path.endsWith(PATCH_FILE_SUFFIX)) {
            continue;
        }
        checkStagedPatch(options.resolution.path, config, conventions, path, bytes, findings);
    }
    return { findings, warnings, counts: countByCode(findings), inventory: null, checked: staged.length, staged, treeUsable };
}
/** Staged paths under delta/, additions and modifications alike. */
function stagedDeltaPaths(patchesDir) {
    const result = runGit({
        args: ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', '--', DELTA_DIR],
        cwd: patchesDir
    });
    if (result.status !== 0) {
        return [];
    }
    return result.stdout.split('\0').filter((path) => path !== '');
}
/** The delta directory, relative to the patchset root. */
const DELTA_DIR = 'delta';
/** The blob as it is staged, or null when it cannot be read. */
function stagedBytes(patchesDir, path) {
    const result = runGit({ args: ['show', `:${path}`], cwd: patchesDir });
    return result.status === 0 ? encodeUtf8(result.stdout) : null;
}
/**
 * Validate one staged artifact through the schema of its layer. Anything the
 * loaders raise is turned into a finding, so the hook reports every staged file
 * rather than the first broken one.
 */
function parseStagedArtifact(path, bytes, conventions, findings) {
    try {
        parseByPath(path, bytes, conventions);
    }
    catch (error) {
        findings.push(toFinding(error, path));
    }
}
function checkStagedPatch(treeDir, config, conventions, path, bytes, findings) {
    let patch;
    try {
        patch = parseCkpatch(bytes, conventions, path);
    }
    catch {
        // Already reported by the schema pass; one broken file, one finding.
        return;
    }
    checkOnePatchMarkers(treeDir, config, conventions, { artifact: path, patch }, [], findings);
}
/** Whether a path under delta/ is one the schemas of the layers describe. */
function hasSchema(path) {
    return ((path.startsWith(`${PATCHES_DIR}/`) && path.endsWith(PATCH_FILE_SUFFIX)) ||
        (path.startsWith(`${OVERLAYS_DIR}/`) && path.endsWith(OVERLAY_FILE_SUFFIX)) ||
        (path.startsWith(`${RULES_DIR}/`) && path.endsWith(RULE_FILE_SUFFIX)) ||
        path === RESOURCE_MAP_PATH ||
        path === OWN_MANIFEST_PATH ||
        path === REMOVED_PATH ||
        path === OWNERS_PATH);
}
/**
 * Validate a delta file through the schema of the layer its path belongs to.
 * A path with no schema - own code, a resource blob - has nothing to validate
 * and passes silently.
 */
function parseByPath(path, bytes, conventions) {
    if (path.startsWith(`${PATCHES_DIR}/`) && path.endsWith(PATCH_FILE_SUFFIX)) {
        parseCkpatch(bytes, conventions, path);
        return;
    }
    if (path.startsWith(`${OVERLAYS_DIR}/`) && path.endsWith(OVERLAY_FILE_SUFFIX)) {
        const parsed = parseOverlay(decodeJson(path, bytes, 'OVERLAY-SCHEMA'), path);
        assertCanonicalMetadataBytes(path, bytes, serializeOverlay(parsed), 'ARTIFACT-BROKEN');
        return;
    }
    if (path.startsWith(`${RULES_DIR}/`) && path.endsWith(RULE_FILE_SUFFIX)) {
        const parsed = parseRule(decodeJson(path, bytes, 'ARTIFACT-BROKEN'), path);
        assertCanonicalMetadataBytes(path, bytes, serializeRule(parsed), 'ARTIFACT-BROKEN');
        return;
    }
    if (path === RESOURCE_MAP_PATH) {
        const parsed = parseResourceMap(decodeJson(path, bytes, 'ARTIFACT-BROKEN'));
        assertCanonicalMetadataBytes(path, bytes, serializeResourceMap(parsed), 'ARTIFACT-BROKEN');
        return;
    }
    if (path === OWN_MANIFEST_PATH) {
        const parsed = parseOwnManifest(decodeJson(path, bytes, 'ARTIFACT-BROKEN'));
        assertCanonicalMetadataBytes(path, bytes, serializeOwnManifest(parsed), 'ARTIFACT-BROKEN');
        return;
    }
    if (path === REMOVED_PATH) {
        const parsed = parseRemoved(decodeJson(path, bytes, 'ARTIFACT-BROKEN'));
        assertCanonicalMetadataBytes(path, bytes, serializeRemoved(parsed), 'ARTIFACT-BROKEN');
        return;
    }
    if (path === OWNERS_PATH && ownerKeysOf(decodeJson(path, bytes, 'CONFIG')) === null) {
        throw ckError('CONFIG', 'has no "owners" object', 'owners.json maps an owner key to its contact and paths', path);
    }
}
function checkCanonicalMetadata(patchesDir, overlays, resourceMap, rules, manifest, removed, findings) {
    const baseConfig = loadBaseConfig(patchesDir);
    if (baseConfig !== null) {
        checkCanonicalMetadataFile(patchesDir, CONFIG_FILE_NAME, serializeBaseConfig(baseConfig), 'CONFIG', findings);
    }
    for (const overlay of overlays) {
        checkCanonicalMetadataFile(patchesDir, overlay.artifactPath, serializeOverlay(overlay), 'ARTIFACT-BROKEN', findings);
    }
    if (resourceMap !== null) {
        checkCanonicalMetadataFile(patchesDir, RESOURCE_MAP_PATH, serializeResourceMap(resourceMap), 'ARTIFACT-BROKEN', findings);
    }
    for (const rule of rules) {
        checkCanonicalMetadataFile(patchesDir, rule.artifactPath, serializeRule(rule), 'ARTIFACT-BROKEN', findings);
    }
    if (manifest.present) {
        checkCanonicalMetadataFile(patchesDir, OWN_MANIFEST_PATH, serializeOwnManifest(manifest), 'ARTIFACT-BROKEN', findings);
    }
    if (removed.present) {
        checkCanonicalMetadataFile(patchesDir, REMOVED_PATH, serializeRemoved(removed), 'ARTIFACT-BROKEN', findings);
    }
}
function checkCanonicalMetadataFile(patchesDir, path, canonical, code, findings) {
    try {
        const bytes = readFileSync(join(patchesDir, ...path.split('/')));
        assertCanonicalMetadataBytes(path, bytes, canonical, code);
    }
    catch (error) {
        findings.push(toFinding(error, path));
    }
}
function assertCanonicalMetadataBytes(path, bytes, canonical, code) {
    if (bytesEqual(bytes, encodeUtf8(canonical)))
        return;
    throw ckError(code, 'metadata bytes are not canonical JSON', 'use schema key order, schema array order, two-space indentation, UTF-8 without BOM, LF line endings, and exactly one final LF', path);
}
function decodeJson(path, bytes, code) {
    const text = decodeUtf8Strict(bytes);
    if (text === null) {
        throw ckError('ENCODING', 'is not valid UTF-8', 'codkit reads and writes UTF-8 only', path);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw ckError(code, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'the artifacts of the delta are plain JSON without comments', path);
    }
}
/**
 * Every record a person wrote. The synthetic entry that stands for the runtime
 * library codkit delivered (##RT-INVENTORY-ENTRY) is left out: no artifact
 * declares it and no owner of this delta is responsible for it, so demanding a
 * unique id or a declared owner from it would report codkit's own work as the
 * product's mistake.
 */
function allRecords(entries, removed) {
    return [
        ...entries.filter((entry) => entry.synthetic !== true).map((entry) => ({ id: entry.id, owner: entry.owner, artifact: entry.artifact })),
        ...removed.map((entry) => ({ id: entry.id, owner: entry.owner, artifact: REMOVED_PATH }))
    ];
}
/**
 * An id names exactly one intervention across the whole delta: the marker in the
 * tree carries nothing but that id, so two records sharing one would make the
 * marker ambiguous.
 */
function checkUniqueIds(entries, removed, findings) {
    const seen = new Map();
    for (const record of allRecords(entries, removed)) {
        const first = seen.get(record.id);
        if (first === undefined) {
            seen.set(record.id, record.artifact);
            continue;
        }
        findings.push(finding('MARKER-DUP-ID', `id ${record.id} is used by two records: ${first} and ${record.artifact}`, 'give one of them an id of its own; a marker carries the id and nothing else, so it has to name one record', record.artifact));
    }
}
function checkOwners(patchesDir, entries, removed, findings) {
    const owners = loadOwnerKeys(patchesDir);
    if (owners === null) {
        findings.push(finding('OWNER-UNKNOWN', `${OWNERS_PATH} declares no owners, so no record can name one`, `add the owners of this delta to ${OWNERS_PATH}`, OWNERS_PATH));
        return;
    }
    const known = new Set(owners);
    for (const record of allRecords(entries, removed)) {
        if (known.has(record.owner)) {
            continue;
        }
        findings.push(finding('OWNER-UNKNOWN', `${record.id}: owner "${record.owner}" is not declared in ${OWNERS_PATH}`, `use one of: ${owners.join(', ')}   (or add the owner to ${OWNERS_PATH} first)`, record.artifact));
    }
}
// ---------------------------------------------------------------------------
// (d) Markers
// ---------------------------------------------------------------------------
function checkPatchMarkers(treeDir, config, conventions, patches, findings) {
    // ##MR-NO-NESTING: one id may cover blocks in several files only for the
    // entry-module layer, so those ids - and only those - are allowed to appear
    // in each other's files.
    const entryModuleIds = patches.filter((entry) => entry.patch.header.layer === 'entry-module').map((entry) => entry.patch.header.id);
    for (const entry of patches) {
        const allowIds = entry.patch.header.layer === 'entry-module' ? entryModuleIds : [];
        checkOnePatchMarkers(treeDir, config, conventions, entry, allowIds, findings);
    }
}
function checkOnePatchMarkers(treeDir, config, conventions, entry, allowIds, findings) {
    const { patch, artifact } = entry;
    const ext = extname(patch.targetPath);
    try {
        if (patch.isAddFile) {
            // ##ADD-FILE-EXEMPTION: there are no upstream lines to protect, so only
            // the markers of the resulting file and their ownership are checked.
            const target = applyUnified(new Uint8Array(0), patch);
            const markers = parseMarkers(target, ext, conventions, patch.targetPath);
            for (const error of [...markers.errors, ...checkMarkerArtifactConsistency(markers.blocks, patch.header.id, allowIds, artifact)]) {
                findings.push(toFinding(error, artifact));
            }
            return;
        }
        const pinBytes = bytesAtPin(treeDir, config.pin.sha, patch.targetPath);
        if (pinBytes === null) {
            findings.push(finding('STALE-ARTIFACT', `${patch.header.id}: the target ${patch.targetPath} does not exist at pin ${config.pin.tag}`, 'regenerate the patch against the current pin (codkit load, then codkit save), or move the change to the own layer', artifact));
            return;
        }
        const outcome = checkHunksInsideMarkers(patch, pinBytes, ext, conventions, { patchFile: artifact, allowIds });
        for (const error of outcome.errors) {
            findings.push(toFinding(error, artifact));
        }
    }
    catch (error) {
        findings.push(toFinding(error, artifact));
    }
}
/** The file at the pin, read from git objects, or null when the pin lacks it. */
function bytesAtPin(treeDir, pinSha, target) {
    const shown = runGit({ args: ['show', `${pinSha}:${toPosix(target)}`], cwd: treeDir });
    return shown.status === 0 ? encodeUtf8(shown.stdout) : null;
}
// ---------------------------------------------------------------------------
// (e) and (k): guard tests
// ---------------------------------------------------------------------------
/**
 * ##CROSS-CUTTING-MECHANISMS, ##RESOURCE-GUARD-MANDATORY,
 * ##REMOVED-GUARD-MANDATORY: a record in a blind zone needs a guard test, and a
 * guard test that no own test declares is not a guard test.
 */
function checkGuards(entries, removed, testIds, findings) {
    for (const entry of entries) {
        if (!requiresGuard(entry)) {
            continue;
        }
        reportGuard(entry.id, entry.contractTests, testIds, entry.artifact, guardReason(entry), findings);
    }
    for (const entry of removed) {
        reportGuard(entry.id, entry.contractTests, testIds, REMOVED_PATH, 'a removal has to be guarded, or the next upgrade brings the removed thing back in silence', findings);
    }
}
function guardReason(entry) {
    return entry.category === 'hide'
        ? 'a hidden element is hidden outside the reach of the compiler, so only a test can see it come back'
        : `the ${entry.layer} layer changes a file no marker and no compiler watches`;
}
function reportGuard(id, contractTests, testIds, artifact, reason, findings) {
    if (contractTests.length === 0) {
        findings.push(finding('GUARD-MISSING', `${id}: contractTests is empty, and ${reason}`, `write the guard test under ${OWN_SOURCE_DIR}/test/ as suite('<id>') and name that id in contractTests`, artifact));
        return;
    }
    const missing = contractTests.filter((test) => !testIds.has(test));
    if (missing.length === 0) {
        return;
    }
    findings.push(finding('GUARD-MISSING', `${id}: no own test declares ${missing.join(', ')}, and ${reason}`, `add suite('${missing[0] ?? ''}') to a test file under ${OWN_SOURCE_DIR}/test/, or correct the id in contractTests`, artifact));
}
// ---------------------------------------------------------------------------
// (f) Rules
// ---------------------------------------------------------------------------
function checkRules(treeDir, config, rules, findings) {
    for (const rule of rules) {
        const pinBytes = bytesAtPin(treeDir, config.pin.sha, rule.target);
        if (pinBytes === null) {
            findings.push(finding('STALE-ARTIFACT', `${rule.id}: the target ${rule.target} does not exist at pin ${config.pin.tag}`, 'point the rule at a file the pin carries, or retire the rule', rule.artifactPath));
            continue;
        }
        const count = countRuleMatches(rule, pinBytes);
        if (count.total === rule.expectedMatches) {
            continue;
        }
        const perOp = rule.ops.map((operation, index) => `ops[${index}] "${operation.match}" -> ${count.perOp[index] ?? 0}`).join('; ');
        findings.push(finding('RULE-DRIFT', `${rule.id}: ${rule.target} at pin ${config.pin.tag} matches ${count.total} line(s), the rule expects ${rule.expectedMatches} (${perOp})`, 'upstream moved the lines this rule is written against: review the operations and update expectedMatches', rule.artifactPath));
    }
}
// ---------------------------------------------------------------------------
// (g) Overlays
// ---------------------------------------------------------------------------
function checkOverlays(treeDir, config, overlays, findings) {
    for (const overlay of overlays) {
        const report = checkOverlay(overlay, { treeDir, pinSha: config.pin.sha, pinOnly: true });
        for (const error of overlayDriftErrors(report.drift)) {
            findings.push(toFinding(error, overlay.artifactPath));
        }
        for (const error of nonProductTargetViolations(overlay)) {
            findings.push(toFinding(error, overlay.artifactPath));
        }
    }
}
// ---------------------------------------------------------------------------
// (h) Own code
// ---------------------------------------------------------------------------
function checkOwn(patchesDir, conventions, manifest, findings) {
    const root = ownSourceRoot(patchesDir);
    const ownFiles = listOwnFiles(root, { refuseSymlinks: true });
    // One definition of "not own code", in the manifest module, rather than two
    // that can drift (PROP-014 ##STD-NOTICE-IS-A-DELIVERED-OWN-FILE).
    const codeFiles = ownFiles.filter((file) => !isNotOwnCode(file));
    if (!manifest.present && codeFiles.length > 0) {
        findings.push(finding('OWN-UNCOVERED', `${codeFiles.length} file(s) under ${OWN_SOURCE_DIR}/ and no manifest to declare them`, `create ${OWN_MANIFEST_PATH} and put every own file into exactly one unit`, OWN_MANIFEST_PATH));
        return;
    }
    // ##OWN-MANIFEST: a module named by a service override is own code too, and
    // its file is covered by a unit like any other.
    const overrideModules = checkServiceOverrideModules(manifest, ownFiles);
    const declaredOverrideModules = new Set(overrideModules.map((item) => item.module));
    const coverage = checkUnitCoverage(manifest, ownFiles);
    for (const file of coverage.uncovered) {
        if (declaredOverrideModules.has(file)) {
            continue;
        }
        findings.push(finding('OWN-UNCOVERED', `${OWN_SOURCE_DIR}/${file} belongs to no unit of the manifest`, `add the file to the roots of a unit in ${OWN_MANIFEST_PATH}, or give it a unit of its own`, `${OWN_SOURCE_DIR}/${file}`));
    }
    for (const [file, units] of coverage.overlapping) {
        if (declaredOverrideModules.has(file)) {
            continue;
        }
        findings.push(finding('OWN-UNCOVERED', `${OWN_SOURCE_DIR}/${file} is claimed by more than one unit (${units.join(', ')}): every own file belongs to exactly one`, `narrow the roots of ${units.join(' or ')} in ${OWN_MANIFEST_PATH} so they do not overlap`, `${OWN_SOURCE_DIR}/${file}`));
    }
    for (const item of overrideModules) {
        const modulePath = `${OWN_SOURCE_DIR}/${item.module}`;
        if (!item.delivered) {
            findings.push(finding('OWN-UNCOVERED', `${item.override.id}: service override module ${modulePath} is not a delivered own file`, `add the module under ${OWN_SOURCE_DIR}/ and cover it with exactly one unit, or correct serviceOverrides[].module in ${OWN_MANIFEST_PATH}`, OWN_MANIFEST_PATH));
            continue;
        }
        if (item.units.length !== 1) {
            const ownership = item.units.length === 0 ? 'no own unit' : `more than one own unit (${item.units.join(', ')})`;
            findings.push(finding('OWN-UNCOVERED', `${item.override.id}: service override module ${modulePath} is claimed by ${ownership}; exactly one is required`, `change the roots in ${OWN_MANIFEST_PATH} so exactly one unit owns the module`, modulePath));
        }
    }
    checkSingletonRegistrations(root, conventions, ownFiles, overrideModules, findings);
}
// ---------------------------------------------------------------------------
// (h2) What codkit delivered into the own layer (PROP-015 sec. 4)
// ---------------------------------------------------------------------------
/**
 * ##RT-DELIVERED-NOT-OWN: the installed runtime library is a managed copy, so
 * the only correct state is "byte for byte what codkit ships". An absent
 * directory is not a finding - a product that never ran `runtime load` is in a
 * legal state - and the licence notice inside the directory belongs to another
 * command (PROP-014 sec. 4a), so it is left out of the comparison.
 */
function checkDeliveredRuntime(patchesDir, toolRoot, findings) {
    const target = join(patchesDir, ...RUNTIME_TARGET_PATH.split('/'));
    if (!existsSync(target)) {
        return;
    }
    let shipped;
    try {
        shipped = shippedRuntime(toolRoot).directory;
    }
    catch (error) {
        if (!isCkError(error)) {
            throw error;
        }
        findings.push(finding('RUNTIME-PACKAGE', error.message, error.hint ?? 'restore the codkit installation from the approved supply', RUNTIME_TARGET_PATH));
        return;
    }
    const comparison = compareTrees(shipped, target, { ignoreInTarget: [NOTICE_NAME] });
    if (comparison.state !== 'drift') {
        return;
    }
    const hint = 'the library is codkit-owned: change it in codkit, then run codkit runtime load --upgrade';
    for (const relative of comparison.modified) {
        findings.push(finding('RUNTIME-DRIFT', `${RUNTIME_TARGET_PATH}/${relative} differs from the runtime library codkit ships`, hint, `${RUNTIME_TARGET_PATH}/${relative}`));
    }
    for (const relative of comparison.extra) {
        findings.push(finding('RUNTIME-DRIFT', `${RUNTIME_TARGET_PATH}/${relative} is not part of the runtime library codkit ships`, hint, `${RUNTIME_TARGET_PATH}/${relative}`));
    }
    for (const relative of comparison.missing) {
        findings.push(finding('RUNTIME-DRIFT', `${RUNTIME_TARGET_PATH}/${relative} is missing from the installed runtime library`, hint, `${RUNTIME_TARGET_PATH}/${relative}`));
    }
}
/**
 * ##OWN-CODKIT-PREFIX-RESERVED: the `codkit/` root inside the own layer is
 * codkit's, and the licence notice claims it by path. A product record that
 * points inside it would put product files under a licence that is not theirs,
 * so the manifest may not name it - neither as a unit root nor as the module of
 * a service override.
 */
function checkCodkitRootIsReserved(manifest, findings) {
    const hint = `move the files out of ${OWN_SOURCE_DIR}/${OWN_CODKIT_ROOT}/, which codkit delivers into, and point the record at its own directory`;
    for (const unit of manifest.units) {
        for (const root of unit.roots) {
            if (!isUnderCodkitRoot(root)) {
                continue;
            }
            findings.push(finding('OWN-UNDER-CODKIT', `${unit.id}: root ${root} is inside ${OWN_CODKIT_ROOT}/, which belongs to codkit`, hint, OWN_MANIFEST_PATH));
        }
    }
    for (const override of manifest.serviceOverrides) {
        if (!isUnderCodkitRoot(override.module)) {
            continue;
        }
        findings.push(finding('OWN-UNDER-CODKIT', `${override.id}: module ${override.module} is inside ${OWN_CODKIT_ROOT}/, which belongs to codkit`, hint, OWN_MANIFEST_PATH));
    }
}
// ---------------------------------------------------------------------------
// (h4) The own-extension layer (PROP-005 sec. 13)
// ---------------------------------------------------------------------------
/**
 * ##OWN-EXTENSION-UNIT: two questions, two codes.
 *
 * The manifest question is answered from patchset alone, plus one fact only the
 * fork tree holds - whether the pin already ships an extension of that name.
 * The drift question is the own layer's, asked of the second pair of roots: an
 * extension the tree has not materialized yet says nothing, and one it has must
 * match the delta byte for byte.
 */
function checkOwnExtensionLayer(patchesDir, treeDir, config, manifest, findings) {
    for (const problem of checkOwnExtensions(patchesDir, manifest.extensions, (name) => upstreamShipsExtension(treeDir, config.pin.sha, name))) {
        findings.push(finding('OWN-EXTENSION-MANIFEST', problem.message, problem.hint, problem.file));
    }
    const hint = 'the delta is the source of truth: extract the tree-side edit with codkit save, or restore the tree with codkit load';
    for (const divergence of compareOwnExtensions(patchesDir, treeDir, manifest.extensions)) {
        const name = divergence.relative.slice(0, divergence.relative.indexOf('/'));
        const inside = divergence.relative.slice(name.length + 1);
        const target = `${ownExtensionTargetRelativeDir(name)}/${inside}`;
        const message = divergence.kind === 'tree-only'
            ? `${target} is not in ${OWN_EXTENSIONS_DIR}/${divergence.relative}`
            : divergence.kind === 'patchset-only'
                ? `${target} is missing from the fork tree, and ${OWN_EXTENSIONS_DIR}/${divergence.relative} carries it`
                : `${target} differs from ${OWN_EXTENSIONS_DIR}/${divergence.relative}`;
        findings.push(finding('OWN-EXTENSION-DRIFT', message, hint, `${OWN_EXTENSIONS_DIR}/${divergence.relative}`));
    }
}
/**
 * Whether the pin already carries `extensions/<name>`. Read from git objects, so
 * a dirty tree answers exactly like a clean one; a tree that cannot answer at
 * all (no repository, unreachable pin) answers "no" and leaves that failure to
 * the checks whose subject it is.
 */
function upstreamShipsExtension(treeDir, pinSha, name) {
    if (!isSafeExtensionName(name)) {
        return false;
    }
    const shown = runGit({ args: ['cat-file', '-t', `${pinSha}:${ownExtensionTargetRelativeDir(name)}`], cwd: treeDir });
    return shown.status === 0 && shown.stdout.trim() === 'tree';
}
// ---------------------------------------------------------------------------
// (h3) The graft budget of a hook patch (PROP-005 ##PATCH-HOOK-BUDGET)
// ---------------------------------------------------------------------------
/** ##PATCH-HOOK-BUDGET: the constant; widening it is an edit of the norm. */
const HOOK_CODE_LINE_BUDGET = 3;
/**
 * A patch whose header says `type = hook` is a seam and nothing else: it hands
 * control to own code and comes back. So at most three lines of code may sit
 * between the markers - blank lines and `//` comments are not code - and at
 * least one of them has to name own code, or the patch grafts nothing.
 */
function checkHookBudget(config, patches, findings) {
    const ownSegment = `${config.ownDirName}/`;
    for (const entry of patches) {
        if (entry.patch.header.type !== 'hook') {
            continue;
        }
        const graft = hookGraftLines(entry.patch);
        if (graft.code.length > HOOK_CODE_LINE_BUDGET) {
            findings.push(finding('HOOK-TOO-LARGE', `a hook patch carries ${graft.code.length} lines of code between its markers, and the budget is ${HOOK_CODE_LINE_BUDGET}`, `move the logic into ${OWN_SOURCE_DIR}/ and leave the patch a call into it`, entry.artifact));
            continue;
        }
        // The own-path requirement is over every line between the markers, the
        // comment lines included: ##PATCH-HOOK-BUDGET excludes comments from the
        // count of code lines only, and a graft that merely delegates is allowed
        // to say so in a comment that names where.
        if (!graft.all.some((line) => line.includes(ownSegment))) {
            findings.push(finding('HOOK-TOO-LARGE', `a hook patch names no path under ${ownSegment} between its markers, so it grafts nothing`, `a hook grafts own code into upstream: import or call something under ${OWN_SOURCE_DIR}/`, entry.artifact));
        }
    }
}
/**
 * The lines the patch leaves between its markers: the new side of every hunk,
 * which is the added and the kept text, read in file order. `all` is every one
 * of them; `code` leaves out the blank lines and the whole-line `//` comments,
 * which the budget does not count.
 */
function hookGraftLines(patch) {
    const all = [];
    const code = [];
    let inside = false;
    for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
            if (line.kind === '-' || line.kind === '\\') {
                continue;
            }
            if (line.text.includes(BEGIN_TOKEN)) {
                inside = true;
                continue;
            }
            if (line.text.includes(END_TOKEN)) {
                inside = false;
                continue;
            }
            if (!inside) {
                continue;
            }
            all.push(line.text);
            const trimmed = line.text.trim();
            if (trimmed === '' || trimmed.startsWith('//')) {
                continue;
            }
            code.push(line.text);
        }
    }
    return { all, code };
}
/**
 * ##SO-FORBIDDEN-IDS: the bootstrap services are set explicitly before the
 * workbench exists, so a later registerSingleton for one of them is ignored
 * without a word and the product breaks at load. The syntax scan also proves
 * ##SO-MECHANISM: the module named by an override really registers its declared
 * decorator. One compiler snapshot parses the batch, separating calls from
 * comments and strings while still recognizing multiline calls.
 */
function checkSingletonRegistrations(root, conventions, ownFiles, overrideModules, findings) {
    const registrations = singletonRegistrations(root, ownFiles);
    const forbidden = new Set(conventions.forbiddenServiceIds);
    for (const [relative, calls] of registrations) {
        for (const call of calls) {
            if (forbidden.has(call.serviceId)) {
                findings.push(finding('FORBIDDEN-SERVICE', `registerSingleton(${call.serviceId}) overrides a service that is set before the workbench is created, so the registration is ignored`, 'pick another seam for this change: a bootstrap service cannot be replaced by a later registration', `${OWN_SOURCE_DIR}/${relative}`, call.line));
            }
        }
    }
    for (const item of overrideModules) {
        if (!item.delivered) {
            continue;
        }
        const calls = registrations.get(item.module) ?? [];
        if (calls.some((call) => call.serviceId === item.override.serviceId)) {
            continue;
        }
        findings.push(finding('ARTIFACT-BROKEN', `${item.override.id}: ${OWN_SOURCE_DIR}/${item.module} does not registerSingleton(${item.override.serviceId}) as its service override declares`, `make the module registration and serviceOverrides[].serviceId in ${OWN_MANIFEST_PATH} agree`, `${OWN_SOURCE_DIR}/${item.module}`));
    }
}
const SINGLETON_SCAN_ROOT = '/codkit-singleton-scan';
function singletonRegistrations(root, ownFiles) {
    const sources = [];
    for (const relative of ownFiles) {
        if (!relative.endsWith('.ts')) {
            continue;
        }
        try {
            sources.push({ relative, text: readFileSync(join(root, ...relative.split('/')), 'utf8') });
        }
        catch {
            // A concurrent disappearance is handled by the coverage check on the next run.
        }
    }
    if (sources.length === 0) {
        return new Map();
    }
    const virtualFiles = {};
    const paths = [];
    for (const [index, source] of sources.entries()) {
        const path = `${SINGLETON_SCAN_ROOT}/source-${index}.ts`;
        virtualFiles[path] = source.text;
        paths.push(path);
    }
    const registrations = new Map();
    const api = new API({ cwd: SINGLETON_SCAN_ROOT, fs: createVirtualFileSystem(virtualFiles) });
    try {
        const snapshot = api.updateSnapshot({ openFiles: paths });
        try {
            for (const [index, path] of paths.entries()) {
                const source = sources[index];
                if (source === undefined) {
                    continue;
                }
                const sourceFile = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
                registrations.set(source.relative, sourceFile === undefined ? [] : collectSingletonRegistrations(sourceFile));
            }
        }
        finally {
            snapshot.dispose();
        }
    }
    finally {
        api.close();
    }
    return registrations;
}
function collectSingletonRegistrations(sourceFile) {
    const registrations = [];
    const callees = singletonCalleeNames(sourceFile);
    const visit = (node) => {
        if (isCallExpression(node) && node.questionDotToken === undefined && isIdentifier(node.expression)) {
            const first = node.arguments[0];
            if (callees.has(node.expression.text) && first !== undefined && isIdentifier(first)) {
                registrations.push({
                    serviceId: first.text,
                    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
                });
            }
        }
        node.forEachChild(visit);
    };
    visit(sourceFile);
    return registrations;
}
function singletonCalleeNames(sourceFile) {
    const names = new Set(['registerSingleton']);
    for (const statement of sourceFile.statements) {
        if (!isImportDeclaration(statement)) {
            continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (bindings === undefined || !isNamedImports(bindings)) {
            continue;
        }
        for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (imported === 'registerSingleton') {
                names.add(element.name.text);
            }
        }
    }
    return names;
}
// ---------------------------------------------------------------------------
// (i) "No intervention outside the inventory" (PROP-006 sec. 6)
// ---------------------------------------------------------------------------
function checkCompleteness(patchesDir, treeDir, config, patches, overlays, resources, findings, warnings) {
    // The completeness of the delta is a property of the *generated branch*, not
    // of the working files: the branch is what the tree was brought to, and the
    // working files are wherever the developer left them.
    const branch = generatedBranchName(config);
    const tip = revParse(treeDir, `refs/heads/${branch}`);
    if (tip === null) {
        warnings.push(`the generated branch ${branch} does not exist in the fork tree, so "no intervention outside the inventory" was not checked; ` +
            'run codkit load first');
        return;
    }
    const changed = changedPaths(treeDir, config.pin.sha, tip);
    if (changed === null) {
        warnings.push(`cannot diff ${config.pin.tag} against ${branch}, so completeness was not checked`);
        return;
    }
    const patchTargets = new Set(patches.map((entry) => toPosix(entry.patch.targetPath)));
    const overlayTargets = new Set(overlays.map((overlay) => toPosix(overlay.target)));
    const resourceTargets = new Set(resources.map((entry) => toPosix(entry.target)));
    // ##OWN-EXTENSION-UNIT: an own extension is committed on the generated branch
    // with the own atom and only there, so it is judged by the same rule and
    // reported in the same words - `ci`, which built the branch, recognises the
    // finding as its own and drops it.
    const ownPrefixes = [`${ownTargetRelativeDir(config.ownDirName)}/`, ...ownExtensionTreePrefixes(loadOwnManifest(patchesDir).extensions)];
    for (const path of changed) {
        if (ownPrefixes.some((prefix) => path.startsWith(prefix))) {
            // ##OWN-EXCLUDED-LOCALLY: own code is committed on the generated branch
            // only in the ci/publish mode; locally it is copied in untracked, so a
            // committed own file means the two modes were mixed in one tree.
            findings.push(finding('UNTRACKED-INTERVENTION', `${path} is committed on ${branch}, but own code is only committed on a branch built by ci or publish`, 'rebuild the branch for this mode: codkit load --fresh', path));
            continue;
        }
        if (patchTargets.has(path) || overlayTargets.has(path) || resourceTargets.has(path)) {
            continue;
        }
        findings.push(finding('UNTRACKED-INTERVENTION', `${path} differs from pin ${config.pin.tag} on ${branch}, and no artifact of the delta explains it`, 'every change of the tree comes from an artifact: extract it with codkit save, or rebuild the branch with codkit load --fresh', path));
    }
    // The other direction: an artifact whose target the branch does not carry is
    // an artifact that no longer does anything.
    for (const entry of patches) {
        const target = toPosix(entry.patch.targetPath);
        if (changed.has(target)) {
            continue;
        }
        findings.push(finding('STALE-ARTIFACT', `${entry.patch.header.id}: ${target} is identical to pin ${config.pin.tag} on ${branch}, so this patch changes nothing`, 'remove the artifact, or regenerate it from a real change (codkit save)', entry.artifact));
    }
    for (const entry of resources) {
        checkResourceEntry(patchesDir, treeDir, branch, tip, changed, entry, findings);
    }
    // Overlay targets are deliberately not required to appear: the local channel
    // writes product.overrides.json and leaves the upstream file alone
    // (##OVERLAY-TWO-CHANNELS), so an absent overlay target is the normal state.
}
function checkResourceEntry(patchesDir, treeDir, branch, tip, changed, entry, findings) {
    const target = toPosix(entry.target);
    if (!changed.has(target)) {
        findings.push(finding('STALE-ARTIFACT', `${entry.id}: ${target} is identical to the pin on ${branch}, so the resource is not replaced`, 'rebuild the branch (codkit load), or drop the entry if the replacement is no longer wanted', RESOURCE_MAP_PATH));
        return;
    }
    // Byte equality through git's own object ids: the content is binary by
    // definition of this layer, so it is never decoded as text.
    const onBranch = blobSha(treeDir, `${tip}:${target}`);
    const ours = hashFile(treeDir, resourceSourcePath(patchesDir, entry));
    if (onBranch === null || ours === null || onBranch === ours) {
        return;
    }
    findings.push(finding('STALE-ARTIFACT', `${entry.id}: ${target} on ${branch} is not the bytes of ${entry.source} - the branch and the map have drifted apart`, 'rebuild the branch: codkit load', RESOURCE_MAP_PATH));
}
/** Paths that differ between two commits, renames resolved to plain changes. */
function changedPaths(treeDir, from, to) {
    const result = runGit({ args: ['diff', '--name-status', '--no-renames', '-z', from, to], cwd: treeDir });
    if (result.status !== 0) {
        return null;
    }
    const fields = result.stdout.split('\0').filter((field) => field !== '');
    const paths = new Set();
    // `-z --name-status` emits status and path as separate NUL-terminated fields.
    for (let index = 1; index < fields.length; index += 2) {
        const path = fields[index];
        if (path !== undefined) {
            paths.add(path);
        }
    }
    return paths;
}
function blobSha(treeDir, revision) {
    const result = runGit({ args: ['rev-parse', revision], cwd: treeDir });
    return result.status === 0 ? result.stdout.trim() : null;
}
function hashFile(treeDir, absolutePath) {
    const result = runGit({ args: ['hash-object', '--no-filters', '--', absolutePath], cwd: treeDir });
    return result.status === 0 ? result.stdout.trim() : null;
}
// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
function finding(code, message, hint, file, line) {
    const payload = { code, message, hint };
    if (file !== undefined) {
        payload.file = file;
    }
    if (line !== undefined) {
        payload.line = line;
    }
    return payload;
}
/** Turn anything raised by a checker into a finding of the artifact it is about. */
function toFinding(error, file) {
    if (isCkError(error)) {
        return finding(error.code, error.message, error.hint ?? 'see the artifact this finding names', error.file ?? file, error.line);
    }
    return finding('INTERNAL', error instanceof Error ? error.message : String(error), 're-run with --verbose and attach the output to a bug report', file);
}
function countByCode(findings) {
    const counts = new Map();
    for (const item of findings) {
        counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
    }
    const out = {};
    for (const key of [...counts.keys()].sort()) {
        out[key] = counts.get(key) ?? 0;
    }
    return out;
}
