/** @scope spec://codkit/modules/codkit/PROP-015#GEN-HEADER-IS-THE-PRODUCTS */
// The text `codkit gen` writes into a product (PROP-015 sec. 5).
//
// Everything here is product code, not codkit's: ##GEN-HEADER-IS-THE-PRODUCTS
// says the header is built from what the product passed - its fields, or its
// own text - and that codkit's own four-line notice is never written into a
// product file. So this module knows only two things - the shape of a skeleton
// and how to put a header the caller supplied in front of it.
//
// The relative specifiers are counted from the materialized location, not from
// the patch set: `delta/own/**` becomes `<ownRoot>/**` in the fork
// tree (modules/vscode/PROP-002 ##OWN-UNDER-SRC-VS), so a file in
// `delta/own/contrib/<name>/browser/` reaches upstream with four `..` segments
// and the runtime library with three; the test sits two directories deeper
// (##GEN-TEST-LIVES-WITH-THE-FEATURE) and reaches upstream with five.

/** The two shapes codkit lays a header out in from the fields it was given. */
export type HeaderStyle = 'line' | 'block';

/** What a run reports about the header it wrote; null when it wrote none. */
export type HeaderStyleName = HeaderStyle | 'file' | null;

/** The fields a header is laid out from, and the shape to lay them out in. */
export type ProductHeaderFields = {
	readonly holder: string;
	readonly license: string;
	readonly year: string;
	readonly style: HeaderStyle;
};

/**
 * The header the product asked for. Either codkit lays the product's fields
 * out in one of the two known shapes, or the product hands over the text
 * itself and codkit copies it (##GEN-HEADER-IS-THE-PRODUCTS): a house form
 * that fields cannot express is still the product's to write.
 */
export type ProductHeader = ({ readonly form: 'fields' } & ProductHeaderFields) | { readonly form: 'text'; readonly text: string };

// The rules of the block form. The widths are the ones upstream files carry,
// so a product file lines up with the upstream file next to it rather than
// almost lining up, which is the one thing a reader would notice.
const BLOCK_RULE_OPEN = `/*${'-'.repeat(93)}`;
const BLOCK_RULE_CLOSE = ` *${'-'.repeat(92)}*/`;

/** ##GEN-HEADER-IS-THE-PRODUCTS: the product's header, ending in one newline. */
export function productHeader(header: ProductHeader): string {
	if (header.form === 'text') {
		// Byte for byte: the caller has already proved the file ends in a newline.
		return header.text;
	}
	return header.style === 'block' ? blockHeader(header) : lineHeader(header);
}

/** ##CMD-GEN-FEATURE: the name `--json` gives the header a run wrote. */
export function headerStyleName(header: ProductHeader | null): HeaderStyleName {
	if (header === null) return null;
	return header.form === 'text' ? 'file' : header.style;
}

/**
 * The `line` shape: the copyright line first and the SPDX line last, which is
 * the shape every licence scanner reads; the two lines between them say where
 * the full text lives. The identifier is the product's, and codkit never
 * substitutes its own.
 */
function lineHeader(header: ProductHeaderFields): string {
	return [
		`// Copyright (c) ${header.year} ${header.holder}`,
		`// Licensed under the ${header.license} licence.`,
		'// The full licence text is the licence file of this repository.',
		`// SPDX-License-Identifier: ${header.license}`,
		''
	].join('\n');
}

/**
 * The `block` shape: the same four statements inside the ruled comment the
 * upstream sources carry, so own code reads as one system with the code it
 * sits beside - the standard ##GEN-HEADER-IS-THE-PRODUCTS cites as
 * `MI-SAME-SHAPE-AS-UPSTREAMS-PARALLEL-SYSTEM`.
 */
function blockHeader(header: ProductHeaderFields): string {
	return [
		BLOCK_RULE_OPEN,
		` *  Copyright (c) ${header.year} ${header.holder}. All rights reserved.`,
		` *  Licensed under the ${header.license} licence. The full licence text is the licence file of this repository.`,
		` *  SPDX-License-Identifier: ${header.license}`,
		BLOCK_RULE_CLOSE,
		''
	].join('\n');
}

/** The class a feature skeleton declares: `sample` becomes `SampleFeature`. */
export function featureClassName(directoryName: string): string {
	return `${directoryName.charAt(0).toUpperCase()}${directoryName.slice(1)}Feature`;
}

export type FeatureTemplateOptions = {
	/** The full feature id, `acme.sample`. */
	readonly id: string;
	/** Its last segment, which is also the directory name. */
	readonly name: string;
	/** Already-written title text; the template localizes it. */
	readonly title: string;
	/** ##GEN-FEATURE: declare a setting for the flag. */
	readonly setting: boolean;
	/** ##RT-COLD-FEATURES: a cold feature is frozen at startup. */
	readonly cold: boolean;
};

/** The setting id a feature with `--setting` declares. */
export function settingId(id: string): string {
	return `${id}.enabled`;
}

/** `delta/own/contrib/<name>/common/<name>.ts`: the identifiers, and nothing else. */
export function commonModule(options: FeatureTemplateOptions): string {
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
export function contributionModule(options: FeatureTemplateOptions): string {
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
		descriptor.push(
			'\t\tsetting: {',
			'\t\t\tid: SETTING_ID,',
			`\t\t\tdescription: localize('${options.id}.description', ${JSON.stringify(`Enables ${options.title}.`)}),`,
			'\t\t},'
		);
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

/**
 * `delta/own/contrib/<name>/test/browser/<name>.test.ts`: the skeleton the
 * fork's runners find. ##GEN-TEST-LIVES-WITH-THE-FEATURE: it belongs to the
 * feature, not to a shared test directory that no unit of the own manifest
 * owns, so its specifiers are counted from inside the feature.
 */
export function testModule(options: FeatureTemplateOptions): string {
	return `${[
		`import assert from 'assert';`,
		`import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';`,
		`import { FEATURE_ID } from '../../common/${options.name}.js';`,
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
export function brandModule(): string {
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
export function brandHookText(ownRoot: string): string {
	return `${[
		'// at the top of src/vs/nls.ts, inside a codkit marker block:',
		'// codkit:begin <ID>',
		`import { brandMessage } from './${underSourceRoot(ownRoot)}/common/brand.js';`,
		'// codkit:end <ID>',
		'',
		'// and around the value _format returns, inside a second block with the same id:',
		'// codkit:begin <ID>',
		'return brandMessage(result);',
		'// codkit:end <ID>'
	].join('\n')}\n`;
}

/** ##GEN-BRAND: the two things a person has to know before writing that patch. */
export function brandReminders(ownRoot: string): readonly string[] {
	return [
		'the graft is a patch of the product with `type = hook` in its header: at most three lines of code between the markers, one of them naming own code (PROP-005 hook budget)',
		`the code-import-patterns target for src/vs/{monaco.d.ts,nls.ts} must allow vs/${underSourceRoot(ownRoot)}/common/~, or the fork's lint refuses the import`
	];
}

/**
 * The own root as the import machinery of this template family spells it -
 * relative to the source root the templates are written against. The remaining
 * knowledge of that source root is the open half of the extraction and moves
 * with the generator templates themselves (PROP-016 ##TYPE-ENGINE-IS-BLIND).
 */
function underSourceRoot(ownRoot: string): string {
	const prefix = 'src/vs/';
	return ownRoot.startsWith(prefix) ? ownRoot.slice(prefix.length) : ownRoot;
}
