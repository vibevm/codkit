// PROP-019 CONSUMER-LICENSE-CLI: real launcher, isolated fixture policy authority.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runCli } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const home = makeTempRoot('consumer-cli-home');
	const patches = makeTempRoot('consumer-cli-patches');
	const source = makeTempRoot('consumer-cli-source');
	mkdirSync(join(home, '.codkit'));
	writeFileSync(
		join(source, 'own.ts'),
		'// Copyright (c) 2026 Fixture Org\n// SPDX-License-Identifier: LicenseRef-FIXTURE-Private\nexport const value = 1;\n'
	);
	const text = 'Fixture private terms, not a commercial legal approval.\n';
	const store = JSON.stringify({
		codkitOrganizationPolicyStore: 1,
		policies: [
			{
				codkitOrganizationPolicy: 1,
				id: 'fixture',
				version: 1,
				holders: ['Fixture Org'],
				ownLicense: 'LicenseRef-FIXTURE-Private',
				allowedThirdParty: ['MIT'],
				forbiddenThirdParty: [],
				allowedExceptions: [],
				licenseRefNamespace: 'FIXTURE',
				customLicenses: [{ id: 'LicenseRef-FIXTURE-Private', text, sha256: createHash('sha256').update(text).digest('hex') }],
				distribution: { requiredNotices: ['NOTICE'], sbom: 'spdx-json', requireSourceCarriers: true }
			}
		]
	});
	const env = { HOME: home, USERPROFILE: home, CODKIT_PATCHES_DIR: patches };
	return {
		home,
		patches,
		source,
		store,
		env,
		run: (args: string[]) => runCli(patches, ['--json', 'license', 'consumer-check', ...args], env)
	};
}
it('selects trusted profile through the launcher without config, fork or adapter', () => {
	const f = fixture();
	writeFileSync(join(f.home, '.codkit/organization-policies.json'), f.store);
	const run = f.run([f.source, '--profile', 'fixture']);
	expect(run.status, run.stderr).toBe(0);
	expect(JSON.parse(run.stdout)).toMatchObject({
		ok: true,
		data: { codkitConsumerLicenseCheck: 1, status: 'complete', policy: { id: 'fixture' }, checked: [{ path: 'own.ts' }] }
	});
	writeFileSync(join(f.source, 'own.ts'), 'export const lostCarrier = 1;\n');
	const lost = f.run([f.source, '--profile', 'fixture']);
	expect(lost.status).toBe(1);
	expect(JSON.parse(lost.stdout).data.status).toBe('incomplete');
});
it('refuses missing trusted profile despite a matching patchset shadow', () => {
	const f = fixture();
	writeFileSync(join(f.patches, 'organization-policies.json'), f.store);
	const run = f.run([f.source, '--profile', 'fixture']);
	expect(run.status).toBe(2);
	expect(run.stderr).toContain('no patchset fallback');
});
it('refuses a trusted home store physically inside the patchset', () => {
	const f = fixture();
	mkdirSync(join(f.patches, '.codkit'));
	writeFileSync(join(f.patches, '.codkit/organization-policies.json'), f.store);
	const run = runCli(f.patches, ['--json', 'license', 'consumer-check', f.source, '--profile', 'fixture'], {
		...f.env,
		HOME: f.patches,
		USERPROFILE: f.patches
	});
	expect(run.status).toBe(2);
	expect(run.stderr).toContain('must not be inside the patchset');
});
it('requires explicit source/profile and exposes no policy authority flags', () => {
	const f = fixture();
	expect(f.run([f.source]).status).toBe(2);
	expect(f.run(['--profile', 'fixture']).status).toBe(2);
	expect(f.run([f.source, '--profile', 'fixture', '--policy-dir', f.patches]).status).toBe(2);
});
