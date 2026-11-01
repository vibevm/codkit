// Mechanism fixture only; no external supplier or commercial legal approval.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { projectType as genericType } from '@codkit/type-generic';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runPublishReceipt } from '../../src/lib/publishReceipt.ts';
import { loadConfig, serializeBaseConfig } from '../../src/lib/configFile.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { projectType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { readOrganizationPolicy } from '../../src/lib/organizationPolicyStore.ts';
import { captureDistributionProvenance } from '../../src/lib/distributionProvenance.ts';
import { renderDistributionDocuments } from '../../src/lib/distributionDocuments.ts';
import { makeDistributionDocuments } from '../fixtures/makeDistributionDocuments.ts';
import { makeCliFixture, provideTreeDependencies } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
it('publishes a wholly synthetic private component with complete evidence through the configured generic type', async () => {
	const data = makeDistributionDocuments();
	const upstream = makeTempRoot('licensed-generic-upstream');
	const patches = makeTempRoot('licensed-generic-patchset');
	const authority = makeTempRoot('licensed-generic-authority');
	writeFileSync(
		join(authority, 'organization-policies.json'),
		JSON.stringify({ codkitOrganizationPolicyStore: 1, policies: [data.selected.policy] })
	);
	const selected = readOrganizationPolicy(authority, patches, { profile: 'fixture' });
	if (!selected.ok) throw new Error(selected.problems.join('; '));
	mkdirSync(join(upstream, 'src'));
	writeFileSync(join(upstream, 'src/main.ts'), readFileSync(join(data.sourceRoot, 'own.ts')));
	fixtureGit(upstream, ['init', '--quiet']);
	const anchor = fixtureCommit(upstream, 'synthetic private component source', '2026-10-03T00:00:00Z');
	const declaration = {
		codkitDistributionDeclaration: 1,
		files: [{ path: 'src/main.ts', sources: ['main.ts'], license: 'LicenseRef-FIXTURE-Private' }],
		metadata: []
	};
	const captured = captureDistributionProvenance({
		sourceRoot: join(upstream, 'src'),
		artifactRoot: upstream,
		outputs: ['src/main.ts'],
		selected: selected.value,
		declaration,
		approvedMetadata: []
	});
	if (!captured.ok) throw new Error(captured.problems.join('; '));
	const docs = renderDistributionDocuments({ ...data, selected: selected.value, provenance: captured.value });
	if (!docs.ok || docs.value.sbom === null) throw new Error('fixture render failed');
	writeFileSync(join(upstream, 'NOTICE'), docs.value.notice);
	writeFileSync(join(upstream, 'SBOM.spdx.json'), docs.value.sbom);
	const pin = fixtureCommit(upstream, 'synthetic distribution documents', '2026-10-03T00:01:00Z');
	fixtureGit(upstream, ['tag', 't1']);
	fixtureGit(patches, ['init', '--quiet']);
	writeFileSync(
		join(patches, 'codkit.json'),
		JSON.stringify({
			codkitConfig: 2,
			pin: { tag: 't1', sha: pin, date: '2026-10-03' },
			upstreamAnchorCommit: anchor,
			type: 'generic',
			typeConfig: { ownRoot: 'own' },
			generatedBranchPrefix: 'codkit/applied/',
			cycleBranchPrefix: 'codkit/cycle/',
			releaseRefPrefix: 'codkit/release/'
		})
	);
	writeFileSync(
		join(patches, 'codkit.licensing.json'),
		JSON.stringify({
			codkitReleaseLicensing: 1,
			profile: 'fixture',
			componentId: data.componentId,
			created: data.created,
			sourceDirectory: 'src',
			publish: { declaration: { ...declaration, metadata: ['NOTICE', 'SBOM.spdx.json'] }, sbomFile: 'SBOM.spdx.json' }
		})
	);
	const canonical = loadConfig(patches);
	if (canonical === null) throw new Error('fixture configuration absent');
	writeFileSync(join(patches, 'codkit.json'), serializeBaseConfig(canonical));
	mkdirSync(join(patches, 'delta'));
	writeFileSync(join(patches, 'delta/owners.json'), JSON.stringify({ codkitOwners: 1, owners: {} }));
	fixtureCommit(patches, 'synthetic publication declaration', '2026-10-03T00:02:00Z');
	const tree = join(makeTempRoot('licensed-generic-tree'), 'fork');
	expect(runGit({ cwd: upstream, args: ['clone', '--quiet', upstream, tree], netAllowed: true }).status).toBe(0);
	const config = loadConfig(patches);
	if (config === null || genericType.configure === undefined) throw new Error('fixture configuration absent');
	const destination = join(makeTempRoot('licensed-generic-export'), 'release');
	const out = new Output({ command: 'publish', version: 'fixture', jsonMode: true, streams: { writeOut: () => {}, writeErr: () => {} } });
	const result = await runPublishReceipt({
		patchesDir: patches,
		resolution: { path: tree, source: 'flag', exists: true, warning: null },
		config,
		type: genericType.configure(config.typeConfig),
		out,
		patchSetRef: 'HEAD',
		profile: 'verify',
		release: null,
		confirmed: true,
		ci: false,
		verbose: false,
		export: { kind: 'repository', path: destination },
		registration: readTypeManifest('generic', '@codkit/type-generic'),
		organizationPolicyDirectory: authority
	});
	expect(result.exitCode, JSON.stringify(out.buildEnvelope(result.exitCode).errors)).toBe(0);
	expect(result.release?.evidenceStatus).toBe('complete');
	expect(readFileSync(join(destination, 'NOTICE'), 'utf8')).toBe(docs.value.notice);
});
it('refuses incomplete shaped distribution before creating the actual export or a success receipt', async () => {
	const fixture = makeCliFixture('publish-licensing-missing-notice');
	provideTreeDependencies(fixture);
	const data = makeDistributionDocuments();
	// The trusted store lives where the machine keeps it, under a temporary home:
	// the CLI runs below read it there, the programmatic publish is handed the
	// directory (PROP-019 ##ORGANIZATION-POLICY-TRUST).
	const home = makeTempRoot('publish-licensing-home');
	const authority = join(home, '.codkit');
	mkdirSync(authority, { recursive: true });
	const env = { HOME: home, USERPROFILE: home };
	writeFileSync(
		join(authority, 'organization-policies.json'),
		JSON.stringify({ codkitOrganizationPolicyStore: 1, policies: [data.selected.policy] })
	);
	writeFileSync(
		fixture.patchesPath('codkit.licensing.json'),
		JSON.stringify({
			codkitReleaseLicensing: 1,
			profile: 'fixture',
			componentId: data.componentId,
			created: data.created,
			sourceDirectory: '.',
			publish: { declaration: { ...data.declaration, metadata: ['NOTICE', 'SBOM.spdx.json'] }, sbomFile: 'SBOM.spdx.json' }
		})
	);
	// A patch set that selects a profile answers for its licence surfaces and
	// carriers under verify (##VERIFY-LICENSING), which publish runs first: the
	// writer and the annotator give the fixture both, so that the refusal below is
	// the distribution's and not the surfaces'.
	expect(fixture.json(['gen', 'licensing', '--owner', 'product'], env).run.status).toBe(0);
	expect(fixture.json(['license', 'annotate', '--own'], env).run.status).toBe(0);
	fixtureCommit(fixture.patchesDir, 'fixture publication licensing declaration', '2026-10-03T00:00:00Z');
	const config = loadConfig(fixture.patchesDir);
	if (config === null) throw new Error('fixture config absent');
	const destination = join(makeTempRoot('publish-licensing-destination'), 'release');
	await expect(
		runPublishReceipt({
			patchesDir: fixture.patchesDir,
			resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null },
			config,
			type: projectType,
			out: new Output({ command: 'publish', version: 'fixture', jsonMode: true, streams: { writeOut: () => {}, writeErr: () => {} } }),
			patchSetRef: 'HEAD',
			profile: 'verify',
			release: null,
			confirmed: true,
			ci: false,
			verbose: false,
			export: { kind: 'bare', path: destination },
			registration: readTypeManifest('stub', STUB_TYPE_MODULE),
			organizationPolicyDirectory: authority
		})
	).rejects.toThrow(/required notice/);
	expect(existsSync(destination)).toBe(false);
	expect(existsSync(fixture.patchesPath('.codkit/releases'))).toBe(false);
});
