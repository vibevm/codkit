/** @scope spec://codkit/modules/vscode/PROP-002#OWN-EXTENSION-UNIT */
import { materializerOf, ownExtensionFiles } from './layers/ownExtensions.ts';
import { loadOwnManifest } from './layers/ownManifest.ts';
import { fileContentEqual } from './ownCopy.ts';
import { resolveContainedPath } from './pathSafety.ts';
import type { ProjectType } from '@codkit/type-api';

/**
 * Tree paths of the declared extension files whose tree copy is byte-identical
 * to its delta source: exactly what `load` delivered and nothing a hand or a
 * build changed since. An edited, absent or undeclared path is never listed.
 */
export function deliveredExtensionTargets(patchesDir: string, treeDir: string, type: ProjectType): readonly string[] {
	const materializer = materializerOf(type);
	if (materializer === null) return [];
	return ownExtensionFiles(materializer, patchesDir, loadOwnManifest(patchesDir).extensions)
		.filter((file) => {
			const target = resolveContainedPath(treeDir, file.target);
			return target.ok && fileContentEqual(file.source, target.absolute);
		})
		.map((file) => file.target);
}

/** Only exact declared deliveries are runtime copies; edits and extra files remain dirt. */
export function withoutDeliveredExtensionDirt<T extends { readonly status: string; readonly path: string }>(
	entries: readonly T[],
	patchesDir: string,
	treeDir: string,
	type: ProjectType
): readonly T[] {
	const delivered = new Set(deliveredExtensionTargets(patchesDir, treeDir, type));
	return entries.filter((entry) => entry.status !== '??' || !delivered.has(entry.path));
}
