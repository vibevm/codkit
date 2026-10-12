/** @scope spec://codkit/modules/vscode/PROP-002#OWN-EXTENSION-UNIT */
import { materializerOf, ownExtensionFiles } from './layers/ownExtensions.ts';
import { loadOwnManifest } from './layers/ownManifest.ts';
import { fileContentEqual } from './ownCopy.ts';
import { resolveContainedPath } from './pathSafety.ts';
import type { ProjectType } from '@codkit/type-api';

/** Only exact declared deliveries are runtime copies; edits and extra files remain dirt. */
export function withoutDeliveredExtensionDirt<T extends { readonly status: string; readonly path: string }>(
	entries: readonly T[],
	patchesDir: string,
	treeDir: string,
	type: ProjectType
): readonly T[] {
	const materializer = materializerOf(type);
	if (materializer === null) return entries;
	const delivered = new Set(
		ownExtensionFiles(materializer, patchesDir, loadOwnManifest(patchesDir).extensions)
			.filter((file) => {
				const target = resolveContainedPath(treeDir, file.target);
				return target.ok && fileContentEqual(file.source, target.absolute);
			})
			.map((file) => file.target)
	);
	return entries.filter((entry) => entry.status !== '??' || !delivered.has(entry.path));
}
