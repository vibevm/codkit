/** @scope spec://codkit/modules/vscode/PROP-008#VSCODE-GENERATORS-ARE-TEMPLATES */
// Area 10: what `codkit gen` writes for this family of upstreams.
//
// The command, its flags, the licence header of a generated file and the
// refusal over an existing one are the engine's; the shape of a feature - a
// contribution class with dependency injection, its identifiers in `common/`,
// its test beside it - and the graft into the string funnel of this
// distribution are this type's, and they are here in full.
//
// The relative specifiers are counted from the materialized location, not from
// the patch set: `delta/own/**` becomes `<ownRoot>/**` in the fork tree
// (modules/vscode/PROP-002 ##OWN-UNDER-SRC-VS), so a file in
// `delta/own/contrib/<name>/browser/` reaches upstream with four `..` segments
// and the runtime library with three; the test sits two directories deeper
// (##GEN-TEST-LIVES-WITH-THE-FEATURE) and reaches upstream with five.

import type { BrandGraft, FeatureRequest, FeatureSkeleton, GeneratorsArea } from '@codkit/type-api';

/** The class a feature skeleton declares: `sample` becomes `SampleFeature`. */
export function featureClassName(directoryName: string): string {
	return `${directoryName.charAt(0).toUpperCase()}${directoryName.slice(1)}Feature`;
}

/** The setting id a feature with `--setting` declares. */
export function settingId(id: string): string {
	return `${id}.enabled`;
}

/** `delta/own/contrib/<name>/common/<name>.ts`: the identifiers, and nothing else. */
function commonModule(options: FeatureRequest): string {
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
function contributionModule(options: FeatureRequest): string {
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
function testModule(options: FeatureRequest): string {
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
function brandModule(): string {
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
 * (PROP-005 ##PATCH-HOOK-BUDGET), and no patch is authored here.
 */
function brandHookText(ownRoot: string): string {
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
function brandReminders(ownRoot: string): readonly string[] {
	return [
		'the graft is a patch of the product with `type = hook` in its header: at most three lines of code between the markers, one of them naming own code (PROP-005 hook budget)',
		`the code-import-patterns target for src/vs/{monaco.d.ts,nls.ts} must allow vs/${underSourceRoot(ownRoot)}/common/~, or the fork's lint refuses the import`
	];
}

/**
 * The own root as the import machinery of this family spells it: relative to
 * the source root every module of this distribution is addressed from.
 */
function underSourceRoot(ownRoot: string): string {
	const prefix = 'src/vs/';
	return ownRoot.startsWith(prefix) ? ownRoot.slice(prefix.length) : ownRoot;
}

/**
 * ##GEN-FEATURE: the three files a feature of this family starts as, plus the
 * line its composition root gains and what is still left to do by hand. The
 * test lies inside the feature's directory, so one unit of the own manifest
 * covers the code and the test together (##GEN-TEST-LIVES-WITH-THE-FEATURE).
 */
export function featureSkeleton(request: FeatureRequest): FeatureSkeleton {
	const directory = `delta/own/contrib/${request.name}`;
	return {
		directory,
		modules: [
			{ path: `${directory}/common/${request.name}.ts`, text: commonModule(request), role: 'identifiers' },
			{ path: `${directory}/browser/${request.name}.contribution.ts`, text: contributionModule(request), role: 'feature' },
			{ path: `${directory}/test/browser/${request.name}.test.ts`, text: testModule(request), role: 'test' }
		],
		importLine: `import '../contrib/${request.name}/browser/${request.name}.contribution.js';`,
		reminders: []
	};
}

/** ##GEN-BRAND: the rules table, and the graft into `nls.ts` that is printed. */
export function brandGraft(ownRoot: string): BrandGraft {
	return {
		module: { path: 'delta/own/common/brand.ts', text: brandModule(), role: 'table' },
		hookText: brandHookText(ownRoot),
		reminders: brandReminders(ownRoot)
	};
}

export const generators: GeneratorsArea = { featureSkeleton, brandGraft };
