// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FeatureFlagsServiceBase } from '../../common/features/featureFlagsServiceBase.js';
import { FlagLayer } from '../../common/features/flagLayers.js';
import { descriptor, FakeSource, RecordingPublisher, RecordingRestart } from './testDoubles.js';

suite('codkit runtime: feature flags service core', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function build(descriptors = [descriptor('acme.hot'), descriptor('acme.cold', { hotToggle: false, default: true })]) {
		const user = new FakeSource([FlagLayer.Policy, FlagLayer.User]);
		const remote = new FakeSource([FlagLayer.RemoteForce, FlagLayer.RemoteDefault]);
		const publisher = new RecordingPublisher();
		const restart = new RecordingRestart();
		const service = store.add(new FeatureFlagsServiceBase(descriptors, [user, remote], publisher, restart, undefined));
		return { service, user, remote, publisher, restart };
	}

	test('initial states come from the sources and every context key is published', () => {
		const { service, publisher } = build();
		assert.deepStrictEqual(service.features.map((feature) => feature.id), ['acme.hot', 'acme.cold']);
		assert.deepStrictEqual(service.enablement('acme.hot').get(), { enabled: false, decidedBy: FlagLayer.Default });
		assert.deepStrictEqual(service.enablement('acme.cold').get(), { enabled: true, decidedBy: FlagLayer.Default });
		assert.deepStrictEqual(publisher.published, [['acme.hot', false], ['acme.cold', true]]);
	});

	test('a source change recomputes only the named features and fires once with the changed ids', () => {
		const { service, user, publisher } = build();
		const events: (readonly string[])[] = [];
		store.add(service.onDidChangeEnablement((ids) => events.push(ids)));
		user.set(FlagLayer.User, 'acme.hot', true);
		user.fire(['acme.hot']);
		assert.deepStrictEqual(service.enablement('acme.hot').get(), { enabled: true, decidedBy: FlagLayer.User });
		assert.deepStrictEqual(events, [['acme.hot']]);
		assert.deepStrictEqual(publisher.published.at(-1), ['acme.hot', true]);
		user.fire(['acme.hot']);
		assert.deepStrictEqual(events, [['acme.hot']], 'an unchanged recompute fires nothing');
	});

	test('a snapshot changing two features is one transaction and one event', () => {
		const { service, remote } = build([descriptor('acme.a'), descriptor('acme.b')]);
		const events: (readonly string[])[] = [];
		store.add(service.onDidChangeEnablement((ids) => events.push(ids)));
		remote.set(FlagLayer.RemoteForce, 'acme.a', true);
		remote.set(FlagLayer.RemoteDefault, 'acme.b', true);
		remote.fire(undefined);
		assert.deepStrictEqual(events, [['acme.a', 'acme.b']]);
		assert.deepStrictEqual(service.explain('acme.a').effective, { enabled: true, decidedBy: FlagLayer.RemoteForce });
		assert.deepStrictEqual(service.explain('acme.b').effective, { enabled: true, decidedBy: FlagLayer.RemoteDefault });
	});

	test('a cold feature keeps its frozen value, reports a pending restart and asks once', () => {
		const { service, user, restart } = build();
		const events: (readonly string[])[] = [];
		store.add(service.onDidChangeEnablement((ids) => events.push(ids)));
		user.set(FlagLayer.User, 'acme.cold', false);
		user.fire(['acme.cold']);
		assert.deepStrictEqual(service.enablement('acme.cold').get(), { enabled: true, decidedBy: FlagLayer.Default }, 'frozen');
		assert.deepStrictEqual(service.liveState('acme.cold').get(), { enabled: false, decidedBy: FlagLayer.User }, 'live');
		assert.deepStrictEqual(service.restartPending.get(), ['acme.cold']);
		assert.deepStrictEqual(events, [], 'the effective state did not change');
		assert.deepStrictEqual(restart.requests, [['acme.cold']]);
		user.set(FlagLayer.Policy, 'acme.cold', false);
		user.fire(['acme.cold']);
		assert.deepStrictEqual(restart.requests, [['acme.cold']], 'the same pending set is not asked twice');
		user.set(FlagLayer.User, 'acme.cold', undefined);
		user.set(FlagLayer.Policy, 'acme.cold', undefined);
		user.fire(['acme.cold']);
		assert.deepStrictEqual(service.restartPending.get(), [], 'back to the frozen value clears the pending restart');
		assert.strictEqual(service.explain('acme.cold').restartPending, false);
	});

	test('explain lists every reading in source order', () => {
		const { service, user, remote } = build();
		user.set(FlagLayer.Policy, 'acme.hot', true);
		remote.set(FlagLayer.RemoteDefault, 'acme.hot', false);
		const explanation = service.explain('acme.hot');
		assert.deepStrictEqual(explanation.readings, [
			{ layer: FlagLayer.Policy, value: true },
			{ layer: FlagLayer.User, value: undefined },
			{ layer: FlagLayer.RemoteForce, value: undefined },
			{ layer: FlagLayer.RemoteDefault, value: false },
		]);
	});

	test('an unknown id is a programming error', () => {
		const { service } = build();
		assert.throws(() => service.enablement('acme.unknown'), /unknown feature id 'acme.unknown'/);
		assert.throws(() => service.explain('acme.unknown'), /unknown feature id/);
		assert.strictEqual(service.isEnabled('acme.cold'), true);
	});

	test('disposing the service stops listening to its sources', () => {
		const user = new FakeSource([FlagLayer.User]);
		const publisher = new RecordingPublisher();
		const service = new FeatureFlagsServiceBase([descriptor('acme.hot')], [user], publisher, new RecordingRestart(), undefined);
		service.dispose();
		user.set(FlagLayer.User, 'acme.hot', true);
		assert.doesNotThrow(() => user.fire(['acme.hot']));
		assert.deepStrictEqual(publisher.published, [['acme.hot', false]]);
	});
});
