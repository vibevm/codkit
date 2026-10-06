/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The generated-branch-only own-code atom. A local load deliberately keeps own
// code outside Git; CI and publish need the complete reproducible tree instead.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './gitx.ts';
import type { HistoryChange, HistoryCommit } from './gitHistory.ts';
import { materializerOf, ownExtensionFiles } from './layers/ownExtensions.ts';
import type { Materializer } from './layers/ownExtensions.ts';
import type { OwnExtensionFile } from './layers/ownExtensions.ts';
import { OWN_MANIFEST_PATH, loadOwnManifest } from './layers/ownManifest.ts';
import { ckError } from './messages.ts';
import { isDeliveredOwnFile, isReleasedOwnFile, listOwnFiles, ownSourceRoot } from './ownCopy.ts';
import { ownCodeFilter } from './ownedRoots.ts';
import type { OwnedRoot } from './ownedRoots.ts';
import type { ProjectType } from '@codkit/type-api';

export const GENERATED_HISTORY_FINGERPRINT_VERSION = 1;

export type GeneratedOwnOptions = {
	readonly patchesDir: string;
	/** The project type of the patch set; the own-extension layer comes from it. */
	readonly type: ProjectType;
	readonly existingPaths: ReadonlySet<string>;
	/** The owned directories, the own root first (PROP-016 ##TYPE-AREA-LAYOUT). */
	readonly roots: readonly OwnedRoot[];
	readonly pinTag: string;
	readonly pinSha: string;
	readonly patchSetCommit: string;
	/**
	 * Leave the codkit licence notice out of the snapshot: only `publish` sets
	 * it (PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION).
	 */
	readonly omitLicenceNotice?: boolean;
	/** Git source of modes when patchesDir is only a scratch file export. */
	readonly modeSource?: { readonly repositoryRoot: string; readonly ref: string };
};

export type GeneratedLayerTarget = {
	readonly layer: 'patch' | 'overlay' | 'resource';
	readonly target: string;
	readonly artifactPaths: readonly string[];
	readonly ids: readonly string[];
};

export type GeneratedOwnEvidence = {
	/** Exact branch-relative paths supplied only by the delivered own layer. */
	readonly ownTargets: readonly string[];
	/**
	 * ##OWN-EXTENSION-UNIT: the same, for a materialized own extension. Kept apart from
	 * `ownTargets` because the upgrade cycle's own preflight is written against
	 * the single own root and must keep judging exactly that root.
	 */
	readonly extensionTargets: readonly string[];
};

/**
 * Which own files the generated snapshot carries. A release branch leaves the
 * codkit licence notice out; every other generated branch carries it
 * (PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION).
 */
function ownPredicate(omitLicenceNotice: boolean): (relative: string) => boolean {
	return omitLicenceNotice ? isReleasedOwnFile : isDeliveredOwnFile;
}

/** Fail before object/ref/worktree mutation when two generated layers claim one target. */
export function assertGeneratedTargetOwnership(
	patchesDir: string,
	type: ProjectType,
	roots: readonly OwnedRoot[],
	layerTargets: readonly GeneratedLayerTarget[],
	omitLicenceNotice = false
): GeneratedOwnEvidence {
	const claims = new Map<string, { readonly layer: string; readonly artifact: string }>();
	const ownTargets: string[] = [];
	for (const owned of roots) {
		for (const relative of ownFilesOf(patchesDir, owned, omitLicenceNotice)) {
			const target = `${owned.path}/${relative}`;
			ownTargets.push(target);
			claims.set(target, { layer: 'own', artifact: `${owned.deltaDir}/${relative}` });
		}
	}
	const ids = new Map<string, string>();
	const manifest = loadOwnManifest(patchesDir);
	const materializer = materializerOf(type);
	const extensionFiles = materializer === null ? [] : ownExtensionFiles(materializer, patchesDir, manifest.extensions);
	for (const file of extensionFiles) {
		claims.set(file.target, { layer: 'own-extension', artifact: `${materializer?.deltaRoot ?? ''}/${file.relative}` });
	}
	for (const entry of [
		...manifest.units.map((unit) => ({ id: unit.id, label: `${OWN_MANIFEST_PATH} unit ${unit.id}` })),
		...manifest.serviceOverrides.map((override) => ({ id: override.id, label: `${OWN_MANIFEST_PATH} serviceOverride ${override.id}` })),
		...manifest.extensions.map((extension) => ({ id: extension.id, label: `${OWN_MANIFEST_PATH} extension ${extension.id}` }))
	]) {
		const previous = ids.get(entry.id);
		if (previous !== undefined) {
			throw ckError(
				'ARTIFACT-BROKEN',
				`generated artifact id ${entry.id} is claimed by both ${previous} and ${entry.label}`,
				'every generated artifact id must identify exactly one source',
				OWN_MANIFEST_PATH
			);
		}
		ids.set(entry.id, entry.label);
	}
	for (const artifact of layerTargets) {
		const label = artifact.artifactPaths.join(', ');
		for (const id of artifact.ids) {
			const previous = ids.get(id);
			if (previous !== undefined) {
				throw ckError(
					'ARTIFACT-BROKEN',
					`generated artifact id ${id} is claimed by both ${previous} and ${label}`,
					'every generated artifact id must identify exactly one source',
					artifact.artifactPaths[0]
				);
			}
			ids.set(id, label);
		}
		const previous = claims.get(artifact.target);
		if (previous !== undefined) {
			throw ckError(
				'ARTIFACT-BROKEN',
				`${artifact.target} is claimed by both the ${previous.layer} layer (${previous.artifact}) and ${artifact.layer} layer (${label})`,
				'one generated target must have exactly one source group; remove the overlapping artifact or own file',
				artifact.artifactPaths[0]
			);
		}
		claims.set(artifact.target, { layer: artifact.layer, artifact: label });
	}
	return { ownTargets, extensionTargets: extensionFiles.map((file) => file.target) };
}

/**
 * The delivered files of one owned directory. A build output inside it is not
 * own code and never reaches the generated snapshot: the branch carries what
 * the delta holds, and a build of the tree writes the rest (##TYPE-AREA-LAYOUT).
 */
function ownFilesOf(patchesDir: string, owned: OwnedRoot, omitLicenceNotice: boolean): readonly string[] {
	return listOwnFiles(ownSourceRoot(patchesDir, owned.deltaDir), { refuseSymlinks: true, keep: ownCodeFilter(owned) }).filter(
		ownPredicate(omitLicenceNotice)
	);
}

/** Keep full and local branch/cache variants distinct without changing schemas. */
export function generatedHistoryFingerprint(
	deltaFingerprint: string,
	patchesDir: string,
	type: ProjectType,
	roots: readonly OwnedRoot[],
	omitLicenceNotice = false,
	modeSource?: GeneratedOwnOptions['modeSource']
): string {
	const modes = fileModes(patchesDir, modeSource);
	const hash = createHash('sha256')
		.update(`codkit-generated-history\0${GENERATED_HISTORY_FINGERPRINT_VERSION}\0`, 'utf8')
		.update(deltaFingerprint, 'utf8');
	// The release snapshot and the ci snapshot must never share a fingerprint:
	// they hold different bytes (PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION).
	if (omitLicenceNotice) hash.update('\0omit-licence-notice\0', 'utf8');
	for (const owned of roots) {
		for (const relative of ownFilesOf(patchesDir, owned, omitLicenceNotice)) {
			hash.update(`\0${owned.deltaDir}/${relative}\0${modes.get(`${owned.deltaDir}/${relative}`) ?? '100644'}`, 'utf8');
		}
	}
	// ##OWN-EXTENSION-UNIT: the extensions are part of the snapshot, so a change
	// to one of them has to change the fingerprint the fast path compares.
	const deltaRoot = materializerOf(type)?.deltaRoot ?? '';
	for (const file of extensionSnapshot(materializerOf(type), patchesDir))
		hash.update(`\0${deltaRoot}/${file.relative}\0${modes.get(`${deltaRoot}/${file.relative}`) ?? '100644'}`, 'utf8');
	return hash.digest('hex');
}

/** The aggregate own atom, prepared without per-file Git processes. */
export function generatedOwnCommit(options: GeneratedOwnOptions): HistoryCommit | null {
	const first = options.roots[0];
	if (first === undefined) throw ckError('ARTIFACT-BROKEN', 'the generated own-code atom was asked for without a single owned directory');
	const snapshot = options.roots.map((owned) => ({
		owned,
		relatives: ownFilesOf(options.patchesDir, owned, options.omitLicenceNotice ?? false)
	}));
	const materializer = materializerOf(options.type);
	const extensions = extensionSnapshot(materializer, options.patchesDir);
	if (snapshot.every(({ relatives }) => relatives.length === 0) && extensions.length === 0) return null;
	const modes = fileModes(options.patchesDir, options.modeSource);
	const changes: HistoryChange[] = [];
	for (const owned of options.roots) {
		for (const path of options.existingPaths) {
			if (path.startsWith(`${owned.path}/`) && !owned.upstreamPaths.has(path.slice(owned.path.length + 1))) {
				changes.push({ path, remove: true });
			}
		}
	}
	for (const { owned, relatives } of snapshot) {
		const sourceRoot = ownSourceRoot(options.patchesDir, owned.deltaDir);
		for (const relative of relatives) {
			changes.push({
				path: `${owned.path}/${relative}`,
				mode: modes.get(`${owned.deltaDir}/${relative}`) ?? '100644',
				bytes: readFileSync(join(sourceRoot, ...relative.split('/')))
			});
		}
	}
	for (const file of extensions) {
		changes.push({
			path: file.target,
			mode: modes.get(`${materializer?.deltaRoot ?? ''}/${file.relative}`) ?? '100644',
			bytes: readFileSync(file.source)
		});
	}
	return { message: ownCommitMessage(first.path, options), changes };
}

/** The own-extension files of the delta, or none when the manifest is unusable. */
function extensionSnapshot(materializer: Materializer | null, patchesDir: string): readonly OwnExtensionFile[] {
	return materializer === null ? [] : ownExtensionFiles(materializer, patchesDir, loadOwnManifest(patchesDir).extensions);
}

/** Read every source mode once, also when the snapshot itself has no .git. */
function fileModes(patchesDir: string, modeSource?: GeneratedOwnOptions['modeSource']): ReadonlyMap<string, string> {
	const listed =
		modeSource === undefined
			? runGit({ args: ['ls-files', '--stage', '-z'], cwd: patchesDir })
			: runGit({ args: ['ls-tree', '-r', '-z', modeSource.ref], cwd: modeSource.repositoryRoot });
	const modes = new Map<string, string>();
	if (listed.status !== 0) return modes;
	for (const record of listed.stdout.split('\0')) {
		const tab = record.indexOf('\t');
		if (tab < 0) continue;
		const path = record.slice(tab + 1);
		if (!modes.has(path)) modes.set(path, record.startsWith('100755 ') ? '100755' : '100644');
	}
	return modes;
}

function ownCommitMessage(targetRoot: string, options: GeneratedOwnOptions): string {
	return [
		`codkit: own code ${targetRoot}`,
		'',
		`Codkit-Patchset-Commit: ${options.patchSetCommit}`,
		`Codkit-Upstream-Pin: ${options.pinTag}@${options.pinSha}`
	].join('\n');
}
