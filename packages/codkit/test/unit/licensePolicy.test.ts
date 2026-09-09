// PROP-013 ##UT-LICENSE-CHECK, policy half: the shipped licence policy and the
// SPDX identifier list, and the rule that a patch set can never shadow either.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LICENSE_POLICY_RELATIVE_PATH, loadLicensePolicy } from '../../src/lib/licensePolicy.ts';
import { SPDX_IDS_RELATIVE_PATH, expressionIds, loadSpdxLicenseIds, spdxIdHint, unknownIds } from '../../src/lib/spdxIds.ts';

describe('the shipped licence policy', () => {
	it('parses and states one owner licence', () => {
		const policy = loadLicensePolicy();

		expect(policy.holders.length).toBeGreaterThan(0);
		expect(policy.ownLicense).toBe('UPL-1.0');
		expect(policy.allowedThirdParty).toContain('MIT');
		// ##LIC-POLICY-FILE: copyleft is not on the list, and widening it is a
		// deliberate edit rather than a side effect of any command.
		expect(policy.allowedThirdParty).not.toContain('GPL-3.0-only');
	});

	it('is read from toolRoot only - no patch-set path can shadow it', () => {
		// The loader takes no directory at all: there is no argument through
		// which a patch set could point it somewhere else
		// (the rule PROP-003 ##CONVENTIONS-SINGLE-DEFINITION states for
		// conventions.json).
		expect(loadLicensePolicy.length).toBe(0);
		expect(LICENSE_POLICY_RELATIVE_PATH).toBe('config/license-policy.json');
	});

	it('rejects an unknown field', () => {
		const raw: unknown = JSON.parse(readFileSync(fileURLToPath(new URL(`../../${LICENSE_POLICY_RELATIVE_PATH}`, import.meta.url)), 'utf8'));
		expect(raw).toMatchObject({ codkitLicensePolicy: 1 });
		expect(Object.keys(raw as object).sort()).toEqual([
			'allowedExceptions',
			'allowedThirdParty',
			'codkitLicensePolicy',
			'holders',
			'ownLicense'
		]);
	});
});

describe('the shipped SPDX identifier list', () => {
	it('is data, not code, and carries the list version it came from', () => {
		const list = loadSpdxLicenseIds();

		expect(SPDX_IDS_RELATIVE_PATH).toBe('config/spdx-license-ids.json');
		expect(list.listVersion.length).toBeGreaterThan(0);
		expect(list.ids.size).toBeGreaterThan(500);
		expect(list.ids.has('UPL-1.0')).toBe(true);
		expect(list.ids.has('MIT')).toBe(true);
		expect(list.ids.has('UPL')).toBe(false);
	});

	it('splits an expression on AND, OR and WITH', () => {
		expect(expressionIds('MIT')).toEqual(['MIT']);
		expect(expressionIds('MIT OR Apache-2.0')).toEqual(['MIT', 'Apache-2.0']);
		expect(expressionIds('Apache-2.0 WITH LLVM-exception')).toEqual(['Apache-2.0', 'LLVM-exception']);
	});

	it('names the unknown identifiers and points at the right form of UPL', () => {
		const list = loadSpdxLicenseIds();

		expect(unknownIds('MIT OR Apache-2.0', list)).toEqual([]);
		expect(unknownIds('UPL', list)).toEqual(['UPL']);
		expect(spdxIdHint(['UPL'])).toContain('the only valid form is UPL-1.0');
		expect(spdxIdHint(['Nonsense-1.0'])).toBe('');
		// A LicenseRef name is well formed by construction; the policy, not the
		// list, is what refuses it.
		expect(unknownIds('LicenseRef-Something', list)).toEqual([]);
	});
});
