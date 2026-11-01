/** @scope spec://codkit/modules/codkit/PROP-019#GEN-LICENSING */
// The planner and the writer behind `codkit gen licensing` (PROP-007
// ##CMD-GEN-LICENSING): the surfaces `licensingSurfaces` describes become the
// artifacts of the patch set - overlay documents, add-file patches and the
// guard - with their ids, their owner, their pin and the proof that each parses
// with the reader every other artifact of its layer goes through.
//
// Two properties shape the module the way `genFeature.ts` is shaped.
// ##GEN-REFUSES-EXISTING: the whole plan is computed and classified before a
// byte is written, so a refusal leaves the patch set as it was. The one path
// that is never refused is an overlay of a target the patch set already has: the
// surface is operations inside somebody's document, not a file of its own, and
// it is merged there. ##GEN-LICENSING: a rerun under `--update` rewrites exactly
// the artifacts of this command and keeps their ids - the id of an artifact is
// read back from the file at its path - so a new edition of the licence text
// changes the body of one patch and nothing else of the patch set.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { addFilePatchText } from './addFilePatch.js';
import { encodeUtf8 } from './bytes.js';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.js';
import { statIfPresent } from './containedPath.js';
import { loadConventions } from './conventionsFile.js';
import { unitReminder } from './genFeature.js';
import { productHeader } from './genTemplates.js';
import { buildInventory } from './inventory.js';
import { OVERLAYS_DIR, OVERLAY_SCHEMA_VERSION, devChannelTarget, loadOverlays, overlayArtifactName, parseOverlay, serializeOverlay } from './layers/overlay.js';
import { renderLicencePlainText, renderLicenceRtf } from './licenceRtf.js';
import { commentStyleNames } from './licenseAnnotate.js';
import { licenceGuardText } from './licensingGuardTemplate.js';
import { OWN_LAYER_DIR, headerFieldsFor, headerStyleOf, ownLicenseFor } from './licensingProfile.js';
import { CODKIT_COMPONENT, LICENCE_GUARD_SUITE, licensingAreaOf, licensingSurfaces } from './licensingSurfaces.js';
import { ckError } from './messages.js';
import { OWNERS_PATH, loadOwnerKeys } from './owners.js';
import { formatPatchHeader, parseCkpatch } from './patchFormat.js';
import { pinKey } from './pinIdentity.js';
/** PROP-007 sec. 8: the vocabularies of a licensing intervention. */
const PATCH_TYPE = 'extend';
const OVERLAY_TYPE = 'modify';
const CATEGORY = 'follow';
/** The reasons the headers carry: one sentence each, the same on every machine. */
const OVERLAY_REASON = 'the licence of the product: the manifest names the licence of the selected profile';
const LICENCE_FILE_REASON = 'the licence of the product, from the trusted profile';
const UPSTREAM_COMPONENT_REASON = "the upstream's own terms travel with the product as a component licence";
const CODKIT_COMPONENT_REASON = "the tool's licence travels with the runtime library it delivers";
const RENDERING_REASON = 'what the installer of this family reads instead of the licence text';
export const ANNOTATE_REMINDER = 'run codkit license annotate --own to give the own files their carriers';
export const VERIFY_REMINDER = 'run codkit verify';
/** ##GEN-LICENSING: the plan of one run, computed without writing anything. */
export function planLicensing(options) {
    const { patchesDir, type, profile, config } = options;
    const area = licensingAreaOf(type, 'gen licensing');
    const owner = ownerOf(patchesDir, options.owner);
    const surfaces = licensingSurfaces({ profile, type, config, patchesDir, treeDir: options.treeDir, toolRoot: options.toolRoot });
    const overlays = loadOverlays(patchesDir, type);
    const context = {
        patchesDir,
        owner,
        pin: `${pinKey(config.pin)}@${config.pin.sha}`,
        conventions: loadConventions(type, patchesDir),
        overlays,
        nextId: idAllocator(area.subsystem, takenIds(patchesDir, type, config, overlays))
    };
    // The order fixes the ids a fresh run allocates: the overlays per target as
    // the type lists the fields, the licence file, the components, the renderings.
    const files = [];
    const planned = [];
    for (const surface of surfaces.overlays) {
        const overlay = planOverlay(context, surface);
        files.push(overlay.file);
        planned.push(overlay.summary);
    }
    files.push(planPatch(context, surfaces.licenceFile, LICENCE_FILE_REASON));
    for (const component of surfaces.components) {
        files.push(planPatch(context, component, component.component === CODKIT_COMPONENT ? CODKIT_COMPONENT_REASON : UPSTREAM_COMPONENT_REASON));
    }
    for (const rendering of surfaces.renderings) {
        const text = rendering.format === 'rtf' ? renderLicenceRtf(surfaces.canonicalText) : renderLicencePlainText(surfaces.canonicalText);
        files.push(planPatch(context, { treePath: rendering.treePath, artifact: rendering.artifact, text }, RENDERING_REASON));
    }
    files.push(planGuard(options, area, surfaces));
    const guardDirectory = surfaces.guard.artifact.slice(0, surfaces.guard.artifact.lastIndexOf('/'));
    return { owner, files, overlays: planned, reminders: [unitReminder(guardDirectory), ANNOTATE_REMINDER, VERIFY_REMINDER] };
}
/**
 * ##GEN-REFUSES-EXISTING: the paths of the plan that are already there and are
 * not merged. The caller refuses them without `--update` and rewrites them with
 * it; either way the question is answered before anything is written.
 */
export function existingTargets(plan) {
    return plan.files.filter((file) => file.exists && file.kind !== 'overlay').map((file) => file.path);
}
/** ##GEN-REFUSES-EXISTING: exit 1 with nothing written, listing every artifact that is already there. */
export function refuseExistingLicensing(plan) {
    const existing = existingTargets(plan);
    if (existing.length === 0)
        return;
    throw ckError('GEN-EXISTS', `gen licensing would overwrite ${existing.length} existing artifact(s): ${existing.join(', ')}`, 'pass --update to rewrite the artifacts of an earlier run of gen licensing; nothing was written', existing[0]);
}
/** Write the plan. The caller has already refused or accepted the existing targets. */
export function writeLicensingPlan(patchesDir, plan) {
    for (const file of plan.files) {
        writeContainedFileAtomic(patchesDir, file.path, { what: file.path, bytes: encodeUtf8(file.text) });
    }
}
/**
 * ##GEN-LICENSING: the owner is the only one of `owners.json`, or the one
 * `--owner` names - which must be declared when the file exists. A patch set
 * with several owners and no flag has nobody to answer for the licence, and the
 * run says so rather than picking one.
 */
function ownerOf(patchesDir, given) {
    const owners = loadOwnerKeys(patchesDir);
    if (given !== null && given !== '') {
        if (owners !== null && !owners.includes(given)) {
            throw ckError('CONFIG', `the owner ${JSON.stringify(given)} is not declared in ${OWNERS_PATH}`, `use one of: ${owners.join(', ')}`, OWNERS_PATH);
        }
        return given;
    }
    const only = owners?.length === 1 ? owners[0] : undefined;
    if (only !== undefined)
        return only;
    throw ckError('CONFIG', owners === null
        ? `gen licensing needs --owner <name>: the patch set has no ${OWNERS_PATH} to take the owner from`
        : `gen licensing needs --owner <name>: ${OWNERS_PATH} declares ${owners.length} owner(s)`, owners === null || owners.length === 0
        ? 'name the owner of the licensing interventions with --owner'
        : `use one of: ${owners.join(', ')}`);
}
/** Every id the delta uses: the inventory's entries, with the overlays named again in case the inventory left one out. */
function takenIds(patchesDir, type, config, overlays) {
    const inventory = buildInventory(patchesDir, type, { config });
    return new Set([...inventory.entries.map((entry) => entry.id), ...overlays.map((overlay) => overlay.id)]);
}
/** ##GEN-LICENSING: the next free three-digit number of the type's subsystem, from 001 upward, in the order the artifacts are planned. */
function idAllocator(subsystem, taken) {
    const used = new Set(taken);
    let next = 1;
    return () => {
        for (; next <= 999; next += 1) {
            const id = `CK-${subsystem}-${String(next).padStart(3, '0')}`;
            if (used.has(id))
                continue;
            used.add(id);
            next += 1;
            return id;
        }
        throw ckError('CONFIG', `the subsystem ${subsystem} has no free three-digit id left for a licensing intervention`, 'retire an intervention of the subsystem, or name another subsystem in the licensing area of the type');
    };
}
/**
 * ##GEN-LICENSING (1): the overlay of one target. An overlay of the target that
 * the patch set already carries receives the operations - the ones with the
 * same path replaced, the others kept, the guard added to its contract tests -
 * and keeps everything else, its id first of all. A target without one gets a
 * new document the way `overlay new` scaffolds it, and either text is proved
 * with the loader before it is planned.
 */
function planOverlay(context, surface) {
    const existing = existingOverlayOf(context.overlays, surface.target);
    if (existing !== null) {
        const text = serializeOverlay(mergedOverlay(existing, surface.operations));
        parseOverlay(JSON.parse(text), existing.artifactPath);
        return {
            file: { path: existing.artifactPath, text, kind: 'overlay', exists: true },
            summary: { artifact: existing.artifactPath, target: surface.target, operations: surface.operations.length, merged: true }
        };
    }
    const artifact = `${OVERLAYS_DIR}/${overlayArtifactName(surface.target)}`;
    if (statIfPresent(join(context.patchesDir, ...artifact.split('/'))) !== null) {
        throw ckError('ARTIFACT-BROKEN', `${artifact} exists but is not an overlay of ${surface.target}`, 'the file name of an overlay is its target; move the file or give it that target', artifact);
    }
    const document = {
        codkitOverlay: OVERLAY_SCHEMA_VERSION,
        id: context.nextId(),
        target: surface.target,
        type: OVERLAY_TYPE,
        category: CATEGORY,
        owner: context.owner,
        reason: OVERLAY_REASON,
        link: 'none',
        cause: 'none',
        pin: context.pin,
        contractTests: [LICENCE_GUARD_SUITE],
        operations: surface.operations
    };
    const text = serializeOverlay(document);
    parseOverlay(JSON.parse(text), artifact);
    return {
        file: { path: artifact, text, kind: 'overlay', exists: false },
        summary: { artifact, target: surface.target, operations: surface.operations.length, merged: false }
    };
}
/** The overlay of a target to merge into: the one at the conventional artifact name, else the first by path. */
function existingOverlayOf(overlays, target) {
    const candidates = overlays.filter((overlay) => overlay.target === target);
    const conventional = `${OVERLAYS_DIR}/${overlayArtifactName(target)}`;
    return candidates.find((overlay) => overlay.artifactPath === conventional) ?? candidates[0] ?? null;
}
function mergedOverlay(existing, expected) {
    const { artifactPath, ...document } = existing;
    void artifactPath;
    const kept = document.operations.filter((operation) => !expected.some((candidate) => samePath(candidate.path, operation.path)));
    const contractTests = document.contractTests.includes(LICENCE_GUARD_SUITE)
        ? document.contractTests
        : [...document.contractTests, LICENCE_GUARD_SUITE];
    return { ...document, contractTests, operations: [...kept, ...expected] };
}
function samePath(left, right) {
    return left.length === right.length && left.every((key, index) => key === right[index]);
}
/**
 * ##GEN-LICENSING (2)-(4): one add-file patch - the licence file, a component
 * licence or a rendering - with the header of a new intervention, or with the
 * id of the patch already at its path so that `--update` is stable. The bytes
 * are proved with the patch reader before they are planned.
 */
function planPatch(context, surface, reason) {
    const exists = statIfPresent(join(context.patchesDir, ...surface.artifact.split('/'))) !== null;
    const id = exists ? existingPatchId(context, surface.artifact) : context.nextId();
    const header = formatPatchHeader({
        id,
        type: PATCH_TYPE,
        category: CATEGORY,
        owner: context.owner,
        reason,
        link: 'none',
        cause: 'none',
        pin: context.pin,
        contractTests: [LICENCE_GUARD_SUITE]
    });
    const text = addFilePatchText(header, surface.treePath, surface.text);
    parseCkpatch(encodeUtf8(text), context.conventions, surface.artifact);
    return { path: surface.artifact, text, kind: 'patch', exists };
}
/** The id of the patch at an artifact path, so a rerun keeps it; a patch that does not read is the reader's refusal. */
function existingPatchId(context, artifact) {
    const read = readContainedFile(context.patchesDir, artifact, { what: artifact });
    if (read.state === 'absent')
        return context.nextId();
    return parseCkpatch(read.bytes, context.conventions, artifact).header.id;
}
/**
 * ##LICENCE-GUARD: the guard at the type's path, headed from the profile like
 * every generated file (##HEADER-FROM-PROFILE): it is an own file of the
 * product, and the first thing it proves about its neighbours holds for itself.
 */
function planGuard(options, area, surfaces) {
    const artifact = surfaces.guard.artifact;
    const header = productHeader({ form: 'fields', ...headerFieldsFor(options.profile, artifact, headerStyleOf(options.type)) });
    const text = `${header}\n${licenceGuardText(guardInput(options, area, surfaces))}`;
    return { path: artifact, text, kind: 'guard', exists: statIfPresent(join(options.patchesDir, ...artifact.split('/'))) !== null };
}
/** ##LICENCE-GUARD: the profile's values and the type's words the template is rendered with. */
function guardInput(options, area, surfaces) {
    const { profile, config } = options;
    const ownRoot = config.typeConfig.ownRoot;
    // The dev channel of the type, and which target it feeds (PROP-005 OVERLAY-TWO-CHANNELS).
    const channel = devChannelTarget(options.type);
    return {
        words: { suite: surfaces.guard.suite, test: surfaces.guard.test },
        preamble: surfaces.guard.preamble,
        holders: profile.selected.policy.holders,
        scopes: [{ treeDirectory: ownRoot, expression: ownLicenseFor(profile, OWN_LAYER_DIR) }, ...extensionScopes(options)],
        skipDirectory: `${ownRoot}/codkit`,
        licenceFile: {
            treePath: surfaces.licenceFile.treePath,
            sha256: createHash('sha256').update(surfaces.canonicalText, 'utf8').digest('hex')
        },
        fields: area.fields.map((field) => ({
            target: field.target,
            path: field.path,
            expected: expectedFieldValue(surfaces, field.target, field.path),
            devChannel: channel !== null && channel.path === field.target
        })),
        devChannel: channel?.devChannel ?? null,
        commentStyleNames: commentStyleNames(),
        components: surfaces.components.map((component) => component.treePath),
        renderings: surfaces.renderings.map((rendering) => rendering.treePath),
        retiredNotices: profile.product.retiredNotices
    };
}
/**
 * The own extensions present in the patch set, each a scope of its own: the
 * directory the type materializes it at, with the own licence resolved for its
 * delta directory (##ORGANIZATION-OWN-SCOPES). Sorted by bytes, like every
 * list the engine produces.
 */
function extensionScopes(options) {
    const extensions = options.type.layers.ownExtensions;
    if (extensions === undefined || extensions === null)
        return [];
    let entries;
    try {
        entries = readdirSync(join(options.patchesDir, ...extensions.deltaRoot.split('/')), { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
        .map((name) => ({
        treeDirectory: extensions.materializedPath(name),
        expression: ownLicenseFor(options.profile, `${extensions.deltaRoot}/${name}`)
    }));
}
/**
 * What the guard reads back from a manifest field: the value the overlay sets,
 * or `absent` for a key the overlay removes - and for a `url` field the product
 * declares no URL for while the pin does not carry the key, which the surfaces
 * leave without an operation because there is nothing to remove.
 */
function expectedFieldValue(surfaces, target, path) {
    const operation = surfaces.overlays
        .find((overlay) => overlay.target === target)
        ?.operations.find((candidate) => samePath(candidate.path, path));
    if (operation === undefined || operation.op === 'remove')
        return 'absent';
    return typeof operation.value === 'string' ? operation.value : JSON.stringify(operation.value);
}
