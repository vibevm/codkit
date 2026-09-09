// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyRemoteFlagsPatch, EMPTY_REMOTE_SNAPSHOT, parseRemoteFlagsSnapshot, serializeRemoteFlagsSnapshot } from '../../common/features/remoteFlags.js';

suite('codkit runtime: remote snapshot', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a valid snapshot round-trips', () => {
		const snapshot = { version: 1 as const, force: { 'acme.a': false }, defaults: { 'acme.b': true }, issuedAt: '2026-09-07T00:00:00Z' };
		assert.deepStrictEqual(parseRemoteFlagsSnapshot(serializeRemoteFlagsSnapshot(snapshot)), snapshot);
	});

	test('missing buckets default to empty', () => {
		assert.deepStrictEqual(parseRemoteFlagsSnapshot('{"version":1}'), { version: 1, force: {}, defaults: {} });
	});

	test('anything malformed is undefined, never an exception', () => {
		const inputs = ['', 'not json', '[]', 'null', '{"version":2}', '{"version":1,"force":{"a":"yes"}}', '{"version":1,"defaults":[true]}', '{"version":1,"issuedAt":5}'];
		assert.deepStrictEqual(inputs.map((input) => parseRemoteFlagsSnapshot(input)), inputs.map(() => undefined));
	});

	test('a patch sets and removes keys without touching the other bucket', () => {
		const base = applyRemoteFlagsPatch(EMPTY_REMOTE_SNAPSHOT, { force: { 'acme.a': true, 'acme.b': false }, defaults: { 'acme.c': true } });
		const next = applyRemoteFlagsPatch(base, { force: { 'acme.a': null }, defaults: { 'acme.d': false } });
		assert.deepStrictEqual(next, { version: 1, force: { 'acme.b': false }, defaults: { 'acme.c': true, 'acme.d': false } });
		assert.deepStrictEqual(base.force, { 'acme.a': true, 'acme.b': false }, 'the input snapshot is not mutated');
	});
});
