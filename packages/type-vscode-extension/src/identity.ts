/** @scope spec://codkit/modules/vscode-extension/PROP-002#VSX-PIN-TAGS */
// Area 1: what a pin of this family looks like, and what proves that a
// directory really is a tree of it.
//
// A pin is an ordinary release tag, with or without the `v`, and a repository
// with another release train declares its own pattern (##VSX-PIN-TAGS). What
// proves the tree is the one file every extension has: the manifest of the
// extension root, with the name, the publisher, the engine range the host
// refuses to load an extension without, and at least one of the three keys
// that make it an extension at all (##VSX-TREE-FINGERPRINT). A monorepo adds
// the root manifest, which must declare the workspaces the install covers, and
// the root manifest's `packageManager` field must name the manager the patch set
// declares, because an install with the wrong manager rewrites the lockfile
// (##VSX-PACKAGE-MANAGER-FINGERPRINT).

import type { FingerprintFiles, IdentityArea, Refusal, TreeFingerprint } from '@codkit/type-api';
import type { PackageManager, VsxTypeConfig } from './configSchema.ts';
import { treePath } from './layout.ts';
import { isJsonObject, nonEmptyString, objectField, readJsonObject } from './manifest.ts';
import type { JsonObject } from './manifest.ts';

/** ##VSX-PIN-TAGS: `v<major>.<minor>.<patch>`, or the same without the `v`. */
export const DEFAULT_TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;

/** The manifest of the tree root; the extension manifest too when the extension root is `.`. */
export const ROOT_MANIFEST_PATH = 'package.json';

/** ##VSX-TREE-FINGERPRINT: one of these keys makes a manifest an extension's. */
export const EXTENSION_KEYS: readonly string[] = ['main', 'browser', 'contributes'];

/** `<extensionRoot>/package.json`, from the tree root. */
export function manifestPathOf(extensionRoot: string): string {
	return treePath(extensionRoot, 'package.json');
}

/** The declared manager, npm by default (PROP-004 ##VSX-PACKAGE-MANAGER). */
export function packageManagerOf(config: VsxTypeConfig): PackageManager {
	return config.packageManager ?? 'npm';
}

/** ##VSX-PIN-TAGS: the family's pattern, or the one the patch set declared. */
export function tagPatternOf(config: VsxTypeConfig): RegExp {
	return config.tagPattern === undefined ? DEFAULT_TAG_PATTERN : new RegExp(config.tagPattern);
}

export function tagShapeOf(config: VsxTypeConfig): string {
	if (config.tagPattern !== undefined) {
		return `a tag matching the pattern ${config.tagPattern} declared in typeConfig.tagPattern`;
	}
	return 'v<major>.<minor>.<patch> or <major>.<minor>.<patch> (a tag that moves - latest, nightly, a channel name - is not a pin)';
}

/**
 * ##VSX-TREE-FINGERPRINT: the extension manifest always; the root manifest too
 * for a monorepo, unless the two are one file. The package-manager check lives
 * with whichever fingerprint is the root manifest, since the field it reads is
 * the root's (##VSX-PACKAGE-MANAGER-FINGERPRINT).
 */
export function fingerprintsOf(config: VsxTypeConfig): readonly TreeFingerprint[] {
	const manifestPath = manifestPathOf(config.extensionRoot);
	const manager = packageManagerOf(config);
	const manifestIsRoot = manifestPath === ROOT_MANIFEST_PATH;
	const extensionManifest: TreeFingerprint = {
		path: manifestPath,
		kind: 'file',
		why: 'the manifest of an extension is the one file every extension has, and the host refuses to load one without its engine range',
		contentProblem: (files) =>
			extensionManifestProblem(files, manifestPath) ?? (manifestIsRoot ? packageManagerProblem(files, manager) : null)
	};
	if (config.monorepo !== true || manifestIsRoot) {
		return [extensionManifest];
	}
	return [
		extensionManifest,
		{
			path: ROOT_MANIFEST_PATH,
			kind: 'file',
			why: 'the extension is one workspace package of this repository, and a package the root manifest does not list as a workspace member is not installed by the root install',
			contentProblem: (files) => rootManifestProblem(files) ?? packageManagerProblem(files, manager)
		}
	];
}

export function makeIdentity(config: VsxTypeConfig): IdentityArea {
	return {
		tagPattern: tagPatternOf(config),
		tagShape: tagShapeOf(config),
		fingerprints: fingerprintsOf(config)
	};
}

/** ##VSX-TREE-FINGERPRINT: what the extension manifest has to say. */
export function extensionManifestProblem(files: FingerprintFiles, path: string): Refusal {
	const manifest = readJsonObject(files, path);
	if (manifest === null) {
		return 'cannot be read as a JSON object';
	}
	if (nonEmptyString(manifest['name']) === null) {
		return 'carries no name, and an extension is published under one';
	}
	if (nonEmptyString(manifest['publisher']) === null) {
		return 'carries no publisher, and the identifier of an extension is <publisher>.<name>';
	}
	if (nonEmptyString(objectField(manifest, 'engines')?.['vscode']) === null) {
		return 'carries no engines.vscode range, and the host refuses to load an extension without one';
	}
	if (!EXTENSION_KEYS.some((key) => manifest[key] !== undefined)) {
		return `carries none of ${EXTENSION_KEYS.join(', ')}, so it is a package and not an extension`;
	}
	return null;
}

/** ##VSX-TREE-FINGERPRINT: the root of a monorepo declares its workspaces. */
export function rootManifestProblem(files: FingerprintFiles): Refusal {
	const manifest = readJsonObject(files, ROOT_MANIFEST_PATH);
	if (manifest === null) {
		return 'cannot be read as a JSON object';
	}
	const workspaces = manifest['workspaces'];
	if (!Array.isArray(workspaces) && !isJsonObject(workspaces)) {
		return 'declares no workspaces, so the extension is not a workspace member and the root install does not install it';
	}
	return null;
}

/**
 * ##VSX-PACKAGE-MANAGER-FINGERPRINT: `packageManager` is `<name>@<version>`, a
 * field npm, pnpm, yarn and bun all honour; its name must be the declared
 * manager. A root manifest without the field proves nothing.
 */
export function packageManagerProblem(files: FingerprintFiles, declared: PackageManager): Refusal {
	const manifest = readJsonObject(files, ROOT_MANIFEST_PATH);
	const field = nonEmptyString(manifest?.['packageManager']);
	if (manifest === null || field === null) {
		return null;
	}
	const name = packageManagerName(field);
	if (name !== declared) {
		return `declares the package manager ${name} while typeConfig.packageManager declares ${declared}: an install with the wrong manager rewrites the lockfile of the tree`;
	}
	return null;
}

/** The name half of `<name>@<version>`; the whole field when it carries no version. */
export function packageManagerName(field: string): string {
	const at = field.indexOf('@', 1);
	return at === -1 ? field : field.slice(0, at);
}

/** The object the root manifest is, for a suite that reads it the way the checks do. */
export function rootManifestOf(files: FingerprintFiles): JsonObject | null {
	return readJsonObject(files, ROOT_MANIFEST_PATH);
}
