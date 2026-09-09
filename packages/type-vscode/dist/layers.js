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
 * with a dev channel; the tree's `package.json` is a target without one and
 * admits additions under `scripts` alone.
 */
export const overlayTargets = [
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
        allowedKeys: ['scripts']
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
export const layers = { overlayTargets, ownExtensions, serviceOverride, entryModule };
