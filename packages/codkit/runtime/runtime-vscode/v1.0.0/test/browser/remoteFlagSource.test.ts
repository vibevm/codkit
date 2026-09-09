// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../platform/storage/common/storage.js';
import { RemoteFlagSource } from '../../browser/adapters/remoteFlagSource.js';
import { REMOTE_SNAPSHOT_STORAGE_KEY, StorageRemoteFlagsProvider } from '../../browser/adapters/storageRemoteFlagsProvider.js';
import { FlagLayer } from '../../common/features/flagLayers.js';
import { descriptor } from '../common/testDoubles.js';

suite('codkit runtime: remote flag source and its simulator', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function build() {
		const storage = store.add(new InMemoryStorageService());
		const provider = store.add(new StorageRemoteFlagsProvider(storage));
		const source = store.add(new RemoteFlagSource(provider));
		return { storage, provider, source };
	}

	test('no snapshot means the remote does not decide', () => {
		const { source } = build();
		assert.deepStrictEqual(source.layers, [FlagLayer.RemoteForce, FlagLayer.RemoteDefault]);
		assert.deepStrictEqual(source.read(descriptor('acme.a')), [
			{ layer: FlagLayer.RemoteForce, value: undefined },
			{ layer: FlagLayer.RemoteDefault, value: undefined },
		]);
	});

	test('a simulated snapshot reaches the source and asks for a full recompute', () => {
		const { provider, source } = build();
		const fired: (readonly string[] | undefined)[] = [];
		store.add(source.onDidChange((ids) => fired.push(ids)));
		provider.simulate({ force: { 'acme.a': false }, defaults: { 'sample-key': true } });
		assert.deepStrictEqual(fired, [undefined]);
		assert.deepStrictEqual(source.read(descriptor('acme.a')), [
			{ layer: FlagLayer.RemoteForce, value: false },
			{ layer: FlagLayer.RemoteDefault, value: undefined },
		]);
		assert.deepStrictEqual(source.read(descriptor('acme.b', { remote: { key: 'sample-key' } })), [
			{ layer: FlagLayer.RemoteForce, value: undefined },
			{ layer: FlagLayer.RemoteDefault, value: true },
		]);
	});

	test('null removes a key, clear removes the snapshot', () => {
		const { provider, storage } = build();
		provider.simulate({ force: { 'acme.a': true, 'acme.b': true } });
		provider.simulate({ force: { 'acme.a': null } });
		assert.deepStrictEqual(provider.current(), { version: 1, force: { 'acme.b': true }, defaults: {} });
		provider.clear();
		assert.strictEqual(provider.current(), undefined);
		assert.strictEqual(storage.get(REMOTE_SNAPSHOT_STORAGE_KEY, -1), undefined);
	});

	test('a corrupt stored snapshot is ignored, never thrown', () => {
		const { provider, storage, source } = build();
		storage.store(REMOTE_SNAPSHOT_STORAGE_KEY, '{not json', -1, 1);
		assert.strictEqual(provider.current(), undefined);
		assert.deepStrictEqual(source.read(descriptor('acme.a'))[0], { layer: FlagLayer.RemoteForce, value: undefined });
	});
});
