/** @scope spec://codkit/modules/vscode-extension/PROP-003#VSX-MANIFEST-OVERLAY */
// Area 3: the layers whose shape this family decides.
//
// The extension manifest is the product manifest and the first overlay target:
// the whole document is open, nothing is stamped by the packaging and there is
// no dev channel, because the host reads the manifest from the extension root
// and reads no sidecar instead (##VSX-MANIFEST-OVERLAY, ##VSX-NO-DEV-CHANNEL).
// The locale manifests the patch set names are targets of the same shape
// (##VSX-LOCALE-MANIFEST-OVERLAYS). The entry modules are the activation
// modules the patch set names - where an extension composes itself, and where
// a graft that imports own code belongs (##VSX-ENTRY-MODULE).
//
// Two layers are absent, and each absence is an answer: no own extensions,
// because an extension has no extension host of its own to materialize a
// second extension into (##VSX-NO-OWN-EXTENSIONS); no service override, because
// the family has no uniform service registry whose last registration wins
// (##VSX-NO-SERVICE-OVERRIDE).
import { manifestPathOf } from './identity.js';
import { treePath } from './layout.js';
/** ##VSX-ENTRY-MODULE: the default activation module of an extension. */
export const DEFAULT_ENTRY_MODULE = 'src/extension.ts';
/** An open target with no dev channel and nothing stamped. */
function openTarget(path) {
    return { path, devChannel: null, stampedKeys: [], allowedKeys: null };
}
/**
 * ##VSX-MANIFEST-OVERLAY, ##VSX-LOCALE-MANIFEST-OVERLAYS: the extension
 * manifest first, then the locale manifests the configuration names - from the
 * configuration, never from the tree.
 */
export function overlayTargetsOf(config) {
    const manifest = manifestPathOf(config.extensionRoot);
    const locales = (config.localeManifests ?? []).filter((path, index, all) => path !== manifest && all.indexOf(path) === index);
    return [manifest, ...locales].map(openTarget);
}
/** ##VSX-ENTRY-MODULE: the declared activation modules, or the family's default. */
export function entryModulesOf(config) {
    return config.entryModules ?? [treePath(config.extensionRoot, DEFAULT_ENTRY_MODULE)];
}
export function entryModuleOf(config) {
    return {
        entries: entryModulesOf(config),
        why: 'the module whose activate the host calls is where an extension composes itself, so a graft that imports own code belongs there; ' +
            "confirm the entry against the manifest's main at every pin, because main names the bundle and not its source"
    };
}
export function makeLayers(config) {
    return {
        overlayTargets: overlayTargetsOf(config),
        ownExtensions: null,
        serviceOverride: null,
        entryModule: entryModuleOf(config)
    };
}
