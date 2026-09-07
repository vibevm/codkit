// PROP-013 ##UT-GEN-FEATURE: the skeletons `codkit gen` writes (PROP-015 sec. 5).
//
// Three properties are what the tests are about: the id decides everything
// (##GEN-FEATURE), the header is the product's or there is none
// (##GEN-HEADER-IS-THE-PRODUCTS), and a refusal writes nothing at all
// (##GEN-REFUSES-EXISTING).

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	BRAND_FILE_PATH,
	brandHookText,
	brandReminders,
	featureDirectoryName,
	featureImportLine,
	planBrand,
	planFeature,
	refuseExisting,
	writeGenerated
} from '../../src/lib/genFeature.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const HEADER = { holder: 'Acme', license: 'MIT', year: '2026' } as const;

function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return isCkError(error) ? error.code : 'not-a-ck-error';
	}
}

function makeProduct(label: string): string {
	const root = makeTempRoot(`gen-${label}`);
	mkdirSync(join(root, 'delta', 'own'), { recursive: true });
	return root;
}

function read(patchesDir: string, relative: string): string {
	return readFileSync(join(patchesDir, ...relative.split('/')), 'utf8');
}

describe('featureDirectoryName', () => {
	it('takes the last segment of a well-formed id', () => {
		expect(featureDirectoryName('acme.sample')).toBe('sample');
		expect(featureDirectoryName('acme.editor.smartPaste')).toBe('smartPaste');
	});

	it('refuses an id that is not two or more camelCase segments', () => {
		// ##RT-DESCRIPTOR: the product prefix is part of the form, so a bare word
		// and a capitalized one are both refused.
		expect(codeOf(() => featureDirectoryName('Sample'))).toBe('GEN-ID');
		expect(codeOf(() => featureDirectoryName('sample'))).toBe('GEN-ID');
		expect(codeOf(() => featureDirectoryName('acme.Sample'))).toBe('GEN-ID');
		expect(codeOf(() => featureDirectoryName('acme..sample'))).toBe('GEN-ID');
		expect(codeOf(() => featureDirectoryName('acme.sample-two'))).toBe('GEN-ID');
	});
});

describe('planFeature', () => {
	it('writes three files, named after the last segment of the id', () => {
		const patchesDir = makeProduct('files');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: true, cold: false });
		writeGenerated(patchesDir, outcome.files);

		expect(outcome.files.map((file) => file.path)).toEqual([
			'delta/own/contrib/sample/common/sample.ts',
			'delta/own/contrib/sample/browser/sample.contribution.ts',
			'delta/own/test/browser/sample.test.ts'
		]);
		expect(read(patchesDir, 'delta/own/contrib/sample/common/sample.ts')).toContain("export const FEATURE_ID = 'acme.sample';");
		expect(read(patchesDir, 'delta/own/contrib/sample/common/sample.ts')).toContain("export const SETTING_ID = 'acme.sample.enabled';");
	});

	it('registers the feature through the runtime library and defaults to a hot toggle', () => {
		const patchesDir = makeProduct('hot');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: true, cold: false });
		const contribution = outcome.files[1]?.text ?? '';

		expect(contribution).toContain("import { registerFeature } from '../../../codkit/browser/featureRegistry.js';");
		expect(contribution).toContain('registerFeature(');
		expect(contribution).toContain('hotToggle: true,');
		expect(contribution).toContain('class SampleFeature extends Disposable {');
		expect(contribution).toContain('localize(\'acme.sample.title\', "Sample")');
	});

	it('declares a cold feature under --cold and no setting without --setting', () => {
		const patchesDir = makeProduct('cold');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: false, cold: true });

		expect(outcome.files[1]?.text).toContain('hotToggle: false,');
		expect(outcome.files[1]?.text).not.toContain('setting: {');
		expect(outcome.files[0]?.text).not.toContain('SETTING_ID');
	});

	it('writes a test skeleton that leaks no disposables', () => {
		const patchesDir = makeProduct('test');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: false, cold: false });

		expect(outcome.files[2]?.text).toContain('ensureNoDisposablesAreLeakedInTestSuite();');
		expect(outcome.files[2]?.text).toContain("suite('acme.sample', () => {");
	});
});

describe('the header of a generated file', () => {
	it("is the product's, four lines, with its holder and its SPDX identifier", () => {
		const patchesDir = makeProduct('header');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: false, cold: false });

		expect(outcome.headerWritten).toBe(true);
		for (const file of outcome.files) {
			const lines = file.text.split('\n');
			expect(lines.slice(0, 4)).toEqual([
				'// Copyright (c) 2026 Acme',
				'// Licensed under the MIT licence.',
				'// The full licence text is the licence file of this repository.',
				'// SPDX-License-Identifier: MIT'
			]);
		}
	});

	it("never carries codkit's own notice into a product file", () => {
		const patchesDir = makeProduct('no-upl');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: false, cold: false });

		for (const file of outcome.files) {
			expect(file.text).not.toContain('UPL-1.0');
			expect(file.text).not.toContain('Oleg Chirukhin');
		}
	});

	it('is absent when the product supplied neither holder nor licence', () => {
		const patchesDir = makeProduct('none');
		const outcome = planFeature({ patchesDir, header: null, id: 'acme.sample', title: 'Sample', setting: false, cold: false });

		expect(outcome.headerWritten).toBe(false);
		expect(outcome.files[0]?.text.startsWith('// Identifiers of the Sample feature.')).toBe(true);
	});
});

describe('refuseExisting', () => {
	it('refuses when a single target is already there, before anything is written', () => {
		const patchesDir = makeProduct('exists');
		const first = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: false, cold: false });
		writeGenerated(patchesDir, first.files);
		const before = read(patchesDir, 'delta/own/contrib/sample/common/sample.ts');

		const second = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Other', setting: true, cold: true });
		expect(codeOf(() => refuseExisting(patchesDir, second.files))).toBe('GEN-EXISTS');
		expect(read(patchesDir, 'delta/own/contrib/sample/common/sample.ts')).toBe(before);
	});

	it('says nothing about a directory that holds no target of this run', () => {
		const patchesDir = makeProduct('free');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.other', title: 'Other', setting: false, cold: false });

		expect(codeOf(() => refuseExisting(patchesDir, outcome.files))).toBeNull();
	});
});

describe('planBrand', () => {
	it('writes one table exporting brandMessage through the runtime engine', () => {
		const patchesDir = makeProduct('brand');
		const outcome = planBrand({ patchesDir, header: HEADER });
		writeGenerated(patchesDir, outcome.files);

		expect(outcome.files.map((file) => file.path)).toEqual([BRAND_FILE_PATH]);
		const text = read(patchesDir, BRAND_FILE_PATH);
		expect(text).toContain("import { createBrandTransform, type IBrandRule } from '../codkit/common/brand/brandRules.js';");
		expect(text).toContain('export const brandMessage = createBrandTransform(RULES);');
		expect(text).toContain("{ find: 'Upstream Name', replace: 'Product Name', except: ['Upstream Name Speech'] },");
	});

	it('refuses to overwrite an existing table', () => {
		const patchesDir = makeProduct('brand-exists');
		mkdirSync(join(patchesDir, 'delta', 'own', 'common'), { recursive: true });
		writeFileSync(join(patchesDir, ...BRAND_FILE_PATH.split('/')), 'mine\n', 'utf8');

		const outcome = planBrand({ patchesDir, header: HEADER });
		expect(codeOf(() => refuseExisting(patchesDir, outcome.files))).toBe('GEN-EXISTS');
		expect(read(patchesDir, BRAND_FILE_PATH)).toBe('mine\n');
	});
});

describe('what the generator prints', () => {
	it('offers the import line the composition root needs', () => {
		expect(featureImportLine('sample')).toBe("import '../contrib/sample/browser/sample.contribution.js';");
	});

	it('offers the graft for nls.ts and the two reminders that go with it', () => {
		expect(brandHookText('patchset')).toContain('brandMessage(');
		expect(brandHookText('patchset')).toContain("import { brandMessage } from './patchset/common/brand.js';");

		const reminders = brandReminders('patchset');
		expect(reminders).toHaveLength(2);
		expect(reminders[0]).toContain('type = hook');
		expect(reminders[1]).toContain('nls.ts');
		expect(reminders[1]).toContain('vs/patchset/common/~');
	});

	it('leaves an empty product directory empty when it refuses', () => {
		const patchesDir = makeProduct('untouched');
		const outcome = planFeature({ patchesDir, header: HEADER, id: 'acme.sample', title: 'Sample', setting: false, cold: false });
		writeGenerated(patchesDir, outcome.files);
		const listed = readdirSync(join(patchesDir, 'delta', 'own')).sort();

		expect(codeOf(() => refuseExisting(patchesDir, outcome.files))).toBe('GEN-EXISTS');
		expect(readdirSync(join(patchesDir, 'delta', 'own')).sort()).toEqual(listed);
	});
});
