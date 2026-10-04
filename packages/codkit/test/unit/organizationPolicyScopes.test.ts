// Scope mechanics only; fixture text is not a commercial/legal approval.
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
	validateOrganizationPolicy,
	checkOrganizationExpression,
	checkOrganizationArtifactExpression
} from '../../src/lib/organizationPolicy.ts';
import {
	organizationPolicyStoreV1Schema,
	organizationPolicyStoreSchema,
	readOrganizationPolicy
} from '../../src/lib/organizationPolicyStore.ts';
import type { SpdxLicenseIds } from '../../src/lib/spdxIds.ts';
const standard: SpdxLicenseIds = { listVersion: 'fixture', releaseDate: '2026-01-01', ids: new Set(['UPL-1.0', 'MIT']) };
const text = 'Fixture proprietary terms; not an actual owner licence ruling.\n';
const v1 = {
	codkitOrganizationPolicy: 1,
	id: 'scoped-fixture',
	version: 1,
	holders: ['Fixture Owner'],
	ownLicense: 'LicenseRef-FIXTURE-Private',
	allowedThirdParty: ['MIT'],
	forbiddenThirdParty: [],
	allowedExceptions: [],
	licenseRefNamespace: 'FIXTURE',
	customLicenses: [{ id: 'LicenseRef-FIXTURE-Private', text, sha256: createHash('sha256').update(text).digest('hex') }],
	distribution: { requiredNotices: [], sbom: 'spdx-json', requireSourceCarriers: true }
};
function raw() {
	return { ...v1, codkitOrganizationPolicy: 2, ownLicenseScopes: [{ paths: ['contributions/**'], license: 'UPL-1.0' }] };
}
function policy(value: unknown = raw()) {
	const r = validateOrganizationPolicy(value, standard);
	if (!r.ok) throw new Error(r.problems.join(';'));
	return r.value;
}
it('keeps v1 bytes/shape and store strictness while admitting explicit v2 scopes', () => {
	const original = policy(v1);
	expect(JSON.stringify(original)).toBe(JSON.stringify(v1));
	expect(validateOrganizationPolicy({ ...v1, ownLicenseScopes: raw().ownLicenseScopes }, standard).ok).toBe(false);
	expect(organizationPolicyStoreV1Schema.safeParse({ codkitOrganizationPolicyStore: 1, policies: [raw()] }).success).toBe(false);
	expect(
		organizationPolicyStoreSchema.safeParse({ codkitOrganizationPolicyStore: 2, policies: [{ ...v1, id: 'legacy' }, raw()] }).success
	).toBe(true);
	expect(organizationPolicyStoreSchema.safeParse({ codkitOrganizationPolicyStore: 3, policies: [raw()] }).success).toBe(false);
});
it('reads scoped authority only from an external trusted v2 store and binds its bytes', () => {
	const base = mkdtempSync(join(tmpdir(), 'codkit-scoped-store-'));
	try {
		const trusted = join(base, 'trusted');
		const patchset = join(base, 'patchset');
		mkdirSync(trusted);
		mkdirSync(patchset);
		const selection = { profile: v1.id };
		const bytes = JSON.stringify({ codkitOrganizationPolicyStore: 2, policies: [raw()] });
		writeFileSync(join(trusted, 'organization-policies.json'), bytes);
		const loaded = readOrganizationPolicy(trusted, patchset, selection, standard);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) throw new Error(loaded.problems.join(';'));
		expect(loaded.value.policy.codkitOrganizationPolicy).toBe(2);
		expect(loaded.value.storeSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
		expect(readOrganizationPolicy(trusted, patchset, { ...selection, ownLicenseScopes: raw().ownLicenseScopes }, standard).ok).toBe(false);
		writeFileSync(join(patchset, 'organization-policies.json'), bytes);
		expect(readOrganizationPolicy(patchset, patchset, selection, standard).ok).toBe(false);
		for (const store of [
			{ codkitOrganizationPolicyStore: 1, policies: [raw()] },
			{ codkitOrganizationPolicyStore: 3, policies: [raw()] },
			{ codkitOrganizationPolicyStore: 2, policies: [raw(), { ...v1, id: v1.id.toUpperCase() }] }
		]) {
			writeFileSync(join(trusted, 'organization-policies.json'), JSON.stringify(store));
			expect(readOrganizationPolicy(trusted, patchset, selection, standard).ok).toBe(false);
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
it('enforces trusted source scope rather than a global licence choice', () => {
	const p = policy();
	expect(checkOrganizationExpression(p, 'UPL-1.0', true, [], 'contributions/change.ts').ok).toBe(true);
	expect(checkOrganizationExpression(p, 'LicenseRef-FIXTURE-Private', true, [], 'own/new.ts').ok).toBe(true);
	expect(checkOrganizationExpression(p, 'UPL-1.0', true, [], 'own/new.ts').ok).toBe(false);
	expect(checkOrganizationExpression(p, 'LicenseRef-FIXTURE-Private', true, [], 'contributions/change.ts').ok).toBe(false);
	expect(checkOrganizationExpression(p, 'UPL-1.0 OR LicenseRef-FIXTURE-Private', true, [], 'own/new.ts').ok).toBe(false);
	expect(checkOrganizationExpression(p, 'UPL-1.0', true).ok).toBe(false);
	expect(checkOrganizationExpression(p, 'UPL-1.0', true, [], '../outside').ok).toBe(false);
	expect(checkOrganizationExpression(p, 'UPL-1.0', false, [], 'contributions/copied.ts').ok).toBe(false);
	expect(checkOrganizationExpression(p, 'MIT', false, [], 'contributions/copied.ts').ok).toBe(true);
	expect(checkOrganizationExpression(p, 'UPL-1.0', true, ['UPL-1.0'], 'contributions/change.ts').ok).toBe(false);
});
it('refuses ambiguous overlaps, repeated paths, unsafe patterns and unapproved expressions', () => {
	const p = policy({ ...raw(), ownLicenseScopes: [...raw().ownLicenseScopes, { paths: ['contributions/change.*'], license: 'UPL-1.0' }] });
	expect(checkOrganizationExpression(p, 'UPL-1.0', true, [], 'contributions/change.ts')).toMatchObject({
		ok: false,
		problems: [expect.stringContaining('overlap')]
	});
	for (const paths of [['../escape/**'], ['/absolute/**'], ['bad\\path'], ['contributions/**', 'contributions/**']])
		expect(validateOrganizationPolicy({ ...raw(), ownLicenseScopes: [{ paths, license: 'UPL-1.0' }] }, standard).ok).toBe(false);
	expect(
		validateOrganizationPolicy({ ...raw(), ownLicenseScopes: [{ paths: ['new/**'], license: 'LicenseRef-OTHER-Private' }] }, standard).ok
	).toBe(false);
	expect(validateOrganizationPolicy({ ...raw(), codkitOrganizationPolicy: 3 }, standard).ok).toBe(false);
});
it('preserves exact source conjunction for an assembled own artifact', () => {
	const p = policy();
	const sources = [
		{ path: 'own/new.ts', license: 'LicenseRef-FIXTURE-Private' },
		{ path: 'contributions/change.ts', license: 'UPL-1.0' }
	];
	const expression = '( LicenseRef-FIXTURE-Private ) AND ( UPL-1.0 )';
	expect(checkOrganizationArtifactExpression(p, expression, true, [], sources).ok).toBe(true);
	for (const changed of ['UPL-1.0', 'LicenseRef-FIXTURE-Private', 'UPL-1.0 OR LicenseRef-FIXTURE-Private'])
		expect(checkOrganizationArtifactExpression(p, changed, true, [], sources).ok).toBe(false);
	expect(checkOrganizationArtifactExpression(p, expression, true, [], []).ok).toBe(false);
	expect(checkOrganizationArtifactExpression(p, expression, true, [], [{ path: 'own/new.ts', license: 'UPL-1.0' }]).ok).toBe(false);
});
