// A trusted organization profile for the e2e suites of the consumer surfaces
// (PROP-019 ##LICENSING-DECLARATION-V2, ##HEADER-FROM-PROFILE, ##GEN-LICENSING,
// ##ANNOTATE-OWN, ##VERIFY-LICENSING).
//
// The store lives in a temporary home directory, never in the patch set
// (##ORGANIZATION-POLICY-TRUST), and the patch set receives a version-2
// declaration selecting the one profile. The canonical text is a fixture
// sentence, not a commercial approval; the suites prove mechanism, not law.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempRoot } from './tmp.ts';

/** The id the declaration selects. */
export const FIXTURE_PROFILE_ID = 'fixture';
/** The one holder of the profile; every own carrier names it. */
export const FIXTURE_HOLDER = 'Fixture Org';
/** The own licence of the profile: a custom text in the profile's namespace. */
export const FIXTURE_LICENSE_ID = 'LicenseRef-FIXTURE-Private-1.0';
/** The human title the declaration gives the licence. */
export const FIXTURE_LICENSE_TITLE = 'Fixture Private Licence';
/** The canonical text of the first edition, LF-only with a final LF. */
export const FIXTURE_LICENSE_TEXT = '# Fixture Private Licence\n\nFixture private terms, not a commercial legal approval.\n';
/** A phrase the guard must forbid: the posture the profile retires. */
export const FIXTURE_RETIRED_NOTICE = 'source-available';
/** The year the declaration fixes for every header. */
export const FIXTURE_YEAR = '2026';
/** A holder the profile does not list, for the files annotate must report and verify must refuse. */
export const FOREIGN_HOLDER = 'Somebody Else';

export type LicensingFixture = {
	/** The temporary home directory carrying `.codkit/organization-policies.json`. */
	readonly home: string;
	/** What a CLI run needs to find the store: HOME and USERPROFILE at the temporary home. */
	readonly env: Readonly<Record<string, string>>;
	/** Rewrite the canonical text of the own licence in the store (a new edition). */
	readonly setLicenseText: (text: string) => void;
	/** Remove the store, so a profile is selected that the machine does not carry. */
	readonly removeStore: () => void;
};

function sha256(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

/** The store: version 2, one version-2 policy with one own scope over the own layer. */
export function storeText(licenseText: string = FIXTURE_LICENSE_TEXT): string {
	return `${JSON.stringify(
		{
			codkitOrganizationPolicyStore: 2,
			policies: [
				{
					codkitOrganizationPolicy: 2,
					id: FIXTURE_PROFILE_ID,
					version: 1,
					holders: [FIXTURE_HOLDER],
					ownLicense: FIXTURE_LICENSE_ID,
					ownLicenseScopes: [{ paths: ['delta/own/**', 'delta/own-extensions/**', 'delta/own-roots/**'], license: FIXTURE_LICENSE_ID }],
					allowedThirdParty: ['MIT', 'UPL-1.0'],
					forbiddenThirdParty: [],
					allowedExceptions: [],
					licenseRefNamespace: 'FIXTURE',
					customLicenses: [{ id: FIXTURE_LICENSE_ID, text: licenseText, sha256: sha256(licenseText) }],
					distribution: { requiredNotices: ['NOTICE'], sbom: 'none', requireSourceCarriers: false }
				}
			]
		},
		null,
		'\t'
	)}\n`;
}

/** The declaration the patch set carries: version 2, selecting the profile, with the product block. */
export function declarationText(overrides: { readonly product?: Record<string, unknown> | null; readonly profile?: string } = {}): string {
	const product =
		overrides.product === null
			? {}
			: {
					product: {
						licenseFile: 'LICENSE.md',
						title: FIXTURE_LICENSE_TITLE,
						holder: FIXTURE_HOLDER,
						year: FIXTURE_YEAR,
						retiredNotices: [FIXTURE_RETIRED_NOTICE],
						...(overrides.product ?? {})
					}
				};
	return `${JSON.stringify(
		{
			codkitReleaseLicensing: 2,
			profile: overrides.profile ?? FIXTURE_PROFILE_ID,
			componentId: 'fixture-product',
			created: '2026-01-01T00:00:00Z',
			sourceDirectory: '.',
			...product
		},
		null,
		'\t'
	)}\n`;
}

/**
 * Install the trusted store in a fresh temporary home and the declaration in
 * the patch set. The returned `env` goes to every CLI run of the suite.
 */
export function installLicensingProfile(
	label: string,
	patchesDir: string,
	options: { readonly licenseText?: string; readonly product?: Record<string, unknown> | null; readonly profile?: string } = {}
): LicensingFixture {
	const home = makeTempRoot(`${label}-home`);
	const storeDir = join(home, '.codkit');
	mkdirSync(storeDir, { recursive: true });
	const storePath = join(storeDir, 'organization-policies.json');
	writeFileSync(storePath, storeText(options.licenseText), 'utf8');
	const overrides: { product?: Record<string, unknown> | null; profile?: string } = {};
	if (options.product !== undefined) overrides.product = options.product;
	if (options.profile !== undefined) overrides.profile = options.profile;
	writeFileSync(join(patchesDir, 'codkit.licensing.json'), declarationText(overrides), 'utf8');
	return {
		home,
		env: { HOME: home, USERPROFILE: home },
		setLicenseText: (text) => writeFileSync(storePath, storeText(text), 'utf8'),
		removeStore: () => writeFileSync(storePath, '', 'utf8')
	};
}

/** The block header the engine lays out from the fixture profile, for a file whose own licence is the fixture's. */
export function fixtureBlockHeaderLines(): readonly string[] {
	return [
		`/*${'-'.repeat(93)}`,
		` *  Copyright (c) ${FIXTURE_YEAR} ${FIXTURE_HOLDER}`,
		` *  All rights reserved. Licensed under the ${FIXTURE_LICENSE_TITLE}; the full text is LICENSE.md of this repository.`,
		` *  SPDX-License-Identifier: ${FIXTURE_LICENSE_ID}`,
		` *${'-'.repeat(92)}*/`
	];
}
