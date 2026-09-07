// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IConfigurationOverrides, IConfigurationValue } from '../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ConfigurationFlagSource } from '../../browser/adapters/configurationFlagSource.js';
import { FlagLayer } from '../../common/features/flagLayers.js';
import { descriptor } from '../common/testDoubles.js';

/** The upstream test double plus a policy value, which it does not model. */
class PolicyAwareConfigurationService extends TestConfigurationService {
	policyValues = new Map<string, boolean>();

	override inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<T> {
		const inspected = super.inspect<T>(key, overrides);
		const policy = this.policyValues.get(key);
		return policy === undefined ? inspected : { ...inspected, policyValue: policy as unknown as T };
	}
}

suite('codkit runtime: configuration flag source', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const withSetting = descriptor('acme.a', { setting: { id: 'acme.a.enabled', description: 'a' } });
	const withoutSetting = descriptor('acme.b');

	test('reads the user layer from the configuration and the policy layer from the policy value', async () => {
		const configuration = new PolicyAwareConfigurationService();
		const source = store.add(new ConfigurationFlagSource([withSetting, withoutSetting], configuration));
		assert.deepStrictEqual(source.layers, [FlagLayer.Policy, FlagLayer.User]);
		assert.deepStrictEqual(source.read(withSetting), [{ layer: FlagLayer.Policy, value: undefined }, { layer: FlagLayer.User, value: undefined }]);
		await configuration.setUserConfiguration('acme.a.enabled', true);
		assert.deepStrictEqual(source.read(withSetting), [{ layer: FlagLayer.Policy, value: undefined }, { layer: FlagLayer.User, value: true }]);
		configuration.policyValues.set('acme.a.enabled', false);
		assert.deepStrictEqual(source.read(withSetting), [{ layer: FlagLayer.Policy, value: false }, { layer: FlagLayer.User, value: true }]);
	});

	test('a feature without a setting reads undefined on both layers', () => {
		const source = store.add(new ConfigurationFlagSource([withSetting, withoutSetting], new PolicyAwareConfigurationService()));
		assert.deepStrictEqual(source.read(withoutSetting), [{ layer: FlagLayer.Policy, value: undefined }, { layer: FlagLayer.User, value: undefined }]);
	});

	test('a non-boolean value is ignored', async () => {
		const configuration = new PolicyAwareConfigurationService();
		const source = store.add(new ConfigurationFlagSource([withSetting], configuration));
		await configuration.setUserConfiguration('acme.a.enabled', 'yes');
		assert.deepStrictEqual(source.read(withSetting)[1], { layer: FlagLayer.User, value: undefined });
	});

	test('fires the ids whose setting the configuration change affects', () => {
		const configuration = new PolicyAwareConfigurationService();
		const source = store.add(new ConfigurationFlagSource([withSetting, withoutSetting], configuration));
		const fired: (readonly string[] | undefined)[] = [];
		store.add(source.onDidChange((ids) => fired.push(ids)));
		configuration.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: (section: string) => section === 'acme.a.enabled',
			affectedKeys: new Set(['acme.a.enabled']),
			source: 2,
			change: { keys: ['acme.a.enabled'], overrides: [] },
		});
		configuration.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: () => false,
			affectedKeys: new Set(['other']),
			source: 2,
			change: { keys: ['other'], overrides: [] },
		});
		assert.deepStrictEqual(fired, [['acme.a']]);
	});
});
