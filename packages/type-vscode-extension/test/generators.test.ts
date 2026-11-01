// What `codkit gen` writes for this family (PROP-005 ##VSX-GEN-FEATURE,
// ##VSX-GEN-BRAND, ##VSX-BRAND-RULE-SHAPE, ##VSX-BRAND-HOOK,
// ##VSX-BRAND-LEFTOVER-GUARD). The brand module is proved by running it: the
// generated text is written to a temporary directory and imported, so the
// transform is tested as the product will run it.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FeatureRequest } from '@codkit/type-api';
import { afterAll, describe, expect, it } from 'vitest';
import {
	BRAND_GUARD_PATH,
	BRAND_MODULE_PATH,
	brandGraftOf,
	featureConstant,
	featureFunctionName,
	featureSkeletonOf,
	makeGenerators,
	ownUnderSource,
	settingConstant,
	settingId,
	testWordsOf
} from '../src/index.ts';
import { FULL, MINIMAL } from './support/config.ts';

function request(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
	return { id: 'acmeSample.hello', name: 'hello', title: 'Hello', setting: false, cold: false, ownRoot: FULL.ownRoot, ...overrides };
}

describe('the feature skeleton', () => {
	it('puts the identifiers, the feature and its test inside one directory under delta/own', () => {
		// ##VSX-GEN-FEATURE
		const skeleton = featureSkeletonOf(FULL, request());
		expect(skeleton.directory).toBe('delta/own/hello');
		expect(skeleton.modules.map((module) => [module.path, module.role])).toEqual([
			['delta/own/hello/hello.identifiers.ts', 'identifiers'],
			['delta/own/hello/hello.ts', 'feature'],
			['delta/own/hello/hello.test.ts', 'test']
		]);
		for (const module of skeleton.modules) {
			expect(module.path.startsWith(`${skeleton.directory}/`)).toBe(true);
			expect(module.text.endsWith('\n')).toBe(true);
			expect(module.text.startsWith('//') || module.text.startsWith('import')).toBe(true);
		}
	});

	it('registers the feature through a function that pushes its disposables into the context', () => {
		const skeleton = featureSkeletonOf(FULL, request());
		const feature = skeleton.modules[1]?.text ?? '';
		expect(featureFunctionName('hello')).toBe('registerHello');
		expect(featureFunctionName('my-view')).toBe('registerMyView');
		expect(feature).toContain('export function registerHello(context: vscode.ExtensionContext): void {');
		expect(feature).toContain('context.subscriptions.push(');
		expect(feature).toContain(`vscode.commands.registerCommand(${featureConstant('hello')}`);
		expect(feature).not.toContain('isEnabled');
		expect(skeleton.modules[0]?.text).toContain(`export const ${featureConstant('hello')} = 'acmeSample.hello';`);
		expect(skeleton.modules[2]?.text).toContain("describe('acmeSample.hello'");
	});

	it('declares the setting under the product section only when asked, cold or hot', () => {
		expect(settingId('acmeSample.hello')).toBe('acmeSample.hello.enabled');
		const hot = featureSkeletonOf(FULL, request({ setting: true }));
		expect(hot.modules[0]?.text).toContain(`export const ${settingConstant('hello')} = 'acmeSample.hello.enabled';`);
		expect(hot.modules[1]?.text).toContain('function isEnabled(): boolean');
		expect(hot.modules[1]?.text).toContain('read on every use');
		const cold = featureSkeletonOf(FULL, request({ setting: true, cold: true }));
		expect(cold.modules[1]?.text).toContain('read once');
		expect(cold.modules[1]?.text).toContain('\tif (!isEnabled()) {');
		expect(hot.reminders.join(' ')).toContain('contributes.configuration');
		expect(featureSkeletonOf(FULL, request()).modules[0]?.text).not.toContain('_SETTING_ID');
	});

	it('prints the import line for the entry module and the reminders of the family', () => {
		const skeleton = featureSkeletonOf(FULL, request());
		expect(ownUnderSource(FULL.ownRoot, FULL.extensionRoot)).toBe('own');
		expect(ownUnderSource('src/acme', '.')).toBe('acme');
		expect(skeleton.importLine).toBe("import { registerHello } from './own/hello/hello';");
		expect(skeleton.reminders[0]).toContain('registerHello(context)');
		expect(skeleton.reminders[0]).toContain('activate');
		expect(skeleton.reminders[0]).toContain('packages/acme-sample/src/extension.ts');
		expect(skeleton.reminders.join(' ')).toContain('contributes.commands');
		expect(makeGenerators(MINIMAL).featureSkeleton(request({ ownRoot: 'src/acme' })).importLine).toBe(
			"import { registerHello } from './acme/hello/hello';"
		);
	});
});

/** The exports of the generated brand module, as the suite reads them. */
type BrandRuleLike = {
	readonly find: string;
	readonly replace: string;
	readonly locales?: readonly string[];
	readonly except?: readonly string[];
};
type BrandModule = {
	readonly RULES: readonly BrandRuleLike[];
	readonly createBrandTransform: (rules: readonly BrandRuleLike[]) => (message: string, locale: string) => string;
	readonly brandMessage: (message: string, locale: string) => string;
};

function isBrandModule(value: unknown): value is BrandModule {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	return (
		'RULES' in value &&
		Array.isArray(value.RULES) &&
		'createBrandTransform' in value &&
		typeof value.createBrandTransform === 'function' &&
		'brandMessage' in value &&
		typeof value.brandMessage === 'function'
	);
}

const temporary: string[] = [];
afterAll(() => {
	for (const directory of temporary) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** Write the generated table to a temporary directory and import it the way the product would. */
async function loadBrandModule(): Promise<BrandModule> {
	const directory = mkdtempSync(join(tmpdir(), 'ck-vsx-brand-'));
	temporary.push(directory);
	const file = join(directory, 'brand.ts');
	writeFileSync(file, brandGraftOf(FULL, FULL.ownRoot).module.text, 'utf8');
	const loaded: unknown = await import(pathToFileURL(file).href);
	if (!isBrandModule(loaded)) {
		throw new Error('the generated brand module does not export RULES, createBrandTransform and brandMessage');
	}
	return loaded;
}

describe('the brand graft', () => {
	it('writes the table into the own layer, with no header of its own', () => {
		// ##VSX-GEN-BRAND, ##DECISION-VSX-BRAND-TRANSFORM-SELF-CONTAINED
		const graft = brandGraftOf(FULL, FULL.ownRoot);
		expect(graft.module.path).toBe(BRAND_MODULE_PATH);
		expect(graft.module.role).toBe('table');
		expect(graft.module.text.startsWith('/**')).toBe(true);
		expect(graft.module.text).not.toContain('import ');
		expect(graft.module.text).toContain('export function createBrandTransform(rules: readonly BrandRule[]): BrandTransform {');
		expect(graft.module.text).toContain('export const brandMessage');
		expect(graft.module.text).not.toContain('Copyright');
		expect(makeGenerators(FULL).brandGraft?.(FULL.ownRoot).module.text).toBe(graft.module.text);
	});

	it('brands one term differently for ru and for every other locale, and honours except', async () => {
		// ##VSX-BRAND-RULE-SHAPE
		const brand = await loadBrandModule();
		const transform = brand.createBrandTransform([
			{ find: 'Upstream Name', replace: 'Localized Product', locales: ['ru'], except: ['https://'] },
			{ find: 'Upstream Name', replace: 'Product', locales: ['*'], except: ['https://'] }
		]);
		expect(transform('Welcome to Upstream Name', 'ru')).toBe('Welcome to Localized Product');
		expect(transform('Welcome to Upstream Name', 'en')).toBe('Welcome to Product');
		expect(transform('Welcome to Upstream Name', 'de')).toBe('Welcome to Product');
		expect(transform('Read https://upstream.example about Upstream Name', 'en')).toBe('Read https://upstream.example about Upstream Name');
		expect(transform('Upstream Name and Upstream Name again', 'en')).toBe('Product and Product again');
	});

	it('returns an unmatched message as the same string and matches whole words only', async () => {
		const brand = await loadBrandModule();
		const transform = brand.createBrandTransform([{ find: 'Upstream', replace: 'Product' }]);
		const untouched = 'Nothing to brand here';
		expect(transform(untouched, 'en')).toBe(untouched);
		expect(transform('', 'en')).toBe('');
		expect(transform('UpstreamKit is not the term, (Upstream) is', 'fr')).toBe('UpstreamKit is not the term, (Product) is');
		// A rule without locales applies to every locale; an inert rule changes nothing.
		expect(transform('Upstream', 'ru')).toBe('Product');
		expect(
			brand.createBrandTransform([
				{ find: '', replace: 'x' },
				{ find: 'same', replace: 'same' }
			])('same', 'en')
		).toBe('same');
		// The shipped starter table brands its worked example.
		expect(brand.RULES.length).toBeGreaterThan(0);
		expect(brand.brandMessage('Upstream Name', 'en')).toBe('Product Name');
		expect(brand.brandMessage('Upstream Name', 'ru')).toBe('Localized Product Name');
	});

	it('writes the leftover guard beside the own tests, naming the scan roots and the allow-list', () => {
		// ##VSX-BRAND-LEFTOVER-GUARD
		const guard = brandGraftOf(FULL, FULL.ownRoot).guard;
		if (guard === undefined) {
			throw new Error('the family answers a leftover guard');
		}
		expect(guard.path).toBe(BRAND_GUARD_PATH);
		expect(guard.path).toBe('delta/own/test/brand.leftovers.test.ts');
		expect(guard.role).toBe('test');
		expect(guard.text).toContain("import { RULES } from '../common/brand';");
		expect(guard.text).toContain('const EXTENSION_ROOT = "packages/acme-sample";');
		expect(guard.text).toContain('const CONTENT_ROOTS = ["dist"];');
		expect(guard.text).toContain('const CONTENT_FILES = ["package.json","README.md","CHANGELOG.md"];');
		expect(guard.text).toContain("const LOCALE_MANIFEST_PREFIX = 'package.nls';");
		expect(guard.text).toContain('const NAME_ROOTS = ["assets"];');
		expect(guard.text).toContain('const ALLOWED_NAME_PREFIXES = ["LICENSE","THIRD_PARTY","NOTICE"];');
		expect(guard.text).toContain('const ALLOWED_DIRECTORIES = ["dist/licenses"];');
		expect(guard.text).toContain('still carries');
		expect(guard.text).toContain("describe('brand-leftovers'");
		expect(guard.text).toContain('pattern.test(line)');
		expect(guard.text).toContain('function readableTextOfScript(text: string): string {');
		expect(guard.text).toContain('const ALLOWED_TEXT: readonly string[] = [];');
		expect(brandGraftOf(MINIMAL, MINIMAL.ownRoot).guard?.text).toContain('const EXTENSION_ROOT = ".";');
	});

	it('writes the guard and the feature test in the words of the declared runner', () => {
		// ##VSX-BRAND-LEFTOVER-GUARD, ##VSX-GEN-FEATURE
		const tdd = { ...FULL, scripts: { ...FULL.scripts, test: { command: ['vscode-test'] } } };
		const bdd = { ...FULL, scripts: { ...FULL.scripts, test: { command: 'npx mocha --ui bdd' } } };
		expect(testWordsOf(FULL)).toEqual({ suite: 'describe', test: 'test' });
		expect(testWordsOf(MINIMAL)).toEqual({ suite: 'describe', test: 'test' });
		expect(testWordsOf(tdd)).toEqual({ suite: 'suite', test: 'test' });
		expect(testWordsOf(bdd)).toEqual({ suite: 'describe', test: 'it' });
		expect(brandGraftOf(tdd, tdd.ownRoot).guard?.text).toContain("suite('brand-leftovers'");
		expect(brandGraftOf(bdd, bdd.ownRoot).guard?.text).toContain("\tit('no original term");
	});

	it('prints the wrap of a translate function, the bundler alternative and the reminders of the rebrand set', () => {
		// ##VSX-BRAND-HOOK, ##VSX-GEN-BRAND
		const graft = brandGraftOf(FULL, FULL.ownRoot);
		expect(graft.hookText).toContain('return brandMessage(result, locale);');
		expect(graft.hookText).toContain('has its bundler as the');
		expect(graft.hookText).toContain('codkit:begin <ID>');
		expect(graft.hookText).toContain(`${FULL.ownRoot}>/common/brand`);
		expect(graft.reminders.join('\n')).toContain('type = hook');
		expect(graft.reminders.join('\n')).toContain('three lines');
		expect(graft.reminders.join('\n')).toContain('packages/acme-sample/package.json');
		expect(graft.reminders.join('\n')).toContain('contractTests');
		expect(graft.reminders.join('\n')).toContain('LICENSE*, THIRD_PARTY*, NOTICE*');
	});
});
