/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Pin/cause rewrites for the non-patch layers of cycle regeneration.
import { bytesEqual, encodeUtf8 } from './bytes.js';
import { serializeOverlay } from './layers/overlay.js';
import { OWN_MANIFEST_PATH, serializeOwnManifest } from './layers/ownManifest.js';
import { REMOVED_PATH, serializeRemoved } from './layers/removed.js';
import { RESOURCE_MAP_PATH, serializeResourceMap } from './layers/resource.js';
import { serializeRule } from './layers/rule.js';
import { ckError } from './messages.js';
export function updateCycleMetadata(options) {
    updateRules(options);
    updateOverlays(options);
    updateResources(options);
    updateOwn(options);
    updateRemoved(options);
}
function updateRules(options) {
    for (const [path, rule] of options.inventory.rules) {
        const item = options.classifications.get(path);
        if (item?.kind !== 'rule')
            throw broken(`${path}: missing rule classification`);
        assertIdentity(item, rule.id, rule.target);
        const cause = options.causes.get(causeKey(path, rule.id)) ?? null;
        if (item.outcome !== 'clean') {
            assertPin(rule.pin, options.sourcePin, path);
            options.actions.push(action(item, 'untouched', cause));
            continue;
        }
        assertTransitionPin(rule.pin, options.sourcePin, options.targetPin, path);
        setJson(options, path, serializeRule({ ...withoutPath(rule), pin: options.targetPin, cause: cause?.sha ?? rule.cause }), action(item, 'write', cause));
    }
}
function updateOverlays(options) {
    for (const [path, overlay] of options.inventory.overlays) {
        const item = options.classifications.get(path);
        if (item?.kind !== 'overlay')
            throw broken(`${path}: missing overlay classification`);
        assertIdentity(item, overlay.id, overlay.target);
        const cause = options.causes.get(causeKey(path, overlay.id)) ?? null;
        if (item.outcome !== 'clean') {
            assertPin(overlay.pin, options.sourcePin, path);
            options.actions.push(action(item, 'untouched', cause));
            continue;
        }
        assertTransitionPin(overlay.pin, options.sourcePin, options.targetPin, path);
        setJson(options, path, serializeOverlay({ ...withoutPath(overlay), pin: options.targetPin, cause: cause?.sha ?? overlay.cause }), action(item, 'write', cause));
    }
}
function updateResources(options) {
    if (options.inventory.resources.length === 0)
        return;
    let changed = false;
    const entries = options.inventory.resources.map((entry) => {
        const item = options.classifications.get(entry.source);
        if (item?.kind !== 'resource')
            throw broken(`${entry.source}: missing resource classification`);
        if (item.artifactId !== entry.id || (item.outcome === 'clean' && item.targetPath !== entry.target))
            throw broken(`${entry.source}: classification identity is stale`);
        const cause = options.causes.get(causeKey(entry.source, entry.id)) ?? null;
        if (item.outcome !== 'clean') {
            assertPin(entry.pin, options.sourcePin, entry.source);
            options.actions.push(action(item, 'untouched', cause));
            return entry;
        }
        assertTransitionPin(entry.pin, options.sourcePin, options.targetPin, entry.source);
        const next = { ...entry, pin: options.targetPin, cause: cause?.sha ?? entry.cause };
        const didChange = JSON.stringify(next) !== JSON.stringify(entry);
        changed ||= didChange;
        options.actions.push(action(item, didChange ? 'write' : 'noop', cause));
        return next;
    });
    if (changed)
        options.desired.set(RESOURCE_MAP_PATH, encodeUtf8(serializeResourceMap({ entries })));
}
function updateOwn(options) {
    if (options.inventory.own === null)
        return;
    let changed = false;
    const units = options.inventory.own.units.map((entry) => metadataEntry(entry, 'own'));
    const serviceOverrides = options.inventory.own.serviceOverrides.map((entry) => metadataEntry(entry, 'service-override'));
    // A declared own extension carries a pin like a unit and no cause
    // (modules/vscode/PROP-002 ##OWN-EXTENSION-UNIT): the pin moves to the target
    // with the rest of the manifest, every other byte of the record is kept.
    const extensions = options.inventory.own.extensions.map((entry) => {
        assertTransitionPin(entry.pin, options.sourcePin, options.targetPin, `${OWN_MANIFEST_PATH}#${entry.id}`);
        const next = { ...entry, pin: options.targetPin };
        const didChange = next.pin !== entry.pin;
        changed ||= didChange;
        options.actions.push({
            artifactPath: OWN_MANIFEST_PATH,
            artifactId: entry.id,
            kind: 'own-extension',
            action: didChange ? 'write' : 'noop',
            cause: null
        });
        return next;
    });
    if (changed)
        options.desired.set(OWN_MANIFEST_PATH, encodeUtf8(serializeOwnManifest({ units, serviceOverrides, extensions })));
    function metadataEntry(entry, kind) {
        assertTransitionPin(entry.pin, options.sourcePin, options.targetPin, `${OWN_MANIFEST_PATH}#${entry.id}`);
        const cause = options.causes.get(causeKey(OWN_MANIFEST_PATH, entry.id)) ?? null;
        const next = { ...entry, pin: options.targetPin, cause: cause?.sha ?? entry.cause };
        const didChange = JSON.stringify(next) !== JSON.stringify(entry);
        changed ||= didChange;
        options.actions.push({ artifactPath: OWN_MANIFEST_PATH, artifactId: entry.id, kind, action: didChange ? 'write' : 'noop', cause });
        return next;
    }
}
function updateRemoved(options) {
    if (options.inventory.removed === null)
        return;
    let changed = false;
    const entries = options.inventory.removed.map((entry) => {
        assertTransitionPin(entry.pin, options.sourcePin, options.targetPin, `${REMOVED_PATH}#${entry.id}`);
        const next = { ...entry, pin: options.targetPin };
        const didChange = next.pin !== entry.pin;
        changed ||= didChange;
        options.actions.push({
            artifactPath: REMOVED_PATH,
            artifactId: entry.id,
            kind: 'removed',
            action: didChange ? 'write' : 'noop',
            cause: null
        });
        return next;
    });
    if (changed)
        options.desired.set(REMOVED_PATH, encodeUtf8(serializeRemoved({ entries })));
}
function setJson(options, path, document, changed) {
    const bytes = encodeUtf8(document);
    const current = options.desired.get(path);
    if (current === undefined)
        throw broken(`${path}: desired bytes disappeared`);
    if (bytesEqual(current, bytes))
        options.actions.push({ ...changed, action: 'noop' });
    else {
        options.desired.set(path, bytes);
        options.actions.push(changed);
    }
}
function action(item, kind, cause) {
    return { artifactPath: item.artifactPath, artifactId: item.artifactId, kind: item.kind, action: kind, cause };
}
function assertIdentity(item, id, target) {
    if (item.artifactId !== id || item.targetPath !== target)
        throw broken(`${item.artifactPath}: classification identity is stale`);
}
function assertPin(actual, expected, path) {
    if (actual !== expected)
        throw broken(`${path}: metadata pin ${actual} does not match cycle source ${expected}`);
}
function assertTransitionPin(actual, source, target, path) {
    if (actual !== source && actual !== target)
        throw broken(`${path}: metadata pin ${actual} matches neither cycle source nor target`);
}
function withoutPath(value) {
    const { artifactPath: _artifactPath, ...rest } = value;
    return rest;
}
function causeKey(path, id) {
    return `${path}\0${id}`;
}
function broken(message) {
    return ckError('ARTIFACT-BROKEN', `cannot regenerate cycle: ${message}`, 'repair cycle inputs or resume the durable transaction');
}
