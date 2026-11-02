// unit: what the drift detector says about an append (PROP-005
// ##OVERLAY-APPEND, ##OVERLAY-DRIFT-DETECTOR). An append names the product's
// element and nothing of upstream's list, so the only thing the pin owes it is
// an array at the path: a scalar, an object or no key there is a drift of its
// own kind, and an `expectUpstream`, when given, is compared with the whole
// array like any other expectation.

import { afterAll, describe, expect, it } from 'vitest';
import type { Overlay, OverlayVarContext } from '../../src/lib/layers/overlay.ts';
import { checkOverlay, overlayDriftErrors, parseOverlay } from '../../src/lib/layers/overlay.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const ARTIFACT = 'delta/overlays/manifest.json.addons.overlay.json';
const ELEMENT = { name: 'acme.pack', version: '1.0.0', sha256: 'a'.repeat(64) };

afterAll(cleanupTempRoots);

function overlayWith(operations: readonly Record<string, unknown>[]): Overlay {
	return parseOverlay(
		{
			codkitOverlay: 2,
			id: 'CK-product-903',
			target: 'manifest.json',
			type: 'extend',
			category: 'own',
			owner: 'product',
			reason: 'fixture: the product bundles one add-on',
			link: 'none',
			cause: 'none',
			pin: 'ignored@0000000000000000000000000000000000000000',
			contractTests: ['CK-product-903'],
			operations
		},
		ARTIFACT
	);
}

describe('checkOverlay with an append', () => {
	const fixture = makeUpstream(makeTempRoot('overlay-append-check'));
	const context: OverlayVarContext = {
		pinTag: fixture.t1.tag,
		pinSha: fixture.t1.sha,
		pinDate: '2026-01-01',
		patchSetCommit: 'a'.repeat(40),
		buildDate: '2026-01-01'
	};
	const check = (overlay: Overlay) =>
		checkOverlay(overlay, { type: stubProjectType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context, pinOnly: true });

	it('agrees with a pin that carries an array at the path, with or without an expectation', () => {
		expect(check(overlayWith([{ op: 'append', path: ['builtInAddons'], value: ELEMENT }])).drift).toEqual([]);
		expect(check(overlayWith([{ op: 'append', path: ['builtInAddons'], value: ELEMENT, expectUpstream: [] }])).drift).toEqual([]);
	});

	it('drifts when the pin holds something else at the path, or no key at all', () => {
		for (const path of [['addonGallery'], ['displayName'], ['neverThere']]) {
			const report = check(overlayWith([{ op: 'append', path, value: ELEMENT }]));
			expect(report.drift).toHaveLength(1);
			expect(report.drift[0]?.needsArray).toBe(true);
			const error = overlayDriftErrors(report.drift)[0];
			expect(error?.code).toBe('OVERLAY-DRIFT');
			expect(error?.message).toContain(`manifest.json:${path.join('.')} at the pin is`);
			expect(error?.message).toContain('appends to it and needs an array there');
		}
	});

	it('still compares an expectation with the whole array', () => {
		const report = check(overlayWith([{ op: 'append', path: ['builtInAddons'], value: ELEMENT, expectUpstream: [ELEMENT] }]));
		expect(report.drift).toHaveLength(1);
		expect(report.drift[0]?.needsArray).toBeUndefined();
		expect(overlayDriftErrors(report.drift)[0]?.message).toContain('but the overlay expects');
	});
});
