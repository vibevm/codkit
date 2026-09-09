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
import type { ProjectType, ServiceOverrideProblem, ServiceOverrideVerifier } from '@codkit/type-api';
import { requireCapability } from '../types/capability.ts';
import { isCallExpression, isIdentifier, isImportDeclaration, isNamedImports } from 'typescript/unstable/ast';
import type { Node, SourceFile } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { applyUnified } from './applyUnified.ts';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import { CONFIG_FILE_NAME, loadBaseConfig, serializeBaseConfig } from './configFile.ts';
import type { CodkitConfig } from './configFile.ts';
import { loadConventions } from './conventionsFile.ts';
import type { Conventions } from './conventionsFile.ts';
import { runGit } from './gitx.ts';
import { checkHunksInsideMarkers, checkMarkerArtifactConsistency } from './hunksInMarkers.ts';
import type { InventoryEntry } from './inventory.ts';
import { buildInventory, loadPatches, ownTestIds, requiresGuard } from './inventory.ts';
import type { Inventory, PatchArtifact } from './inventory.ts';
import {
	OVERLAYS_DIR,
	OVERLAY_FILE_SUFFIX,
	checkOverlay,
	devChannelIgnoreWarning,
	devChannelTarget,
	loadOverlays,
	restrictedTargetViolations,
	overlayDriftErrors,
	parseOverlay,
	serializeOverlay
} from './layers/overlay.ts';
import type { Overlay } from './layers/overlay.ts';
import {
	checkOwnExtensions,
	compareOwnExtensions,
	materializerOf,
	ownExtensionTargetRelativeDir,
	ownExtensionTreePrefixes,
	pinShipsExtension
} from './layers/ownExtensions.ts';
import type { Materializer } from './layers/ownExtensions.ts';
import {
	OWN_CODKIT_ROOT,
	OWN_MANIFEST_PATH,
	checkServiceOverrideModules,
	checkUnitCoverage,
	isNotOwnCode,
	isUnderCodkitRoot,
	loadOwnManifest,
	parseOwnManifest,
	serializeOwnManifest
} from './layers/ownManifest.ts';
import type { OwnManifest } from './layers/ownManifest.ts';
import { REMOVED_PATH, loadRemoved, parseRemoved, serializeRemoved } from './layers/removed.ts';
import type { RemovedEntry, RemovedRegistry } from './layers/removed.ts';
import { RESOURCE_MAP_PATH, loadResourceMap, parseResourceMap, resourceSourcePath, serializeResourceMap } from './layers/resource.ts';
import type { ResourceMap } from './layers/resource.ts';
import type { ResourceEntry } from './layers/resource.ts';
import { RULES_DIR, RULE_FILE_SUFFIX, countRuleMatches, loadRules, parseRule, serializeRule } from './layers/rule.ts';
import type { Rule } from './layers/rule.ts';
import { BEGIN_TOKEN, END_TOKEN, parseMarkers } from './markers.ts';
import { ckError, isCkError } from './messages.ts';
import type { CkErrorPayload, ErrorCode } from './messages.ts';
import { OWNERS_PATH, loadOwnerKeys, ownerKeysOf } from './owners.ts';
import { OWN_SOURCE_DIR, listOwnFiles, ownSourceRoot } from './ownCopy.ts';
import { PATCH_FILE_SUFFIX, parseCkpatch } from './patchFormat.ts';
import { CODKIT_TOOL_ROOT, shippedRuntime } from './runtimePackage.ts';
import { RUNTIME_TARGET_PATH } from './runtimeLoad.ts';
import { NOTICE_NAME } from './licenceNotice.ts';
import { compareTrees } from './standardsPackage.ts';
import type { ParsedPatch } from './patchFormat.ts';
import type { ForkDirResolution } from './paths.ts';
import { PATCHES_DIR, generatedBranchName, toPosix } from './syncEngine.ts';
import { revParse } from './treeCache.ts';
import { checkTree } from './treeIdentity.ts';

/** One violation, in the shape the `--json` data carries it. */
export type Finding = CkErrorPayload & { readonly hint: string };

export type VerifyResult = {
	readonly findings: readonly Finding[];
	/** Uncoded advisories: things a reviewer should see that are not failures. */
	readonly warnings: readonly string[];
	/** How many findings each code produced, keys in byte order. */
	readonly counts: Readonly<Record<string, number>>;
	/** The inventory the run was made against; null in the staged-fast mode. */
	readonly inventory: Inventory | null;
	/** Artifacts examined. In the full run this is the number of entries. */
	readonly checked: number;
};

export type VerifyOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	/** The project type of the patch set; every family answer below comes from it. */
	readonly type: ProjectType;
	/**
	 * The codkit installation the delivered runtime library is compared against
	 * (##RT-DELIVERED-NOT-OWN). It defaults to the root this module was loaded
	 * from, which is the value main.ts computes the same way: `verify` is reached
	 * through `ci` and the upgrade cycle as well, and threading an immutable root
	 * through those option types would say nothing a caller could choose.
	 */
	readonly toolRoot?: string;
};

/**
 * ##TYPE-CAPABILITY-REFUSAL: `verify` over an artifact of a layer the declared
 * type does not provide.
 *
 * `own`, `patch`, `resource-file` and `rewrite-rule` are universal and ask the
 * type nothing. The other four are the type's answer, and an artifact of one
 * the type does not answer is not a violation to be collected - it is a patch
 * set that cannot be checked at all by this type, so it refuses before any
 * finding is produced.
 */
function assertLayerCapabilities(
	type: ProjectType,
	patches: readonly PatchArtifact[],
	overlays: readonly Overlay[],
	manifest: OwnManifest
): void {
	const first = overlays[0];
	if (first !== undefined) {
		requireCapability(type, 'config-overlay', `the config-overlay artifact ${first.artifactPath}`);
	}
	const override = manifest.serviceOverrides[0];
	if (override !== undefined) {
		requireCapability(type, 'service-override', `the service override ${override.id} of ${OWN_MANIFEST_PATH}`);
	}
	const extension = manifest.extensions[0];
	if (extension !== undefined) {
		requireCapability(type, 'own-extensions', `the own extension ${extension.id} of ${OWN_MANIFEST_PATH}`);
	}
	const entry = patches.find((artifact) => artifact.patch.header.layer === 'entry-module');
	if (entry !== undefined) {
		requireCapability(type, 'entry-module', `the entry-module patch ${entry.artifact}`);
	}
}

/**
 * The whole check list of ##CMD-VERIFY, in the order a reviewer reads it: the
 * artifacts first, then what they say about each other, then what the tree says
 * about all of them.
 */
export function runVerify(options: VerifyOptions): VerifyResult {
	const { patchesDir, config } = options;
	const tree = options.resolution.path;
	const conventions = loadConventions(options.type, patchesDir);

	// (a) Everything parses. A schema failure is raised, not collected: an
	// artifact that does not describe itself cannot be cross-checked at all.
	const patches = loadPatches(patchesDir, conventions);
	const overlays = loadOverlays(patchesDir);
	const rules = loadRules(patchesDir);
	const manifest = loadOwnManifest(patchesDir);
	const removed = loadRemoved(patchesDir);
	const resourceMap = loadResourceMap(patchesDir);
	const resources = resourceMap?.entries ?? [];
	assertLayerCapabilities(options.type, patches, overlays, manifest);
	const inventory = buildInventory(patchesDir, options.type, { config });

	const findings: Finding[] = [];
	const warnings: string[] = [];
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
	checkOverlays(options.type, tree, config, overlays, findings);

	// (h) Own code: declared, not overlapping, and not overriding a bootstrap
	// service.
	checkOwn(options.type, patchesDir, conventions, manifest, findings);

	// (h2) What codkit delivered into the own layer: the installed runtime
	// library is byte-equal to the shipped one, and no record of the product
	// claims a path inside the root that belongs to codkit (PROP-015 sec. 4,
	// PROP-005 ##OWN-CODKIT-PREFIX-RESERVED).
	checkDeliveredRuntime(patchesDir, options.toolRoot ?? CODKIT_TOOL_ROOT, options.type.runtime?.packageId ?? null, findings);
	checkCodkitRootIsReserved(manifest, findings);

	// (h4) The own-extension layer: the section describes materializable
	// extensions, and what the tree carries is what the delta holds
	// (modules/vscode/PROP-002 ##OWN-EXTENSION-UNIT).
	checkOwnExtensionLayer(materializerOf(options.type), patchesDir, tree, config, manifest, findings);

	// (h3) The graft budget: a patch of type `hook` creates a seam and nothing
	// more (PROP-005 ##PATCH-HOOK-BUDGET).
	checkHookBudget(config, patches, findings);

	// (i) "No intervention outside the inventory", against the generated branch.
	checkCompleteness(options.type, patchesDir, tree, config, patches, overlays, resources, findings, warnings);

	// (l) The dev channel has to stay invisible to the tree's git.
	const devChannel = devChannelTarget(options.type);
	if (devChannel !== null && overlays.some((overlay) => overlay.target === devChannel.path)) {
		const warning = devChannelIgnoreWarning(options.type, tree);
		if (warning !== null) {
			warnings.push(warning);
		}
	}

	return { findings, warnings, counts: countByCode(findings), inventory, checked: inventory.entries.length };
}

// ---------------------------------------------------------------------------
// The staged-fast mode: the pre-commit hook (PROP-007 sec. 19)
// ---------------------------------------------------------------------------

export type StagedFastOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution | null;
	readonly config: CodkitConfig;
	/** The project type of the patch set. */
	readonly type: ProjectType;
};

export type StagedFastResult = VerifyResult & {
	/** The staged paths under delta/ that were examined. */
	readonly staged: readonly string[];
	/** False when the fork tree could not be used, so the pin checks were skipped. */
	readonly treeUsable: boolean;
};

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
export function runStagedFast(options: StagedFastOptions): StagedFastResult {
	const { patchesDir, config } = options;
	const conventions = loadConventions(options.type, patchesDir);
	const staged = stagedDeltaPaths(patchesDir);
	const findings: Finding[] = [];
	const warnings: string[] = [];

	if (staged.length === 0) {
		return { findings, warnings, counts: {}, inventory: null, checked: 0, staged, treeUsable: true };
	}

	const identity = options.resolution === null ? null : checkTree(options.resolution, config, { mode: 'read', type: options.type });
	const treeUsable = identity !== null && identity.fatal === null;
	if (!treeUsable) {
		warnings.push(
			(options.resolution === null
				? 'the fork tree is not configured, '
				: `the fork tree at ${options.resolution.path} cannot be used (${identity?.fatal?.message ?? 'unusable'}), `) +
				'so the staged patches were checked for their format only; run codkit verify once the tree is available'
		);
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
function stagedDeltaPaths(patchesDir: string): readonly string[] {
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
function stagedBytes(patchesDir: string, path: string): Uint8Array | null {
	const result = runGit({ args: ['show', `:${path}`], cwd: patchesDir });
	return result.status === 0 ? encodeUtf8(result.stdout) : null;
}

/**
 * Validate one staged artifact through the schema of its layer. Anything the
 * loaders raise is turned into a finding, so the hook reports every staged file
 * rather than the first broken one.
 */
function parseStagedArtifact(path: string, bytes: Uint8Array, conventions: Conventions, findings: Finding[]): void {
	try {
		parseByPath(path, bytes, conventions);
	} catch (error) {
		findings.push(toFinding(error, path));
	}
}

function checkStagedPatch(
	treeDir: string,
	config: CodkitConfig,
	conventions: Conventions,
	path: string,
	bytes: Uint8Array,
	findings: Finding[]
): void {
	let patch: ParsedPatch;
	try {
		patch = parseCkpatch(bytes, conventions, path);
	} catch {
		// Already reported by the schema pass; one broken file, one finding.
		return;
	}
	checkOnePatchMarkers(treeDir, config, conventions, { artifact: path, patch }, [], findings);
}

/** Whether a path under delta/ is one the schemas of the layers describe. */
function hasSchema(path: string): boolean {
	return (
		(path.startsWith(`${PATCHES_DIR}/`) && path.endsWith(PATCH_FILE_SUFFIX)) ||
		(path.startsWith(`${OVERLAYS_DIR}/`) && path.endsWith(OVERLAY_FILE_SUFFIX)) ||
		(path.startsWith(`${RULES_DIR}/`) && path.endsWith(RULE_FILE_SUFFIX)) ||
		path === RESOURCE_MAP_PATH ||
		path === OWN_MANIFEST_PATH ||
		path === REMOVED_PATH ||
		path === OWNERS_PATH
	);
}

/**
 * Validate a delta file through the schema of the layer its path belongs to.
 * A path with no schema - own code, a resource blob - has nothing to validate
 * and passes silently.
 */
function parseByPath(path: string, bytes: Uint8Array, conventions: Conventions): void {
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

function checkCanonicalMetadata(
	patchesDir: string,
	overlays: readonly Overlay[],
	resourceMap: ResourceMap | null,
	rules: readonly Rule[],
	manifest: OwnManifest,
	removed: RemovedRegistry,
	findings: Finding[]
): void {
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

function checkCanonicalMetadataFile(patchesDir: string, path: string, canonical: string, code: ErrorCode, findings: Finding[]): void {
	try {
		const bytes = readFileSync(join(patchesDir, ...path.split('/')));
		assertCanonicalMetadataBytes(path, bytes, canonical, code);
	} catch (error) {
		findings.push(toFinding(error, path));
	}
}

function assertCanonicalMetadataBytes(path: string, bytes: Uint8Array, canonical: string, code: ErrorCode): void {
	if (bytesEqual(bytes, encodeUtf8(canonical))) return;
	throw ckError(
		code,
		'metadata bytes are not canonical JSON',
		'use schema key order, schema array order, two-space indentation, UTF-8 without BOM, LF line endings, and exactly one final LF',
		path
	);
}

function decodeJson(path: string, bytes: Uint8Array, code: ErrorCode): unknown {
	const text = decodeUtf8Strict(bytes);
	if (text === null) {
		throw ckError('ENCODING', 'is not valid UTF-8', 'codkit reads and writes UTF-8 only', path);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw ckError(
			code,
			`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			'the artifacts of the delta are plain JSON without comments',
			path
		);
	}
}

// ---------------------------------------------------------------------------
// (b) Unique ids, (c) known owners
// ---------------------------------------------------------------------------

type Record_ = { readonly id: string; readonly owner: string; readonly artifact: string };

/**
 * Every record a person wrote. The synthetic entry that stands for the runtime
 * library codkit delivered (##RT-INVENTORY-ENTRY) is left out: no artifact
 * declares it and no owner of this delta is responsible for it, so demanding a
 * unique id or a declared owner from it would report codkit's own work as the
 * product's mistake.
 */
function allRecords(entries: readonly InventoryEntry[], removed: readonly RemovedEntry[]): readonly Record_[] {
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
function checkUniqueIds(entries: readonly InventoryEntry[], removed: readonly RemovedEntry[], findings: Finding[]): void {
	const seen = new Map<string, string>();
	for (const record of allRecords(entries, removed)) {
		const first = seen.get(record.id);
		if (first === undefined) {
			seen.set(record.id, record.artifact);
			continue;
		}
		findings.push(
			finding(
				'MARKER-DUP-ID',
				`id ${record.id} is used by two records: ${first} and ${record.artifact}`,
				'give one of them an id of its own; a marker carries the id and nothing else, so it has to name one record',
				record.artifact
			)
		);
	}
}

function checkOwners(patchesDir: string, entries: readonly InventoryEntry[], removed: readonly RemovedEntry[], findings: Finding[]): void {
	const owners = loadOwnerKeys(patchesDir);
	if (owners === null) {
		findings.push(
			finding(
				'OWNER-UNKNOWN',
				`${OWNERS_PATH} declares no owners, so no record can name one`,
				`add the owners of this delta to ${OWNERS_PATH}`,
				OWNERS_PATH
			)
		);
		return;
	}
	const known = new Set(owners);
	for (const record of allRecords(entries, removed)) {
		if (known.has(record.owner)) {
			continue;
		}
		findings.push(
			finding(
				'OWNER-UNKNOWN',
				`${record.id}: owner "${record.owner}" is not declared in ${OWNERS_PATH}`,
				`use one of: ${owners.join(', ')}   (or add the owner to ${OWNERS_PATH} first)`,
				record.artifact
			)
		);
	}
}

// ---------------------------------------------------------------------------
// (d) Markers
// ---------------------------------------------------------------------------

function checkPatchMarkers(
	treeDir: string,
	config: CodkitConfig,
	conventions: Conventions,
	patches: readonly PatchArtifact[],
	findings: Finding[]
): void {
	// ##MR-NO-NESTING: one id may cover blocks in several files only for the
	// entry-module layer, so those ids - and only those - are allowed to appear
	// in each other's files.
	const entryModuleIds = patches.filter((entry) => entry.patch.header.layer === 'entry-module').map((entry) => entry.patch.header.id);
	for (const entry of patches) {
		const allowIds = entry.patch.header.layer === 'entry-module' ? entryModuleIds : [];
		checkOnePatchMarkers(treeDir, config, conventions, entry, allowIds, findings);
	}
}

function checkOnePatchMarkers(
	treeDir: string,
	config: CodkitConfig,
	conventions: Conventions,
	entry: PatchArtifact,
	allowIds: readonly string[],
	findings: Finding[]
): void {
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
			findings.push(
				finding(
					'STALE-ARTIFACT',
					`${patch.header.id}: the target ${patch.targetPath} does not exist at pin ${config.pin.tag}`,
					'regenerate the patch against the current pin (codkit load, then codkit save), or move the change to the own layer',
					artifact
				)
			);
			return;
		}
		const outcome = checkHunksInsideMarkers(patch, pinBytes, ext, conventions, { patchFile: artifact, allowIds });
		for (const error of outcome.errors) {
			findings.push(toFinding(error, artifact));
		}
	} catch (error) {
		findings.push(toFinding(error, artifact));
	}
}

/** The file at the pin, read from git objects, or null when the pin lacks it. */
function bytesAtPin(treeDir: string, pinSha: string, target: string): Uint8Array | null {
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
function checkGuards(
	entries: readonly InventoryEntry[],
	removed: readonly RemovedEntry[],
	testIds: ReadonlySet<string>,
	findings: Finding[]
): void {
	for (const entry of entries) {
		if (!requiresGuard(entry)) {
			continue;
		}
		reportGuard(entry.id, entry.contractTests, testIds, entry.artifact, guardReason(entry), findings);
	}
	for (const entry of removed) {
		reportGuard(
			entry.id,
			entry.contractTests,
			testIds,
			REMOVED_PATH,
			'a removal has to be guarded, or the next upgrade brings the removed thing back in silence',
			findings
		);
	}
}

function guardReason(entry: InventoryEntry): string {
	return entry.category === 'hide'
		? 'a hidden element is hidden outside the reach of the compiler, so only a test can see it come back'
		: `the ${entry.layer} layer changes a file no marker and no compiler watches`;
}

function reportGuard(
	id: string,
	contractTests: readonly string[],
	testIds: ReadonlySet<string>,
	artifact: string,
	reason: string,
	findings: Finding[]
): void {
	if (contractTests.length === 0) {
		findings.push(
			finding(
				'GUARD-MISSING',
				`${id}: contractTests is empty, and ${reason}`,
				`write the guard test under ${OWN_SOURCE_DIR}/test/ as suite('<id>') or describe('<id>') and name that id in contractTests`,
				artifact
			)
		);
		return;
	}
	const missing = contractTests.filter((test) => !testIds.has(test));
	if (missing.length === 0) {
		return;
	}
	findings.push(
		finding(
			'GUARD-MISSING',
			`${id}: no own test declares ${missing.join(', ')}, and ${reason}`,
			`add suite('${missing[0] ?? ''}') or describe('${missing[0] ?? ''}') to a test file under ${OWN_SOURCE_DIR}/test/, or correct the id in contractTests`,
			artifact
		)
	);
}

// ---------------------------------------------------------------------------
// (f) Rules
// ---------------------------------------------------------------------------

function checkRules(treeDir: string, config: CodkitConfig, rules: readonly Rule[], findings: Finding[]): void {
	for (const rule of rules) {
		const pinBytes = bytesAtPin(treeDir, config.pin.sha, rule.target);
		if (pinBytes === null) {
			findings.push(
				finding(
					'STALE-ARTIFACT',
					`${rule.id}: the target ${rule.target} does not exist at pin ${config.pin.tag}`,
					'point the rule at a file the pin carries, or retire the rule',
					rule.artifactPath
				)
			);
			continue;
		}
		const count = countRuleMatches(rule, pinBytes);
		if (count.total === rule.expectedMatches) {
			continue;
		}
		const perOp = rule.ops.map((operation, index) => `ops[${index}] "${operation.match}" -> ${count.perOp[index] ?? 0}`).join('; ');
		findings.push(
			finding(
				'RULE-DRIFT',
				`${rule.id}: ${rule.target} at pin ${config.pin.tag} matches ${count.total} line(s), the rule expects ${rule.expectedMatches} (${perOp})`,
				'upstream moved the lines this rule is written against: review the operations and update expectedMatches',
				rule.artifactPath
			)
		);
	}
}

// ---------------------------------------------------------------------------
// (g) Overlays
// ---------------------------------------------------------------------------

function checkOverlays(type: ProjectType, treeDir: string, config: CodkitConfig, overlays: readonly Overlay[], findings: Finding[]): void {
	for (const overlay of overlays) {
		const report = checkOverlay(overlay, { type, treeDir, pinSha: config.pin.sha, pinOnly: true });
		for (const error of overlayDriftErrors(report.drift)) {
			findings.push(toFinding(error, overlay.artifactPath));
		}
		for (const error of restrictedTargetViolations(type, overlay)) {
			findings.push(toFinding(error, overlay.artifactPath));
		}
	}
}

// ---------------------------------------------------------------------------
// (h) Own code
// ---------------------------------------------------------------------------

function checkOwn(type: ProjectType, patchesDir: string, conventions: Conventions, manifest: OwnManifest, findings: Finding[]): void {
	const root = ownSourceRoot(patchesDir);
	const ownFiles = listOwnFiles(root, { refuseSymlinks: true });
	// One definition of "not own code", in the manifest module, rather than two
	// that can drift (PROP-014 ##STD-NOTICE-IS-A-DELIVERED-OWN-FILE).
	const codeFiles = ownFiles.filter((file) => !isNotOwnCode(file));

	if (!manifest.present && codeFiles.length > 0) {
		findings.push(
			finding(
				'OWN-UNCOVERED',
				`${codeFiles.length} file(s) under ${OWN_SOURCE_DIR}/ and no manifest to declare them`,
				`create ${OWN_MANIFEST_PATH} and put every own file into exactly one unit`,
				OWN_MANIFEST_PATH
			)
		);
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
		findings.push(
			finding(
				'OWN-UNCOVERED',
				`${OWN_SOURCE_DIR}/${file} belongs to no unit of the manifest`,
				`add the file to the roots of a unit in ${OWN_MANIFEST_PATH}, or give it a unit of its own`,
				`${OWN_SOURCE_DIR}/${file}`
			)
		);
	}
	for (const [file, units] of coverage.overlapping) {
		if (declaredOverrideModules.has(file)) {
			continue;
		}
		findings.push(
			finding(
				'OWN-UNCOVERED',
				`${OWN_SOURCE_DIR}/${file} is claimed by more than one unit (${units.join(', ')}): every own file belongs to exactly one`,
				`narrow the roots of ${units.join(' or ')} in ${OWN_MANIFEST_PATH} so they do not overlap`,
				`${OWN_SOURCE_DIR}/${file}`
			)
		);
	}

	for (const item of overrideModules) {
		const modulePath = `${OWN_SOURCE_DIR}/${item.module}`;
		if (!item.delivered) {
			findings.push(
				finding(
					'OWN-UNCOVERED',
					`${item.override.id}: service override module ${modulePath} is not a delivered own file`,
					`add the module under ${OWN_SOURCE_DIR}/ and cover it with exactly one unit, or correct serviceOverrides[].module in ${OWN_MANIFEST_PATH}`,
					OWN_MANIFEST_PATH
				)
			);
			continue;
		}
		if (item.units.length !== 1) {
			const ownership = item.units.length === 0 ? 'no own unit' : `more than one own unit (${item.units.join(', ')})`;
			findings.push(
				finding(
					'OWN-UNCOVERED',
					`${item.override.id}: service override module ${modulePath} is claimed by ${ownership}; exactly one is required`,
					`change the roots in ${OWN_MANIFEST_PATH} so exactly one unit owns the module`,
					modulePath
				)
			);
		}
	}

	checkSingletonRegistrations(type.layers.serviceOverride, root, conventions, ownFiles, overrideModules, findings);
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
function checkDeliveredRuntime(patchesDir: string, toolRoot: string, packageId: string | null, findings: Finding[]): void {
	const target = join(patchesDir, ...RUNTIME_TARGET_PATH.split('/'));
	// A type with no runtime library ships none to compare against; the directory
	// under `delta/own/codkit/` is then the notice file's and nothing else.
	if (packageId === null || !existsSync(target)) {
		return;
	}
	let shipped: string;
	try {
		shipped = shippedRuntime(toolRoot, packageId).directory;
	} catch (error) {
		if (!isCkError(error)) {
			throw error;
		}
		findings.push(
			finding(
				'RUNTIME-PACKAGE',
				error.message,
				error.hint ?? 'restore the codkit installation from the approved supply',
				RUNTIME_TARGET_PATH
			)
		);
		return;
	}
	const comparison = compareTrees(shipped, target, { ignoreInTarget: [NOTICE_NAME] });
	if (comparison.state !== 'drift') {
		return;
	}
	const hint = 'the library is codkit-owned: change it in codkit, then run codkit runtime load --upgrade';
	for (const relative of comparison.modified) {
		findings.push(
			finding(
				'RUNTIME-DRIFT',
				`${RUNTIME_TARGET_PATH}/${relative} differs from the runtime library codkit ships`,
				hint,
				`${RUNTIME_TARGET_PATH}/${relative}`
			)
		);
	}
	for (const relative of comparison.extra) {
		findings.push(
			finding(
				'RUNTIME-DRIFT',
				`${RUNTIME_TARGET_PATH}/${relative} is not part of the runtime library codkit ships`,
				hint,
				`${RUNTIME_TARGET_PATH}/${relative}`
			)
		);
	}
	for (const relative of comparison.missing) {
		findings.push(
			finding(
				'RUNTIME-DRIFT',
				`${RUNTIME_TARGET_PATH}/${relative} is missing from the installed runtime library`,
				hint,
				`${RUNTIME_TARGET_PATH}/${relative}`
			)
		);
	}
}

/**
 * ##OWN-CODKIT-PREFIX-RESERVED: the `codkit/` root inside the own layer is
 * codkit's, and the licence notice claims it by path. A product record that
 * points inside it would put product files under a licence that is not theirs,
 * so the manifest may not name it - neither as a unit root nor as the module of
 * a service override.
 */
function checkCodkitRootIsReserved(manifest: OwnManifest, findings: Finding[]): void {
	const hint = `move the files out of ${OWN_SOURCE_DIR}/${OWN_CODKIT_ROOT}/, which codkit delivers into, and point the record at its own directory`;
	for (const unit of manifest.units) {
		for (const root of unit.roots) {
			if (!isUnderCodkitRoot(root)) {
				continue;
			}
			findings.push(
				finding(
					'OWN-UNDER-CODKIT',
					`${unit.id}: root ${root} is inside ${OWN_CODKIT_ROOT}/, which belongs to codkit`,
					hint,
					OWN_MANIFEST_PATH
				)
			);
		}
	}
	for (const override of manifest.serviceOverrides) {
		if (!isUnderCodkitRoot(override.module)) {
			continue;
		}
		findings.push(
			finding(
				'OWN-UNDER-CODKIT',
				`${override.id}: module ${override.module} is inside ${OWN_CODKIT_ROOT}/, which belongs to codkit`,
				hint,
				OWN_MANIFEST_PATH
			)
		);
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
function checkOwnExtensionLayer(
	materializer: Materializer | null,
	patchesDir: string,
	treeDir: string,
	config: CodkitConfig,
	manifest: OwnManifest,
	findings: Finding[]
): void {
	if (materializer === null) {
		// The type has no own-extension layer; `verify` refuses an artifact of an
		// absent layer elsewhere, and there is nothing to compare here.
		return;
	}
	const deltaRoot = materializer.deltaRoot;
	for (const problem of checkOwnExtensions(materializer, patchesDir, manifest.extensions, (name) =>
		pinShipsExtension(materializer, treeDir, config.pin.sha, name)
	)) {
		findings.push(finding('OWN-EXTENSION-MANIFEST', problem.message, problem.hint, problem.file));
	}
	const hint = 'the delta is the source of truth: extract the tree-side edit with codkit save, or restore the tree with codkit load';
	for (const divergence of compareOwnExtensions(materializer, patchesDir, treeDir, manifest.extensions)) {
		const name = divergence.relative.slice(0, divergence.relative.indexOf('/'));
		const inside = divergence.relative.slice(name.length + 1);
		const target = `${ownExtensionTargetRelativeDir(materializer, name)}/${inside}`;
		const message =
			divergence.kind === 'tree-only'
				? `${target} is not in ${deltaRoot}/${divergence.relative}`
				: divergence.kind === 'patchset-only'
					? `${target} is missing from the fork tree, and ${deltaRoot}/${divergence.relative} carries it`
					: `${target} differs from ${deltaRoot}/${divergence.relative}`;
		findings.push(finding('OWN-EXTENSION-DRIFT', message, hint, `${deltaRoot}/${divergence.relative}`));
	}
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
function checkHookBudget(config: CodkitConfig, patches: readonly PatchArtifact[], findings: Finding[]): void {
	// A graft is written as an import or a call, and those spell own code
	// relatively (`../../<own>/x.js`), so the segment a line has to carry is the
	// name of the own root and not the whole path from the tree root.
	const ownRoot = config.typeConfig.ownRoot;
	const ownSegment = `${ownRoot.split('/').at(-1) ?? ownRoot}/`;
	for (const entry of patches) {
		if (entry.patch.header.type !== 'hook') {
			continue;
		}
		const graft = hookGraftLines(entry.patch);
		if (graft.code.length > HOOK_CODE_LINE_BUDGET) {
			findings.push(
				finding(
					'HOOK-TOO-LARGE',
					`a hook patch carries ${graft.code.length} lines of code between its markers, and the budget is ${HOOK_CODE_LINE_BUDGET}`,
					`move the logic into ${OWN_SOURCE_DIR}/ and leave the patch a call into it`,
					entry.artifact
				)
			);
			continue;
		}
		// The own-path requirement is over every line between the markers, the
		// comment lines included: ##PATCH-HOOK-BUDGET excludes comments from the
		// count of code lines only, and a graft that merely delegates is allowed
		// to say so in a comment that names where.
		if (!graft.all.some((line) => line.includes(ownSegment))) {
			findings.push(
				finding(
					'HOOK-TOO-LARGE',
					`a hook patch names no path under ${ownSegment} between its markers, so it grafts nothing`,
					`a hook grafts own code into upstream: import or call something under ${OWN_SOURCE_DIR}/`,
					entry.artifact
				)
			);
		}
	}
}

/**
 * The lines the patch leaves between its markers: the new side of every hunk,
 * which is the added and the kept text, read in file order. `all` is every one
 * of them; `code` leaves out the blank lines and the whole-line `//` comments,
 * which the budget does not count.
 */
function hookGraftLines(patch: ParsedPatch): { readonly all: readonly string[]; readonly code: readonly string[] } {
	const all: string[] = [];
	const code: string[] = [];
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
 * the composition root is built, so a later registration for one of them is ignored
 * without a word and the product breaks at load. The syntax scan also proves
 * ##SO-MECHANISM: the module named by an override really registers its declared
 * decorator. One compiler snapshot parses the batch, separating calls from
 * comments and strings while still recognizing multiline calls.
 */
function checkSingletonRegistrations(
	verifier: ServiceOverrideVerifier | null,
	root: string,
	conventions: Conventions,
	ownFiles: readonly string[],
	overrideModules: ReturnType<typeof checkServiceOverrideModules>,
	findings: Finding[]
): void {
	if (verifier === null) {
		// The type has no service-override seam, so there is no registration to
		// look for and nothing own code could re-register (##TYPE-AREA-LAYERS).
		return;
	}
	const call = verifier.registrationCall;
	const registrations = singletonRegistrations(verifier, root, ownFiles);
	const forbidden = new Set(conventions.forbiddenServiceIds);
	for (const [relative, calls] of registrations) {
		for (const registration of calls) {
			if (forbidden.has(registration.serviceId)) {
				findings.push(
					finding(
						'FORBIDDEN-SERVICE',
						`${call}(${registration.serviceId}) overrides a service the type protects: ${verifier.forbiddenReason}`,
						verifier.forbiddenHint,
						`${OWN_SOURCE_DIR}/${relative}`,
						registration.line
					)
				);
			}
		}
	}

	for (const item of overrideModules) {
		if (!item.delivered) {
			continue;
		}
		const calls = registrations.get(item.module) ?? [];
		if (!calls.some((registration) => registration.serviceId === item.override.serviceId)) {
			findings.push(
				finding(
					'ARTIFACT-BROKEN',
					`${item.override.id}: ${OWN_SOURCE_DIR}/${item.module} does not call ${call}(${item.override.serviceId}) as its service override declares`,
					`make the module registration and serviceOverrides[].serviceId in ${OWN_MANIFEST_PATH} agree`,
					`${OWN_SOURCE_DIR}/${item.module}`
				)
			);
			continue;
		}
		// ##TYPE-AREA-LAYERS: in a family where the last registration wins, the
		// call is the whole proof; in one where an override wins only because
		// its package is loaded after the package it overrides, it is not. What
		// else has to hold is the type's answer, and it is asked over the same
		// module the registration was found in.
		for (const problem of overrideProblems(verifier, root, item.module, item.override.serviceId)) {
			findings.push(finding('ARTIFACT-BROKEN', `${item.override.id}: ${problem.detail}`, problem.hint, `${OWN_SOURCE_DIR}/${item.module}`));
		}
	}
}

/** What the type finds wrong with one override beyond its registration call. */
function overrideProblems(
	verifier: ServiceOverrideVerifier,
	root: string,
	modulePath: string,
	serviceId: string
): readonly ServiceOverrideProblem[] {
	const ask = verifier.overrideProblems;
	if (ask === undefined) {
		return [];
	}
	const read = (relative: string): string | null => {
		try {
			return readFileSync(join(root, ...relative.split('/')), 'utf8');
		} catch {
			// A file of the own layer the type asked for and the layer does not
			// carry is an answer - "it is not there" - and not a failure.
			return null;
		}
	};
	const moduleText = read(modulePath);
	if (moduleText === null) {
		return [];
	}
	return ask({ serviceId, modulePath, moduleText, read });
}

type SingletonRegistration = { readonly serviceId: string; readonly line: number };
type OwnSource = { readonly relative: string; readonly text: string };

const SINGLETON_SCAN_ROOT = '/codkit-singleton-scan';

function singletonRegistrations(
	verifier: ServiceOverrideVerifier,
	root: string,
	ownFiles: readonly string[]
): ReadonlyMap<string, readonly SingletonRegistration[]> {
	const sources: OwnSource[] = [];
	for (const relative of ownFiles) {
		if (!relative.endsWith('.ts')) {
			continue;
		}
		try {
			sources.push({ relative, text: readFileSync(join(root, ...relative.split('/')), 'utf8') });
		} catch {
			// A concurrent disappearance is handled by the coverage check on the next run.
		}
	}
	if (sources.length === 0) {
		return new Map();
	}

	const virtualFiles: Record<string, string> = {};
	const paths: string[] = [];
	for (const [index, source] of sources.entries()) {
		const path = `${SINGLETON_SCAN_ROOT}/source-${index}.ts`;
		virtualFiles[path] = source.text;
		paths.push(path);
	}

	const registrations = new Map<string, readonly SingletonRegistration[]>();
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
				registrations.set(source.relative, sourceFile === undefined ? [] : collectSingletonRegistrations(verifier, sourceFile));
			}
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
	return registrations;
}

function collectSingletonRegistrations(verifier: ServiceOverrideVerifier, sourceFile: SourceFile): readonly SingletonRegistration[] {
	const registrations: SingletonRegistration[] = [];
	const callees = singletonCalleeNames(verifier, sourceFile);
	const visit = (node: Node): void => {
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

function singletonCalleeNames(verifier: ServiceOverrideVerifier, sourceFile: SourceFile): ReadonlySet<string> {
	const names = new Set<string>([verifier.registrationCall]);
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
			if (imported === verifier.registrationCall) {
				names.add(element.name.text);
			}
		}
	}
	return names;
}

// ---------------------------------------------------------------------------
// (i) "No intervention outside the inventory" (PROP-006 sec. 6)
// ---------------------------------------------------------------------------

function checkCompleteness(
	type: ProjectType,
	patchesDir: string,
	treeDir: string,
	config: CodkitConfig,
	patches: readonly PatchArtifact[],
	overlays: readonly Overlay[],
	resources: readonly ResourceEntry[],
	findings: Finding[],
	warnings: string[]
): void {
	// The completeness of the delta is a property of the *generated branch*, not
	// of the working files: the branch is what the tree was brought to, and the
	// working files are wherever the developer left them.
	const branch = generatedBranchName(config);
	const tip = revParse(treeDir, `refs/heads/${branch}`);
	if (tip === null) {
		warnings.push(
			`the generated branch ${branch} does not exist in the fork tree, so "no intervention outside the inventory" was not checked; ` +
				'run codkit load first'
		);
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
	const materializer = materializerOf(type);
	const ownPrefixes = [
		`${config.typeConfig.ownRoot}/`,
		...(materializer === null ? [] : ownExtensionTreePrefixes(materializer, loadOwnManifest(patchesDir).extensions))
	];

	for (const path of changed) {
		if (ownPrefixes.some((prefix) => path.startsWith(prefix))) {
			// ##OWN-EXCLUDED-LOCALLY: own code is committed on the generated branch
			// only in the ci/publish mode; locally it is copied in untracked, so a
			// committed own file means the two modes were mixed in one tree.
			findings.push(
				finding(
					'UNTRACKED-INTERVENTION',
					`${path} is committed on ${branch}, but own code is only committed on a branch built by ci or publish`,
					'rebuild the branch for this mode: codkit load --fresh',
					path
				)
			);
			continue;
		}
		if (patchTargets.has(path) || overlayTargets.has(path) || resourceTargets.has(path)) {
			continue;
		}
		findings.push(
			finding(
				'UNTRACKED-INTERVENTION',
				`${path} differs from pin ${config.pin.tag} on ${branch}, and no artifact of the delta explains it`,
				'every change of the tree comes from an artifact: extract it with codkit save, or rebuild the branch with codkit load --fresh',
				path
			)
		);
	}

	// The other direction: an artifact whose target the branch does not carry is
	// an artifact that no longer does anything.
	for (const entry of patches) {
		const target = toPosix(entry.patch.targetPath);
		if (changed.has(target)) {
			continue;
		}
		findings.push(
			finding(
				'STALE-ARTIFACT',
				`${entry.patch.header.id}: ${target} is identical to pin ${config.pin.tag} on ${branch}, so this patch changes nothing`,
				'remove the artifact, or regenerate it from a real change (codkit save)',
				entry.artifact
			)
		);
	}
	for (const entry of resources) {
		checkResourceEntry(patchesDir, treeDir, branch, tip, changed, entry, findings);
	}
	// Overlay targets are deliberately not required to appear: the local channel
	// writes the dev channel of the type and leaves the upstream file alone
	// (##OVERLAY-TWO-CHANNELS), so an absent overlay target is the normal state.
}

function checkResourceEntry(
	patchesDir: string,
	treeDir: string,
	branch: string,
	tip: string,
	changed: ReadonlySet<string>,
	entry: ResourceEntry,
	findings: Finding[]
): void {
	const target = toPosix(entry.target);
	if (!changed.has(target)) {
		findings.push(
			finding(
				'STALE-ARTIFACT',
				`${entry.id}: ${target} is identical to the pin on ${branch}, so the resource is not replaced`,
				'rebuild the branch (codkit load), or drop the entry if the replacement is no longer wanted',
				RESOURCE_MAP_PATH
			)
		);
		return;
	}
	// Byte equality through git's own object ids: the content is binary by
	// definition of this layer, so it is never decoded as text.
	const onBranch = blobSha(treeDir, `${tip}:${target}`);
	const ours = hashFile(treeDir, resourceSourcePath(patchesDir, entry));
	if (onBranch === null || ours === null || onBranch === ours) {
		return;
	}
	findings.push(
		finding(
			'STALE-ARTIFACT',
			`${entry.id}: ${target} on ${branch} is not the bytes of ${entry.source} - the branch and the map have drifted apart`,
			'rebuild the branch: codkit load',
			RESOURCE_MAP_PATH
		)
	);
}

/** Paths that differ between two commits, renames resolved to plain changes. */
function changedPaths(treeDir: string, from: string, to: string): ReadonlySet<string> | null {
	const result = runGit({ args: ['diff', '--name-status', '--no-renames', '-z', from, to], cwd: treeDir });
	if (result.status !== 0) {
		return null;
	}
	const fields = result.stdout.split('\0').filter((field) => field !== '');
	const paths = new Set<string>();
	// `-z --name-status` emits status and path as separate NUL-terminated fields.
	for (let index = 1; index < fields.length; index += 2) {
		const path = fields[index];
		if (path !== undefined) {
			paths.add(path);
		}
	}
	return paths;
}

function blobSha(treeDir: string, revision: string): string | null {
	const result = runGit({ args: ['rev-parse', revision], cwd: treeDir });
	return result.status === 0 ? result.stdout.trim() : null;
}

function hashFile(treeDir: string, absolutePath: string): string | null {
	const result = runGit({ args: ['hash-object', '--no-filters', '--', absolutePath], cwd: treeDir });
	return result.status === 0 ? result.stdout.trim() : null;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function finding(code: ErrorCode, message: string, hint: string, file?: string, line?: number): Finding {
	const payload: { code: ErrorCode; message: string; hint: string; file?: string; line?: number } = { code, message, hint };
	if (file !== undefined) {
		payload.file = file;
	}
	if (line !== undefined) {
		payload.line = line;
	}
	return payload;
}

/** Turn anything raised by a checker into a finding of the artifact it is about. */
function toFinding(error: unknown, file: string): Finding {
	if (isCkError(error)) {
		return finding(error.code, error.message, error.hint ?? 'see the artifact this finding names', error.file ?? file, error.line);
	}
	return finding(
		'INTERNAL',
		error instanceof Error ? error.message : String(error),
		're-run with --verbose and attach the output to a bug report',
		file
	);
}

function countByCode(findings: readonly Finding[]): Readonly<Record<string, number>> {
	const counts = new Map<string, number>();
	for (const item of findings) {
		counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
	}
	const out: Record<string, number> = {};
	for (const key of [...counts.keys()].sort()) {
		out[key] = counts.get(key) ?? 0;
	}
	return out;
}
