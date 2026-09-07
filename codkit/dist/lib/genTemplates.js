/** @scope spec://codkit/modules/codkit/PROP-015#GEN-HEADER-IS-THE-PRODUCTS */
// The text `codkit gen` writes into a product (PROP-015 sec. 5).
//
// Everything here is product code, not codkit's: ##GEN-HEADER-IS-THE-PRODUCTS
// says the header comes from `--holder`/`--license` and that codkit's own
// four-line notice is never written into a product file. So this module knows
// only two things - the shape of a skeleton and how to put a header the caller
// supplied in front of it.
//
// The relative specifiers are counted from the materialized location, not from
// the patch set: `delta/own/**` becomes `src/vs/<ownDirName>/**` in the fork
// tree (PROP-005 ##OWN-UNDER-SRC-VS), so a file in
// `delta/own/contrib/<name>/browser/` reaches upstream with four `..` segments
// and the runtime library with three.
/**
 * ##GEN-HEADER-IS-THE-PRODUCTS: the copyright line first and the SPDX line
 * last, which is the shape every licence scanner reads; the two lines between
 * them say where the full text lives. The identifier is the product's, and
 * codkit never substitutes its own.
 */
export function productHeader(header) {
    return [
        `// Copyright (c) ${header.year} ${header.holder}`,
        `// Licensed under the ${header.license} licence.`,
        '// The full licence text is the licence file of this repository.',
        `// SPDX-License-Identifier: ${header.license}`,
        ''
    ].join('\n');
}
/** The class a feature skeleton declares: `sample` becomes `SampleFeature`. */
export function featureClassName(directoryName) {
    return `${directoryName.charAt(0).toUpperCase()}${directoryName.slice(1)}Feature`;
}
/** The setting id a feature with `--setting` declares. */
export function settingId(id) {
    return `${id}.enabled`;
}
/** `delta/own/contrib/<name>/common/<name>.ts`: the identifiers, and nothing else. */
export function commonModule(options) {
    const lines = [
        `// Identifiers of the ${options.title} feature.`,
        '//',
        '// They live in `common/` so that any layer of the product can name the',
        '// feature - a `when` clause, a test, another feature - without importing',
        '// browser code.',
        '',
        `export const FEATURE_ID = '${options.id}';`
    ];
    if (options.setting) {
        lines.push('', `export const SETTING_ID = '${settingId(options.id)}';`);
    }
    return `${lines.join('\n')}\n`;
}
/**
 * `delta/own/contrib/<name>/browser/<name>.contribution.ts`: the feature itself.
 *
 * ##RT-FEATURE-IS-AN-INSTANCE: the class is an ordinary `Disposable` with a DI
 * constructor. Turning the flag on creates it, turning the flag off disposes
 * it, so everything the feature adds is registered in the constructor through
 * `this._register(...)` and nothing needs an `activate` method.
 */
export function contributionModule(options) {
    const className = featureClassName(options.name);
    const imports = [
        `import { localize } from '../../../../nls.js';`,
        `import { Disposable } from '../../../../base/common/lifecycle.js';`,
        `import { ILogService } from '../../../../platform/log/common/log.js';`,
        `import { registerFeature } from '../../../codkit/browser/featureRegistry.js';`,
        options.setting
            ? `import { FEATURE_ID, SETTING_ID } from '../common/${options.name}.js';`
            : `import { FEATURE_ID } from '../common/${options.name}.js';`
    ];
    const descriptor = [
        '\t{',
        '\t\tid: FEATURE_ID,',
        `\t\ttitle: localize('${options.id}.title', ${JSON.stringify(options.title)}),`,
        '\t\tdefault: false,',
        `\t\thotToggle: ${options.cold ? 'false' : 'true'},`
    ];
    if (options.setting) {
        descriptor.push('\t\tsetting: {', '\t\t\tid: SETTING_ID,', `\t\t\tdescription: localize('${options.id}.description', ${JSON.stringify(`Enables ${options.title}.`)}),`, '\t\t},');
    }
    descriptor.push('\t},');
    return `${[
        ...imports,
        '',
        '/**',
        ` * The ${options.title} feature.`,
        ' *',
        ' * The features host creates this class when the flag turns on and disposes',
        ' * it when the flag turns off: the constructor is the whole activation, and',
        ' * everything the feature adds belongs in `this._register(...)`.',
        ' */',
        `class ${className} extends Disposable {`,
        '\tconstructor(@ILogService private readonly logService: ILogService) {',
        '\t\tsuper();',
        '\t\tthis.logService.trace(`${FEATURE_ID}: enabled`);',
        '\t}',
        '}',
        '',
        'registerFeature(',
        ...descriptor,
        `\t${className},`,
        ');'
    ].join('\n')}\n`;
}
/** `delta/own/test/browser/<name>.test.ts`: the skeleton the fork's runners find. */
export function testModule(options) {
    return `${[
        `import assert from 'assert';`,
        `import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';`,
        `import { FEATURE_ID } from '../../contrib/${options.name}/common/${options.name}.js';`,
        '',
        `suite('${options.id}', () => {`,
        '\tensureNoDisposablesAreLeakedInTestSuite();',
        '',
        `\ttest('declares the feature id its contribution registers', () => {`,
        `\t\tassert.strictEqual(FEATURE_ID, '${options.id}');`,
        '\t});',
        '});'
    ].join('\n')}\n`;
}
/** `delta/own/common/brand.ts`: the rules table with one worked example. */
export function brandModule() {
    return `${[
        `import { createBrandTransform, type IBrandRule } from '../codkit/common/brand/brandRules.js';`,
        '',
        '/**',
        ' * The brand table of this product.',
        ' *',
        ' * Rules are applied in order to every message that reaches `_format`, so',
        ' * they brand the English defaults and every language pack alike. `except`',
        ' * is the escape hatch: a rule is skipped for a message that contains one of',
        ' * its strings, which is how a name that must survive - a protocol name, a',
        ' * URL, a setting id quoted in prose, a longer product name that contains the',
        ' * upstream one - is kept out of the replacement.',
        ' */',
        'const RULES: readonly IBrandRule[] = [',
        `\t{ find: 'Upstream Name', replace: 'Product Name', except: ['Upstream Name Speech'] },`,
        '];',
        '',
        'export const brandMessage = createBrandTransform(RULES);'
    ].join('\n')}\n`;
}
/**
 * ##GEN-BRAND: the graft the product puts into `nls.ts`. It is printed, never
 * written: `nls.ts` is upstream text, so the seam is a patch of the product
 * (PROP-005 ##PATCH-HOOK-BUDGET), and codkit does not author a patch here.
 */
export function brandHookText(ownDirName) {
    return `${[
        '// at the top of src/vs/nls.ts, inside a codkit marker block:',
        '// codkit:begin <ID>',
        `import { brandMessage } from './${ownDirName}/common/brand.js';`,
        '// codkit:end <ID>',
        '',
        '// and around the value _format returns, inside a second block with the same id:',
        '// codkit:begin <ID>',
        'return brandMessage(result);',
        '// codkit:end <ID>'
    ].join('\n')}\n`;
}
/** ##GEN-BRAND: the two things a person has to know before writing that patch. */
export function brandReminders(ownDirName) {
    return [
        'the graft is a patch of the product with `type = hook` in its header: at most three lines of code between the markers, one of them naming own code (PROP-005 hook budget)',
        `the code-import-patterns target for src/vs/{monaco.d.ts,nls.ts} must allow vs/${ownDirName}/common/~, or the fork's lint refuses the import`
    ];
}
