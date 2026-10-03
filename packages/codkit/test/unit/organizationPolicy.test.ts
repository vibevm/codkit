import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	checkOrganizationExpression,
	parsePolicyExpression,
	selectOrganizationPolicy,
	validateOrganizationPolicy
} from '../../src/lib/organizationPolicy.ts';
import { ORGANIZATION_POLICY_STORE_FILE, readOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import type { SpdxLicenseIds } from '../../src/lib/spdxIds.ts';

const standard: SpdxLicenseIds = { listVersion: 'fixture', releaseDate: '2026-01-01', ids: new Set(['MIT', 'Apache-2.0', 'GPL-3.0-only']) };
const text = 'Fixture proprietary terms; not an actual organization licence ruling.\n';
function raw() {
	return {
		codkitOrganizationPolicy: 1,
		id: 'fixture-policy',
		version: 1,
		holders: ['Fixture Organization'],
		ownLicense: 'LicenseRef-FIXTURE-Private',
		allowedThirdParty: ['MIT', 'Apache-2.0', 'MIT AND Apache-2.0'],
		forbiddenThirdParty: ['GPL-3.0-only'],
		allowedExceptions: [],
		licenseRefNamespace: 'FIXTURE',
		customLicenses: [{ id: 'LicenseRef-FIXTURE-Private', text, sha256: createHash('sha256').update(text).digest('hex') }],
		distribution: { requiredNotices: ['NOTICE'], sbom: 'spdx-json', requireSourceCarriers: false }
	};
}
function validated() {
	const result = validateOrganizationPolicy(raw(), standard);
	if (!result.ok) throw new Error(result.problems.join('; '));
	return result.value;
}
const roots: string[] = [];
function root() {
	const path = mkdtempSync(join(tmpdir(), 'codkit-organization-policy-'));
	roots.push(path);
	return path;
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('organization policy authority', () => {
	it('allows proprietary own code only under its validated text-bound policy, and keeps third-party scope distinct', () => {
		const policy = validated();
		expect(checkOrganizationExpression(policy, 'LicenseRef-FIXTURE-Private', true).ok).toBe(true);
		expect(checkOrganizationExpression(policy, 'LicenseRef-FIXTURE-Private', false).ok).toBe(false);
		expect(checkOrganizationExpression(policy, 'MIT', true).ok).toBe(false);
		expect(checkOrganizationExpression(policy, 'MIT AND Apache-2.0', false).ok).toBe(true);
		expect(checkOrganizationExpression(policy, 'MIT OR Apache-2.0', false).ok).toBe(false);
	});
	it('keeps policy third-party prohibitions out of own scope while additional restrictions remain monotone', () => {
		const result = validateOrganizationPolicy({ ...raw(), ownLicense: 'MIT', forbiddenThirdParty: ['MIT'] }, standard);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('fixture policy invalid');
		expect(checkOrganizationExpression(result.value, 'MIT', true).ok).toBe(true);
		expect(checkOrganizationExpression(result.value, 'MIT', false).ok).toBe(false);
		expect(checkOrganizationExpression(result.value, 'MIT', true, ['MIT']).ok).toBe(false);
	});
	it('refuses future formats before silently treating them as current policy', () => {
		expect(validateOrganizationPolicy({ ...raw(), codkitOrganizationPolicy: 2 }, standard)).toMatchObject({
			ok: false,
			problems: [expect.stringContaining('newer')]
		});
	});
	it('refuses undeclared, foreign-namespace and text/hash-tampered LicenseRef values', () => {
		for (const policy of [
			{ ...raw(), customLicenses: [] },
			{ ...raw(), customLicenses: [{ ...raw().customLicenses[0], id: 'LicenseRef-OTHER-Private' }] },
			{ ...raw(), customLicenses: [{ ...raw().customLicenses[0], sha256: '0'.repeat(64) }] },
			{ ...raw(), customLicenses: [{ ...raw().customLicenses[0], text: '' }] },
			{ ...raw(), customLicenses: [{ ...raw().customLicenses[0], text: ' \n', sha256: createHash('sha256').update(' \n').digest('hex') }] },
			{ ...raw(), ownLicense: 'NOASSERTION' }
		])
			expect(validateOrganizationPolicy(policy, standard).ok).toBe(false);
	});
	it('allows the patchset to add prohibitions but never provide permissions or a policy path', () => {
		const policy = validated();
		for (const authority of [
			{ allowedThirdParty: ['LicenseRef-FIXTURE-Private'] },
			{ ownLicense: 'MIT' },
			{ path: '../policy.json' },
			{ holders: ['Anyone'] }
		])
			expect(selectOrganizationPolicy(policy, { profile: policy.id, ...authority }).ok).toBe(false);
		const selected = selectOrganizationPolicy(policy, { profile: policy.id, additionalForbidden: ['MIT'] });
		expect(selected.ok).toBe(true);
		if (!selected.ok) throw new Error('selection failed');
		expect(checkOrganizationExpression(policy, 'MIT', false, selected.value.additionalForbidden).ok).toBe(false);
		expect(checkOrganizationExpression(policy, 'GPL-3.0-only', false).ok).toBe(false);
	});
	it.each(['', 'NOASSERTION', 'MIT Apache-2.0', 'MIT OR', '(MIT', 'MIT)', 'MIT WITH', '(MIT OR Apache-2.0) WITH X', 'MIT; execute'])(
		'refuses malformed or undetermined expression %s',
		(value) => {
			expect(parsePolicyExpression(value).ok).toBe(false);
		}
	);
	it('parses nested expressions without inferring permission for an unapproved combination', () => {
		expect(parsePolicyExpression('(MIT OR Apache-2.0) AND MIT')).toMatchObject({
			ok: true,
			value: { canonical: '( MIT OR Apache-2.0 ) AND MIT' }
		});
	});
	it('reads only the supplied trusted store and rejects a patchset shadow, unknown IDs and authority fields', () => {
		const trusted = root();
		const patchset = root();
		writeFileSync(join(trusted, ORGANIZATION_POLICY_STORE_FILE), JSON.stringify({ codkitOrganizationPolicyStore: 1, policies: [raw()] }));
		writeFileSync(
			join(patchset, ORGANIZATION_POLICY_STORE_FILE),
			JSON.stringify({ codkitOrganizationPolicyStore: 1, policies: [{ ...raw(), ownLicense: 'MIT' }] })
		);
		expect(readOrganizationPolicy(trusted, patchset, { profile: 'fixture-policy' }, standard)).toMatchObject({
			ok: true,
			value: { policy: { ownLicense: 'LicenseRef-FIXTURE-Private' } }
		});
		expect(readOrganizationPolicy(patchset, patchset, { profile: 'fixture-policy' }, standard).ok).toBe(false);
		expect(readOrganizationPolicy(trusted, patchset, { profile: 'other' }, standard).ok).toBe(false);
		expect(
			readOrganizationPolicy(
				trusted,
				patchset,
				{ profile: 'fixture-policy', path: join(patchset, ORGANIZATION_POLICY_STORE_FILE) },
				standard
			).ok
		).toBe(false);
	});
	it('rejects a trusted-root alias into the patchset and conflicting case-insensitive policy IDs', () => {
		const parent = root();
		const patchset = root();
		mkdirSync(join(patchset, 'policies'));
		symlinkSync(join(patchset, 'policies'), join(parent, 'shadow'), 'junction');
		expect(readOrganizationPolicy(join(parent, 'shadow'), patchset, { profile: 'fixture-policy' }, standard).ok).toBe(false);
		writeFileSync(
			join(parent, ORGANIZATION_POLICY_STORE_FILE),
			JSON.stringify({ codkitOrganizationPolicyStore: 1, policies: [raw(), { ...raw(), id: 'FIXTURE-POLICY' }] })
		);
		expect(readOrganizationPolicy(parent, patchset, { profile: 'fixture-policy' }, standard).ok).toBe(false);
	});
});
