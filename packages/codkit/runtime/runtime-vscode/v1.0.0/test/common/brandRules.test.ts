// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { affectedEntries, createBrandTransform } from '../../common/brand/brandRules.js';

suite('codkit runtime: brand rules', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const transform = createBrandTransform([
		{ find: 'Upstream Editor', replace: 'Acme Editor', except: ['Upstream Editor Speech'] },
		{ find: 'Upstream', replace: 'Acme' },
	]);

	test('replaces every occurrence, rule by rule', () => {
		assert.strictEqual(transform('Welcome to Upstream Editor. Upstream Editor is ready.'), 'Welcome to Acme Editor. Acme Editor is ready.');
		assert.strictEqual(transform('Open in Upstream'), 'Open in Acme');
	});

	test('an exception skips only the rule that names it', () => {
		assert.strictEqual(transform('Install the \'Upstream Editor Speech\' extension'), 'Install the \'Acme Editor Speech\' extension');
	});

	test('a message without any find is returned as the same string', () => {
		const message = 'Nothing to brand here';
		assert.strictEqual(transform(message), message);
	});

	test('the transform is idempotent and cached', () => {
		const once = transform('Upstream Editor');
		assert.strictEqual(transform(once), once);
		assert.strictEqual(transform('Upstream Editor'), once);
	});

	test('rules that do nothing are dropped and an empty table is the identity', () => {
		const identity = createBrandTransform([{ find: '', replace: 'x' }, { find: 'same', replace: 'same' }]);
		assert.strictEqual(identity('same same'), 'same same');
	});

	test('affectedEntries names the keys a transform changes', () => {
		const entries: (readonly [string, string])[] = [
			['a', 'Upstream is here'],
			['b', 'Untouched'],
			['c', 'Upstream Editor Speech'],
		];
		assert.deepStrictEqual(affectedEntries(transform, entries), ['a', 'c']);
	});
});
