// FEAT-002 ##S96, PROP-019 ##CONSUMER-LICENSE-CHECK, PROP-015
// ##GEN-HEADER-IS-THE-PRODUCTS: the header `gen` lays out in either style is an
// own carrier of the policy holder, and the pre-campaign block form - the
// sentence on the copyright line - is read as a foreign holder. The decision of
// 2026-11-01 stays recorded here: the two styles and the old form run through
// the consumer check side by side.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkConsumerLicenses } from '../../src/lib/consumerLicenseCheck.ts';
import { productHeader } from '../../src/lib/genTemplates.ts';
import { readOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import {
	FIXTURE_HOLDER,
	FIXTURE_LICENSE_ID,
	FIXTURE_LICENSE_TITLE,
	FIXTURE_PROFILE_ID,
	FIXTURE_YEAR,
	storeText
} from '../support/licensingFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const FIELDS = {
	holder: FIXTURE_HOLDER,
	license: FIXTURE_LICENSE_ID,
	year: FIXTURE_YEAR,
	title: FIXTURE_LICENSE_TITLE,
	file: 'LICENSE.md'
} as const;

/** The block form before the decision, written literally: the sentence shares the copyright line. */
const PRE_CAMPAIGN_BLOCK = [
	`/*${'-'.repeat(93)}`,
	` *  Copyright (c) ${FIXTURE_YEAR} ${FIXTURE_HOLDER}. All rights reserved.`,
	` *  Licensed under the ${FIXTURE_LICENSE_ID} licence. The full licence text is the licence file of this repository.`,
	` *  SPDX-License-Identifier: ${FIXTURE_LICENSE_ID}`,
	` *${'-'.repeat(92)}*/`,
	''
].join('\n');

describe('the block header is a carrier (S96)', () => {
	it('reads both styles as own carriers and the pre-campaign block as a foreign holder', () => {
		const dir = makeTempRoot('header-carrier-source');
		writeFileSync(
			join(dir, 'block.ts'),
			`${productHeader({ form: 'fields', ...FIELDS, style: 'block' })}\nexport const block = 1;\n`,
			'utf8'
		);
		writeFileSync(join(dir, 'line.ts'), `${productHeader({ form: 'fields', ...FIELDS, style: 'line' })}\nexport const line = 1;\n`, 'utf8');
		writeFileSync(join(dir, 'old.ts'), `${PRE_CAMPAIGN_BLOCK}\nexport const old = 1;\n`, 'utf8');

		// The store lives in a home directory, never in the patch set (##ORGANIZATION-POLICY-TRUST).
		const home = makeTempRoot('header-carrier-home');
		mkdirSync(join(home, '.codkit'), { recursive: true });
		writeFileSync(join(home, '.codkit', 'organization-policies.json'), storeText(), 'utf8');
		const selected = readOrganizationPolicy(join(home, '.codkit'), makeTempRoot('header-carrier-patches'), { profile: FIXTURE_PROFILE_ID });
		if (!selected.ok) throw new Error(selected.problems.join('; '));

		const report = checkConsumerLicenses(dir, selected.value);
		const checked = new Map(report.checked.map((file) => [file.path, file]));

		for (const path of ['block.ts', 'line.ts']) {
			expect(checked.get(path)?.kind, path).toBe('own');
			expect(checked.get(path)?.holders, path).toEqual([FIXTURE_HOLDER]);
			expect(checked.get(path)?.license, path).toBe(FIXTURE_LICENSE_ID);
			expect(
				report.problems.filter((problem) => problem.file === path),
				path
			).toEqual([]);
		}
		expect(checked.get('old.ts')?.kind).toBe('third-party');
		expect(checked.get('old.ts')?.holders).toEqual([`${FIXTURE_HOLDER}. All rights reserved.`]);
		expect(report.problems.map((problem) => `${problem.file}: ${problem.message}`)).toContain(
			'old.ts: third-party consumer file requires provenance annotation'
		);
		expect(report.status).toBe('incomplete');
	});
});
