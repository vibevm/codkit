// Mechanism fixture only: these private terms are not a real legal approval.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateOrganizationPolicy } from '../../src/lib/organizationPolicy.ts';
import type { SelectedOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import { captureDistributionProvenance } from '../../src/lib/distributionProvenance.ts';
import { makeTempRoot } from '../support/tmp.ts';

export const FIXTURE_PRIVATE_TERMS = 'Fixture private terms; no legal approval.\n\n';
export function makeDistributionDocuments(options: { readonly standard?: boolean; readonly standardText?: string } = {}) {
	const sourceRoot = makeTempRoot('doc-source');
	const artifactRoot = makeTempRoot('doc-artifact');
	const expression = options.standard === true ? 'MIT' : 'LicenseRef-FIXTURE-Private';
	writeFileSync(
		join(sourceRoot, 'own.ts'),
		`// Copyright (c) 2026 Fixture Org\n// SPDX-License-Identifier: ${expression}\nexport const value = 1;\n`
	);
	writeFileSync(join(artifactRoot, 'app.min.js'), '(()=>1)();');
	const policy = validateOrganizationPolicy(
		{
			codkitOrganizationPolicy: 1,
			id: 'fixture',
			version: 1,
			holders: ['Fixture Org'],
			ownLicense: expression,
			allowedThirdParty: ['MIT'],
			forbiddenThirdParty: [],
			allowedExceptions: [],
			licenseRefNamespace: 'FIXTURE',
			customLicenses: [
				{
					id: 'LicenseRef-FIXTURE-Private',
					text: FIXTURE_PRIVATE_TERMS,
					sha256: createHash('sha256').update(FIXTURE_PRIVATE_TERMS).digest('hex')
				}
			],
			...(options.standardText === undefined
				? {}
				: {
						standardLicenseTexts: [
							{ id: 'MIT', text: options.standardText, sha256: createHash('sha256').update(options.standardText).digest('hex') }
						]
					}),
			distribution: { requiredNotices: ['NOTICE'], sbom: 'spdx-json', requireSourceCarriers: false }
		},
		{ listVersion: 'fixture', releaseDate: '2026-01-01', ids: new Set(['MIT']) }
	);
	if (!policy.ok) throw new Error(policy.problems.join('; '));
	const selected: SelectedOrganizationPolicy = {
		policy: policy.value,
		sha256: createHash('sha256').update(JSON.stringify(policy.value)).digest('hex'),
		storeSha256: 'a'.repeat(64),
		additionalForbidden: []
	};
	const declaration = {
		codkitDistributionDeclaration: 1,
		files: [{ path: 'app.min.js', sources: ['own.ts'], license: expression }],
		metadata: []
	};
	const captured = captureDistributionProvenance({
		sourceRoot,
		artifactRoot,
		outputs: ['app.min.js'],
		selected,
		declaration,
		approvedMetadata: []
	});
	if (!captured.ok) throw new Error(captured.problems.join('; '));
	return {
		sourceRoot,
		artifactRoot,
		selected,
		declaration,
		provenance: captured.value,
		componentId: 'fixture-component',
		created: '2026-10-03T00:00:00Z'
	};
}
