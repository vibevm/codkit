// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import type { IProductConfiguration } from '../../../../base/common/product.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ProductFlagSource } from '../../browser/adapters/productFlagSource.js';
import { FlagLayer } from '../../common/features/flagLayers.js';
import { descriptor } from '../common/testDoubles.js';

suite('codkit runtime: product flag source', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const product = { nameShort: 'Sample', nameLong: 'Sample Editor' } as Partial<IProductConfiguration> as IProductConfiguration;

	test('the build layer is whatever the descriptor reads from the product', () => {
		const source = store.add(new ProductFlagSource(product));
		assert.deepStrictEqual(source.layers, [FlagLayer.Build]);
		assert.deepStrictEqual(source.read(descriptor('acme.a')), [{ layer: FlagLayer.Build, value: undefined }]);
		assert.deepStrictEqual(source.read(descriptor('acme.b', { product: (p) => p.nameShort === 'Sample' })), [{ layer: FlagLayer.Build, value: true }]);
		assert.deepStrictEqual(source.read(descriptor('acme.c', { product: () => false })), [{ layer: FlagLayer.Build, value: false }]);
	});

	test('the product never changes at runtime, so the source never fires', () => {
		const source = store.add(new ProductFlagSource(product));
		let fired = 0;
		store.add(source.onDidChange(() => fired++));
		assert.strictEqual(fired, 0);
	});
});
