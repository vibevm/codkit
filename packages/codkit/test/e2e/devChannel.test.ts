// e2e: the dev channel of the config-overlay layer (PROP-005
// ##OVERLAY-TWO-CHANNELS, channel 1).
//
// Upstream merges `manifest.overrides.json` over `manifest.json` with a flat
// Object.assign of the top level. A nested key therefore cannot simply be
// written: the top-level object it lives in has to be seeded from the clean pin
// first, or every sibling upstream put there would disappear in dev.

import { readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

let fixture: CliFixture;

beforeAll(() => {
	fixture = makeCliFixture('dev-channel');
	// A second overlay on the same target, writing one key inside a nested
	// object the pin already carries.
	const overlay = fixture.patchesPath('delta/overlays/manifest.json.gallery.overlay.json');
	mkdirSync(fixture.patchesPath('delta/overlays'), { recursive: true });
	writeFileSync(
		overlay,
		`${JSON.stringify(
			{
				codkitOverlay: 2,
				id: 'CK-product-903',
				target: 'manifest.json',
				type: 'modify',
				category: 'own',
				owner: 'product',
				reason: 'fixture gallery: a nested key in the dev channel',
				link: 'none',
				cause: 'none',
				pin: `${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
				contractTests: ['fixture.guard.gallery'],
				operations: [{ op: 'set', path: ['addonGallery', 'serviceUrl'], value: 'https://gallery.patchset.invalid/api' }]
			},
			null,
			2
		)}\n`,
		'utf8'
	);
	expect(fixture.run(['load']).status).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

describe('manifest.overrides.json', () => {
	it('seeds the top-level key from the pin before writing into it', () => {
		const overrides = JSON.parse(readFileSync(fixture.treePath('manifest.overrides.json'), 'utf8')) as Record<string, unknown>;
		const gallery = overrides['addonGallery'] as Record<string, unknown>;

		expect(gallery['serviceUrl']).toBe('https://gallery.patchset.invalid/api');
		// The sibling of the pin survived the flat merge.
		expect(gallery['itemUrl']).toBe('https://gallery.fixture.invalid/item');
		// The other overlay still contributes its top-level keys.
		expect(overrides['displayName']).toBe('Fixture PatchSet');
		expect(overrides['patchsetUpstreamPin']).toBe(fixture.upstream.t1.tag);
	});

	it('leaves the upstream file itself untouched and the tree clean', () => {
		const product = JSON.parse(readFileSync(fixture.treePath('manifest.json'), 'utf8')) as Record<string, unknown>;
		expect((product['addonGallery'] as Record<string, unknown>)['serviceUrl']).toBe('https://gallery.fixture.invalid/api');
		expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');
	});

	it('says nothing about a nested key, because it is the normal way to write one', () => {
		const outcome = fixture.json(['load', '--fresh']);
		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.messages.filter((message) => message.level === 'warn' && message.text.includes('nested'))).toEqual([]);
	});
});
