// Actual I/O over generic source/payload fixtures, not legal decisions for any consumer product.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { validateOrganizationPolicy } from '../../src/lib/organizationPolicy.ts';
import { checkConsumerLicenses } from '../../src/lib/consumerLicenseCheck.ts';
import { captureDistributionProvenance } from '../../src/lib/distributionProvenance.ts';
import { renderDistributionDocuments } from '../../src/lib/distributionDocuments.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
afterAll(cleanupTempRoots);
function fixture() {
	const sourceRoot = makeTempRoot('mixed-source'),
		artifactRoot = makeTempRoot('mixed-payload');
	mkdirSync(join(sourceRoot, 'contributions'));
	writeFileSync(
		join(sourceRoot, 'contributions/a.ts'),
		'// Copyright (c) 2026 Fixture Owner\n// SPDX-License-Identifier: UPL-1.0\nexport const a=1;\n'
	);
	writeFileSync(
		join(sourceRoot, 'b.ts'),
		'// Copyright (c) 2026 Fixture Owner\n// SPDX-License-Identifier: LicenseRef-FIXTURE-Private\nexport const b=2;\n'
	);
	writeFileSync(join(artifactRoot, 'app.bin'), 'opaque assembled output');
	const text = 'Fixture proprietary terms; not an actual licence approval.\n';
	const upl = 'Fixture UPL terms, not an actual distribution licence text.\n';
	const result = validateOrganizationPolicy(
		{
			codkitOrganizationPolicy: 2,
			id: 'mixed-fixture',
			version: 1,
			holders: ['Fixture Owner'],
			ownLicense: 'LicenseRef-FIXTURE-Private',
			ownLicenseScopes: [{ paths: ['contributions/**'], license: 'UPL-1.0' }],
			allowedThirdParty: [],
			forbiddenThirdParty: [],
			allowedExceptions: [],
			licenseRefNamespace: 'FIXTURE',
			customLicenses: [{ id: 'LicenseRef-FIXTURE-Private', text, sha256: hash(text) }],
			standardLicenseTexts: [{ id: 'UPL-1.0', text: upl, sha256: hash(upl) }],
			distribution: { requiredNotices: ['NOTICE'], sbom: 'spdx-json', requireSourceCarriers: false }
		},
		{ listVersion: 'fixture', releaseDate: '2026-01-01', ids: new Set(['UPL-1.0']) }
	);
	if (!result.ok) throw new Error(result.problems.join(';'));
	const selected = {
		policy: result.value,
		sha256: hash(JSON.stringify(result.value)),
		storeSha256: 'a'.repeat(64),
		additionalForbidden: []
	};
	const expression = '( LicenseRef-FIXTURE-Private ) AND ( UPL-1.0 )';
	const declaration = {
		codkitDistributionDeclaration: 1,
		files: [{ path: 'app.bin', sources: ['b.ts', 'contributions/a.ts'], license: expression }],
		metadata: []
	};
	return { sourceRoot, artifactRoot, outputs: ['app.bin'], selected, declaration, expression, approvedMetadata: [] as string[] };
}
function hash(text: string) {
	return createHash('sha256').update(text).digest('hex');
}
it('carries independently checked scoped licences into immutable provenance, notice and SPDX', () => {
	const f = fixture();
	const source = checkConsumerLicenses(f.sourceRoot, f.selected);
	expect(source.status).toBe('complete');
	expect(source.checked.map((file) => file.license).sort()).toEqual(['LicenseRef-FIXTURE-Private', 'UPL-1.0']);
	const proof = captureDistributionProvenance(f);
	if (!proof.ok) throw new Error(proof.problems.join(';'));
	const docs = renderDistributionDocuments({
		selected: f.selected,
		provenance: proof.value,
		componentId: 'generic-mixed',
		created: '2026-01-01T00:00:00Z'
	});
	if (!docs.ok) throw new Error(docs.problems.join(';'));
	expect(docs.value.notice).toContain('UPL-1.0');
	expect(docs.value.notice).toContain('LicenseRef-FIXTURE-Private');
	expect(docs.value.spdx?.files[0]?.licenseConcluded).toBe(f.expression);
	expect(docs.value.spdx?.hasExtractedLicensingInfos[0]?.licenseId).toBe('LicenseRef-FIXTURE-Private');
});
it('refuses relabelled source scope, disjunction and narrowed artifact licences', () => {
	const f = fixture();
	for (const license of ['UPL-1.0', 'LicenseRef-FIXTURE-Private', 'UPL-1.0 OR LicenseRef-FIXTURE-Private'])
		expect(
			captureDistributionProvenance({ ...f, declaration: { ...f.declaration, files: [{ ...f.declaration.files[0]!, license }] } }).ok
		).toBe(false);
	writeFileSync(
		join(f.sourceRoot, 'b.ts'),
		'// Copyright (c) 2026 Fixture Owner\n// SPDX-License-Identifier: UPL-1.0\nexport const b=2;\n'
	);
	expect(checkConsumerLicenses(f.sourceRoot, f.selected).status).toBe('incomplete');
	expect(captureDistributionProvenance(f).ok).toBe(false);
});
