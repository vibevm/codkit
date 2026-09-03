/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// Pin/cause rewrites for the non-patch layers of cycle regeneration.

import { bytesEqual, encodeUtf8 } from './bytes.ts';
import type { CycleApplyClassification, CycleClassificationCause } from './cycleClassify.ts';
import type { CycleRegenerationAction } from './cycleRegenerate.ts';
import { serializeOverlay } from './layers/overlay.ts';
import type { Overlay } from './layers/overlay.ts';
import { OWN_MANIFEST_PATH, serializeOwnManifest } from './layers/ownManifest.ts';
import type { OwnUnit, ServiceOverride } from './layers/ownManifest.ts';
import { REMOVED_PATH, serializeRemoved } from './layers/removed.ts';
import type { RemovedEntry } from './layers/removed.ts';
import { RESOURCE_MAP_PATH, serializeResourceMap } from './layers/resource.ts';
import type { ResourceEntry } from './layers/resource.ts';
import { serializeRule } from './layers/rule.ts';
import type { Rule } from './layers/rule.ts';
import { ckError } from './messages.ts';

export type CycleMetadataInventory = {
	readonly rules: ReadonlyMap<string, Rule>;
	readonly overlays: ReadonlyMap<string, Overlay>;
	readonly resources: readonly ResourceEntry[];
	readonly own: { readonly units: readonly OwnUnit[]; readonly serviceOverrides: readonly ServiceOverride[] } | null;
	readonly removed: readonly RemovedEntry[] | null;
};

export function updateCycleMetadata(options: {
	readonly inventory: CycleMetadataInventory;
	readonly classifications: ReadonlyMap<string, CycleApplyClassification>;
	readonly causes: ReadonlyMap<string, CycleClassificationCause['cause']>;
	readonly sourcePin: string;
	readonly targetPin: string;
	readonly desired: Map<string, Uint8Array>;
	readonly actions: CycleRegenerationAction[];
}): void {
	updateRules(options);
	updateOverlays(options);
	updateResources(options);
	updateOwn(options);
	updateRemoved(options);
}

type UpdateOptions = Parameters<typeof updateCycleMetadata>[0];

function updateRules(options: UpdateOptions): void {
	for (const [path, rule] of options.inventory.rules) {
		const item = options.classifications.get(path);
		if (item?.kind !== 'rule') throw broken(`${path}: missing rule classification`);
		assertIdentity(item, rule.id, rule.target);
		const cause = options.causes.get(causeKey(path, rule.id)) ?? null;
		if (item.outcome !== 'clean') {
			assertPin(rule.pin, options.sourcePin, path);
			options.actions.push(action(item, 'untouched', cause));
			continue;
		}
		assertTransitionPin(rule.pin, options.sourcePin, options.targetPin, path);
		setJson(
			options,
			path,
			serializeRule({ ...withoutPath(rule), pin: options.targetPin, cause: cause?.sha ?? rule.cause }),
			action(item, 'write', cause)
		);
	}
}

function updateOverlays(options: UpdateOptions): void {
	for (const [path, overlay] of options.inventory.overlays) {
		const item = options.classifications.get(path);
		if (item?.kind !== 'overlay') throw broken(`${path}: missing overlay classification`);
		assertIdentity(item, overlay.id, overlay.target);
		const cause = options.causes.get(causeKey(path, overlay.id)) ?? null;
		if (item.outcome !== 'clean') {
			assertPin(overlay.pin, options.sourcePin, path);
			options.actions.push(action(item, 'untouched', cause));
			continue;
		}
		assertTransitionPin(overlay.pin, options.sourcePin, options.targetPin, path);
		setJson(
			options,
			path,
			serializeOverlay({ ...withoutPath(overlay), pin: options.targetPin, cause: cause?.sha ?? overlay.cause }),
			action(item, 'write', cause)
		);
	}
}

function updateResources(options: UpdateOptions): void {
	if (options.inventory.resources.length === 0) return;
	let changed = false;
	const entries = options.inventory.resources.map((entry) => {
		const item = options.classifications.get(entry.source);
		if (item?.kind !== 'resource') throw broken(`${entry.source}: missing resource classification`);
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
	if (changed) options.desired.set(RESOURCE_MAP_PATH, encodeUtf8(serializeResourceMap({ entries })));
}

function updateOwn(options: UpdateOptions): void {
	if (options.inventory.own === null) return;
	let changed = false;
	const units = options.inventory.own.units.map((entry) => metadataEntry(entry, 'own'));
	const serviceOverrides = options.inventory.own.serviceOverrides.map((entry) => metadataEntry(entry, 'service-override'));
	if (changed) options.desired.set(OWN_MANIFEST_PATH, encodeUtf8(serializeOwnManifest({ units, serviceOverrides })));
	function metadataEntry<T extends OwnUnit | ServiceOverride>(entry: T, kind: 'own' | 'service-override'): T {
		assertTransitionPin(entry.pin, options.sourcePin, options.targetPin, `${OWN_MANIFEST_PATH}#${entry.id}`);
		const cause = options.causes.get(causeKey(OWN_MANIFEST_PATH, entry.id)) ?? null;
		const next = { ...entry, pin: options.targetPin, cause: cause?.sha ?? entry.cause };
		const didChange = JSON.stringify(next) !== JSON.stringify(entry);
		changed ||= didChange;
		options.actions.push({ artifactPath: OWN_MANIFEST_PATH, artifactId: entry.id, kind, action: didChange ? 'write' : 'noop', cause });
		return next;
	}
}

function updateRemoved(options: UpdateOptions): void {
	if (options.inventory.removed === null) return;
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
	if (changed) options.desired.set(REMOVED_PATH, encodeUtf8(serializeRemoved({ entries })));
}

function setJson(options: UpdateOptions, path: string, document: string, changed: CycleRegenerationAction): void {
	const bytes = encodeUtf8(document);
	const current = options.desired.get(path);
	if (current === undefined) throw broken(`${path}: desired bytes disappeared`);
	if (bytesEqual(current, bytes)) options.actions.push({ ...changed, action: 'noop' });
	else {
		options.desired.set(path, bytes);
		options.actions.push(changed);
	}
}

function action(
	item: CycleApplyClassification,
	kind: CycleRegenerationAction['action'],
	cause: CycleRegenerationAction['cause']
): CycleRegenerationAction {
	return { artifactPath: item.artifactPath, artifactId: item.artifactId, kind: item.kind, action: kind, cause };
}
function assertIdentity(item: CycleApplyClassification, id: string, target: string): void {
	if (item.artifactId !== id || item.targetPath !== target) throw broken(`${item.artifactPath}: classification identity is stale`);
}
function assertPin(actual: string, expected: string, path: string): void {
	if (actual !== expected) throw broken(`${path}: metadata pin ${actual} does not match cycle source ${expected}`);
}
function assertTransitionPin(actual: string, source: string, target: string, path: string): void {
	if (actual !== source && actual !== target) throw broken(`${path}: metadata pin ${actual} matches neither cycle source nor target`);
}
function withoutPath<T extends { readonly artifactPath: string }>(value: T): Omit<T, 'artifactPath'> {
	const { artifactPath: _artifactPath, ...rest } = value;
	return rest;
}
function causeKey(path: string, id: string): string {
	return `${path}\0${id}`;
}
function broken(message: string): Error {
	return ckError('ARTIFACT-BROKEN', `cannot regenerate cycle: ${message}`, 'repair cycle inputs or resume the durable transaction');
}
