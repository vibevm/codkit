// unit: channel 2 of the config-overlay layer - `overlay apply` and
// `overlay check` (PROP-005 ##OVERLAY-TWO-CHANNELS, PROP-007 sec. 12).
//
// The property that makes this channel usable is the base: the clean file at the
// pin, read from git objects, never the file in the tree. That is what makes
// applying an overlay twice write the same bytes, and what lets `check` say
// whether the file in the tree really is "the pin plus these operations".

import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	applyOverlayToTree,
	applyOverlaysToTree,
	checkOverlay,
	checkOverlayTarget,
	isExactOverlayMaterialization,
	overlayDriftErrors,
	parseOverlay,
	renderOverlayTarget,
	serializeOverlayTarget
} from '../../src/lib/layers/overlay.ts';
import type { Overlay, OverlayVarContext } from '../../src/lib/layers/overlay.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

const ARTIFACT = 'delta/overlays/product.json.overlay.json';

const BASE = {
	codkitOverlay: 2,
	id: 'CK-product-901',
	target: 'product.json',
	type: 'modify',
	category: 'own',
	owner: 'product',
	reason: 'fixture product identity',
	link: 'none',
	cause: 'none',
	pin: 'ignored@0000000000000000000000000000000000000000',
	contractTests: ['fixture.guard.product'],
	operations: [] as unknown[]
};

const CONTEXT: OverlayVarContext = {
	pinTag: 't1',
	pinSha: '0000000000000000000000000000000000000000',
	pinDate: '2026-01-01',
	patchSetCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	buildDate: '2026-01-01'
};

function overlay(operations: unknown[], overrides: Record<string, unknown> = {}): Overlay {
	return parseOverlay({ ...BASE, ...overrides, operations }, ARTIFACT);
}

/** A fresh pseudo-upstream: a git repository whose t1 tag is the pin. */
function upstreamAt(label: string): UpstreamFixture {
	return makeUpstream(makeTempRoot(label));
}

function productInTree(fixture: UpstreamFixture): string {
	return readFileSync(join(fixture.dir, 'product.json'), 'utf8');
}

afterAll(() => {
	cleanupTempRoots();
});

describe('applyOverlayToTree', () => {
	it('takes the clean pin file as its base, not the file in the tree', () => {
		const fixture = upstreamAt('overlay-apply-base');
		// Whatever the tree carries is irrelevant: this is what makes the second
		// apply write the same bytes as the first one.
		writeFileSync(join(fixture.dir, 'product.json'), '{\n\t"nameShort": "hand edited"\n}\n', 'utf8');

		const applied = applyOverlayToTree(
			overlay([{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }]),
			fixture.dir,
			fixture.t1.sha,
			CONTEXT
		);

		const written = JSON.parse(productInTree(fixture)) as Record<string, unknown>;
		expect(applied.changed).toBe(true);
		expect(written['nameShort']).toBe('Fixture PatchSet');
		// The keys of the pin are all still there: the base was the pin.
		expect(written['nameLong']).toBe('Fixture Code - OSS');
		expect(written['applicationName']).toBe('fixture-code');
	});

	it('serializes with tabs and a final line feed', () => {
		const fixture = upstreamAt('overlay-apply-bytes');

		applyOverlayToTree(overlay([{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }]), fixture.dir, fixture.t1.sha, CONTEXT);

		const text = productInTree(fixture);
		expect(text.startsWith('{\n\t"nameShort": "Fixture PatchSet",\n')).toBe(true);
		expect(text.endsWith('}\n')).toBe(true);
		expect(text).not.toContain('\n  ');
		// A nested object is indented with tabs too, not spaces.
		expect(text).toContain('\n\t"extensionsGallery": {\n\t\t"serviceUrl"');
	});

	it('is idempotent: the second apply writes nothing at all', () => {
		const fixture = upstreamAt('overlay-apply-twice');
		const sample = overlay([
			{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' },
			{ op: 'set', path: ['patchsetUpstreamPin'], value: { $var: 'pin.tag' } }
		]);

		const first = applyOverlayToTree(sample, fixture.dir, fixture.t1.sha, CONTEXT);
		const bytesAfterFirst = readFileSync(join(fixture.dir, 'product.json'));
		const second = applyOverlayToTree(sample, fixture.dir, fixture.t1.sha, CONTEXT);

		expect(first.changed).toBe(true);
		expect(second.changed).toBe(false);
		expect(readFileSync(join(fixture.dir, 'product.json')).equals(bytesAfterFirst)).toBe(true);
		expect((JSON.parse(productInTree(fixture)) as Record<string, unknown>)['patchsetUpstreamPin']).toBe('t1');
	});

	it('composes several overlays of one target over one base', () => {
		const fixture = upstreamAt('overlay-apply-compose');
		const rendered = renderOverlayTarget(
			[
				overlay([{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }]),
				overlay([{ op: 'set', path: ['extensionsGallery', 'serviceUrl'], value: 'https://gallery.patchset.invalid' }], {
					id: 'CK-product-903'
				})
			],
			fixture.dir,
			fixture.t1.sha,
			CONTEXT
		);

		const document = rendered.document as Record<string, Record<string, unknown>>;
		expect(rendered.overlayIds).toEqual(['CK-product-901', 'CK-product-903']);
		expect(document['nameShort']).toBe('Fixture PatchSet');
		expect(document['extensionsGallery']?.['serviceUrl']).toBe('https://gallery.patchset.invalid');
		// The sibling upstream put in the nested object is not lost.
		expect(document['extensionsGallery']?.['itemUrl']).toBe('https://gallery.fixture.invalid/item');
	});

	it('refuses a target the pin does not carry', () => {
		const fixture = upstreamAt('overlay-apply-missing');
		try {
			applyOverlayToTree(overlay([{ op: 'set', path: ['a'], value: 1 }], { target: 'nowhere.json' }), fixture.dir, fixture.t1.sha, CONTEXT);
		} catch (error) {
			expect(isCkError(error) && error.code).toBe('ARTIFACT-BROKEN');
			expect(String(error)).toContain('does not exist at the pin');
			return;
		}
		throw new Error('expected the call to fail');
	});

	it('refuses a symlink target without overwriting the external file', () => {
		const fixture = upstreamAt('overlay-apply-symlink');
		const outside = makeTempRoot('overlay-apply-symlink-outside');
		const victim = join(outside, 'product.json');
		writeFileSync(victim, '{\n\t"outside": true\n}\n', 'utf8');
		const target = join(fixture.dir, 'product.json');
		rmSync(target);
		symlinkSync(victim, target);

		expect(() =>
			applyOverlayToTree(overlay([{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }]), fixture.dir, fixture.t1.sha, CONTEXT)
		).toThrow(/symlink/i);
		expect(readFileSync(victim, 'utf8')).toBe('{\n\t"outside": true\n}\n');
	});
});

describe('serializeOverlayTarget', () => {
	it('reproduces the upstream style of product.json byte for byte when nothing changed', () => {
		const fixture = upstreamAt('overlay-serialize');
		const atPin = readFileSync(join(fixture.dir, 'product.json'), 'utf8');

		expect(serializeOverlayTarget(JSON.parse(atPin) as Record<string, never>)).toBe(atPin);
	});
});

describe('checkOverlay: expectUpstream against the pin', () => {
	it('says nothing when every expectation holds', () => {
		const fixture = upstreamAt('overlay-check-ok');
		const report = checkOverlay(
			overlay([
				{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet', expectUpstream: 'Fixture - OSS' },
				{ op: 'set', path: ['patchsetUpstreamPin'], value: { $var: 'pin.tag' }, expectUpstream: { $absent: true } },
				{
					op: 'set',
					path: ['extensionsGallery'],
					value: { serviceUrl: 'https://gallery.patchset.invalid' },
					expectUpstream: { serviceUrl: 'https://gallery.fixture.invalid/api', itemUrl: 'https://gallery.fixture.invalid/item' }
				}
			]),
			{ type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT }
		);

		expect(report.drift).toEqual([]);
		expect(report.warnings).toEqual([]);
	});

	it('collects every mismatch, not only the first one', () => {
		const fixture = upstreamAt('overlay-check-drift');
		const report = checkOverlay(
			overlay([
				{ op: 'set', path: ['nameShort'], value: 'PatchSet', expectUpstream: 'Code - OSS' },
				{ op: 'set', path: ['nameLong'], value: 'PatchSet', expectUpstream: 'Fixture Code - OSS' },
				{ op: 'set', path: ['applicationName'], value: 'patchset', expectUpstream: 'code-oss' },
				{ op: 'set', path: ['dataFolderName'], value: '.patchset', expectUpstream: { $absent: true } }
			]),
			{ type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT }
		);

		expect(report.drift.map((entry) => entry.operationIndex)).toEqual([0, 2, 3]);
		expect(report.drift[0]?.actual).toBe('Fixture - OSS');
		expect(report.drift[0]?.expected).toBe('Code - OSS');
		expect(report.drift[2]?.expectedAbsent).toBe(true);

		const errors = overlayDriftErrors(report.drift);
		expect(errors.length).toBe(3);
		expect(errors.every((error) => error.code === 'OVERLAY-DRIFT')).toBe(true);
		expect(errors[0]?.file).toBe(ARTIFACT);
		expect(errors[0]?.message).toContain('product.json:nameShort');
	});

	it('sees a key that is expected to be absent but is there', () => {
		const fixture = upstreamAt('overlay-check-absent');
		const report = checkOverlay(overlay([{ op: 'set', path: ['version'], value: '2', expectUpstream: { $absent: true } }]), {
			type: vscodeType,

			treeDir: fixture.dir,
			pinSha: fixture.t1.sha
		});

		expect(report.drift.length).toBe(1);
		expect(report.drift[0]?.actual).toBe('1.0.0');
	});

	it('compares deeply, so an equal object is not a drift and a different one is', () => {
		const fixture = upstreamAt('overlay-check-deep');
		const equal = checkOverlay(
			overlay([
				{
					op: 'remove',
					path: ['extensionsGallery'],
					expectUpstream: { itemUrl: 'https://gallery.fixture.invalid/item', serviceUrl: 'https://gallery.fixture.invalid/api' }
				}
			]),
			{ type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha }
		);
		const different = checkOverlay(
			overlay([{ op: 'remove', path: ['extensionsGallery'], expectUpstream: { serviceUrl: 'https://gallery.fixture.invalid/api' } }]),
			{ type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha }
		);

		expect(equal.drift).toEqual([]);
		expect(different.drift.length).toBe(1);
	});
});

describe('checkOverlay: the keys packaging stamps', () => {
	it('warns about an operation on a stamped key of product.json', () => {
		const fixture = upstreamAt('overlay-check-stamped');
		const report = checkOverlay(
			overlay([
				{ op: 'set', path: ['version'], value: '9.9.9' },
				{ op: 'set', path: ['commit'], value: 'deadbeef' },
				{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }
			]),
			{ type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha }
		);

		expect(report.warnings.length).toBe(2);
		expect(report.warnings[0]).toContain('set version');
		expect(report.warnings[0]).toContain('packaging');
		expect(report.warnings[1]).toContain('set commit');
		expect(report.drift).toEqual([]);
	});

	it('says nothing about the same key on another target', () => {
		const fixture = upstreamAt('overlay-check-stamped-other');
		const report = checkOverlay(overlay([{ op: 'set', path: ['version'], value: '9.9.9' }], { target: 'package.json' }), {
			type: vscodeType,

			treeDir: fixture.dir,
			pinSha: fixture.t1.sha
		});

		expect(report.warnings).toEqual([]);
	});
});

describe('checkOverlay: the file in the tree', () => {
	const OPERATIONS = [{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }];

	it('reports nothing to compare while the target still equals the pin', () => {
		const fixture = upstreamAt('overlay-check-clean');
		const report = checkOverlay(overlay(OPERATIONS), { type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT });

		expect(report.materialization).toEqual({ present: true, differsFromPin: false, matches: null });
	});

	it('agrees with a target this overlay materialized', () => {
		const fixture = upstreamAt('overlay-check-applied');
		const sample = overlay(OPERATIONS);
		applyOverlayToTree(sample, fixture.dir, fixture.t1.sha, CONTEXT);

		const report = checkOverlay(sample, { type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT });

		expect(report.materialization?.differsFromPin).toBe(true);
		expect(report.materialization?.matches).toBe(true);
	});

	it('disagrees with a target somebody edited by hand', () => {
		const fixture = upstreamAt('overlay-check-edited');
		const sample = overlay(OPERATIONS);
		applyOverlayToTree(sample, fixture.dir, fixture.t1.sha, CONTEXT);
		const path = join(fixture.dir, 'product.json');
		writeFileSync(path, readFileSync(path, 'utf8').replace('"applicationName": "fixture-code"', '"applicationName": "by-hand"'), 'utf8');

		const report = checkOverlay(sample, { type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT });

		expect(report.materialization?.differsFromPin).toBe(true);
		expect(report.materialization?.matches).toBe(false);
		// The drift detector is about the pin, and the pin did not move.
		expect(report.drift).toEqual([]);
	});

	it('does not look at the tree at all when the caller asks for the pin side only', () => {
		const fixture = upstreamAt('overlay-check-pinonly');
		applyOverlayToTree(overlay(OPERATIONS), fixture.dir, fixture.t1.sha, CONTEXT);

		const report = checkOverlay(overlay(OPERATIONS), { type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, pinOnly: true });

		expect(report.materialization).toBeNull();
	});
});

describe('isExactOverlayMaterialization: the bytes the drift guard certifies', () => {
	const OPERATIONS = [{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }];

	it('recognizes exactly the bytes applyOverlaysToTree wrote', () => {
		const fixture = upstreamAt('overlay-exact-applied');
		const sample = overlay(OPERATIONS);
		// The pin state is not the composition, so it is not certified.
		expect(isExactOverlayMaterialization([sample], fixture.dir, fixture.t1.sha, CONTEXT)).toBe(false);

		applyOverlayToTree(sample, fixture.dir, fixture.t1.sha, CONTEXT);

		expect(isExactOverlayMaterialization([sample], fixture.dir, fixture.t1.sha, CONTEXT)).toBe(true);
	});

	it('does not recognize a manual edit of those bytes', () => {
		const fixture = upstreamAt('overlay-exact-edited');
		const sample = overlay(OPERATIONS);
		applyOverlayToTree(sample, fixture.dir, fixture.t1.sha, CONTEXT);
		const path = join(fixture.dir, 'product.json');
		writeFileSync(path, readFileSync(path, 'utf8').replace('"applicationName": "fixture-code"', '"applicationName": "by-hand"'), 'utf8');

		expect(isExactOverlayMaterialization([sample], fixture.dir, fixture.t1.sha, CONTEXT)).toBe(false);
	});

	it('does not recognize an absent target', () => {
		const fixture = upstreamAt('overlay-exact-absent');
		rmSync(join(fixture.dir, 'product.json'));

		expect(isExactOverlayMaterialization([overlay(OPERATIONS)], fixture.dir, fixture.t1.sha, CONTEXT)).toBe(false);
	});

	it('judges the composed target, not one overlay of it', () => {
		const fixture = upstreamAt('overlay-exact-compose');
		const group = [
			overlay([{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }]),
			overlay([{ op: 'set', path: ['extensionsGallery', 'serviceUrl'], value: 'https://gallery.patchset.invalid' }], {
				id: 'CK-product-903'
			})
		];
		applyOverlaysToTree(group, fixture.dir, fixture.t1.sha, CONTEXT);

		// What the tree carries is the composition of both overlays; checking it
		// against the composition is true and against either overlay alone false.
		expect(isExactOverlayMaterialization(group, fixture.dir, fixture.t1.sha, CONTEXT)).toBe(true);
		expect(isExactOverlayMaterialization([group[0] as Overlay], fixture.dir, fixture.t1.sha, CONTEXT)).toBe(false);
	});
});

describe('checkOverlayTarget: a target several overlays contribute to', () => {
	const GROUP = [
		overlay([{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet' }]),
		overlay([{ op: 'set', path: ['extensionsGallery', 'serviceUrl'], value: 'https://gallery.patchset.invalid' }], { id: 'CK-product-903' })
	];

	it('collects the findings of every overlay of the target', () => {
		const fixture = upstreamAt('overlay-target-collect');
		const drifting = [
			overlay([{ op: 'set', path: ['nameShort'], value: 'PatchSet', expectUpstream: 'Code - OSS' }]),
			overlay([{ op: 'set', path: ['version'], value: '9.9.9' }], { id: 'CK-product-903' })
		];

		const report = checkOverlayTarget(drifting, { type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT });

		expect(report.target).toBe('product.json');
		expect(report.reports.length).toBe(2);
		expect(report.drift.map((entry) => entry.overlayId)).toEqual(['CK-product-901']);
		expect(report.warnings.length).toBe(1);
	});

	it('compares the file in the tree with the composed result, not with one overlay', () => {
		const fixture = upstreamAt('overlay-target-composed');
		// What `overlay apply` writes for this target: both overlays, in order.
		writeFileSync(join(fixture.dir, 'product.json'), renderOverlayTarget(GROUP, fixture.dir, fixture.t1.sha, CONTEXT).text, 'utf8');

		const composed = checkOverlayTarget(GROUP, { type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT });
		const single = checkOverlay(GROUP[0] as Overlay, { type: vscodeType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT });

		expect(composed.materialization?.matches).toBe(true);
		// Checked alone, the same file looks wrong - which is why the command
		// checks the target rather than each artifact of it.
		expect(single.materialization?.matches).toBe(false);
	});
});
