/** @scope spec://codkit/modules/theia/PROP-006#THEIA-NO-GEN-BRAND */
// Area 10: what `codkit gen` writes for this family of upstreams.
//
// `gen brand` is not answered at all: identity in this family is one key of the
// application manifest (##THEIA-IDENTITY-FUNNEL), so there is no string funnel
// to graft a rules table into and no honest graft to print. What is answered is
// `gen feature`, and the skeleton is what a Theia extension actually is: a
// container-module fragment that binds a contribution, plus the preference the
// flag is read from, plus the spec beside them.
//
// The engine keeps the command, the licence header of a generated file, the
// refusal over an existing one and the rule that the test lives inside the
// feature's directory; the text below is the type's.

import type { FeatureRequest, FeatureSkeleton, GeneratedModule, GeneratorsArea } from '@codkit/type-api';

/** `sample` becomes `SampleContribution`; `my-view` becomes `MyViewContribution`. */
export function featureClassName(name: string): string {
	const words = name.split(/[^A-Za-z0-9]+/u).filter((word) => word !== '');
	return `${words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join('')}Contribution`;
}

/** `sample` becomes `bindSampleFeature`. */
export function bindFunctionName(name: string): string {
	const className = featureClassName(name).replace(/Contribution$/u, '');
	return `bind${className}Feature`;
}

/** The constant of the feature id, e.g. `SAMPLE_FEATURE_ID`. */
export function featureConstant(name: string): string {
	return `${name
		.replace(/[^A-Za-z0-9]+/gu, '_')
		.replace(/^_+|_+$/gu, '')
		.toUpperCase()}_FEATURE_ID`;
}

/** The preference a feature with `--setting` is read behind. */
export function preferenceId(id: string): string {
	return `${id}.enabled`;
}

/** The own package's source layout: the browser folder of the closed set of runtime folders. */
export const FEATURE_PARENT = 'delta/own/src/browser';

/**
 * The indentation of this family: four spaces. Its lint refuses a tab outright
 * (`configs/errors.eslintrc.json`, `no-tabs`), so a skeleton written with tabs
 * would be red on the first `lerna run lint` - measured on a real clone in P5.
 */
const INDENT = '    ';

function preferencesModule(request: FeatureRequest, constant: string, preferenceConstant: string): string {
	const imports = request.setting
		? ["import { PreferenceSchema } from '@theia/core/lib/common';", "import { nls } from '@theia/core/lib/common/nls';", '']
		: [];
	const lines = [
		...imports,
		`// Identifiers of the ${request.title} feature.`,
		'//',
		'// They live in the browser folder beside the contribution because that is',
		'// where the feature is bound; a value another runtime folder needs moves to',
		'// `common/`, which is the only folder every other one may import from.',
		'',
		`export const ${constant} = '${request.id}';`
	];
	if (request.setting) {
		lines.push(
			'',
			`export const ${preferenceConstant} = '${preferenceId(request.id)}';`,
			'',
			'/**',
			' * The preference the flag of this feature is read from. It is contributed as',
			' * a schema, so the setting shows up in the preference view like any other.',
			' */',
			'export const preferenceSchema: PreferenceSchema = {',
			// No `scope`: the field is typed by the family's own enum, and the
			// default scope is what a product's flag wants anyway (measured on a
			// real clone in P5 - a string literal there does not compile).
			`${INDENT}properties: {`,
			`${INDENT.repeat(2)}[${preferenceConstant}]: {`,
			`${INDENT.repeat(3)}type: 'boolean',`,
			`${INDENT.repeat(3)}description: nls.localize('${request.id}.enabled', 'Enables ${request.title}.'),`,
			`${INDENT.repeat(3)}default: false`,
			`${INDENT.repeat(2)}}`,
			`${INDENT}}`,
			'};'
		);
	}
	return `${lines.join('\n')}\n`;
}

function contributionModule(request: FeatureRequest, constant: string, preferenceConstant: string): string {
	const className = featureClassName(request.name);
	const bindName = bindFunctionName(request.name);
	const identifiers = request.setting ? `${constant}, ${preferenceConstant}, preferenceSchema` : constant;
	const lifetime = request.cold
		? 'The flag is read once, when the frontend starts: a cold feature is what it was at startup for the life of the window.'
		: 'The flag is read on every use, so turning the preference off takes effect without a reload.';
	const enabled = request.setting
		? [
				`${INDENT}protected get enabled(): boolean {`,
				`${INDENT.repeat(2)}return this.preferences.get<boolean>(${preferenceConstant}, false) === true;`,
				`${INDENT}}`
			]
		: [`${INDENT}protected get enabled(): boolean {`, `${INDENT.repeat(2)}return true;`, `${INDENT}}`];
	const imports = [
		"import { injectable, inject, interfaces } from '@theia/core/shared/inversify';",
		"import { FrontendApplicationContribution } from '@theia/core/lib/browser';",
		...(request.setting ? ["import { PreferenceContribution, PreferenceService } from '@theia/core/lib/common';"] : []),
		`import { ${identifiers} } from './${request.name}-preferences';`
	];
	const fields = request.setting
		? [`${INDENT}@inject(PreferenceService)`, `${INDENT}protected readonly preferences: PreferenceService;`, '']
		: [];
	const bindings = [
		`${INDENT}bind(${className}).toSelf().inSingletonScope();`,
		`${INDENT}bind(FrontendApplicationContribution).toService(${className});`,
		...(request.setting ? [`${INDENT}bind(PreferenceContribution).toConstantValue({ schema: preferenceSchema });`] : [])
	];
	return `${[
		...imports,
		'',
		'/**',
		` * The ${request.title} feature.`,
		' *',
		` * ${lifetime}`,
		' */',
		'@injectable()',
		`export class ${className} implements FrontendApplicationContribution {`,
		// The id is the class's own, so a `when` clause, a test or another
		// feature names the feature through the class - and the compiler of this
		// family, which refuses an unread import, sees the identifier used.
		`${INDENT}static readonly ID = ${constant};`,
		'',
		...fields,
		`${INDENT}onStart(): void {`,
		`${INDENT.repeat(2)}if (!this.enabled) {`,
		`${INDENT.repeat(3)}return;`,
		`${INDENT.repeat(2)}}`,
		`${INDENT.repeat(2)}// everything ${request.id} does starts here`,
		`${INDENT}}`,
		'',
		...enabled,
		'}',
		'',
		'/**',
		' * Bound from the container module of the own package; nothing upstream is',
		' * patched to reach it, because the application loads the own package by one',
		' * line in its own dependencies.',
		' */',
		`export function ${bindName}(bind: interfaces.Bind): void {`,
		...bindings,
		'}'
	].join('\n')}\n`;
}

function specModule(request: FeatureRequest, constant: string): string {
	return `${[
		"import * as assert from 'assert';",
		`import { ${constant} } from '../${request.name}-preferences';`,
		'',
		`describe('${request.id}', () => {`,
		`${INDENT}it('declares the id its contribution is bound under', () => {`,
		`${INDENT.repeat(2)}assert.strictEqual(${constant}, '${request.id}');`,
		`${INDENT}});`,
		'});'
	].join('\n')}\n`;
}

/**
 * ##THEIA-NO-GEN-BRAND: the three files a feature of this family starts as. The
 * spec sits inside the feature's own directory, so one unit of the own manifest
 * covers the code and its guard together; it is compiled to `lib/` with
 * everything else and run from there by `theiaext test`.
 */
export function featureSkeleton(request: FeatureRequest): FeatureSkeleton {
	const directory = `${FEATURE_PARENT}/${request.name}`;
	const constant = featureConstant(request.name);
	const preferenceConstant = `${constant.replace(/_FEATURE_ID$/u, '')}_ENABLED`;
	const modules: readonly GeneratedModule[] = [
		{
			path: `${directory}/${request.name}-preferences.ts`,
			text: preferencesModule(request, constant, preferenceConstant),
			role: 'identifiers'
		},
		{
			path: `${directory}/${request.name}-contribution.ts`,
			text: contributionModule(request, constant, preferenceConstant),
			role: 'feature'
		},
		{ path: `${directory}/test/${request.name}.spec.ts`, text: specModule(request, constant), role: 'test' }
	];
	return {
		directory,
		modules,
		importLine: `${bindFunctionName(request.name)}(bind);`,
		reminders: [
			`call ${bindFunctionName(request.name)}(bind) from the container module of the own package - the one its theiaExtensions entry names - and import it from './${request.name}/${request.name}-contribution'`,
			'the lint of this upstream requires the SPDX header of the family in every source file: either carry a header its file-header rule accepts or override that rule in the .eslintrc.js of the own package',
			`own text goes through nls.localize with an own key: nls.localizeByDefault refuses any string that is not one of VS Code's own messages`,
			`the spec runs over the compiled package: run the tests with lerna run test --scope <own package> after a compile, never over ${directory}/test directly`
		]
	};
}

// No `brandGraft`: the capability `gen-brand` is not declared, and a family
// whose product name is a key of a manifest has no funnel to graft into.
export const generators: GeneratorsArea = { featureSkeleton };
