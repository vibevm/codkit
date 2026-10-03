import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { checkDistributionNotices, distributionNoticesSchema } from '../../src/lib/distributionNotices.ts';
import { validateOrganizationPolicy } from '../../src/lib/organizationPolicy.ts';
import type { SelectedOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const root = makeTempRoot('distribution-notice');
	mkdirSync(join(root, 'dist'));
	writeFileSync(join(root, 'dist/app.min.js'), '(()=>{console.log(1)})();');
	const validated = validateOrganizationPolicy(
		{
			codkitOrganizationPolicy: 1,
			id: 'fixture',
			version: 1,
			holders: ['Fixture Org'],
			ownLicense: 'MIT',
			allowedThirdParty: ['MIT'],
			forbiddenThirdParty: [],
			allowedExceptions: [],
			licenseRefNamespace: 'FIXTURE',
			customLicenses: [],
			distribution: { requiredNotices: ['NOTICE'], sbom: 'none', requireSourceCarriers: false }
		},
		{ listVersion: 'fixture', releaseDate: '2026-01-01', ids: new Set(['MIT']) }
	);
	if (!validated.ok) throw new Error(validated.problems.join('; '));
	const selected: SelectedOrganizationPolicy = {
		policy: validated.value,
		sha256: createHash('sha256').update(JSON.stringify(validated.value)).digest('hex'),
		storeSha256: 'a'.repeat(64),
		additionalForbidden: []
	};
	return { root, selected };
}
it('refuses minified output with lost carriers and no required attached notice', () => {
	const f = fixture();
	const report = checkDistributionNotices(f.root, ['dist'], f.selected);
	expect(report.status).toBe('incomplete');
	expect(report.problems).toMatchObject([{ file: 'dist/NOTICE', message: 'required distribution notice is missing' }]);
});
it('binds actual attached notice and directory inventory bytes deterministically', () => {
	const f = fixture();
	const text = 'Fixture distribution notice; mechanism evidence, not legal approval.\n';
	writeFileSync(join(f.root, 'dist/NOTICE'), text);
	const report = checkDistributionNotices(f.root, ['dist'], f.selected);
	expect(report.status).toBe('complete');
	expect(report.notices).toEqual([
		{ id: 'NOTICE', path: 'dist/NOTICE', sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }
	]);
	expect(checkDistributionNotices(f.root, ['dist'], f.selected)).toEqual(report);
	writeFileSync(join(f.root, 'dist/app.min.js'), '(()=>{console.log(2)})();');
	expect(checkDistributionNotices(f.root, ['dist'], f.selected).artifactInventorySha256).not.toBe(report.artifactInventorySha256);
});
it('requires a sibling notice to be a declared delivered output for file artifacts', () => {
	const f = fixture();
	writeFileSync(join(f.root, 'dist/NOTICE'), 'Fixture notice\n');
	expect(checkDistributionNotices(f.root, ['dist/app.min.js'], f.selected).status).toBe('incomplete');
	expect(checkDistributionNotices(f.root, ['dist/app.min.js', 'dist/NOTICE'], f.selected).status).toBe('complete');
});
it('does not borrow notice from another directory bundle or nested directory', () => {
	const f = fixture();
	mkdirSync(join(f.root, 'other'));
	writeFileSync(join(f.root, 'other/app.js'), '1;');
	writeFileSync(join(f.root, 'dist/NOTICE'), 'Fixture notice\n');
	mkdirSync(join(f.root, 'other/nested'));
	writeFileSync(join(f.root, 'other/nested/NOTICE'), 'Fixture notice in the wrong location\n');
	expect(checkDistributionNotices(f.root, ['dist', 'other'], f.selected).problems).toMatchObject([{ file: 'other/NOTICE' }]);
});
it('refuses empty, undecodable, absent payload and falsely complete reports', () => {
	const f = fixture();
	for (const text of [Buffer.from(' \n'), Buffer.from([255])]) {
		writeFileSync(join(f.root, 'dist/NOTICE'), text);
		expect(checkDistributionNotices(f.root, ['dist'], f.selected).status).toBe('incomplete');
	}
	writeFileSync(join(f.root, 'dist/NOTICE'), 'Fixture notice\n');
	expect(checkDistributionNotices(f.root, ['dist/NOTICE'], f.selected).status).toBe('incomplete');
	expect(checkDistributionNotices(f.root, [], f.selected).status).toBe('incomplete');
	const report = checkDistributionNotices(f.root, ['missing'], f.selected);
	expect(report.status).toBe('incomplete');
	expect(distributionNoticesSchema.safeParse({ ...report, status: 'complete' }).success).toBe(false);
	expect(distributionNoticesSchema.safeParse({ ...report, codkitDistributionNotices: 2 }).success).toBe(false);
});
