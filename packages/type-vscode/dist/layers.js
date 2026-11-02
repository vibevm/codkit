/** @scope spec://codkit/modules/vscode/PROP-003#VSCODE-OVERLAY-TARGETS */
// Area 3: the four layers whose shape this family decides.
//
// `own`, `patch`, `resource-file` and `rewrite-rule` are universal and ask the
// type nothing. `config-overlay` gets its targets and its dev channel here,
// `own-extension` its materializer, `service-override` its verifier and
// `entry-module` its locator.
import { ownExtensionPath } from './layout.js';
/** The product manifest of the distribution, from the tree root. */
export const PRODUCT_JSON_TARGET = 'product.json';
/** The sidecar the bootstrap of this family reads under `VSCODE_DEV`. */
export const PRODUCT_OVERRIDES_FILE = 'product.overrides.json';
/**
 * ##PRODUCT-OVERLAY-FACTS: the top-level keys the packaging step stamps by
 * itself. An operation on one of them is announced, not refused: whatever it
 * writes is overwritten when the product is packaged.
 */
export const STAMPED_PRODUCT_KEYS = ['commit', 'date', 'checksums', 'version'];
/**
 * ##VSCODE-OVERLAY-TARGETS: `product.json` is the manifest and the only target
 * with a dev channel; root and remote npm manifests admit guarded dependency
 * removals, with matching npm-prune operations on their lockfiles.
 */
export const overlayTargets = [
    {
        path: 'build/checker/tsconfig.electron-main.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: null
    },
    {
        path: 'build/checker/tsconfig.electron-utility.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: null
    },
    {
        path: 'build/checker/tsconfig.node.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: null
    },
    {
        path: PRODUCT_JSON_TARGET,
        devChannel: PRODUCT_OVERRIDES_FILE,
        stampedKeys: STAMPED_PRODUCT_KEYS,
        allowedKeys: null
    },
    {
        path: 'package.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: ['scripts'],
        // `license` since 2026-11-01: the licence of the product is a declaration of
        // the manifest, replaced under guard by `gen licensing` (modules/vscode/PROP-010).
        allowedScalarKeys: ['license'],
        allowedRemovals: ['dependencies', 'devDependencies', 'optionalDependencies'],
        allowedDependencyUpdates: ['dependencies', 'devDependencies', 'optionalDependencies']
    },
    {
        path: 'package-lock.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: [],
        allowedRemovals: ['dependencies', 'devDependencies', 'optionalDependencies'],
        allowedDependencyUpdates: ['dependencies', 'devDependencies', 'optionalDependencies'],
        npmLockfile: true
    },
    {
        path: 'remote/package.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: [],
        allowedRemovals: ['dependencies', 'devDependencies', 'optionalDependencies'],
        allowedDependencyUpdates: ['dependencies', 'devDependencies', 'optionalDependencies']
    },
    {
        path: 'remote/package-lock.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: [],
        allowedRemovals: ['dependencies', 'devDependencies', 'optionalDependencies'],
        allowedDependencyUpdates: ['dependencies', 'devDependencies', 'optionalDependencies'],
        npmLockfile: true
    },
    {
        path: 'src/tsconfig.json',
        devChannel: null,
        stampedKeys: [],
        allowedKeys: null
    }
];
/** ##OWN-EXTENSION-UNIT: the delta directory and its materialization. */
export const ownExtensions = {
    deltaRoot: 'delta/own-extensions',
    materializedPath: ownExtensionPath,
    namePattern: /^[a-z0-9][a-z0-9-]*$/,
    manifestFile: 'package.json'
};
/** ##SO-MECHANISM, ##SO-FORBIDDEN-IDS: how an override is proved and refused. */
export const serviceOverride = {
    registrationCall: 'registerSingleton',
    registrationModule: null,
    forbiddenReason: 'this service is set explicitly before the workbench is created, so a later registration is ignored and the product breaks at load',
    forbiddenHint: 'override a service the workbench itself instantiates, or replace the behaviour through the entry-module layer'
};
/** ##VSCODE-ENTRY-MODULE-LOCATOR: the renderer entries of this family. */
export const entryModule = {
    entries: [
        'src/vs/workbench/workbench.common.main.ts',
        'src/vs/workbench/workbench.desktop.main.ts',
        'src/vs/workbench/workbench.web.main.ts'
    ],
    why: 'these modules are the import lists the renderer of this distribution is assembled from, so a contribution reaches the product by being imported there'
};
/** The marketplace identity of an extension: `publisher.name`, each a word of letters, digits and `-`. */
export const BUNDLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu;
/** Where the packaging and the development run look for a built-in extension, from the tree root. */
export const BUILT_IN_EXTENSIONS_CACHE = '.build/builtInExtensions';
/**
 * ##VSCODE-BUNDLED-EXTENSION: the marketplace target platforms of a
 * platform-specific extension, the vocabulary upstream's own
 * `build/lib/extensionTarget.ts` keys `platformSpecific` by.
 */
export const EXTENSION_TARGETS = [
    'win32-x64',
    'win32-arm64',
    'linux-x64',
    'linux-arm64',
    'linux-armhf',
    'alpine-x64',
    'alpine-arm64',
    'darwin-x64',
    'darwin-arm64'
];
/** The marketplace target of a Node platform and architecture, as upstream derives it; Alpine is never guessed. */
export function extensionTargetOf(platform, arch) {
    const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
    if (os === null)
        return null;
    const target = `${os}-${arch === 'arm' ? 'armhf' : arch}`;
    return EXTENSION_TARGETS.includes(target) ? target : null;
}
/** A map of target to hash, or null when the value is not one. */
function targetHashes(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const entries = Object.entries(value);
    return entries.every(([, hash]) => typeof hash === 'string') ? Object.fromEntries(entries) : null;
}
/** The entries of `builtInExtensions` that carry a name, a version and a hash or `platformSpecific` hashes; the rest are skipped. */
function builtInExtensionsOf(list) {
    if (!Array.isArray(list))
        return [];
    return list.flatMap((element) => {
        if (typeof element !== 'object' || element === null || Array.isArray(element))
            return [];
        const { name, version, sha256, platformSpecific } = element;
        if (typeof name !== 'string' || typeof version !== 'string')
            return [];
        const targets = targetHashes(platformSpecific);
        if (targets !== null)
            return [{ name, version, sha256: typeof sha256 === 'string' ? sha256 : '', targets }];
        return typeof sha256 === 'string' ? [{ name, version, sha256 }] : [];
    });
}
/**
 * ##VSCODE-BUNDLED-EXTENSION: a bundled extension is an entry of
 * `builtInExtensions` of `product.json` whose VSIX the patch set declares as a
 * bundle. `name` is `publisher.name` of the extension's manifest - the key the
 * dev scanner and the packaging look the cache up by - and `repo` is empty,
 * because the bytes never come from a release of upstream's. The unit is
 * `extension/` of the VSIX, unpacked into `.build/builtInExtensions/<name>`,
 * where `build/lib/builtInExtensions.ts` takes it by version and the scanner
 * of the development run finds it through the dev channel.
 */
export const bundles = {
    manifestTarget: PRODUCT_JSON_TARGET,
    listPath: ['builtInExtensions'],
    entries: (document) => builtInExtensionsOf(document['builtInExtensions']),
    // A unit built per target is upstream's platform-specific entry: no single
    // hash, one per marketplace target in `platformSpecific` (build/lib/builtInExtensions.ts).
    entry: (unit) => unit.targets === undefined
        ? { name: unit.name, version: unit.version, sha256: unit.sha256, repo: '' }
        : { name: unit.name, version: unit.version, repo: '', platformSpecific: { ...unit.targets } },
    cachePath: (name) => `${BUILT_IN_EXTENSIONS_CACHE}/${name}`,
    archiveRoot: 'extension/',
    archiveManifest: 'extension/package.json',
    identity(manifestText) {
        let parsed;
        try {
            parsed = JSON.parse(manifestText);
        }
        catch {
            return null;
        }
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        const { publisher, name, version } = parsed;
        if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string')
            return null;
        if (publisher === '' || name === '' || version === '')
            return null;
        return { name: `${publisher}.${name}`, version };
    },
    namePattern: BUNDLE_NAME_PATTERN,
    archiveWord: 'VSIX',
    targets: EXTENSION_TARGETS,
    hostTarget: (host) => extensionTargetOf(host.platform, host.arch),
    packageTarget: (target) => extensionTargetOf(target.platform === 'windows' ? 'win32' : target.platform === 'macos' ? 'darwin' : 'linux', target.arch),
    // `vsce package --target <t>` writes the target into the identity of the VSIX manifest.
    archiveTargetManifest: 'extension.vsixmanifest',
    archiveTarget: (manifestText) => /<Identity\b[^>]*\bTargetPlatform="([^"]+)"/u.exec(manifestText)?.[1] ?? null
};
export const layers = { overlayTargets, ownExtensions, serviceOverride, entryModule, bundles };
