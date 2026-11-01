/** @scope spec://codkit/modules/vscode/PROP-010#VSCODE-LICENSING-AREA */
// Area 12: where this family states a licence.
//
// The profile - who the rights holders are, which licence, which text - is the
// organization's and is selected by the patch set (modules/codkit/PROP-019); the
// engine lays the headers out, writes the overlays, the add-file patches, the
// rendering and the guard, and checks them back. What is this type's: own files
// carry the ruled comment the sources of this distribution carry; the licence
// file lives at the tree root because the build copies `product.licenseFileName`
// from there; `licenses/**` travels into the application too, so component
// licences gather there; the installer reads an RTF from the root when one
// exists; and the manifest fields that name the licence are five, in two
// overlay targets.
import { PRODUCT_JSON_TARGET } from './layers.js';
/** ##VSCODE-LICENCE-FIELDS: the keys of the two manifests that name the licence. */
export const LICENCE_FIELDS = [
    { target: PRODUCT_JSON_TARGET, path: ['licenseName'], role: 'expression' },
    { target: PRODUCT_JSON_TARGET, path: ['licenseFileName'], role: 'file-name' },
    { target: PRODUCT_JSON_TARGET, path: ['licenseUrl'], role: 'url' },
    { target: PRODUCT_JSON_TARGET, path: ['serverLicenseUrl'], role: 'url' },
    { target: 'package.json', path: ['license'], role: 'expression' }
];
/**
 * ##VSCODE-COMPONENT-LICENCES: the upstream's own terms, shipped as a component
 * licence under the directory the build copies into the application. The
 * component is named after the upstream's own name for its open build.
 */
export const UPSTREAM_LICENCE_FILES = [{ path: 'LICENSE.txt', component: 'code-oss' }];
/** ##VSCODE-COMPONENT-LICENCES: `licenses/**` is copied into the application beside the licence file. */
export const COMPONENT_LICENCE_DIRECTORY = 'licenses';
/**
 * ##VSCODE-INSTALLER-RTF: the Windows installer shows `LICENSE.rtf` from the
 * root when it exists and the text file otherwise, and reads only text or RTF;
 * one rendering at the root makes it show the product's terms unchanged.
 */
export const LICENCE_RENDERINGS = [{ path: 'LICENSE.rtf', format: 'rtf' }];
/** ##VSCODE-LICENCE-GUARD: where the guard is written in the patch set, and the runner's words. */
export const LICENCE_GUARD_PATH = 'delta/own/test/node/licence.leftovers.test.ts';
/**
 * ##VSCODE-LICENCE-GUARD: the own tests of this family run under a Mocha-style
 * runner, and the family's lint asks every suite for a disposable-leak check;
 * the guard reads files and asserts, it creates no disposable, so the suite is
 * excused by the directive in front of it, with that reason.
 */
export function licenceGuard(_ownRoot) {
    return {
        path: LICENCE_GUARD_PATH,
        suite: 'suite',
        test: 'test',
        preamble: [
            '// eslint-disable-next-line local/code-ensure-no-disposables-leak-in-test -- the guard reads files and asserts; it creates no disposable'
        ]
    };
}
/** ##VSCODE-LICENSING-AREA: the answer, as data. */
export const licensing = {
    headerStyle: 'block',
    licenceFileDirectory: '',
    componentLicenceDirectory: COMPONENT_LICENCE_DIRECTORY,
    subsystem: 'product',
    fields: LICENCE_FIELDS,
    upstreamLicenceFiles: UPSTREAM_LICENCE_FILES,
    renderings: LICENCE_RENDERINGS,
    guard: licenceGuard
};
