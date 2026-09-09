// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

// The assumptions the runtime makes about upstream. When one of these goes
// red on a new pin, the failing test names the assumption that moved.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

interface ISampleService {
	readonly _serviceBrand: undefined;
	readonly name: string;
}
const ISampleService = createDecorator<ISampleService>('codkitContractSample');

suite('codkit runtime: contracts with upstream', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the last registration of a service id wins in a ServiceCollection (service-override reach)', () => {
		const collection = new ServiceCollection();
		collection.set(ISampleService, { _serviceBrand: undefined, name: 'first' });
		collection.set(ISampleService, { _serviceBrand: undefined, name: 'second' });
		assert.strictEqual((collection.get(ISampleService) as ISampleService).name, 'second');
	});

	test('a configuration property with included: false is not published by the registry', () => {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const node = { id: 'codkit.contract', properties: { 'codkit.contract.hidden': { type: 'boolean' as const, default: false, included: false } } };
		registry.registerConfiguration(node);
		try {
			assert.strictEqual(registry.getConfigurationProperties()['codkit.contract.hidden'], undefined);
		} finally {
			registry.deregisterConfigurations([node]);
		}
	});

	test('a configuration change event answers affectsConfiguration for the changed key', async () => {
		const configuration = new TestConfigurationService();
		let affected = false;
		const listener = configuration.onDidChangeConfiguration((event) => { affected = event.affectsConfiguration('codkit.contract.flag'); });
		await configuration.updateValue('codkit.contract.flag', true);
		configuration.onDidChangeConfigurationEmitter.fire({
			affectsConfiguration: (section: string) => section === 'codkit.contract.flag',
			affectedKeys: new Set(['codkit.contract.flag']),
			source: 2,
			change: { keys: ['codkit.contract.flag'], overrides: [] },
		});
		listener.dispose();
		assert.strictEqual(affected, true);
	});
});
