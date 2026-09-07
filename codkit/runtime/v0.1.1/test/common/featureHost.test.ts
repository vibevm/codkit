// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// allow-any-unicode-next-line
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FeatureDeclarations, type FeatureConstructor } from '../../common/features/featureDeclarations.js';
import { FeaturePhase } from '../../common/features/featureDescriptor.js';
import { FeatureFlagsServiceBase } from '../../common/features/featureFlagsServiceBase.js';
import { FeatureHost, FeatureHostRegistry } from '../../common/features/featureHost.js';
import { FlagLayer } from '../../common/features/flagLayers.js';
import { descriptor, FakeSource, RecordingPublisher, RecordingRestart } from './testDoubles.js';

class SampleFeature extends Disposable {
	static created = 0;
	static disposed = 0;
	constructor() {
		super();
		SampleFeature.created++;
	}
	override dispose(): void {
		SampleFeature.disposed++;
		super.dispose();
	}
}

class BrokenFeature implements IDisposable {
	constructor() {
		throw new Error('boom');
	}
	dispose(): void { }
}

suite('codkit runtime: feature host', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function build(hot = true) {
		SampleFeature.created = 0;
		SampleFeature.disposed = 0;
		const user = new FakeSource([FlagLayer.User]);
		const feature = descriptor('acme.sample', { hotToggle: hot });
		const service = store.add(new FeatureFlagsServiceBase([feature], [user], new RecordingPublisher(), new RecordingRestart(), undefined));
		const logged: unknown[] = [];
		const create = (ctor: FeatureConstructor) => new ctor();
		return { feature, service, user, logged, create };
	}

	test('the instance lives exactly while the flag is on', () => {
		const { feature, service, user, logged, create } = build();
		const host = store.add(new FeatureHost(feature, SampleFeature, service, create, (error) => logged.push(error)));
		assert.strictEqual(host.state.get(), 'inactive');
		assert.strictEqual(SampleFeature.created, 0);
		user.set(FlagLayer.User, 'acme.sample', true);
		user.fire(['acme.sample']);
		assert.strictEqual(host.state.get(), 'active');
		assert.deepStrictEqual([SampleFeature.created, SampleFeature.disposed], [1, 0]);
		user.set(FlagLayer.User, 'acme.sample', false);
		user.fire(['acme.sample']);
		assert.strictEqual(host.state.get(), 'inactive');
		assert.deepStrictEqual([SampleFeature.created, SampleFeature.disposed], [1, 1]);
		user.set(FlagLayer.User, 'acme.sample', true);
		user.fire(['acme.sample']);
		assert.deepStrictEqual([SampleFeature.created, SampleFeature.disposed], [2, 1], 're-enabling creates a new instance');
		assert.deepStrictEqual(logged, []);
	});

	test('disposing the host disposes the instance', () => {
		const { feature, service, user, logged, create } = build();
		user.set(FlagLayer.User, 'acme.sample', true);
		user.fire(['acme.sample']);
		const host = new FeatureHost(feature, SampleFeature, service, create, (error) => logged.push(error));
		assert.strictEqual(SampleFeature.created, 1);
		host.dispose();
		assert.strictEqual(SampleFeature.disposed, 1);
	});

	test('a constructor that throws marks the feature failed and is logged, not thrown', () => {
		const { feature, service, user, logged, create } = build();
		user.set(FlagLayer.User, 'acme.sample', true);
		user.fire(['acme.sample']);
		const host = store.add(new FeatureHost(feature, BrokenFeature, service, create, (error) => logged.push(error)));
		assert.strictEqual(host.state.get(), 'failed');
		assert.strictEqual(logged.length, 1);
		assert.ok(logged[0] instanceof Error && logged[0].message === 'boom');
	});

	test('a cold feature is not recreated when the live flag changes', () => {
		const { feature, service, user, logged, create } = build(false);
		const host = store.add(new FeatureHost(feature, SampleFeature, service, create, (error) => logged.push(error)));
		assert.strictEqual(host.state.get(), 'inactive');
		user.set(FlagLayer.User, 'acme.sample', true);
		user.fire(['acme.sample']);
		assert.strictEqual(host.state.get(), 'inactive', 'frozen at startup');
		assert.strictEqual(SampleFeature.created, 0);
	});

	test('the host registry reports instance states and forgets on dispose', () => {
		const { feature, service, logged, create } = build();
		const registry = new FeatureHostRegistry();
		const host = store.add(new FeatureHost(feature, SampleFeature, service, create, (error) => logged.push(error)));
		const registration = registry.register(host);
		assert.strictEqual(registry.stateOf('acme.sample'), 'inactive');
		registration.dispose();
		assert.strictEqual(registry.stateOf('acme.sample'), undefined);
	});

	test('declarations refuse a duplicate id and keep declaration order', () => {
		const declarations = new FeatureDeclarations();
		declarations.add({ descriptor: descriptor('acme.b'), ctor: SampleFeature, phase: FeaturePhase.AfterRestored });
		declarations.add({ descriptor: descriptor('acme.a'), ctor: SampleFeature, phase: FeaturePhase.Eventually });
		assert.deepStrictEqual(declarations.all().map((declaration) => declaration.descriptor.id), ['acme.b', 'acme.a']);
		assert.throws(() => declarations.add({ descriptor: descriptor('acme.a'), ctor: SampleFeature, phase: FeaturePhase.Eventually }), /declared twice/);
		assert.strictEqual(declarations.byId('acme.a')?.phase, FeaturePhase.Eventually);
	});
});
