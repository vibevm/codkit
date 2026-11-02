/** @scope spec://codkit/modules/codkit/PROP-007#CMD-BUNDLES-ADD */
// codkit bundles add <archive> --id <id> [--owner <owner>] [--reason <text>]
// and codkit bundles update [<name>...|--all] (PROP-007 ##CMD-BUNDLES-ADD,
// ##CMD-BUNDLES-UPDATE): the declaration of a bundle - a unit the product ships
// inside its distribution, built elsewhere and delivered as an archive the
// upstream build already takes (PROP-003 ##CFG-BUNDLES).
//
// `add` reads the identity of the unit from the manifest inside the archive the
// way the type's bundles layer names it, hashes the archive, appends the
// declaration to codkit.json canonically under the configuration lock, and
// writes the overlay record with one `append` on the manifest's list (PROP-005
// ##OVERLAY-APPEND) and the guard test the layer makes mandatory, through the
// type's generator. `update` reads the archives again and rewrites the version
// and the hash in the record and in the guard. Every refusal comes before the
// first write, and nothing here touches a fork tree: the bytes of a bundle
// reach the tree through `load` and `package` (PROP-008 ##BUNDLES-LOAD).
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { bytesEqual, encodeUtf8 } from '../lib/bytes.js';
import { declaredBundleFile, resolveBundleFile } from '../lib/bundlesDeclaration.js';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, commandFlagValue, patchesRoot, requireProjectType } from '../lib/command.js';
import { CONFIG_FILE_NAME, parseBaseConfig, parseConfigBytes, serializeBaseConfig } from '../lib/configFile.js';
import { readContainedFile, writeContainedFileAtomic } from '../lib/containedFile.js';
import { loadConventions } from '../lib/conventionsFile.js';
import { refuseExisting, unitReminder, writeGenerated } from '../lib/genFeature.js';
import { OVERLAY_FILE_SUFFIX, OVERLAY_SCHEMA_VERSION, OVERLAYS_DIR, loadOverlays, overlayArtifactName, parseOverlay, serializeOverlay } from '../lib/layers/overlay.js';
import { withLock } from '../lib/lock.js';
import { ckError, isCkError } from '../lib/messages.js';
import { OWNERS_PATH, loadOwnerKeys } from '../lib/owners.js';
import { pinKey } from '../lib/pinIdentity.js';
import { requireCapability } from '../types/capability.js';
import { hashFile, readZipEntry } from '../lib/zipArchive.js';
const ID = '--id';
const OWNER = '--owner';
const REASON = '--reason';
const ALL = '--all';
/** The lock every writer of codkit.json takes (the pin update of a cycle included). */
const CONFIG_LOCK_ID = 'cycle-global';
/** The intervention type and category of a bundle record: the product extends a list of the manifest with its own unit. */
const RECORD_TYPE = 'extend';
const RECORD_CATEGORY = 'own';
const USAGE_ADD = `usage: codkit bundles add <archive> ${ID} CK-<subsystem>-<NNN> [${OWNER} <owner>] [${REASON} <text>]`;
const USAGE_UPDATE = 'usage: codkit bundles update <name>...|--all';
/** main.ts answers a bare namespace before this runs. */
async function runNamespace() {
    return EXIT_ENVIRONMENT;
}
async function runAdd(ctx) {
    try {
        return addBundle(ctx);
    }
    catch (error) {
        return answer(ctx, error);
    }
}
async function runUpdate(ctx) {
    try {
        return updateBundles(ctx);
    }
    catch (error) {
        return answer(ctx, error);
    }
}
/**
 * PROP-007 ##CLI-EXIT-CODES, as `overlay new` reads it: a problem with what was
 * typed, with the archive or with the configuration is a startup failure (2); a
 * problem with the state of the delta - a taken id, an unknown owner, an
 * artifact that is already there - is a check that did not pass (1).
 */
function answer(ctx, error) {
    if (!isCkError(error))
        throw error;
    ctx.out.addError(error.toPayload());
    return error.code === 'CONFIG' || error.code === 'TYPE-CAPABILITY' ? EXIT_ENVIRONMENT : EXIT_CHECK_FAILED;
}
function addBundle(ctx) {
    const config = requireConfig(ctx.config, 'add');
    const type = requireProjectType(ctx);
    const layer = bundleLayer(type, 'bundles add');
    const patchesDir = patchesRoot(ctx);
    const given = ctx.args[0];
    if (given === undefined || given === '') {
        throw ckError('CONFIG', 'bundles add needs the archive of the unit', USAGE_ADD);
    }
    const id = commandFlagValue(ctx.commandFlags, ID);
    if (id === null || id === '')
        throw ckError('CONFIG', `bundles add needs ${ID}`, USAGE_ADD);
    const absolute = resolve(given);
    const archive = readArchive(layer, absolute, given);
    if ((config.bundles ?? []).some((bundle) => bundle.name === archive.name)) {
        throw ckError('CONFIG', `codkit.json already declares the bundle ${archive.name}`, `codkit bundles update ${archive.name} rewrites its record from the archive; to move the archive, edit its file in codkit.json`);
    }
    const conventions = loadConventions(type, patchesDir);
    if (!new RegExp(conventions.idPattern).test(id)) {
        throw ckError('MARKER-BAD-ID', `id "${id}" does not match the id pattern of conventions.json`, `use an id of the form CK-<subsystem>-<NNN> with a subsystem from conventions.json (pattern: ${conventions.idPattern})`);
    }
    if (!conventions.interventionTypes.includes(RECORD_TYPE) || !conventions.categories.includes(RECORD_CATEGORY)) {
        throw ckError('CONFIG', `a bundle record is an intervention of type ${RECORD_TYPE} and category ${RECORD_CATEGORY}, and conventions.json does not know them`, 'add them to the vocabularies of conventions.json, or write the record by hand with codkit overlay new');
    }
    const overlays = loadOverlays(patchesDir, type);
    const taken = overlays.find((overlay) => overlay.id === id);
    if (taken !== undefined) {
        throw ckError('MARKER-DUP-ID', `id already used: ${id} is the id of ${taken.artifactPath}`, 'give this bundle its own id', taken.artifactPath);
    }
    const owner = ownerOf(patchesDir, commandFlagValue(ctx.commandFlags, OWNER));
    const reason = commandFlagValue(ctx.commandFlags, REASON) ?? `the product ships ${archive.name} inside its distribution`;
    const declared = { name: archive.name, file: declaredBundleFile(patchesDir, absolute, given) };
    const artifact = recordArtifactPath(layer, archive.name);
    const document = {
        codkitOverlay: OVERLAY_SCHEMA_VERSION,
        id,
        target: layer.manifestTarget,
        type: RECORD_TYPE,
        category: RECORD_CATEGORY,
        owner,
        reason,
        link: 'none',
        cause: 'none',
        pin: `${pinKey(config.pin)}@${config.pin.sha}`,
        contractTests: [id],
        operations: [recordOperation(layer, archive)]
    };
    const record = { path: artifact, text: serializeOverlay(document) };
    // The bytes this command writes are the bytes the loader accepts.
    parseOverlay(JSON.parse(record.text), artifact);
    const guard = guardOf(type, { id, archive, ownRoot: config.typeConfig.ownRoot, manifestTarget: layer.manifestTarget });
    refuseExisting(patchesDir, [record, guard]);
    // codkit.json first, under the lock every writer of it takes; the two
    // artifacts after it, so that a refusal of the declaration leaves nothing.
    withLock(patchesDir, CONFIG_LOCK_ID, 'bundles add', () => appendDeclaration(patchesDir, declared));
    writeGenerated(patchesDir, [record, guard]);
    ctx.out.info(`bundle ${archive.name}@${archive.version}: ${declared.file} (sha256 ${archive.sha256.slice(0, 12)})`);
    ctx.out.info(`${CONFIG_FILE_NAME}: bundles += ${archive.name}`);
    ctx.out.info(`created ${record.path}`);
    ctx.out.info(`created ${guard.path}`);
    ctx.out.info(`next: ${unitReminder(guard.path.slice(0, guard.path.lastIndexOf('/')))}`);
    ctx.out.info("commit them together with the archive's new content");
    ctx.out.setData({
        name: archive.name,
        version: archive.version,
        sha256: archive.sha256,
        file: declared.file,
        artifacts: [CONFIG_FILE_NAME, record.path, guard.path]
    });
    return EXIT_OK;
}
function updateBundles(ctx) {
    const config = requireConfig(ctx.config, 'update');
    const type = requireProjectType(ctx);
    const layer = bundleLayer(type, 'bundles update');
    const patchesDir = patchesRoot(ctx);
    const selected = selectedBundles(ctx, config);
    const overlays = loadOverlays(patchesDir, type);
    // Every named bundle is read and checked before one is written.
    const planned = selected.map((bundle) => {
        const found = recordOf(overlays, layer, bundle.name);
        if (found === null) {
            throw ckError('CONFIG', `bundle ${bundle.name}: no overlay record appends it to ${layer.manifestTarget}`, `codkit bundles add <archive> --id <id> writes the record; expected ${recordArtifactPath(layer, bundle.name)}`);
        }
        const archive = readArchive(layer, resolveBundleFile(patchesDir, bundle.file), bundle.file);
        if (archive.name !== bundle.name) {
            throw ckError('CONFIG', `bundle ${bundle.name}: the archive ${archive.path} holds ${archive.name}@${archive.version}`, 'point codkit.json at the archive of this unit, or declare the other one with codkit bundles add');
        }
        const previous = found.operation.value;
        const from = { version: String(previous['version'] ?? ''), sha256: String(previous['sha256'] ?? '') };
        const changed = from.version !== archive.version || from.sha256 !== archive.sha256;
        const guard = guardOf(type, {
            id: found.overlay.id,
            archive,
            ownRoot: config.typeConfig.ownRoot,
            manifestTarget: layer.manifestTarget
        });
        const { artifactPath, ...document } = found.overlay;
        const operations = document.operations.map((operation) => operation === found.operation ? recordOperation(layer, archive) : operation);
        const record = { path: artifactPath, text: serializeOverlay({ ...document, operations }) };
        parseOverlay(JSON.parse(record.text), artifactPath);
        return { bundle, archive, from, changed, record, guard };
    });
    for (const plan of planned) {
        if (plan.changed)
            writeGenerated(patchesDir, [plan.record, plan.guard]);
        ctx.out.info(plan.changed
            ? `bundle ${plan.bundle.name}: ${plan.from.version} (${plan.from.sha256.slice(0, 12)}) -> ${plan.archive.version} (${plan.archive.sha256.slice(0, 12)})`
            : `bundle ${plan.bundle.name}: already current`);
    }
    if (planned.some((plan) => plan.changed))
        ctx.out.info("commit the rewritten record and guard together with the archive's new content");
    ctx.out.setData({
        bundles: planned.map((plan) => ({
            name: plan.bundle.name,
            from: plan.from,
            to: { version: plan.archive.version, sha256: plan.archive.sha256 },
            changed: plan.changed,
            artifacts: plan.changed ? [plan.record.path, plan.guard.path] : []
        }))
    });
    return EXIT_OK;
}
/** The bundles the arguments name, or every one with `--all`; a name codkit.json does not declare is refused. */
function selectedBundles(ctx, config) {
    const declared = config.bundles ?? [];
    const all = commandFlagGiven(ctx.commandFlags, ALL);
    if (all === ctx.args.length > 0) {
        throw ckError('CONFIG', 'bundles update needs the names of bundles, or --all', USAGE_UPDATE);
    }
    if (all) {
        if (declared.length === 0)
            throw ckError('CONFIG', 'codkit.json declares no bundles', 'declare one with codkit bundles add <archive>');
        return declared;
    }
    return ctx.args.map((name) => {
        const bundle = declared.find((candidate) => candidate.name === name);
        if (bundle === undefined) {
            throw ckError('CONFIG', `codkit.json declares no bundle named ${name}`, `the declared bundles: ${declared.map((entry) => entry.name).join(', ') || 'none'}`);
        }
        return bundle;
    });
}
/** The layer, after the capability: a type without it has nothing to declare a bundle against. */
function bundleLayer(type, what) {
    requireCapability(type, 'bundles', what);
    const layer = type.layers.bundles;
    if (layer === null) {
        throw ckError('TYPE-CAPABILITY', `${what}: the project type ${type.id} declares the capability bundles but answers no bundles layer`, 'report this to the author of the type');
    }
    return layer;
}
/** The archive read the way the layer says: its hash, and the identity of the unit from the manifest inside it. */
function readArchive(layer, path, asGiven) {
    if (!existsSync(path) || !statSync(path).isFile()) {
        throw ckError('CONFIG', `the ${layer.archiveWord} ${asGiven} is not there`, `give the path of the ${layer.archiveWord}, absolute or relative to the current directory`);
    }
    let manifest;
    try {
        manifest = readZipEntry(path, layer.archiveManifest);
    }
    catch (error) {
        throw ckError('CONFIG', `${asGiven} is not a zip archive: ${error instanceof Error ? error.message : String(error)}`, `a ${layer.archiveWord} is a zip with ${layer.archiveManifest} inside`);
    }
    if (manifest === null) {
        throw ckError('CONFIG', `${asGiven} holds no ${layer.archiveManifest}`, `a ${layer.archiveWord} carries the manifest of its unit at ${layer.archiveManifest}`);
    }
    const identity = layer.identity(Buffer.from(manifest).toString('utf8'));
    if (identity === null) {
        throw ckError('CONFIG', `${layer.archiveManifest} of ${asGiven} declares no name or no version`, 'the manifest inside the archive must name the unit and its version');
    }
    if (!layer.namePattern.test(identity.name)) {
        throw ckError('CONFIG', `${asGiven} names its unit ${JSON.stringify(identity.name)}, which is not a name of the ${layer.archiveWord} kind`, `the name must match ${layer.namePattern.source}`);
    }
    return { path, name: identity.name, version: identity.version, sha256: hashFile(path).sha256 };
}
/**
 * The owner is the one `--owner` names - which must be declared when
 * owners.json exists - or the only one of owners.json. A patch set with several
 * owners and no flag has nobody to answer for the bundle, and the run says so.
 */
function ownerOf(patchesDir, given) {
    const owners = loadOwnerKeys(patchesDir);
    if (given !== null && given !== '') {
        if (owners !== null && !owners.includes(given)) {
            throw ckError('OWNER-UNKNOWN', `owner "${given}" is not declared in ${OWNERS_PATH}`, `use one of: ${owners.join(', ')}   (or add the owner to ${OWNERS_PATH} first)`, OWNERS_PATH);
        }
        return given;
    }
    const only = owners?.length === 1 ? owners[0] : undefined;
    if (only !== undefined)
        return only;
    throw ckError('CONFIG', owners === null
        ? `bundles add needs ${OWNER} <name>: the patch set has no ${OWNERS_PATH} to take the owner from`
        : `bundles add needs ${OWNER} <name>: ${OWNERS_PATH} declares ${owners.length} owner(s)`, owners === null || owners.length === 0 ? `name the owner of the bundle record with ${OWNER}` : `use one of: ${owners.join(', ')}`);
}
/** `delta/overlays/<target as a patch name>.bundle-<name>.overlay.json`. */
export function recordArtifactPath(layer, name) {
    const conventional = overlayArtifactName(layer.manifestTarget);
    return `${OVERLAYS_DIR}/${conventional.slice(0, -OVERLAY_FILE_SUFFIX.length)}.bundle-${name}${OVERLAY_FILE_SUFFIX}`;
}
/** The one operation of a record: the layer's entry for the unit, appended to the list of the manifest. */
function recordOperation(layer, archive) {
    const value = JSON.parse(JSON.stringify(layer.entry({ name: archive.name, version: archive.version, sha256: archive.sha256 })));
    return { op: 'append', path: [...layer.listPath], value };
}
/** The record of a bundle: the overlay at the conventional path, or any overlay of the target that appends the unit by name. */
function recordOf(overlays, layer, name) {
    const conventional = recordArtifactPath(layer, name);
    const candidates = [
        ...overlays.filter((overlay) => overlay.artifactPath === conventional),
        ...overlays.filter((overlay) => overlay.artifactPath !== conventional && overlay.target === layer.manifestTarget)
    ];
    for (const overlay of candidates) {
        const operation = overlay.operations.find((candidate) => candidate.op === 'append' &&
            candidate.path.length === layer.listPath.length &&
            candidate.path.every((segment, index) => segment === layer.listPath[index]) &&
            typeof candidate.value === 'object' &&
            candidate.value !== null &&
            !Array.isArray(candidate.value) &&
            candidate.value['name'] === name);
        if (operation !== undefined)
            return { overlay, operation };
    }
    return null;
}
/** The guard test the type generates for the record (PROP-007 ##CMD-BUNDLES-ADD). */
function guardOf(type, request) {
    const generate = type.generators.bundleGuard;
    if (generate === undefined) {
        throw ckError('TYPE-CAPABILITY', `the project type ${type.id} answers the bundles layer but generates no guard test for a record`, 'report this to the author of the type');
    }
    const module = generate({
        id: request.id,
        unit: { name: request.archive.name, version: request.archive.version, sha256: request.archive.sha256 },
        ownRoot: request.ownRoot,
        manifestTarget: request.manifestTarget
    });
    return { path: module.path, text: module.text };
}
/**
 * Append the declaration to codkit.json, canonically. The file is read,
 * rewritten and compared again right before the replace, so an edit that lands
 * in between survives (the way `inputs pin` moves a pin).
 */
function appendDeclaration(patchesDir, bundle) {
    const read = readContainedFile(patchesDir, CONFIG_FILE_NAME, { what: CONFIG_FILE_NAME });
    if (read.state !== 'ok') {
        throw ckError('CONFIG', `${CONFIG_FILE_NAME} does not exist`, 'run from a configured patch set', CONFIG_FILE_NAME);
    }
    const base = parseBaseConfig(parseConfigBytes(read.bytes), CONFIG_FILE_NAME);
    if ((base.bundles ?? []).some((declared) => declared.name === bundle.name)) {
        throw ckError('CONFIG', `codkit.json already declares the bundle ${bundle.name}`, `codkit bundles update ${bundle.name} rewrites its record`);
    }
    const next = encodeUtf8(serializeBaseConfig({ ...base, bundles: [...(base.bundles ?? []), { name: bundle.name, file: bundle.file }] }));
    const current = readContainedFile(patchesDir, CONFIG_FILE_NAME, { what: CONFIG_FILE_NAME });
    if (current.state !== 'ok' || !bytesEqual(current.bytes, read.bytes)) {
        throw ckError('LOCKED', `${CONFIG_FILE_NAME} changed while the declaration was prepared`, 'run the command again; the newer content was kept', CONFIG_FILE_NAME);
    }
    writeContainedFileAtomic(patchesDir, CONFIG_FILE_NAME, { bytes: next, what: CONFIG_FILE_NAME });
}
function requireConfig(config, verb) {
    if (config === null) {
        throw ckError('CONFIG', `codkit.json was not found in the patchset root: bundles ${verb} declares against it`, 'run from a patchset checkout that carries codkit.json');
    }
    return config;
}
export const bundlesCommand = {
    name: 'bundles',
    summary: 'namespace of the bundles the product ships; run bundles add or bundles update',
    configMode: 'none',
    namespace: true,
    roots: 'none',
    maxArgs: 0,
    run: runNamespace
};
export const bundlesAddCommand = {
    name: 'bundles add',
    summary: 'declare a bundle from its archive: codkit.json, the overlay record and its guard test',
    configMode: 'load',
    roots: 'patches',
    maxArgs: 1,
    commandFlags: [ID, OWNER, REASON],
    run: runAdd
};
export const bundlesUpdateCommand = {
    name: 'bundles update',
    summary: 'rewrite the version and the hash of bundles from their archives',
    configMode: 'load',
    roots: 'patches',
    maxArgs: 100,
    commandFlags: [ALL],
    run: runUpdate
};
