// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IProductConfiguration } from '../../../../base/common/product.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { declareFeatureWith } from '../../browser/featureRegistry.js';
import { FeatureDeclarations } from '../../common/features/featureDeclarations.js';
import { FeaturePhase } from '../../common/features/featureDescriptor.js';
import { descriptor } from '../common/testDoubles.js';

class SampleFeature extends Disposable { }

suite('codkit runtime: feature registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const product = { nameShort: 'Sample' } as Partial<IProductConfiguration> as IProductConfiguration;

	function deregister(settingId: string): void {
		registry.deregisterConfigurations([{ id: settingId, properties: { [settingId]: { type: 'boolean' } } }]);
	}

	test('a feature with a setting registers the setting with the declaration default', () => {
		const declarations = new FeatureDeclarations();
		const feature = descriptor('acme.registered', { default: true, setting: { id: 'acme.registered.enabled', description: 'Registered' } });
		try {
			declareFeatureWith(declarations, registry, product, feature, SampleFeature, FeaturePhase.Eventually);
			const property = registry.getConfigurationProperties()['acme.registered.enabled'];
			assert.ok(property, 'the setting is registered');
			assert.strictEqual(property.default, true);
			assert.strictEqual(property.description, 'Registered');
			assert.strictEqual(declarations.byId('acme.registered')?.phase, FeaturePhase.Eventually);
		} finally {
			deregister('acme.registered.enabled');
		}
	});

	test('a build-forced feature declares itself but registers no setting', () => {
		const declarations = new FeatureDeclarations();
		const feature = descriptor('acme.forced', { setting: { id: 'acme.forced.enabled', description: 'Forced' }, product: () => false });
		declareFeatureWith(declarations, registry, product, feature, SampleFeature, FeaturePhase.AfterRestored);
		assert.strictEqual(registry.getConfigurationProperties()['acme.forced.enabled'], undefined);
		assert.strictEqual(declarations.all().length, 1);
	});

	test('an invalid descriptor throws before anything is declared', () => {
		const declarations = new FeatureDeclarations();
		assert.throws(() => declareFeatureWith(declarations, registry, product, descriptor('Bad'), SampleFeature, FeaturePhase.AfterRestored), /invalid feature declaration/);
		assert.strictEqual(declarations.all().length, 0);
	});

	test('the same id twice throws', () => {
		const declarations = new FeatureDeclarations();
		const feature = descriptor('acme.twice');
		declareFeatureWith(declarations, registry, product, feature, SampleFeature, FeaturePhase.AfterRestored);
		assert.throws(() => declareFeatureWith(declarations, registry, product, feature, SampleFeature, FeaturePhase.AfterRestored), /declared twice/);
	});
});
