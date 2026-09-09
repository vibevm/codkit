// The skeleton `gen feature` writes over a plain git upstream (PROP-016
// ##TYPE-AREA-GENERATORS).

import { describe, expect, it } from 'vitest';
import type { FeatureRequest } from '@codkit/type-api';
import { featureConstant, featureSkeleton, generators, settingId } from '../src/index.ts';

function request(overrides: Partial<FeatureRequest> = {}): FeatureRequest {
	return { id: 'acme.sample', name: 'sample', title: 'Sample', setting: false, cold: false, ownRoot: 'src/own', ...overrides };
}

describe('the feature skeleton', () => {
	it('puts the identifiers, the feature and its test inside one directory', () => {
		const skeleton = featureSkeleton(request());
		expect(skeleton.directory).toBe('delta/own/sample');
		expect(skeleton.modules.map((module) => module.path)).toEqual([
			'delta/own/sample/sample.identifiers.ts',
			'delta/own/sample/sample.ts',
			'delta/own/sample/test/sample.test.ts'
		]);
		expect(skeleton.modules.map((module) => module.role)).toEqual(['identifiers', 'feature', 'test']);
		for (const module of skeleton.modules) {
			expect(module.path.startsWith(`${skeleton.directory}/`)).toBe(true);
			expect(module.text.endsWith('\n')).toBe(true);
		}
	});

	it('carries the feature id in the identifier module and the contract test', () => {
		const skeleton = featureSkeleton(request());
		expect(skeleton.modules[0]?.text).toContain(`${featureConstant('sample')} = 'acme.sample'`);
		expect(skeleton.modules[2]?.text).toContain("suite('acme.sample'");
	});

	it('declares the setting only when the run asked for one', () => {
		expect(featureSkeleton(request({ setting: true })).modules[0]?.text).toContain(settingId('acme.sample'));
		expect(featureSkeleton(request()).modules[0]?.text).not.toContain('_SETTING');
	});

	it('says what a plain upstream still asks of a person', () => {
		const skeleton = featureSkeleton(request());
		expect(skeleton.importLine).toContain('sample');
		expect(skeleton.reminders.join(' ')).toContain('no entry module');
		expect(skeleton.reminders.join(' ')).toContain('contractTests');
	});
});

describe('the brand graft', () => {
	it('does not exist: a plain upstream has no string funnel to graft into', () => {
		expect(generators.brandGraft).toBeUndefined();
	});
});
