// unit: the tree paths of the licence surfaces an add-file patch ships verbatim
// (PROP-006 ##LICENCE-DOCUMENT-EXEMPTION) - computed from the type's area and the
// declaration's file name alone, never from the trusted store, so `verify` and
// `save` read those patches as block-free on any machine.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectType } from '@codkit/type-api';
import { afterAll, describe, expect, it } from 'vitest';
import { licensingDocumentPaths } from '../../src/lib/licensingSurfaces.ts';
import { RELEASE_LICENSING_FILE } from '../../src/lib/releaseLicensing.ts';
import { projectType } from '../fixtures/stubType.ts';
import { declarationText } from '../support/licensingFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

describe('licensingDocumentPaths', () => {
	it('names the licence file, the component licences and the renderings of the stub type', () => {
		const patchesDir = makeTempRoot('licence-documents');
		writeFileSync(join(patchesDir, RELEASE_LICENSING_FILE), declarationText(), 'utf8');

		expect([...licensingDocumentPaths(patchesDir, projectType)].sort()).toEqual([
			'LICENSE.md',
			'LICENSE.rtf',
			'licenses/LICENSE-codkit.txt',
			'licenses/LICENSE-upstream.txt'
		]);
	});

	it('follows the file name of the product block and needs no trusted store', () => {
		const patchesDir = makeTempRoot('licence-documents-named');
		writeFileSync(join(patchesDir, RELEASE_LICENSING_FILE), declarationText({ product: { licenseFile: 'EULA.md' } }), 'utf8');

		const paths = licensingDocumentPaths(patchesDir, projectType);

		expect(paths.has('EULA.md')).toBe(true);
		expect(paths.has('LICENSE.md')).toBe(false);
	});

	it('is empty without a declaration and for a type without the area', () => {
		const patchesDir = makeTempRoot('licence-documents-none');
		expect(licensingDocumentPaths(patchesDir, projectType).size).toBe(0);

		writeFileSync(join(patchesDir, RELEASE_LICENSING_FILE), declarationText(), 'utf8');
		const { licensing, ...withoutArea } = projectType;
		void licensing;
		expect(licensingDocumentPaths(patchesDir, withoutArea as ProjectType).size).toBe(0);
	});
});
