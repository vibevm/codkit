/** @scope spec://codkit/modules/codkit/PROP-005#root */
// Strict inventory loading for cycle classification. Optional layer documents
// may be absent, but anything present must be a real readable file; no loader
// is allowed to turn an I/O failure into an empty layer at this boundary.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConventions } from './conventionsFile.js';
import { runGit } from './gitx.js';
import { OVERLAYS_DIR, OVERLAY_FILE_SUFFIX, parseOverlayFile } from './layers/overlay.js';
import { OWN_MANIFEST_PATH, parseOwnManifest } from './layers/ownManifest.js';
import { REMOVED_PATH, parseRemoved } from './layers/removed.js';
import { RESOURCE_FILES_PREFIX, RESOURCE_MAP_PATH, parseResourceMap, resourceSourcePath } from './layers/resource.js';
import { RULES_DIR, RULE_FILE_SUFFIX, parseRuleFile } from './layers/rule.js';
import { ckError, isCkError } from './messages.js';
import { encodePatchName, parseCkpatch, PATCH_FILE_SUFFIX } from './patchFormat.js';
import { PATCHES_DIR } from './syncEngine.js';
export function loadCycleClassificationInventory(patchesDir, type, expectedPin, runtime = {}) {
    const patchFiles = artifactFiles(patchesDir, PATCHES_DIR, PATCH_FILE_SUFFIX);
    const conventions = patchFiles.length === 0 ? null : loadConventions(type, patchesDir);
    const patches = patchFiles.map(({ absolute, artifactPath, name }) => {
        if (conventions === null)
            throw broken('patch conventions disappeared while loading inventory');
        const patch = parseCkpatch(readArtifact(absolute, artifactPath), conventions, artifactPath);
        const expectedName = encodePatchName(patch.targetPath);
        if (name !== expectedName)
            throw broken(`${artifactPath}: file name must be ${expectedName}`);
        return { artifactPath, patch };
    });
    const rules = artifactFiles(patchesDir, RULES_DIR, RULE_FILE_SUFFIX).map(({ absolute, artifactPath }) => parseRuleFile(absolute, artifactPath));
    const overlays = artifactFiles(patchesDir, OVERLAYS_DIR, OVERLAY_FILE_SUFFIX).map(({ absolute, artifactPath }) => parseOverlayFile(absolute, artifactPath));
    const resourceRaw = readOptionalJson(patchesDir, RESOURCE_MAP_PATH, runtime);
    const ownRaw = readOptionalJson(patchesDir, OWN_MANIFEST_PATH, runtime);
    const removedRaw = readOptionalJson(patchesDir, REMOVED_PATH, runtime);
    const resources = resourceRaw === null ? [] : parseResourceMap(resourceRaw).entries;
    for (const entry of resources) {
        if (!entry.source.startsWith(RESOURCE_FILES_PREFIX))
            throw broken(`${entry.id}: source ${entry.source} is outside resource files`);
    }
    for (const entry of resources)
        strictAbsoluteFile(resourceSourcePath(patchesDir, entry), entry.source);
    const duplicateResource = duplicate(resources.map((entry) => entry.source));
    if (duplicateResource !== null)
        throw broken(`resource source occurs more than once: ${duplicateResource}`);
    const own = ownRaw === null ? { units: [], serviceOverrides: [] } : parseOwnManifest(ownRaw);
    const removed = removedRaw === null ? { entries: [] } : parseRemoved(removedRaw);
    for (const [path, pin] of [
        ...patches.map((artifact) => [artifact.artifactPath, artifact.patch.header.pin]),
        ...rules.map((rule) => [rule.artifactPath, rule.pin]),
        ...overlays.map((overlay) => [overlay.artifactPath, overlay.pin]),
        ...resources.map((entry) => [entry.source, entry.pin]),
        ...own.units.map((unit) => [`${OWN_MANIFEST_PATH}#${unit.id}`, unit.pin]),
        ...own.serviceOverrides.map((entry) => [`${OWN_MANIFEST_PATH}#${entry.id}`, entry.pin]),
        ...removed.entries.map((entry) => [`${REMOVED_PATH}#${entry.id}`, entry.pin])
    ]) {
        if (pin !== expectedPin)
            throw broken(`${path}: metadata pin ${pin} does not match cycle source ${expectedPin}`);
    }
    const artifacts = [
        ...patches.map((artifact) => ({ kind: 'patch', ...artifact })),
        ...rules.map((rule) => ({ kind: 'rule', rule })),
        ...overlays.map((overlay) => ({ kind: 'overlay', overlay }))
    ];
    artifacts.sort((left, right) => compareText(classificationPath(left), classificationPath(right)));
    const validated = [
        ...own.units.map((unit) => ({ kind: 'own', artifactPath: OWN_MANIFEST_PATH, artifactId: unit.id, pin: unit.pin })),
        ...own.serviceOverrides.map((entry) => ({
            kind: 'service-override',
            artifactPath: OWN_MANIFEST_PATH,
            artifactId: entry.id,
            pin: entry.pin
        })),
        ...removed.entries.map((entry) => ({ kind: 'removed', artifactPath: REMOVED_PATH, artifactId: entry.id, pin: entry.pin }))
    ].sort((left, right) => compareText(`${left.artifactPath}\0${left.artifactId}`, `${right.artifactPath}\0${right.artifactId}`));
    return { patches, artifacts, resources: [...resources].sort((a, b) => compareText(a.source, b.source)), validated };
}
export function classifyCycleResources(treeDir, oldPin, newPin, resources, renamed) {
    const renamedByNew = new Map([...renamed.values()].map((rename) => [rename.to, rename]));
    return resources
        .map((entry) => {
        if (!targetExists(treeDir, oldPin, entry.target)) {
            const reverseRename = renamedByNew.get(entry.target);
            if (reverseRename === undefined ||
                !targetExists(treeDir, oldPin, reverseRename.from) ||
                !targetExists(treeDir, newPin, reverseRename.to)) {
                throw broken(`${entry.source}: resource target ${entry.target} is absent at metadata pin ${entry.pin}`);
            }
        }
        const rename = renamed.get(entry.target);
        if (rename !== undefined) {
            return {
                kind: 'resource',
                layer: 'resource-file',
                artifactPath: entry.source,
                artifactId: entry.id,
                targetPath: rename.to,
                outcome: 'target-renamed'
            };
        }
        const exists = targetExists(treeDir, newPin, entry.target);
        return {
            kind: 'resource',
            layer: 'resource-file',
            artifactPath: entry.source,
            artifactId: entry.id,
            targetPath: entry.target,
            outcome: exists ? 'clean' : 'target-deleted'
        };
    })
        .sort((left, right) => compareText(left.artifactPath, right.artifactPath));
}
function targetExists(treeDir, ref, target) {
    const listed = runGit({ args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', target], cwd: treeDir });
    if (listed.status !== 0 || (listed.stdout !== '' && !listed.stdout.endsWith('\0'))) {
        throw broken(`cannot inspect resource target ${target} at ${ref}`);
    }
    if (listed.stdout === '')
        return false;
    const records = listed.stdout.split('\0').filter(Boolean);
    if (records.length !== 1 ||
        !/^(100644|100755) blob [0-9a-f]{40}\t/.test(records[0] ?? '') ||
        !(records[0] ?? '').endsWith(`\t${target}`)) {
        throw broken(`resource target ${target} is not one regular blob at ${ref}`);
    }
    return true;
}
function artifactFiles(patchesDir, directory, suffix) {
    const absoluteDirectory = join(patchesDir, ...directory.split('/'));
    let stat;
    try {
        stat = lstatSync(absoluteDirectory);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return [];
        throw broken(`cannot inspect ${directory}: ${messageOf(error)}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw broken(`${directory} is not a real directory`);
    let names;
    try {
        names = readdirSync(absoluteDirectory);
    }
    catch (error) {
        throw broken(`cannot read ${directory}: ${messageOf(error)}`);
    }
    return names
        .filter((name) => name.endsWith(suffix))
        .sort(compareText)
        .map((name) => {
        const absolute = join(absoluteDirectory, name);
        const artifactPath = `${directory}/${name}`;
        strictAbsoluteFile(absolute, artifactPath);
        return { absolute, artifactPath, name };
    });
}
function readOptionalJson(patchesDir, relative, runtime) {
    const absolute = join(patchesDir, ...relative.split('/'));
    let fd;
    try {
        fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return null;
        throw broken(`cannot open ${relative}: ${messageOf(error)}`);
    }
    try {
        const opened = fstatSync(fd);
        if (!opened.isFile())
            throw broken(`${relative} is not a real file`);
        runtime.afterOptionalOpen?.(relative);
        const text = readFileSync(fd, 'utf8');
        let current;
        try {
            current = lstatSync(absolute);
        }
        catch (error) {
            throw broken(`${relative} disappeared while its mandatory bytes were being read: ${messageOf(error)}`);
        }
        if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
            throw broken(`${relative} changed identity while its mandatory bytes were being read`);
        }
        try {
            return JSON.parse(text);
        }
        catch (error) {
            throw broken(`${relative} is not valid JSON: ${messageOf(error)}`);
        }
    }
    finally {
        closeSync(fd);
    }
}
function strictAbsoluteFile(absolute, label) {
    try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink() || !stat.isFile())
            throw broken(`${label} is not a real file`);
    }
    catch (error) {
        if (isCycleBroken(error))
            throw error;
        throw broken(`cannot inspect ${label}: ${messageOf(error)}`);
    }
}
function readArtifact(absolute, artifactPath) {
    try {
        return readFileSync(absolute);
    }
    catch (error) {
        throw broken(`cannot read ${artifactPath}: ${messageOf(error)}`);
    }
}
function classificationPath(artifact) {
    return artifact.kind === 'patch'
        ? artifact.artifactPath
        : artifact.kind === 'rule'
            ? artifact.rule.artifactPath
            : artifact.overlay.artifactPath;
}
function compareText(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function duplicate(values) {
    const seen = new Set();
    for (const value of values) {
        if (seen.has(value))
            return value;
        seen.add(value);
    }
    return null;
}
function broken(reason) {
    return ckError('ARTIFACT-BROKEN', `cannot classify cycle apply: ${reason}`, 'repair the complete cycle inventory or restart the cycle before retrying');
}
function isCycleBroken(error) {
    return isCkError(error) && error.code === 'ARTIFACT-BROKEN';
}
function errorCode(error) {
    return error.code;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
