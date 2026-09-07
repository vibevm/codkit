// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { contextKeyOf, remoteKeyOf, validateFeatureDescriptor } from '../../common/features/featureDescriptor.js';
import { descriptor } from './testDoubles.js';

suite('codkit runtime: feature descriptor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a well-formed descriptor has no problems', () => {
		assert.deepStrictEqual(validateFeatureDescriptor(descriptor('acme.smartPaste')), []);
		assert.deepStrictEqual(validateFeatureDescriptor(descriptor('acme.editor.smartPaste2', {
			setting: { id: 'acme.smartPaste.enabled', description: 'Smart paste' },
		})), []);
	});

	test('the id needs at least two camelCase segments', () => {
		for (const id of ['Sample', 'sample', 'acme.Sample', 'acme..sample', 'acme.sample.', 'acme-x.sample', '']) {
			const problems = validateFeatureDescriptor(descriptor(id));
			assert.strictEqual(problems.length, 1, id);
			assert.ok(problems[0].includes('camelCase'), id);
		}
	});

	test('empty title, setting id, description and remote key are reported', () => {
		const problems = validateFeatureDescriptor(descriptor('acme.sample', {
			title: ' ',
			setting: { id: '', description: '' },
			remote: { key: '' },
		}));
		assert.deepStrictEqual(problems.map((problem) => problem.split(' ')[0]), ['feature', 'feature', 'feature', 'feature']);
		assert.strictEqual(problems.length, 4);
	});

	test('remote and context keys derive from the id', () => {
		assert.strictEqual(remoteKeyOf(descriptor('acme.sample')), 'acme.sample');
		assert.strictEqual(remoteKeyOf(descriptor('acme.sample', { remote: { key: 'sample-v2' } })), 'sample-v2');
		assert.strictEqual(contextKeyOf(descriptor('acme.sample')), 'acme.sample.enabled');
	});
});
