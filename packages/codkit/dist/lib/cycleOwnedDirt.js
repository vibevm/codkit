/** @scope spec://codkit/modules/vscode/PROP-002#OWN-EXTENSION-UNIT */
import { materializerOf, ownExtensionFiles } from './layers/ownExtensions.js';
import { loadOwnManifest } from './layers/ownManifest.js';
import { fileContentEqual } from './ownCopy.js';
import { resolveContainedPath } from './pathSafety.js';
/** Only exact declared deliveries are runtime copies; edits and extra files remain dirt. */
export function withoutDeliveredExtensionDirt(entries, patchesDir, treeDir, type) {
    const materializer = materializerOf(type);
    if (materializer === null)
        return entries;
    const delivered = new Set(ownExtensionFiles(materializer, patchesDir, loadOwnManifest(patchesDir).extensions)
        .filter((file) => {
        const target = resolveContainedPath(treeDir, file.target);
        return target.ok && fileContentEqual(file.source, target.absolute);
    })
        .map((file) => file.target));
    return entries.filter((entry) => entry.status !== '??' || !delivered.has(entry.path));
}
