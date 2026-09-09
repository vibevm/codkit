// Area 10: the skeletons `codkit gen` writes for this family
// (modules/vscode/PROP-008 ##VSCODE-GENERATORS-ARE-TEMPLATES, ##GEN-FEATURE,
// ##GEN-BRAND, ##GEN-TEST-LIVES-WITH-THE-FEATURE).
//
// The command, the licence header and the refusal over an existing file are the
// engine's and are proved there. What is proved here is the text: the shape of
// a contribution of this distribution, the specifiers it reaches upstream with,
// and the graft into the string funnel.

import { describe, expect, it } from 'vitest';
import type { FeatureRequest } from '@codkit/type-api';
import { brandGraft, featureClassName, featureSkeleton, generators, settingId } from '../src/generators.ts';

const request = (over: Partial<FeatureRequest> = {}): FeatureRequest => ({
	id: 'acme.sample',
	name: 'sample',
	title: 'Sample',
	setting: false,
	cold: false,
	ownRoot: 'src/vs/patchset',
	...over
});

const moduleOf = (skeleton: ReturnType<typeof featureSkeleton>, role: string) =>
	skeleton.modules.find((module) => module.role === role)?.text ?? '';

describe('the feature skeleton', () => {
	it('is three files under the feature directory, named after the last id segment', () => {
		const skeleton = featureSkeleton(request({ setting: true }));

		expect(skeleton.directory).toBe('delta/own/contrib/sample');
		expect(skeleton.modules.map((module) => module.path)).toEqual([
			'delta/own/contrib/sample/common/sample.ts',
			'delta/own/contrib/sample/browser/sample.contribution.ts',
			'delta/own/contrib/sample/test/browser/sample.test.ts'
		]);
		expect(skeleton.modules.map((module) => module.role)).toEqual(['identifiers', 'feature', 'test']);
	});

	it('puts the identifiers where any layer can name them without importing browser code', () => {
		const text = moduleOf(featureSkeleton(request({ setting: true })), 'identifiers');

		expect(text).toContain("export const FEATURE_ID = 'acme.sample';");
		expect(text).toContain(`export const SETTING_ID = '${settingId('acme.sample')}';`);
	});

	it('registers the feature through the runtime library and defaults to a hot toggle', () => {
		const text = moduleOf(featureSkeleton(request({ setting: true })), 'feature');

		expect(text).toContain("import { registerFeature } from '../../../codkit/browser/featureRegistry.js';");
		expect(text).toContain('registerFeature(');
		expect(text).toContain('hotToggle: true,');
		expect(text).toContain(`class ${featureClassName('sample')} extends Disposable {`);
		expect(text).toContain('localize(\'acme.sample.title\', "Sample")');
	});

	it('declares a cold feature under --cold and no setting without --setting', () => {
		const skeleton = featureSkeleton(request({ cold: true }));

		expect(moduleOf(skeleton, 'feature')).toContain('hotToggle: false,');
		expect(moduleOf(skeleton, 'feature')).not.toContain('setting: {');
		expect(moduleOf(skeleton, 'identifiers')).not.toContain('SETTING_ID');
	});

	it('writes a test skeleton that leaks no disposables', () => {
		const text = moduleOf(featureSkeleton(request()), 'test');

		expect(text).toContain('ensureNoDisposablesAreLeakedInTestSuite();');
		expect(text).toContain("suite('acme.sample', () => {");
	});

	it('counts the specifiers of that test from inside the feature directory', () => {
		// ##GEN-TEST-LIVES-WITH-THE-FEATURE: `test/browser/` sits two levels below
		// the feature, so upstream is five `..` away and own code is two.
		const text = moduleOf(featureSkeleton(request()), 'test');

		expect(text).toContain("import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';");
		expect(text).toContain("import { FEATURE_ID } from '../../common/sample.js';");
	});

	it('offers the import line the composition root needs', () => {
		expect(featureSkeleton(request()).importLine).toBe("import '../contrib/sample/browser/sample.contribution.js';");
	});
});

describe('the brand table and its graft', () => {
	it('writes one table exporting brandMessage through the runtime engine', () => {
		const graft = brandGraft('src/vs/patchset');

		expect(graft.module.path).toBe('delta/own/common/brand.ts');
		expect(graft.module.text).toContain("import { createBrandTransform, type IBrandRule } from '../codkit/common/brand/brandRules.js';");
		expect(graft.module.text).toContain('export const brandMessage = createBrandTransform(RULES);');
		expect(graft.module.text).toContain("{ find: 'Upstream Name', replace: 'Product Name', except: ['Upstream Name Speech'] },");
	});

	it('prints the graft for the string funnel and the two reminders that go with it', () => {
		const graft = brandGraft('src/vs/patchset');

		expect(graft.hookText).toContain('brandMessage(');
		expect(graft.hookText).toContain("import { brandMessage } from './patchset/common/brand.js';");
		expect(graft.reminders).toHaveLength(2);
		expect(graft.reminders[0]).toContain('type = hook');
		expect(graft.reminders[1]).toContain('nls.ts');
		expect(graft.reminders[1]).toContain('vs/patchset/common/~');
	});

	it('is the area the type declares, graft included', () => {
		expect(generators.featureSkeleton).toBe(featureSkeleton);
		expect(generators.brandGraft).toBe(brandGraft);
	});
});
