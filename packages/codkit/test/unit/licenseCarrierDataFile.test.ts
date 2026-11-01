// unit: the header form of a licence carrier belongs to a file with a comment
// style (PROP-014 ##LIC-CARRIER-HEADER). A copyright-like line inside a data
// file - the upstream's notice in a string of a translation file - is data, and
// the file's carrier is its annotation or its sidecar (##LIC-CARRIER-ANNOTATION).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selectLicenseCarrier } from '../../src/lib/licenseCarrier.ts';
import type { ReuseAnnotation } from '../../src/lib/licenseCheck.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const THIRD_PARTY: ReuseAnnotation = {
	paths: ['**'],
	precedence: 'aggregate',
	copyright: 'Microsoft Corporation',
	license: 'MIT',
	comment: 'third-party; the localisation pack of the upstream',
	registry: 'pack/REUSE.toml',
	base: 'pack/'
};

const TRANSLATION = [
	'{',
	'\t"": [',
	'\t\t"Copyright (c) Microsoft Corporation. All rights reserved.",',
	'\t\t"Licensed under the MIT License. See License.txt in the project root for license information."',
	'\t],',
	'\t"hello": "greeting"',
	'}',
	''
].join('\n');

function tree(label: string): string {
	const root = makeTempRoot(`carrier-${label}`);
	mkdirSync(join(root, 'pack'), { recursive: true });
	return root;
}

describe('selectLicenseCarrier on a file without a comment style', () => {
	it('reads a copyright-like line inside the data as data and takes the annotation', () => {
		const root = tree('data');
		const file = 'pack/main.i18n.json';
		writeFileSync(join(root, file), TRANSLATION, 'utf8');
		const problems: string[] = [];

		const carrier = selectLicenseCarrier(root, file, new Set([file]), [THIRD_PARTY], (_code, _file, message) => problems.push(message));

		expect(carrier?.kind).toBe('annotation');
		expect(problems).toEqual([]);
	});

	it('asks such a file for a sidecar or an annotation, never for a header', () => {
		const root = tree('bare');
		const file = 'pack/main.i18n.json';
		writeFileSync(join(root, file), TRANSLATION, 'utf8');
		const problems: string[] = [];

		const carrier = selectLicenseCarrier(root, file, new Set([file]), [], (_code, _file, message) => problems.push(message));

		expect(carrier).toBeNull();
		expect(problems).toEqual([
			'no licence carrier: a file without a comment style carries no header, and it has no .license sidecar and no REUSE.toml annotation'
		]);
	});

	it('still reads the header of a file with a comment style before any annotation', () => {
		const root = tree('source');
		const file = 'pack/NOTICE.md';
		writeFileSync(join(root, file), '# Notice\n\nCopyright (c) 2020 Microsoft Corporation\nSPDX-License-Identifier: MIT\n', 'utf8');
		const problems: string[] = [];

		const carrier = selectLicenseCarrier(root, file, new Set([file]), [THIRD_PARTY], (_code, _file, message) => problems.push(message));

		expect(carrier?.kind).toBe('header');
		expect(problems).toEqual([]);
	});
});
