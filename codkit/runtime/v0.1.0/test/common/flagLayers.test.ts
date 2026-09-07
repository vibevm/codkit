// Copyright (c) 2026 Oleg Chirukhin
// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
// SPDX-License-Identifier: UPL-1.0

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { FLAG_LAYER_PRECEDENCE, FlagLayer, resolveFeature, sameState, type FlagReading } from '../../common/features/flagLayers.js';
import { descriptor } from './testDoubles.js';

suite('codkit runtime: flag layers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const feature = descriptor('acme.sample', { default: false });

	test('precedence is build, policy, remote-force, user, remote-default, default', () => {
		assert.deepStrictEqual(FLAG_LAYER_PRECEDENCE, [
			FlagLayer.Build, FlagLayer.Policy, FlagLayer.RemoteForce, FlagLayer.User, FlagLayer.RemoteDefault, FlagLayer.Default,
		]);
	});

	test('the declaration default decides when no layer speaks', () => {
		assert.deepStrictEqual(resolveFeature(feature, []), { enabled: false, decidedBy: FlagLayer.Default });
		assert.deepStrictEqual(resolveFeature(descriptor('acme.on', { default: true }), []), { enabled: true, decidedBy: FlagLayer.Default });
	});

	test('the highest defined layer wins, whatever the order of readings', () => {
		const readings: FlagReading[] = [
			{ layer: FlagLayer.User, value: true },
			{ layer: FlagLayer.RemoteDefault, value: false },
			{ layer: FlagLayer.Policy, value: false },
			{ layer: FlagLayer.Build, value: undefined },
		];
		assert.deepStrictEqual(resolveFeature(feature, readings), { enabled: false, decidedBy: FlagLayer.Policy });
	});

	test('a build value cannot be undone by any other layer', () => {
		const readings: FlagReading[] = [
			{ layer: FlagLayer.Build, value: false },
			{ layer: FlagLayer.Policy, value: true },
			{ layer: FlagLayer.RemoteForce, value: true },
			{ layer: FlagLayer.User, value: true },
			{ layer: FlagLayer.RemoteDefault, value: true },
		];
		assert.deepStrictEqual(resolveFeature(feature, readings), { enabled: false, decidedBy: FlagLayer.Build });
	});

	test('remote force beats the user, remote default yields to the user', () => {
		assert.deepStrictEqual(
			resolveFeature(feature, [{ layer: FlagLayer.RemoteForce, value: false }, { layer: FlagLayer.User, value: true }]),
			{ enabled: false, decidedBy: FlagLayer.RemoteForce },
		);
		assert.deepStrictEqual(
			resolveFeature(feature, [{ layer: FlagLayer.RemoteDefault, value: false }, { layer: FlagLayer.User, value: true }]),
			{ enabled: true, decidedBy: FlagLayer.User },
		);
		assert.deepStrictEqual(
			resolveFeature(feature, [{ layer: FlagLayer.RemoteDefault, value: true }]),
			{ enabled: true, decidedBy: FlagLayer.RemoteDefault },
		);
	});

	test('a table of every single-layer decision', () => {
		const table = FLAG_LAYER_PRECEDENCE
			.filter((layer) => layer !== FlagLayer.Default)
			.map((layer) => [layer, resolveFeature(feature, [{ layer, value: true }])]);
		assert.deepStrictEqual(table, [
			[FlagLayer.Build, { enabled: true, decidedBy: FlagLayer.Build }],
			[FlagLayer.Policy, { enabled: true, decidedBy: FlagLayer.Policy }],
			[FlagLayer.RemoteForce, { enabled: true, decidedBy: FlagLayer.RemoteForce }],
			[FlagLayer.User, { enabled: true, decidedBy: FlagLayer.User }],
			[FlagLayer.RemoteDefault, { enabled: true, decidedBy: FlagLayer.RemoteDefault }],
		]);
	});

	test('sameState compares both fields', () => {
		assert.ok(sameState({ enabled: true, decidedBy: FlagLayer.User }, { enabled: true, decidedBy: FlagLayer.User }));
		assert.ok(!sameState({ enabled: true, decidedBy: FlagLayer.User }, { enabled: true, decidedBy: FlagLayer.Build }));
		assert.ok(!sameState({ enabled: true, decidedBy: FlagLayer.User }, { enabled: false, decidedBy: FlagLayer.User }));
	});
});
