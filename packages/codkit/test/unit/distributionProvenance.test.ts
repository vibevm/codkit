import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { captureDistributionProvenance } from '../../src/lib/distributionProvenance.ts';
import { validateOrganizationPolicy } from '../../src/lib/organizationPolicy.ts';
import type { SelectedOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const sourceRoot = makeTempRoot('dist-provenance-source');
	const artifactRoot = makeTempRoot('dist-provenance-artifact');
	writeFileSync(
		join(sourceRoot, 'own.ts'),
		'// Copyright (c) 2026 Fixture Org\n// SPDX-License-Identifier: MIT\nexport const value = 1;\n'
	);
	writeFileSync(join(artifactRoot, 'app.min.js'), '(()=>1)();');
	const checked = validateOrganizationPolicy(
		{
			codkitOrganizationPolicy: 1,
			id: 'fixture',
			version: 1,
			holders: ['Fixture Org'],
			ownLicense: 'MIT',
			allowedThirdParty: ['MIT', 'MIT AND Apache-2.0', 'MIT OR Apache-2.0'],
			forbiddenThirdParty: [],
			allowedExceptions: [],
			licenseRefNamespace: 'FIXTURE',
			customLicenses: [],
			distribution: { requiredNotices: ['NOTICE'], sbom: 'none', requireSourceCarriers: false }
		},
		{ listVersion: 'fixture', releaseDate: '2026-01-01', ids: new Set(['MIT', 'Apache-2.0']) }
	);
	if (!checked.ok) throw new Error(checked.problems.join('; '));
	const selected: SelectedOrganizationPolicy = {
		policy: checked.value,
		sha256: createHash('sha256').update(JSON.stringify(checked.value)).digest('hex'),
		storeSha256: 'a'.repeat(64),
		additionalForbidden: []
	};
	const declaration = {
		codkitDistributionDeclaration: 1,
		files: [{ path: 'app.min.js', sources: ['own.ts'], license: 'MIT' }],
		metadata: []
	};
	const options = { sourceRoot, artifactRoot, outputs: ['app.min.js'], selected, declaration, approvedMetadata: [] as string[] };
	return options;
}
it('binds actual payload, checked source, carrier and selected authority without inferring from minified output', () => {
	const f = fixture();
	const captured = captureDistributionProvenance(f);
	expect(captured.ok).toBe(true);
	if (!captured.ok) throw new Error(captured.problems.join('; '));
	expect(captured.value.files).toMatchObject([
		{ path: 'app.min.js', license: 'MIT', scope: 'own', sources: [{ path: 'own.ts', carrierPath: 'own.ts' }] }
	]);
	expect(captured.value.files[0]?.sha256).toBe(createHash('sha256').update('(()=>1)();').digest('hex'));
	expect(captureDistributionProvenance(f)).toEqual(captured);
});
it('refuses uninspected sources, missing and undeclared payloads and duplicate mappings', () => {
	const f = fixture();
	expect(
		captureDistributionProvenance({
			...f,
			declaration: { ...f.declaration, files: [{ path: 'app.min.js', sources: ['missing.ts'], license: 'MIT' }] }
		}).ok
	).toBe(false);
	writeFileSync(join(f.artifactRoot, 'extra.js'), '2;');
	expect(captureDistributionProvenance({ ...f, outputs: ['app.min.js', 'extra.js'] }).ok).toBe(false);
	expect(captureDistributionProvenance({ ...f, outputs: ['extra.js'] }).ok).toBe(false);
	expect(
		captureDistributionProvenance({ ...f, declaration: { ...f.declaration, files: [...f.declaration.files, ...f.declaration.files] } }).ok
	).toBe(false);
});
it('lets only trusted composition approve metadata exclusions, and still binds their actual bytes', () => {
	const f = fixture();
	writeFileSync(join(f.artifactRoot, 'NOTICE'), 'Fixture notice\n');
	const withMetadata = { ...f, outputs: ['app.min.js', 'NOTICE'], declaration: { ...f.declaration, metadata: ['NOTICE'] } };
	expect(captureDistributionProvenance(withMetadata).ok).toBe(false);
	const accepted = captureDistributionProvenance({ ...withMetadata, approvedMetadata: ['NOTICE'] });
	expect(accepted).toMatchObject({ ok: true, value: { metadata: [{ path: 'NOTICE', bytes: 15 }] } });
	expect(
		captureDistributionProvenance({ ...f, declaration: { ...f.declaration, metadata: ['missing'] }, approvedMetadata: ['missing'] }).ok
	).toBe(false);
});
it('refuses incomplete source declarations, future formats and additional policy prohibitions', () => {
	const f = fixture();
	expect(captureDistributionProvenance({ ...f, declaration: { ...f.declaration, codkitDistributionDeclaration: 2 } }).ok).toBe(false);
	expect(captureDistributionProvenance({ ...f, selected: { ...f.selected, additionalForbidden: ['MIT'] } }).ok).toBe(false);
	writeFileSync(join(f.sourceRoot, 'own.ts'), 'export const lost = 1;\n');
	expect(captureDistributionProvenance(f).ok).toBe(false);
});
it('does not convert an upstream AND obligation to OR even when the profile lists both combinations', () => {
	const f = fixture();
	writeFileSync(
		join(f.sourceRoot, 'own.ts'),
		'// Copyright (c) 2026 Upstream Holder\n// SPDX-License-Identifier: MIT AND Apache-2.0\n1;\n'
	);
	writeFileSync(
		join(f.sourceRoot, 'REUSE.toml'),
		'version = 1\n[[annotations]]\npath = "own.ts"\nSPDX-FileCopyrightText = "2026 Upstream Holder"\nSPDX-License-Identifier = "MIT AND Apache-2.0"\nSPDX-FileComment = "third-party; fixture origin"\n'
	);
	const files = [{ path: 'app.min.js', sources: ['own.ts'], license: 'MIT AND Apache-2.0' }];
	expect(captureDistributionProvenance({ ...f, declaration: { ...f.declaration, files } }).ok).toBe(true);
	expect(
		captureDistributionProvenance({ ...f, declaration: { ...f.declaration, files: [{ ...files[0], license: 'MIT OR Apache-2.0' }] } })
	).toMatchObject({ ok: false, problems: [expect.stringContaining('AND/OR/WITH')] });
});
