import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkConsumerLicenses } from '../../src/lib/consumerLicenseCheck.ts';
import { validateOrganizationPolicy } from '../../src/lib/organizationPolicy.ts';
import type { SelectedOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';

const roots: string[] = [];
function root() {
	const path = mkdtempSync(join(tmpdir(), 'codkit-consumer-license-'));
	roots.push(path);
	return path;
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const terms = 'Fixture organization proprietary terms; no real legal approval.\n';
function selected(): SelectedOrganizationPolicy {
	const raw = {
		codkitOrganizationPolicy: 1,
		id: 'fixture',
		version: 1,
		holders: ['Fixture Org'],
		ownLicense: 'LicenseRef-FIXTURE-Private',
		allowedThirdParty: ['MIT'],
		forbiddenThirdParty: [],
		allowedExceptions: [],
		licenseRefNamespace: 'FIXTURE',
		customLicenses: [{ id: 'LicenseRef-FIXTURE-Private', text: terms, sha256: createHash('sha256').update(terms).digest('hex') }],
		distribution: { requiredNotices: ['NOTICE'], sbom: 'spdx-json', requireSourceCarriers: false }
	};
	const checked = validateOrganizationPolicy(raw, { listVersion: 'fixture', releaseDate: '2026-01-01', ids: new Set(['MIT']) });
	if (!checked.ok) throw new Error(checked.problems.join('; '));
	return {
		policy: checked.value,
		sha256: createHash('sha256').update(JSON.stringify(checked.value)).digest('hex'),
		storeSha256: 'a'.repeat(64),
		additionalForbidden: []
	};
}
function header(holder = 'Fixture Org', expression = 'LicenseRef-FIXTURE-Private'): string {
	return `// Copyright (c) 2026 ${holder}\n// SPDX-License-Identifier: ${expression}\nexport const value = 1;\n`;
}

it('checks proprietary own source against the trusted policy and binds actual byte hashes', () => {
	const dir = root();
	const bytes = header();
	writeFileSync(join(dir, 'own.ts'), bytes);
	const report = checkConsumerLicenses(dir, selected());
	expect(report.status).toBe('complete');
	expect(report.problems).toEqual([]);
	expect(report.checked).toMatchObject([
		{
			path: 'own.ts',
			kind: 'own',
			carrier: 'header',
			license: 'LicenseRef-FIXTURE-Private',
			sha256: createHash('sha256').update(bytes).digest('hex')
		}
	]);
	expect(checkConsumerLicenses(dir, selected())).toEqual(report);
});
it('refuses an undeclared custom expression and a patchset prohibition', () => {
	const dir = root();
	writeFileSync(join(dir, 'own.ts'), header('Fixture Org', 'LicenseRef-FIXTURE-Other'));
	expect(checkConsumerLicenses(dir, selected()).status).toBe('incomplete');
	writeFileSync(join(dir, 'own.ts'), header());
	expect(checkConsumerLicenses(dir, { ...selected(), additionalForbidden: ['LicenseRef-FIXTURE-Private'] }).status).toBe('incomplete');
});
it('keeps foreign holders in third-party scope and requires provenance before accepting an approved expression', () => {
	const dir = root();
	writeFileSync(join(dir, 'vendor.ts'), header('External Vendor', 'MIT'));
	expect(checkConsumerLicenses(dir, selected()).status).toBe('incomplete');
	writeFileSync(
		join(dir, 'REUSE.toml'),
		'version = 1\n[[annotations]]\npath = "vendor.ts"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2026 External Vendor"\nSPDX-License-Identifier = "MIT"\nSPDX-FileComment = "third-party; fixture provenance"\n'
	);
	expect(checkConsumerLicenses(dir, selected())).toMatchObject({ status: 'complete', checked: [{ kind: 'third-party', license: 'MIT' }] });
});
it('uses sidecars for binary bytes but refuses orphan and disagreeing carriers', () => {
	const dir = root();
	writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 255, 2]));
	writeFileSync(
		join(dir, 'image.bin.license'),
		'SPDX-FileCopyrightText: 2026 Fixture Org\nSPDX-License-Identifier: LicenseRef-FIXTURE-Private\n'
	);
	expect(checkConsumerLicenses(dir, selected())).toMatchObject({
		status: 'complete',
		checked: [{ carrier: 'sidecar', carrierPath: 'image.bin.license' }]
	});
	writeFileSync(join(dir, 'orphan.license'), header());
	expect(checkConsumerLicenses(dir, selected()).problems.some((entry) => entry.message.includes('orphan'))).toBe(true);
});
it('does not reclassify a mixed/upstream copyright as organization-owned work', () => {
	const dir = root();
	writeFileSync(join(dir, 'mixed.ts'), header() + '// Copyright (c) 2025 Upstream Holder\n');
	const report = checkConsumerLicenses(dir, selected());
	expect(report.status).toBe('incomplete');
	expect(report.checked[0]?.kind).toBe('third-party');
});
it('refuses an own override annotation that erases declared upstream ownership', () => {
	const dir = root();
	writeFileSync(join(dir, 'upstream.ts'), header('Upstream Holder', 'MIT'));
	writeFileSync(
		join(dir, 'REUSE.toml'),
		'version = 1\n[[annotations]]\npath = "upstream.ts"\nprecedence = "override"\nSPDX-FileCopyrightText = "2026 Fixture Org"\nSPDX-License-Identifier = "LicenseRef-FIXTURE-Private"\n'
	);
	const report = checkConsumerLicenses(dir, selected());
	expect(report.status).toBe('incomplete');
	expect(report.problems.some((entry) => entry.message.includes('upstream ownership'))).toBe(true);
});
it('refuses source directory symlinks without consuming outside source', () => {
	const dir = root();
	const outside = root();
	mkdirSync(join(outside, 'source'));
	writeFileSync(join(outside, 'source/hidden.ts'), header());
	symlinkSync(join(outside, 'source'), join(dir, 'escape'), 'junction');
	expect(checkConsumerLicenses(dir, selected())).toMatchObject({ status: 'incomplete', checked: [] });
});
