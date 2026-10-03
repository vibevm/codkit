import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runPackageRelease } from '../../src/lib/packageRelease.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { stubType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { makeDistributionDocuments } from '../fixtures/makeDistributionDocuments.ts';
import { readOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import { captureDistributionProvenance } from '../../src/lib/distributionProvenance.ts';
import { renderDistributionDocuments } from '../../src/lib/distributionDocuments.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';

afterAll(() => cleanupTempRoots());
it('records complete trusted distribution evidence and refuses a stale attached notice before recording another release', () => {
	const fixture = makeSyncFixture('package-release-licensed');
	for (const relative of ['hello.ts', 'test/fixture.test.ts']) {
		const file = join(fixture.patchesDir, 'delta/own', relative);
		writeFileSync(
			file,
			'// Copyright (c) 2026 Fixture Org\n// SPDX-License-Identifier: LicenseRef-FIXTURE-Private\n' + readFileSync(file, 'utf8')
		);
	}
	fixtureCommit(fixture.patchesDir, 'fixture licensed own sources', '2026-10-03T00:00:00Z');
	expect(fixture.sync().exitCode).toBe(0);
	const data = makeDistributionDocuments();
	const authority = makeTempRoot('package-license-authority');
	writeFileSync(
		join(authority, 'organization-policies.json'),
		JSON.stringify({ codkitOrganizationPolicyStore: 1, policies: [data.selected.policy] })
	);
	const selected = readOrganizationPolicy(authority, fixture.patchesDir, { profile: 'fixture' });
	if (!selected.ok) throw new Error(selected.problems.join('; '));
	mkdirSync(join(fixture.treeDir, 'out/licensing-artifacts'), { recursive: true });
	writeFileSync(join(fixture.treeDir, 'out/licensing-artifacts/app.min.js'), '(()=>1)();');
	const declaration = {
		codkitDistributionDeclaration: 1,
		files: [{ path: 'out/licensing-artifacts/app.min.js', sources: ['hello.ts'], license: 'LicenseRef-FIXTURE-Private' }],
		metadata: []
	};
	const proof = captureDistributionProvenance({
		sourceRoot: join(fixture.treeDir, fixture.config.typeConfig.ownRoot),
		artifactRoot: fixture.treeDir,
		outputs: ['out/licensing-artifacts/app.min.js'],
		selected: selected.value,
		declaration,
		approvedMetadata: []
	});
	if (!proof.ok) throw new Error(proof.problems.join('; '));
	const docs = renderDistributionDocuments({ ...data, selected: selected.value, provenance: proof.value });
	if (!docs.ok || docs.value.sbom === null) throw new Error('fixture render failed');
	writeFileSync(join(fixture.treeDir, 'out/licensing-artifacts/NOTICE'), docs.value.notice);
	writeFileSync(join(fixture.treeDir, 'out/licensing-artifacts/SBOM.spdx.json'), docs.value.sbom);
	writeFileSync(
		join(fixture.patchesDir, 'codkit.licensing.json'),
		JSON.stringify({
			codkitReleaseLicensing: 1,
			profile: 'fixture',
			componentId: data.componentId,
			created: data.created,
			sourceDirectory: fixture.config.typeConfig.ownRoot,
			package: {
				declaration: { ...declaration, metadata: ['out/licensing-artifacts/NOTICE', 'out/licensing-artifacts/SBOM.spdx.json'] },
				sbomFile: 'out/licensing-artifacts/SBOM.spdx.json'
			}
		})
	);
	fixtureCommit(fixture.patchesDir, 'fixture distribution declaration', '2026-10-03T00:00:00Z');
	const base = stubType({});
	const type = stubType({
		build: { ...base.build, packageBuild: [], packageDistributable: [], packageOutputs: ['out/licensing-artifacts'], packageScratch: [] }
	});
	const out = new Output({ command: 'package', version: 'fixture', jsonMode: false, streams: { writeOut: () => {}, writeErr: () => {} } });
	const options = {
		patchesDir: fixture.patchesDir,
		resolution: fixture.resolution,
		config: fixture.config,
		type,
		out,
		flags: { keepOverlay: false, skipTypeBuild: false },
		timeoutMs: null,
		registration: readTypeManifest('stub', STUB_TYPE_MODULE),
		organizationPolicyDirectory: authority
	};
	const result = runPackageRelease(options);
	expect(result.exitCode, JSON.stringify(result)).toBe(0);
	expect(result.release?.evidenceStatus).toBe('complete');
	if (result.release === null) throw new Error('fixture receipt absent');
	const receipt = JSON.parse(readFileSync(join(fixture.patchesDir, result.release.path), 'utf8'));
	expect(receipt.licensePolicies).toEqual(expect.arrayContaining([expect.objectContaining({ scope: 'organization', id: 'fixture' })]));
	writeFileSync(join(fixture.treeDir, 'out/licensing-artifacts/NOTICE'), 'stale fixture notice\n');
	expect(() => runPackageRelease(options)).toThrow(/stale or noncanonical/);
});
it('refuses a declared output whose materialized bytes were replaced by restoration, and preserves the dev state', () => {
	const fixture = makeSyncFixture('package-release-restored-output');
	expect(fixture.sync().exitCode).toBe(0);
	const original = readFileSync(join(fixture.treeDir, 'manifest.json'));
	const base = stubType({});
	const type = stubType({
		build: { ...base.build, packageBuild: [], packageDistributable: [], packageOutputs: ['manifest.json'], packageScratch: [] }
	});
	const out = new Output({ command: 'package', version: 'fixture', jsonMode: false, streams: { writeOut: () => {}, writeErr: () => {} } });
	expect(() =>
		runPackageRelease({
			patchesDir: fixture.patchesDir,
			resolution: fixture.resolution,
			config: fixture.config,
			type,
			out,
			flags: { keepOverlay: false, skipTypeBuild: false },
			timeoutMs: null,
			registration: readTypeManifest('stub', STUB_TYPE_MODULE)
		})
	).toThrow(/restoration changed/);
	expect(readFileSync(join(fixture.treeDir, 'manifest.json'))).toEqual(original);
	expect(existsSync(join(fixture.patchesDir, '.codkit/releases'))).toBe(false);
});
