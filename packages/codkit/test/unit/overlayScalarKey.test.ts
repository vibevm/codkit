// The guarded replacement of a top-level scalar on a restricted overlay target
// (PROP-016 ##TYPE-AREA-LAYERS `allowedScalarKeys`, PROP-005
// ##OVERLAY-NPM-DECLARED-TARGETS): the licence identifier of a manifest is set
// with the pin's value as `expectUpstream`, and nothing else about the target
// opens up.

import { describe, expect, it } from 'vitest';
import { projectType as stubType } from '../fixtures/stubType.ts';
import { parseOverlay, restrictedTargetViolations } from '../../src/lib/layers/overlay.ts';
import type { Overlay } from '../../src/lib/layers/overlay.ts';

function overlayWith(operations: readonly Record<string, unknown>[]): Overlay {
	return parseOverlay(
		{
			codkitOverlay: 2,
			id: 'CK-product-950',
			target: 'package.json',
			type: 'modify',
			category: 'follow',
			owner: 'product',
			reason: 'the licence of the product',
			link: 'none',
			cause: 'none',
			pin: 't1@0000000000000000000000000000000000000000',
			contractTests: ['licence-leftovers'],
			operations
		},
		'delta/overlays/package.json.overlay.json'
	);
}

describe('a guarded scalar key of a restricted overlay target', () => {
	it('allows a set of the key with a string value and an upstream expectation', () => {
		const overlay = overlayWith([{ op: 'set', path: ['license'], value: 'LicenseRef-FIXTURE-Private-1.0', expectUpstream: 'MIT' }]);
		expect(restrictedTargetViolations(stubType, overlay)).toEqual([]);
	});

	it('keeps the additions under scripts allowed beside it', () => {
		const overlay = overlayWith([
			{ op: 'set', path: ['scripts', 'patchset-check'], value: 'node check.mjs', expectUpstream: { $absent: true } },
			{ op: 'set', path: ['license'], value: 'LicenseRef-FIXTURE-Private-1.0', expectUpstream: 'MIT' }
		]);
		expect(restrictedTargetViolations(stubType, overlay)).toEqual([]);
	});

	it('refuses the key without an upstream expectation, with a non-string value, and any other scalar', () => {
		const cases: readonly Record<string, unknown>[] = [
			{ op: 'set', path: ['license'], value: 'LicenseRef-FIXTURE-Private-1.0' },
			{ op: 'set', path: ['license'], value: { spdx: 'MIT' }, expectUpstream: 'MIT' },
			{ op: 'set', path: ['name'], value: 'product', expectUpstream: 'upstream' }
		];
		for (const operation of cases) {
			const violations = restrictedTargetViolations(stubType, overlayWith([operation]));
			expect(violations).toHaveLength(1);
			expect(violations[0]?.message).toContain(
				'only additions under scripts and guarded replacements of license are allowed for this target'
			);
		}
	});

	it('refuses a remove of the key: a scalar is replaced, never dropped', () => {
		const violations = restrictedTargetViolations(stubType, overlayWith([{ op: 'remove', path: ['license'], expectUpstream: 'MIT' }]));
		expect(violations).toHaveLength(1);
	});
});
