import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
	assertReleaseLicensingUnchanged,
	checkReleaseLicensing,
	readReleaseLicensing,
	readSnapshotReleaseLicensing,
	RELEASE_LICENSING_FILE
} from '../../src/lib/releaseLicensing.ts';
import { captureDistributionProvenance } from '../../src/lib/distributionProvenance.ts';
import { renderDistributionDocuments } from '../../src/lib/distributionDocuments.ts';
import { readOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { makeDistributionDocuments } from '../fixtures/makeDistributionDocuments.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture(carriers = false) {
	const f = makeDistributionDocuments();
	const patchesDir = makeTempRoot('licensing-declaration');
	const policyDir = makeTempRoot('licensing-authority');
	writeFileSync(
		join(policyDir, 'organization-policies.json'),
		JSON.stringify({
			codkitOrganizationPolicyStore: 1,
			policies: [{ ...f.selected.policy, distribution: { ...f.selected.policy.distribution, requireSourceCarriers: carriers } }]
		})
	);
	const selected = readOrganizationPolicy(policyDir, patchesDir, { profile: 'fixture' });
	if (!selected.ok) throw new Error(selected.problems.join('; '));
	if (carriers) writeFileSync(join(f.artifactRoot, 'app.min.js'), readFileSync(join(f.sourceRoot, 'own.ts')));
	const proof = captureDistributionProvenance({
		sourceRoot: f.sourceRoot,
		artifactRoot: f.artifactRoot,
		outputs: ['app.min.js'],
		declaration: f.declaration,
		selected: selected.value,
		approvedMetadata: []
	});
	if (!proof.ok) throw new Error(proof.problems.join('; '));
	const docs = renderDistributionDocuments({ ...f, selected: selected.value, provenance: proof.value });
	if (!docs.ok || docs.value.sbom === null) throw new Error('fixture documents failed');
	writeFileSync(join(f.artifactRoot, 'NOTICE'), docs.value.notice);
	writeFileSync(join(f.artifactRoot, 'SBOM.spdx.json'), docs.value.sbom);
	const operation = { declaration: { ...f.declaration, metadata: ['NOTICE', 'SBOM.spdx.json'] }, sbomFile: 'SBOM.spdx.json' };
	const declaration = {
		codkitReleaseLicensing: 1,
		profile: 'fixture',
		componentId: f.componentId,
		created: f.created,
		sourceDirectory: '.',
		package: operation,
		publish: operation
	};
	writeFileSync(join(patchesDir, RELEASE_LICENSING_FILE), JSON.stringify(declaration));
	const licensing = readReleaseLicensing(patchesDir, 'package', policyDir);
	if (licensing === null) throw new Error('fixture declaration absent');
	return {
		...f,
		patchesDir,
		policyDir,
		declaration,
		licensing,
		check: () =>
			checkReleaseLicensing({
				licensing,
				sourceTree: f.sourceRoot,
				artifactRoot: f.artifactRoot,
				outputs: ['app.min.js', 'NOTICE', 'SBOM.spdx.json'],
				operation: 'package'
			})
	};
}
it('selects fixed profile data and binds actual canonical notices/SBOM/provenance', () => {
	const f = fixture();
	expect(f.check().evidence.map((entry) => entry.requirement)).toEqual([
		'organization-policy',
		'distribution-notices',
		'distribution-provenance',
		'sbom'
	]);
	expect(() => assertReleaseLicensingUnchanged(f.patchesDir, 'package', f.licensing, f.policyDir)).not.toThrow();
	writeFileSync(join(f.artifactRoot, 'SBOM.spdx.json'), '{}\n');
	expect(f.check).toThrow(/stale or noncanonical/);
});
it('enforces source carriers only on actual delivered paths and refuses lost headers', () => {
	const f = fixture(true);
	writeFileSync(join(f.artifactRoot, 'unrelated.txt'), 'not a delivered artifact\n');
	expect(f.check().evidence.map((entry) => entry.requirement)).toContain('distribution-source-carriers');
	writeFileSync(join(f.artifactRoot, 'app.min.js'), '(()=>1)();');
	const proof = captureDistributionProvenance({
		sourceRoot: f.sourceRoot,
		artifactRoot: f.artifactRoot,
		outputs: ['app.min.js'],
		selected: f.licensing.selected,
		declaration: { ...f.declaration.package.declaration, metadata: [] },
		approvedMetadata: []
	});
	if (!proof.ok) throw new Error(proof.problems.join('; '));
	const docs = renderDistributionDocuments({ ...f, selected: f.licensing.selected, provenance: proof.value });
	if (!docs.ok || docs.value.sbom === null) throw new Error('fixture documents failed');
	writeFileSync(join(f.artifactRoot, 'NOTICE'), docs.value.notice);
	writeFileSync(join(f.artifactRoot, 'SBOM.spdx.json'), docs.value.sbom);
	expect(f.check).toThrow(/delivered source carriers are incomplete/);
});
it('refuses policy paths/allowlist widening, future declaration and declaration/store movement', () => {
	const f = fixture();
	// Version 2 is a known version since 2026-11-01 (##LICENSING-DECLARATION-V2); version 3 is the future.
	expect(readReleaseLicensing(f.patchesDir, 'package', f.policyDir)).not.toBeNull();
	writeFileSync(join(f.patchesDir, RELEASE_LICENSING_FILE), JSON.stringify({ ...f.declaration, codkitReleaseLicensing: 2 }));
	expect(readReleaseLicensing(f.patchesDir, 'package', f.policyDir)?.declaration.codkitReleaseLicensing).toBe(2);
	for (const extra of [{ policyDirectory: f.policyDir }, { allowedThirdParty: ['anything'] }, { codkitReleaseLicensing: 3 }]) {
		writeFileSync(join(f.patchesDir, RELEASE_LICENSING_FILE), JSON.stringify({ ...f.declaration, ...extra }));
		expect(() => readReleaseLicensing(f.patchesDir, 'package', f.policyDir)).toThrow();
	}
	writeFileSync(join(f.patchesDir, RELEASE_LICENSING_FILE), JSON.stringify({ ...f.declaration, created: '2026-10-03T00:00:01Z' }));
	expect(() => assertReleaseLicensingUnchanged(f.patchesDir, 'package', f.licensing, f.policyDir)).toThrow(/changed during/);
	writeFileSync(join(f.patchesDir, RELEASE_LICENSING_FILE), JSON.stringify(f.declaration));
	writeFileSync(
		join(f.policyDir, 'organization-policies.json'),
		readFileSync(join(f.policyDir, 'organization-policies.json'), 'utf8') + '\n'
	);
	expect(() => assertReleaseLicensingUnchanged(f.patchesDir, 'package', f.licensing, f.policyDir)).toThrow(/changed during/);
});
it('reads a declaration that leaves the operation unconfigured, and requires exact metadata roles instead of hiding payload', () => {
	const f = fixture();
	const packageDeclaration = f.licensing.declaration.package;
	if (packageDeclaration === undefined) throw new Error('fixture package absent');
	writeFileSync(join(f.patchesDir, RELEASE_LICENSING_FILE), JSON.stringify({ ...f.declaration, package: undefined }));
	// ##LICENSING-DECLARATION-V2: the operation is unconfigured, not refused; its caller records incomplete evidence.
	const unconfigured = readReleaseLicensing(f.patchesDir, 'package', f.policyDir);
	expect(unconfigured?.declaration.package).toBeUndefined();
	expect(unconfigured?.configured).toBe(false);
	expect(readReleaseLicensing(f.patchesDir, 'publish', f.policyDir)?.configured).toBe(f.declaration.publish !== undefined);
	expect(unconfigured?.selected.policy.id).toBe(f.licensing.selected.policy.id);
	expect(() =>
		checkReleaseLicensing({
			licensing: {
				...f.licensing,
				declaration: {
					...f.licensing.declaration,
					package: { ...packageDeclaration, declaration: { ...packageDeclaration.declaration, metadata: ['app.min.js'] } }
				}
			},
			sourceTree: f.sourceRoot,
			artifactRoot: f.artifactRoot,
			outputs: ['app.min.js', 'NOTICE', 'SBOM.spdx.json'],
			operation: 'package'
		})
	).toThrow(/metadata exclusions/);
});
it('reads publication from the selected Git commit and retains original patchset trust boundary', () => {
	const f = fixture();
	fixtureGit(f.patchesDir, ['init', '--quiet']);
	fixtureCommit(f.patchesDir, 'licensing fixture', '2026-10-03T00:00:00Z');
	const commit = fixtureGit(f.patchesDir, ['rev-parse', 'HEAD']).stdout.trim();
	const snapshot = makeTempRoot('licensing-snapshot');
	writeFileSync(join(snapshot, RELEASE_LICENSING_FILE), JSON.stringify(f.declaration));
	expect(readSnapshotReleaseLicensing(f.patchesDir, snapshot, commit, f.policyDir)?.sha256).toBe(f.licensing.sha256);
	writeFileSync(join(snapshot, RELEASE_LICENSING_FILE), JSON.stringify({ ...f.declaration, created: '2026-10-03T00:00:01Z' }));
	expect(() => readSnapshotReleaseLicensing(f.patchesDir, snapshot, commit, f.policyDir)).toThrow(/differs from selected/);
	writeFileSync(join(snapshot, RELEASE_LICENSING_FILE), JSON.stringify(f.declaration));
	mkdirSync(join(f.patchesDir, 'shadow'));
	writeFileSync(join(f.patchesDir, 'shadow/organization-policies.json'), readFileSync(join(f.policyDir, 'organization-policies.json')));
	expect(() => readSnapshotReleaseLicensing(f.patchesDir, snapshot, commit, join(f.patchesDir, 'shadow'))).toThrow(/must not be inside/);
});
