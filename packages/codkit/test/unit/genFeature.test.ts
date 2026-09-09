// PROP-013 ##UT-GEN-FEATURE: what `codkit gen` does with the skeleton a project
// type hands it (PROP-015 sec. 5).
//
// Four properties are what the tests are about: the id decides everything
// (##GEN-FEATURE), the header is the product's or there is none
// (##GEN-HEADER-IS-THE-PRODUCTS), the test belongs to the feature
// (##GEN-TEST-LIVES-WITH-THE-FEATURE), and a refusal writes nothing at all
// (##GEN-REFUSES-EXISTING). What a skeleton says is the type's answer and is
// proved in the suite of the package that gives it, so the type here is a stub.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability } from '@codkit/type-api';
import { featureDirectoryName, planBrand, planFeature, refuseExisting, unitReminder, writeGenerated } from '../../src/lib/genFeature.ts';
import type { FeatureOptions } from '../../src/lib/genFeature.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { stubGenerators, stubType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const HEADER = { form: 'fields', holder: 'Acme', license: 'MIT', year: '2026', style: 'line' } as const;
const BLOCK_HEADER = { ...HEADER, style: 'block' } as const;

/** A family with no string funnel: the stub without its brand graft. */
const TYPE = stubType({ capabilities: new Set<Capability>([]), generators: stubGenerators() });
const BRANDING_TYPE = stubType({ capabilities: new Set<Capability>(['gen-brand']), generators: stubGenerators({ brand: true }) });

// The block form is pinned line by line: its width is what makes an own file
// sit flush with the upstream file next to it, and a silent change of width is
// exactly the regression the fields alone would not catch.
const BLOCK_LINES: readonly string[] = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) 2026 Acme. All rights reserved.',
	' *  Licensed under the MIT licence. The full licence text is the licence file of this repository.',
	' *  SPDX-License-Identifier: MIT',
	' *--------------------------------------------------------------------------------------------*/'
];

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

function feature(patchesDir: string, over: Partial<Omit<FeatureOptions, 'patchesDir'>> = {}) {
	return planFeature({
		patchesDir,
		header: HEADER,
		type: TYPE,
		ownRoot: 'own/root',
		id: 'acme.sample',
		title: 'Sample',
		setting: false,
		cold: false,
		...over
	});
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
	it('writes what the type answered, at the paths the type named', () => {
		const patchesDir = makeProduct('files');
		const outcome = feature(patchesDir);
		writeGenerated(patchesDir, outcome.files);

		expect(outcome.files.map((file) => file.path)).toEqual([
			'delta/own/contrib/sample/common/sample.ts',
			'delta/own/contrib/sample/browser/sample.contribution.ts',
			'delta/own/contrib/sample/test/browser/sample.test.ts'
		]);
		expect(read(patchesDir, 'delta/own/contrib/sample/common/sample.ts')).toContain("export const FEATURE_ID = 'acme.sample';");
	});

	it('hands the type the id, the directory name, the flags and the own root', () => {
		const seen: unknown[] = [];
		const type = stubType({
			generators: {
				featureSkeleton: (request) => {
					seen.push(request);
					return { directory: 'delta/own/x', modules: [], importLine: '', reminders: [] };
				}
			}
		});
		feature(makeProduct('request'), { type, id: 'acme.editor.smartPaste', title: 'Smart paste', setting: true, cold: true });

		expect(seen).toEqual([
			{ id: 'acme.editor.smartPaste', name: 'smartPaste', title: 'Smart paste', setting: true, cold: true, ownRoot: 'own/root' }
		]);
	});

	it('carries the reminders of the type after the one the own manifest needs', () => {
		const outcome = feature(makeProduct('reminders'));

		expect(outcome.directory).toBe('delta/own/contrib/sample');
		expect(outcome.importLine).toBe("import '../contrib/sample/browser/sample.contribution.js';");
		expect(outcome.reminders).toEqual([unitReminder('delta/own/contrib/sample'), 'teach the stub family about sample']);
	});

	it('refuses a skeleton whose test does not live with the feature', () => {
		// ##GEN-TEST-LIVES-WITH-THE-FEATURE is the engine's rule, so the engine
		// checks it rather than trusting whatever the type answered.
		const type = stubType({ generators: stubGenerators({ testOutside: true }) });

		expect(codeOf(() => feature(makeProduct('stray-test'), { type }))).toBe('ARTIFACT-BROKEN');
	});
});

describe('the header of a generated file', () => {
	it("is the product's, four lines, with its holder and its SPDX identifier", () => {
		const outcome = feature(makeProduct('header'));

		expect(outcome.headerWritten).toBe(true);
		expect(outcome.headerStyle).toBe('line');
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

	it('is the ruled block of the upstream form under the block style, to the character', () => {
		const outcome = feature(makeProduct('header-block'), { header: BLOCK_HEADER });

		expect(outcome.headerStyle).toBe('block');
		for (const file of outcome.files) {
			const lines = file.text.split('\n');
			expect(lines.slice(0, 5)).toEqual(BLOCK_LINES);
			// One blank line between the header and the module, as with `line`.
			expect(lines[5]).toBe('');
		}
	});

	it('copies the text of a header file byte for byte and calls it the file style', () => {
		const text = `${['/* the house header of this product', ' * second line, exactly as written', ' */'].join('\n')}\n`;
		const outcome = feature(makeProduct('header-file'), { header: { form: 'text', text } });

		expect(outcome.headerWritten).toBe(true);
		expect(outcome.headerStyle).toBe('file');
		for (const file of outcome.files) {
			expect(file.text.startsWith(`${text}\n`)).toBe(true);
		}
	});

	it("never carries codkit's own notice into a product file", () => {
		const outcome = feature(makeProduct('no-upl'));

		for (const file of outcome.files) {
			expect(file.text).not.toContain('UPL-1.0');
			expect(file.text).not.toContain('Oleg Chirukhin');
		}
	});

	it('is absent when the product supplied neither holder nor licence', () => {
		const outcome = feature(makeProduct('none'), { header: null });

		expect(outcome.headerWritten).toBe(false);
		expect(outcome.headerStyle).toBeNull();
		expect(outcome.files[0]?.text.startsWith('// Identifiers of the Sample feature.')).toBe(true);
	});
});

describe('refuseExisting', () => {
	it('refuses when a single target is already there, before anything is written', () => {
		const patchesDir = makeProduct('exists');
		const first = feature(patchesDir);
		writeGenerated(patchesDir, first.files);
		const before = read(patchesDir, 'delta/own/contrib/sample/common/sample.ts');

		const second = feature(patchesDir, { title: 'Other', setting: true, cold: true });
		expect(codeOf(() => refuseExisting(patchesDir, second.files))).toBe('GEN-EXISTS');
		expect(read(patchesDir, 'delta/own/contrib/sample/common/sample.ts')).toBe(before);
	});

	it('says nothing about a directory that holds no target of this run', () => {
		const patchesDir = makeProduct('free');
		const outcome = feature(patchesDir, { id: 'acme.other', title: 'Other' });

		expect(codeOf(() => refuseExisting(patchesDir, outcome.files))).toBeNull();
	});

	it('leaves an empty product directory empty when it refuses', () => {
		const patchesDir = makeProduct('untouched');
		const outcome = feature(patchesDir);
		writeGenerated(patchesDir, outcome.files);
		const listed = readdirSync(join(patchesDir, 'delta', 'own')).sort();

		expect(codeOf(() => refuseExisting(patchesDir, outcome.files))).toBe('GEN-EXISTS');
		expect(readdirSync(join(patchesDir, 'delta', 'own')).sort()).toEqual(listed);
	});
});

describe('planBrand', () => {
	it('writes the table the type answered and hands back its graft unwritten', () => {
		const patchesDir = makeProduct('brand');
		const outcome = planBrand({ patchesDir, header: HEADER, type: BRANDING_TYPE, ownRoot: 'own/root' });
		writeGenerated(patchesDir, outcome.files);

		expect(outcome.files.map((file) => file.path)).toEqual(['delta/own/common/brand.ts']);
		expect(read(patchesDir, 'delta/own/common/brand.ts')).toContain('the brand table of own/root');
		expect(outcome.hookText).toContain('own/root');
		expect(outcome.reminders).toEqual([
			'the graft is a patch of the product: type = hook',
			'declare the import of the table in the layering rules of the family'
		]);
	});

	it('refuses to overwrite an existing table', () => {
		const patchesDir = makeProduct('brand-exists');
		mkdirSync(join(patchesDir, 'delta', 'own', 'common'), { recursive: true });
		writeFileSync(join(patchesDir, 'delta', 'own', 'common', 'brand.ts'), 'mine\n', 'utf8');

		const outcome = planBrand({ patchesDir, header: HEADER, type: BRANDING_TYPE, ownRoot: 'own/root' });
		expect(codeOf(() => refuseExisting(patchesDir, outcome.files))).toBe('GEN-EXISTS');
		expect(read(patchesDir, 'delta/own/common/brand.ts')).toBe('mine\n');
	});

	it('refuses a family that has no string funnel to graft into', () => {
		const patchesDir = makeProduct('brand-none');

		expect(codeOf(() => planBrand({ patchesDir, header: HEADER, type: TYPE, ownRoot: 'own/root' }))).toBe('TYPE-CAPABILITY');
	});
});

describe('what the generator prints', () => {
	it('names one unit, the feature directory that now holds the test too', () => {
		// ##GEN-TEST-LIVES-WITH-THE-FEATURE: one declaration covers code and test.
		expect(unitReminder('delta/own/contrib/sample')).toBe(
			'declare a unit for delta/own/contrib/sample in delta/own/patchset.delta.json, or verify reports CK-E-OWN-UNCOVERED'
		);
	});
});
