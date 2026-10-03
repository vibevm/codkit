import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runPackageRelease } from '../../src/lib/packageRelease.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { stubType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(() => cleanupTempRoots());
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
