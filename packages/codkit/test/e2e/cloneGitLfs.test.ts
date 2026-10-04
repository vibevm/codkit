import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { LFS_SAMPLE, LFS_SAMPLE_PATH, provideLfsContent } from '../fixtures/lfsUpstream.ts';
import { runCli, withStubType } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
const available = runGit({ cwd: process.cwd(), args: ['lfs', 'version'] }).status === 0;
it.runIf(available)('clones actual LFS content at the pin without installing hooks into the working tree', () => {
	const upstream = makeUpstream(makeTempRoot('clone-lfs-upstream'), { lfs: 'rule' });
	provideLfsContent(upstream.dir, upstream.lfsObjects ?? []);
	const patches = makeTempRoot('clone-lfs-patchset');
	makePatchSet(patches, upstream);
	const target = join(makeTempRoot('clone-lfs-target'), 'fork');
	const result = runCli(
		patches,
		['--patches-dir', patches, '--json', 'clone', '--from', upstream.dir, '--fork-dir', target],
		withStubType()
	);
	expect(result.status, result.stderr + result.stdout).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { outcome: 'cloned' } });
	expect(runGit({ cwd: target, args: ['rev-parse', 'HEAD'] }).stdout.trim()).toBe(upstream.t1.sha);
	expect(readFileSync(join(target, LFS_SAMPLE_PATH))).toEqual(Buffer.from(LFS_SAMPLE.content));
	expect(runGit({ cwd: target, args: ['status', '--porcelain=v1'] }).stdout).toBe('');
	expect(existsSync(join(target, 'dev'))).toBe(false);
});
