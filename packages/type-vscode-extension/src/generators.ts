/** @scope spec://codkit/modules/vscode-extension/PROP-005#VSX-GEN-FEATURE */
// Area 10: what `codkit gen` writes for this family of upstreams.
//
// The command, its flags, the licence header of a generated file and the
// refusal over an existing one are the engine's; the shape of a feature and the
// graft into the string funnels are this type's. A feature of an extension is a
// function `register<Name>(context)` that pushes its disposables into
// `context.subscriptions` - the shape every contribution of an extension takes -
// with its identifiers beside it and its test inside the feature directory
// (##VSX-GEN-FEATURE). `gen brand` writes the brand table and the leftover
// guard and prints the hook (##VSX-GEN-BRAND); the texts are in
// `brandTemplates.ts`.

import type { BrandGraft, FeatureRequest, FeatureSkeleton, GeneratedModule, GeneratorsArea } from '@codkit/type-api';
import { BRAND_GUARD_PATH, BRAND_MODULE_PATH, brandGuardText, brandHookText, brandModuleText, brandReminders } from './brandTemplates.ts';
import type { TestWords } from './brandTemplates.ts';
import { argvOf } from './configSchema.ts';
import type { VsxTypeConfig } from './configSchema.ts';
import { manifestPathOf } from './identity.ts';
import { entryModulesOf } from './layers.ts';
import { sourceRootOf } from './layout.ts';

/** `sample` becomes `Sample`; `my-view` becomes `MyView`. */
function pascalCase(name: string): string {
	return name
		.split(/[^A-Za-z0-9]+/u)
		.filter((word) => word !== '')
		.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join('');
}

/** `sample` becomes `registerSample`: the function the activation module calls. */
export function featureFunctionName(name: string): string {
	return `register${pascalCase(name)}`;
}

/** The constant of the feature id, e.g. `SAMPLE_FEATURE_ID`. */
export function featureConstant(name: string): string {
	return `${upperSnake(name)}_FEATURE_ID`;
}

/** The constant of the setting id, e.g. `SAMPLE_SETTING_ID`. */
export function settingConstant(name: string): string {
	return `${upperSnake(name)}_SETTING_ID`;
}

/**
 * The setting of a feature with `--setting`, under the product's configuration
 * section: the section is the first segment of the id, so `acme.sample` reads
 * `acme.sample.enabled`.
 */
export function settingId(id: string): string {
	return `${id}.enabled`;
}

/**
 * The words a generated test is written in, read from the declared own-test
 * runner: `vscode-test` runs mocha's TDD interface (`suite`/`test`, the
 * extension generator's default), mocha itself its BDD one (`describe`/`it`),
 * and every other runner - and a patch set that declared none - the Jest
 * shape (`describe`/`test`) that bun, vitest and jest share. The engine's
 * guard lookup reads both `suite` and `describe`.
 */
export function testWordsOf(config: VsxTypeConfig): TestWords {
	const command = config.scripts?.test?.command;
	const words = command === undefined ? [] : argvOf(command).map((word) => word.replace(/^.*[\\/]/u, '').replace(/\.[cm]?js$/u, ''));
	if (words.includes('vscode-test')) {
		return { suite: 'suite', test: 'test' };
	}
	if (words.includes('mocha')) {
		return { suite: 'describe', test: 'it' };
	}
	return { suite: 'describe', test: 'test' };
}

function upperSnake(name: string): string {
	return name
		.replace(/[^A-Za-z0-9]+/gu, '_')
		.replace(/^_+|_+$/gu, '')
		.toUpperCase();
}

/**
 * The own root as the entry module reaches it: relative to `<extensionRoot>/src/`,
 * where both of them sit. An own root outside it - the placeholder of an
 * unconfigured type - is spelled as it is.
 */
export function ownUnderSource(ownRoot: string, extensionRoot: string): string {
	const prefix = `${sourceRootOf(extensionRoot)}/`;
	return ownRoot.startsWith(prefix) ? ownRoot.slice(prefix.length) : ownRoot;
}

function identifiersModule(request: FeatureRequest, constant: string, setting: string): string {
	const lines = [
		`// Identifiers of the ${request.title} feature.`,
		'//',
		'// The feature id is the command the feature contributes, and the setting of',
		"// the feature sits under the product's configuration section - the first",
		'// segment of the id - so that the manifest overlay can declare both.',
		'',
		`export const ${constant} = '${request.id}';`
	];
	if (request.setting) {
		lines.push('', `export const ${setting} = '${settingId(request.id)}';`);
	}
	return `${lines.join('\n')}\n`;
}

function featureModule(request: FeatureRequest, constant: string, setting: string): string {
	const functionName = featureFunctionName(request.name);
	const identifiers = request.setting ? `${constant}, ${setting}` : constant;
	const lifetime = request.cold
		? 'The flag is read once, when the extension activates: a cold feature is what it was at activation for the life of the host.'
		: 'The flag is read on every use, so turning the setting off takes effect without a reload.';
	const guard = request.setting ? (request.cold ? ['\tif (!isEnabled()) {', '\t\treturn;', '\t}'] : []) : [];
	const invocation = request.setting && !request.cold ? ['\t\t\tif (!isEnabled()) {', '\t\t\t\treturn;', '\t\t\t}'] : [];
	const enabled = request.setting
		? [
				'',
				'/** The flag of the feature, read from the configuration of the host. */',
				'function isEnabled(): boolean {',
				`\treturn vscode.workspace.getConfiguration().get<boolean>(${setting}, false) === true;`,
				'}'
			]
		: [];
	return `${[
		"import * as vscode from 'vscode';",
		`import { ${identifiers} } from './${request.name}.identifiers';`,
		'',
		'/**',
		` * The ${request.title} feature.`,
		' *',
		' * Registered from the activation module of the extension: every disposable the',
		' * feature creates is pushed into `context.subscriptions`, so the host disposes',
		' * it when the extension deactivates - the shape every contribution of an',
		' * extension takes.',
		...(request.setting ? [' *', ` * ${lifetime}`] : []),
		' */',
		`export function ${functionName}(context: vscode.ExtensionContext): void {`,
		...guard,
		'\tcontext.subscriptions.push(',
		`\t\tvscode.commands.registerCommand(${constant}, () => {`,
		...invocation,
		`\t\t\t// everything ${request.id} does starts here`,
		'\t\t})',
		'\t);',
		'}',
		...enabled
	].join('\n')}\n`;
}

function testModule(request: FeatureRequest, constant: string, words: TestWords): string {
	return `${[
		"import * as assert from 'node:assert';",
		`import { ${constant} } from './${request.name}.identifiers';`,
		'',
		`${words.suite}('${request.id}', () => {`,
		`\t${words.test}('declares the id its command is registered under', () => {`,
		`\t\tassert.strictEqual(${constant}, '${request.id}');`,
		'\t});',
		'});'
	].join('\n')}\n`;
}

/**
 * ##VSX-GEN-FEATURE: the three files a feature of this family starts as, under
 * `delta/own/<name>/`, with the test beside them inside the feature directory
 * (`spec://codkit/modules/vscode/PROP-008#GEN-TEST-LIVES-WITH-THE-FEATURE`),
 * the import line for the entry module and what is left to do by hand. The
 * unit of the own manifest is the engine's own reminder.
 */
export function featureSkeletonOf(config: VsxTypeConfig, request: FeatureRequest): FeatureSkeleton {
	const directory = `delta/own/${request.name}`;
	const constant = featureConstant(request.name);
	const setting = settingConstant(request.name);
	const functionName = featureFunctionName(request.name);
	const modules: readonly GeneratedModule[] = [
		{ path: `${directory}/${request.name}.identifiers.ts`, text: identifiersModule(request, constant, setting), role: 'identifiers' },
		{ path: `${directory}/${request.name}.ts`, text: featureModule(request, constant, setting), role: 'feature' },
		{ path: `${directory}/${request.name}.test.ts`, text: testModule(request, constant, testWordsOf(config)), role: 'test' }
	];
	const reminders = [
		`call ${functionName}(context) from activate of the entry module (${entryModulesOf(config).join(', ')}), after confirming the entry against the manifest's main at this pin`,
		`declare the command ${request.id} under contributes.commands of the manifest overlay, or the host never shows it`
	];
	if (request.setting) {
		reminders.push(`declare the setting ${settingId(request.id)} under contributes.configuration of the manifest overlay`);
	}
	return {
		directory,
		modules,
		// REVIEW: the specifier is extensionless, as the bundlers of the family
		// resolve it; a product whose compiler wants the `.js` suffix adds it.
		importLine: `import { ${functionName} } from './${ownUnderSource(request.ownRoot, config.extensionRoot)}/${request.name}/${request.name}';`,
		reminders
	};
}

/**
 * ##VSX-GEN-BRAND: the two modules `gen brand` writes - the table, and the
 * leftover guard (##VSX-BRAND-LEFTOVER-GUARD) in the words of the declared
 * runner - and the hook it prints.
 */
export function brandGraftOf(config: VsxTypeConfig, ownRoot: string): BrandGraft {
	return {
		module: { path: BRAND_MODULE_PATH, text: brandModuleText(), role: 'table' },
		guard: { path: BRAND_GUARD_PATH, text: brandGuardText(config.extensionRoot, testWordsOf(config)), role: 'test' },
		hookText: brandHookText(ownRoot),
		reminders: brandReminders(manifestPathOf(config.extensionRoot), config.extensionRoot)
	};
}

export function makeGenerators(config: VsxTypeConfig): GeneratorsArea {
	return {
		featureSkeleton: (request) => featureSkeletonOf(config, request),
		brandGraft: (ownRoot) => brandGraftOf(config, ownRoot)
	};
}
