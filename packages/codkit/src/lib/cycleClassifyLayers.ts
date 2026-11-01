/** @scope spec://codkit/modules/codkit/PROP-005#root */
// Strict inventory loading for cycle classification. Optional layer documents
// may be absent, but anything present must be a real readable file; no loader
// is allowed to turn an I/O failure into an empty layer at this boundary.

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ClassificationArtifact, ClassificationOutcome } from './classifyEngine.ts';
import { loadConventions } from './conventionsFile.ts';
import { runGit } from './gitx.ts';
import { OVERLAYS_DIR, OVERLAY_FILE_SUFFIX, parseOverlayFile } from './layers/overlay.ts';
import { OWN_MANIFEST_PATH, parseOwnManifest } from './layers/ownManifest.ts';
import { REMOVED_PATH, parseRemoved } from './layers/removed.ts';
import { RESOURCE_FILES_PREFIX, RESOURCE_MAP_PATH, parseResourceMap, resourceSourcePath } from './layers/resource.ts';
import type { ResourceEntry } from './layers/resource.ts';
import { RULES_DIR, RULE_FILE_SUFFIX, parseRuleFile } from './layers/rule.ts';
import { ckError, isCkError } from './messages.ts';
import { encodePatchName, parseCkpatch, PATCH_FILE_SUFFIX } from './patchFormat.ts';
import type { ParsedPatch } from './patchFormat.ts';
import type { UpstreamRename } from './renames.ts';
import { PATCHES_DIR } from './syncEngine.ts';
import type { ProjectType } from '@codkit/type-api';

export type LoadedCyclePatch = { readonly artifactPath: string; readonly patch: ParsedPatch };

export type ValidatedCycleRecord = {
	readonly kind: 'own' | 'own-extension' | 'service-override' | 'removed';
	readonly artifactPath: string;
	readonly artifactId: string;
	readonly pin: string;
};

export type ResourceCycleClassification = {
	readonly kind: 'resource';
	readonly layer: 'resource-file';
	readonly artifactPath: string;
	readonly artifactId: string;
	readonly targetPath: string;
	readonly outcome: Extract<ClassificationOutcome, 'clean' | 'target-deleted' | 'target-renamed'>;
};

export type LoadedCycleInventory = {
	readonly patches: readonly LoadedCyclePatch[];
	readonly artifacts: readonly ClassificationArtifact[];
	readonly resources: readonly ResourceEntry[];
	readonly validated: readonly ValidatedCycleRecord[];
};

export type CycleLayerReadRuntime = { readonly afterOptionalOpen?: (path: string) => void };

export function loadCycleClassificationInventory(
	patchesDir: string,
	type: ProjectType,
	expectedPin: string,
	runtime: CycleLayerReadRuntime = {}
): LoadedCycleInventory {
	const patchFiles = artifactFiles(patchesDir, PATCHES_DIR, PATCH_FILE_SUFFIX);
	const conventions = patchFiles.length === 0 ? null : loadConventions(type, patchesDir);
	const patches = patchFiles.map(({ absolute, artifactPath, name }) => {
		if (conventions === null) throw broken('patch conventions disappeared while loading inventory');
		const patch = parseCkpatch(readArtifact(absolute, artifactPath), conventions, artifactPath);
		const expectedName = encodePatchName(patch.targetPath);
		if (name !== expectedName) throw broken(`${artifactPath}: file name must be ${expectedName}`);
		return { artifactPath, patch };
	});
	const rules = artifactFiles(patchesDir, RULES_DIR, RULE_FILE_SUFFIX).map(({ absolute, artifactPath }) =>
		parseRuleFile(absolute, artifactPath)
	);
	const overlays = artifactFiles(patchesDir, OVERLAYS_DIR, OVERLAY_FILE_SUFFIX).map(({ absolute, artifactPath }) =>
		parseOverlayFile(absolute, artifactPath)
	);
	const resourceRaw = readOptionalJson(patchesDir, RESOURCE_MAP_PATH, runtime);
	const ownRaw = readOptionalJson(patchesDir, OWN_MANIFEST_PATH, runtime);
	const removedRaw = readOptionalJson(patchesDir, REMOVED_PATH, runtime);
	const resources = resourceRaw === null ? [] : parseResourceMap(resourceRaw).entries;
	for (const entry of resources) {
		if (!entry.source.startsWith(RESOURCE_FILES_PREFIX)) throw broken(`${entry.id}: source ${entry.source} is outside resource files`);
	}
	for (const entry of resources) strictAbsoluteFile(resourceSourcePath(patchesDir, entry), entry.source);
	const duplicateResource = duplicate(resources.map((entry) => entry.source));
	if (duplicateResource !== null) throw broken(`resource source occurs more than once: ${duplicateResource}`);
	const own = ownRaw === null ? { units: [], serviceOverrides: [], extensions: [] } : parseOwnManifest(ownRaw);
	const removed = removedRaw === null ? { entries: [] } : parseRemoved(removedRaw);
	for (const [path, pin] of [
		...patches.map((artifact) => [artifact.artifactPath, artifact.patch.header.pin] as const),
		...rules.map((rule) => [rule.artifactPath, rule.pin] as const),
		...overlays.map((overlay) => [overlay.artifactPath, overlay.pin] as const),
		...resources.map((entry) => [entry.source, entry.pin] as const),
		...own.units.map((unit) => [`${OWN_MANIFEST_PATH}#${unit.id}`, unit.pin] as const),
		...own.serviceOverrides.map((entry) => [`${OWN_MANIFEST_PATH}#${entry.id}`, entry.pin] as const),
		...own.extensions.map((entry) => [`${OWN_MANIFEST_PATH}#${entry.id}`, entry.pin] as const),
		...removed.entries.map((entry) => [`${REMOVED_PATH}#${entry.id}`, entry.pin] as const)
	]) {
		if (pin !== expectedPin) throw broken(`${path}: metadata pin ${pin} does not match cycle source ${expectedPin}`);
	}
	const artifacts: ClassificationArtifact[] = [
		...patches.map((artifact) => ({ kind: 'patch' as const, ...artifact })),
		...rules.map((rule) => ({ kind: 'rule' as const, rule })),
		...overlays.map((overlay) => ({ kind: 'overlay' as const, overlay }))
	];
	artifacts.sort((left, right) => compareText(classificationPath(left), classificationPath(right)));
	const validated: ValidatedCycleRecord[] = [
		...own.units.map((unit) => ({ kind: 'own' as const, artifactPath: OWN_MANIFEST_PATH, artifactId: unit.id, pin: unit.pin })),
		...own.serviceOverrides.map((entry) => ({
			kind: 'service-override' as const,
			artifactPath: OWN_MANIFEST_PATH,
			artifactId: entry.id,
			pin: entry.pin
		})),
		// A declared own extension carries a pin like a unit (modules/vscode/PROP-002
		// ##OWN-EXTENSION-UNIT): validated here, rebound by the regeneration.
		...own.extensions.map((entry) => ({
			kind: 'own-extension' as const,
			artifactPath: OWN_MANIFEST_PATH,
			artifactId: entry.id,
			pin: entry.pin
		})),
		...removed.entries.map((entry) => ({ kind: 'removed' as const, artifactPath: REMOVED_PATH, artifactId: entry.id, pin: entry.pin }))
	].sort((left, right) => compareText(`${left.artifactPath}\0${left.artifactId}`, `${right.artifactPath}\0${right.artifactId}`));
	return { patches, artifacts, resources: [...resources].sort((a, b) => compareText(a.source, b.source)), validated };
}

export function classifyCycleResources(
	treeDir: string,
	oldPin: string,
	newPin: string,
	resources: readonly ResourceEntry[],
	renamed: ReadonlyMap<string, UpstreamRename>
): readonly ResourceCycleClassification[] {
	const renamedByNew = new Map([...renamed.values()].map((rename) => [rename.to, rename]));
	return resources
		.map((entry): ResourceCycleClassification => {
			if (!targetExists(treeDir, oldPin, entry.target)) {
				const reverseRename = renamedByNew.get(entry.target);
				if (
					reverseRename === undefined ||
					!targetExists(treeDir, oldPin, reverseRename.from) ||
					!targetExists(treeDir, newPin, reverseRename.to)
				) {
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

/** A clean resource entry whose target the upstream changed between the two pins. */
export type ResourceUpstreamChange = {
	readonly artifactPath: string;
	readonly artifactId: string;
	readonly targetPath: string;
	readonly oldObject: string;
	readonly newObject: string;
	/** Lines added and removed between the pins; null for a binary target. */
	readonly insertions: number | null;
	readonly deletions: number | null;
};

/**
 * The clean resource entries whose target the upstream changed between the
 * pins (PROP-005 ##RESOURCE-UPSTREAM-CHANGE): the copy replaces the target
 * whatever it holds, so the outcome stays `clean` and the cycle names the
 * change, so the copy can take over what matters in it.
 */
export function resourceUpstreamChanges(
	treeDir: string,
	oldPin: string,
	newPin: string,
	classifications: readonly ResourceCycleClassification[]
): readonly ResourceUpstreamChange[] {
	return classifications.flatMap((item): readonly ResourceUpstreamChange[] => {
		if (item.outcome !== 'clean') return [];
		const oldObject = blobObject(treeDir, oldPin, item.targetPath);
		const newObject = blobObject(treeDir, newPin, item.targetPath);
		if (oldObject === null || newObject === null || oldObject === newObject) return [];
		const stat = runGit({ args: ['diff', '--numstat', '-z', oldPin, newPin, '--', item.targetPath], cwd: treeDir });
		if (stat.status !== 0) throw broken(`${item.artifactPath}: cannot diff ${item.targetPath} between the pins`);
		const fields = stat.stdout.split('\t');
		const count = (field: string | undefined): number | null => (field === undefined || field === '-' ? null : Number.parseInt(field, 10));
		return [
			{
				artifactPath: item.artifactPath,
				artifactId: item.artifactId,
				targetPath: item.targetPath,
				oldObject,
				newObject,
				insertions: count(fields[0]),
				deletions: count(fields[1])
			}
		];
	});
}

/** The blob of a regular file at a ref; null when the path is absent or not a blob there. */
function blobObject(treeDir: string, ref: string, target: string): string | null {
	const listed = runGit({ args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', target], cwd: treeDir });
	if (listed.status !== 0) throw broken(`cannot inspect ${target} at ${ref}`);
	const record = listed.stdout.split('\0').find((line) => line !== '');
	const match = record === undefined ? null : /^\d{6} blob ([0-9a-f]{40,64})\t/.exec(record);
	return match?.[1] ?? null;
}

function targetExists(treeDir: string, ref: string, target: string): boolean {
	const listed = runGit({ args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', target], cwd: treeDir });
	if (listed.status !== 0 || (listed.stdout !== '' && !listed.stdout.endsWith('\0'))) {
		throw broken(`cannot inspect resource target ${target} at ${ref}`);
	}
	if (listed.stdout === '') return false;
	const records = listed.stdout.split('\0').filter(Boolean);
	if (
		records.length !== 1 ||
		!/^(100644|100755) blob [0-9a-f]{40}\t/.test(records[0] ?? '') ||
		!(records[0] ?? '').endsWith(`\t${target}`)
	) {
		throw broken(`resource target ${target} is not one regular blob at ${ref}`);
	}
	return true;
}

type ArtifactFile = { readonly absolute: string; readonly artifactPath: string; readonly name: string };

function artifactFiles(patchesDir: string, directory: string, suffix: string): readonly ArtifactFile[] {
	const absoluteDirectory = join(patchesDir, ...directory.split('/'));
	let stat;
	try {
		stat = lstatSync(absoluteDirectory);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return [];
		throw broken(`cannot inspect ${directory}: ${messageOf(error)}`);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw broken(`${directory} is not a real directory`);
	let names: string[];
	try {
		names = readdirSync(absoluteDirectory);
	} catch (error) {
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

function readOptionalJson(patchesDir: string, relative: string, runtime: CycleLayerReadRuntime): unknown | null {
	const absolute = join(patchesDir, ...relative.split('/'));
	let fd: number;
	try {
		fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return null;
		throw broken(`cannot open ${relative}: ${messageOf(error)}`);
	}
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile()) throw broken(`${relative} is not a real file`);
		runtime.afterOptionalOpen?.(relative);
		const text = readFileSync(fd, 'utf8');
		let current;
		try {
			current = lstatSync(absolute);
		} catch (error) {
			throw broken(`${relative} disappeared while its mandatory bytes were being read: ${messageOf(error)}`);
		}
		if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
			throw broken(`${relative} changed identity while its mandatory bytes were being read`);
		}
		try {
			return JSON.parse(text);
		} catch (error) {
			throw broken(`${relative} is not valid JSON: ${messageOf(error)}`);
		}
	} finally {
		closeSync(fd);
	}
}

function strictAbsoluteFile(absolute: string, label: string): void {
	try {
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink() || !stat.isFile()) throw broken(`${label} is not a real file`);
	} catch (error) {
		if (isCycleBroken(error)) throw error;
		throw broken(`cannot inspect ${label}: ${messageOf(error)}`);
	}
}

function readArtifact(absolute: string, artifactPath: string): Uint8Array {
	try {
		return readFileSync(absolute);
	} catch (error) {
		throw broken(`cannot read ${artifactPath}: ${messageOf(error)}`);
	}
}

function classificationPath(artifact: ClassificationArtifact): string {
	return artifact.kind === 'patch'
		? artifact.artifactPath
		: artifact.kind === 'rule'
			? artifact.rule.artifactPath
			: artifact.overlay.artifactPath;
}

function compareText(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

function duplicate(values: readonly string[]): string | null {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) return value;
		seen.add(value);
	}
	return null;
}

function broken(reason: string): Error {
	return ckError(
		'ARTIFACT-BROKEN',
		`cannot classify cycle apply: ${reason}`,
		'repair the complete cycle inventory or restart the cycle before retrying'
	);
}

function isCycleBroken(error: unknown): boolean {
	return isCkError(error) && error.code === 'ARTIFACT-BROKEN';
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
