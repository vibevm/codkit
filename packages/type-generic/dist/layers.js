/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYERS */
// Area 3: the layers of a patch set over a plain git upstream.
//
// `own`, `patch`, `resource-file` and `rewrite-rule` are universal and ask the
// type nothing, which is exactly why this type is enough to put a patch set
// over any repository. Of the four layers that do ask, only `config-overlay` is
// answered, and only for the JSON files the patch set declared: an extension
// materializer needs an extension host, a service-override verifier needs a
// service registry and an entry-module locator needs a composition root, and a
// plain upstream is not known to have any of the three.
/**
 * ##TYPE-GENERIC: a declared JSON file, with no development channel. A sidecar
 * the running product reads instead of the target is a product model; without
 * one, an overlay of this type always writes the target itself and the whole
 * document is open to it.
 */
export function overlayTargetsOf(paths) {
    return paths.map((path) => ({ path, devChannel: null, stampedKeys: [], allowedKeys: null }));
}
export function makeLayers(overlayTargetPaths) {
    return {
        overlayTargets: overlayTargetsOf(overlayTargetPaths),
        ownExtensions: null,
        serviceOverride: null,
        entryModule: null
    };
}
export const layers = makeLayers([]);
