import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { checkDistributionDocument, distributionSpdxSchema, renderDistributionDocuments } from '../../src/lib/distributionDocuments.ts';
import { captureDistributionProvenance } from '../../src/lib/distributionProvenance.ts';
import { FIXTURE_PRIVATE_TERMS, makeDistributionDocuments } from '../fixtures/makeDistributionDocuments.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
it('requires trusted text for standard licenses too, rather than treating the identifier as a complete notice', () => {
	expect(renderDistributionDocuments(makeDistributionDocuments({ standard: true }))).toMatchObject({
		ok: false,
		problems: [expect.stringContaining('text is missing')]
	});
	const text = 'Fixture standard terms; mechanism only, not actual MIT text or approval.\n';
	const f = makeDistributionDocuments({ standard: true, standardText: text });
	const result = renderDistributionDocuments(f);
	if (!result.ok) throw new Error(result.problems.join('; '));
	expect(result.value.notice).toContain(text);
	expect(result.value.spdx?.hasExtractedLicensingInfos).toEqual([]);
});
it('renders stable versioned notice/SPDX with exact controlled texts and actual payload checksums', () => {
	const f = makeDistributionDocuments();
	const rendered = renderDistributionDocuments(f);
	expect(rendered.ok).toBe(true);
	if (!rendered.ok) throw new Error(rendered.problems.join('; '));
	expect(rendered.value.notice).toContain(FIXTURE_PRIVATE_TERMS);
	expect(rendered.value.notice).toContain('Codkit distribution notices v1');
	expect(rendered.value.spdx).toMatchObject({
		spdxVersion: 'SPDX-2.3',
		files: [{ licenseConcluded: 'LicenseRef-FIXTURE-Private', checksums: [{ checksumValue: f.provenance.files[0]?.sha256 }] }],
		hasExtractedLicensingInfos: [{ licenseId: 'LicenseRef-FIXTURE-Private', extractedText: FIXTURE_PRIVATE_TERMS }]
	});
	expect(rendered.value.sbom).not.toContain('NOASSERTION');
	expect(renderDistributionDocuments(f)).toEqual(rendered);
	const changed = renderDistributionDocuments({ ...f, created: '2026-10-03T00:00:01Z' });
	if (!changed.ok) throw new Error(changed.problems.join('; '));
	expect(changed.value.spdx?.documentNamespace).not.toBe(rendered.value.spdx?.documentNamespace);
});
it('avoids NOTICE/SBOM hash cycles when finalized metadata enters the delivered inventory', () => {
	const f = makeDistributionDocuments();
	const rendered = renderDistributionDocuments(f);
	if (!rendered.ok || rendered.value.sbom === null) throw new Error('fixture export failed');
	writeFileSync(join(f.artifactRoot, 'NOTICE'), rendered.value.notice);
	writeFileSync(join(f.artifactRoot, 'SBOM.spdx.json'), rendered.value.sbom);
	const captured = captureDistributionProvenance({
		sourceRoot: f.sourceRoot,
		artifactRoot: f.artifactRoot,
		outputs: ['app.min.js', 'NOTICE', 'SBOM.spdx.json'],
		selected: f.selected,
		declaration: { ...f.declaration, metadata: ['NOTICE', 'SBOM.spdx.json'] },
		approvedMetadata: ['NOTICE', 'SBOM.spdx.json']
	});
	if (!captured.ok) throw new Error(captured.problems.join('; '));
	expect(captured.value.artifactInventorySha256).not.toBe(f.provenance.artifactInventorySha256);
	expect(renderDistributionDocuments({ ...f, provenance: captured.value })).toEqual(rendered);
});
it('refuses absent, stale/noncanonical documents and payload changes after rendering', () => {
	const f = makeDistributionDocuments();
	const rendered = renderDistributionDocuments(f);
	if (!rendered.ok) throw new Error(rendered.problems.join('; '));
	expect(checkDistributionDocument(f.artifactRoot, 'NOTICE', rendered.value.notice, f.provenance).ok).toBe(false);
	writeFileSync(join(f.artifactRoot, 'NOTICE'), rendered.value.notice);
	expect(checkDistributionDocument(f.artifactRoot, 'NOTICE', rendered.value.notice, f.provenance).ok).toBe(true);
	writeFileSync(join(f.artifactRoot, 'NOTICE'), rendered.value.notice.replaceAll('\n', '\r\n'));
	expect(checkDistributionDocument(f.artifactRoot, 'NOTICE', rendered.value.notice, f.provenance).ok).toBe(false);
	writeFileSync(join(f.artifactRoot, 'NOTICE'), rendered.value.notice);
	writeFileSync(join(f.artifactRoot, 'app.min.js'), '(()=>2)();');
	expect(checkDistributionDocument(f.artifactRoot, 'NOTICE', rendered.value.notice, f.provenance).ok).toBe(false);
});
it('refuses moved authority, invalid component/time, tampered custom text and future SPDX', () => {
	const f = makeDistributionDocuments();
	expect(renderDistributionDocuments({ ...f, selected: { ...f.selected, sha256: 'b'.repeat(64) } }).ok).toBe(false);
	expect(renderDistributionDocuments({ ...f, componentId: '../bad' }).ok).toBe(false);
	expect(renderDistributionDocuments({ ...f, created: '2026-10-03T00:00:00.1Z' }).ok).toBe(false);
	expect(
		renderDistributionDocuments({
			...f,
			selected: {
				...f.selected,
				policy: { ...f.selected.policy, customLicenses: f.selected.policy.customLicenses.map((entry) => ({ ...entry, text: 'changed\n' })) }
			}
		}).ok
	).toBe(false);
	const rendered = renderDistributionDocuments(f);
	if (!rendered.ok) throw new Error(rendered.problems.join('; '));
	expect(distributionSpdxSchema.safeParse({ ...rendered.value.spdx, spdxVersion: 'SPDX-3.0' }).success).toBe(false);
});
