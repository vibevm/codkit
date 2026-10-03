import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { captureComponentRelease } from '../../src/lib/releaseFacts.ts';
import { serializeBaseConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

let fixture: SyncFixture;
beforeAll(() => {
	fixture = makeSyncFixture('release-facts');
}, 30_000);
afterAll(() => cleanupTempRoots());
function options() {
	return {
		patchesDir: fixture.patchesDir,
		forkDir: fixture.treeDir,
		config: fixture.config,
		registration: readTypeManifest('stub', STUB_TYPE_MODULE),
		operation: 'package' as const,
		tip: fixture.upstream.t1.sha,
		outputs: ['.build/release.bin'],
		recipe: { argv: ['node', 'build.mjs'], network: 'offline' }
	};
}
it('binds actual Git, config, manifest and artifact bytes while leaving unverified obligations missing', () => {
	mkdirSync(join(fixture.treeDir, '.build'), { recursive: true });
	writeFileSync(join(fixture.treeDir, '.build/release.bin'), 'actual bytes');
	const input = options();
	const result = captureComponentRelease(input);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.problem.message);
	expect(result.value.generated.tree).toBe(runGit({ cwd: fixture.treeDir, args: ['rev-parse', 'HEAD^{tree}'] }).stdout.trim());
	expect(result.value.patchset.configSha256).toBe(createHash('sha256').update(serializeBaseConfig(fixture.config)).digest('hex'));
	expect(result.value.type.manifestSha256).toBe(input.registration.sha256);
	expect(result.value.artifacts).toContainEqual({
		kind: 'file',
		path: '.build/release.bin',
		sha256: createHash('sha256').update('actual bytes').digest('hex'),
		bytes: 12
	});
	expect(result.value.distribution.status).toBe('incomplete');
	expect(result.value.distribution.missing).toEqual(expect.arrayContaining(['organization-policy', 'distribution-notices', 'sbom']));
	expect(captureComponentRelease(input)).toEqual(result);
});
it('refuses changed commit expectations, moving refs and non-data recipes', () => {
	const input = options();
	for (const change of [
		{ expectedPatchsetCommit: 'a'.repeat(40) },
		{ tip: 'HEAD' },
		{ config: { ...input.config, pin: { ...input.config.pin, date: '1999-01-01' } } },
		{
			recipe: {
				execute: () => {
					throw new Error('must not execute');
				}
			}
		}
	])
		expect(captureComponentRelease({ ...input, ...change }).ok).toBe(false);
});
it('reports dirty tracked patchset inputs rather than attributing them wholly to HEAD', () => {
	const path = join(fixture.patchesDir, 'codkit.json');
	const original = readFileSync(path);
	try {
		writeFileSync(path, `${original.toString('utf8')} `);
		const result = captureComponentRelease(options());
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.problem.message);
		expect(result.value.distribution.missing).toContain('patchset-clean');
	} finally {
		writeFileSync(path, original);
	}
});
