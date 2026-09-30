// git-lfs in an export (PROP-007 ##PUBLISH-EXPORT-LFS): an export that keeps
// the git-lfs content carries the objects of the tip - not of the history -
// checked against their pointers; an export under --no-lfs carries nothing of
// git-lfs. The fixture's history names three objects, and its tip two.

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { LFS_ATTRIBUTES_PATH, LFS_EXTRA, LFS_EXTRA_PATH, LFS_SAMPLE, LFS_SAMPLE_PATH, lfsObjectPath } from '../fixtures/lfsUpstream.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import {
	RELEASE_AUTHOR,
	configureRemote,
	excludeRuntime,
	gitOut,
	infoLines,
	invokePublish,
	invokePublishLibrary,
	lfsNeeds,
	messageFile,
	objectData,
	plainGit
} from '../support/publishFixture.ts';
import type { PublishFlags } from '../support/publishFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const LFS_INSTALLED = runGit({ args: ['lfs', 'version'], cwd: process.cwd() }).status === 0;
const TIP_OBJECTS = [LFS_EXTRA.oid, LFS_SAMPLE.oid].sort();

let shared: CliFixture | null = null;
function lfsFixture(): CliFixture {
	if (shared === null) {
		shared = makeCliFixture('export-lfs', { upstream: { lfs: 'rule' } });
		excludeRuntime(shared);
		configureRemote(shared, null);
	}
	return shared;
}

describe('git-lfs in an export', () => {
	it('carries the objects of the tip into a repository with a working tree, and checks the files out', async () => {
		const fixture = lfsFixture();
		const path = join(makeTempRoot('export-lfs-repo'), 'release');
		const result = await invokePublish(fixture, { bot: true, branch: 'release/1.0.0', exportRepo: path });
		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		expect(objectData(result.envelope)['export']).toEqual({ kind: 'repository', path, lfsObjects: 2 });
		const storage = join(path, '.git', 'lfs');
		expect(storedLfsObjects(storage)).toEqual(TIP_OBJECTS);
		for (const object of [LFS_SAMPLE, LFS_EXTRA])
			expect(readFileSync(lfsObjectPath(storage, object.oid))).toEqual(Buffer.from(object.content));
		expect(infoLines(result.envelope)).toContain(
			`export: 2 git-lfs object(s) of the tip copied into ${join(storage, 'objects')} and checked`
		);
		expect(lfsNeeds(path, 'HEAD').pointers).toEqual([LFS_EXTRA_PATH, LFS_SAMPLE_PATH]);

		const file = (relative: string): Buffer => readFileSync(join(path, ...relative.split('/')));
		if (!LFS_INSTALLED) {
			// Without git-lfs the objects are carried all the same, and the working tree keeps the pointers.
			expect(file(LFS_SAMPLE_PATH).toString('utf8')).toBe(LFS_SAMPLE.pointer);
			expect(result.envelope.messages.map((message) => message.text)).toContainEqual(expect.stringContaining('git-lfs is not installed'));
			return;
		}
		expect(file(LFS_SAMPLE_PATH)).toEqual(Buffer.from(LFS_SAMPLE.content));
		expect(file(LFS_EXTRA_PATH)).toEqual(Buffer.from(LFS_EXTRA.content));
		expect(gitOut(path, ['config', '--local', '--get', 'filter.lfs.process'])).toBe('git-lfs filter-process');
		expect(plainGit(path, ['status', '--porcelain'])).toMatchObject({ status: 0, stdout: '' });
		const crlf = join(makeTempRoot('export-lfs-crlf'), 'gitconfig');
		writeFileSync(crlf, '[core]\n\tautocrlf = true\n', 'utf8');
		expect(plainGit(path, ['status', '--porcelain'], { GIT_CONFIG_GLOBAL: crlf })).toMatchObject({ status: 0, stdout: '' });
		const listed = plainGit(path, ['lfs', 'ls-files', '--name-only']);
		expect(listed.status, listed.stderr).toBe(0);
		expect(listed.stdout.trim().split('\n').sort()).toEqual([LFS_EXTRA_PATH, LFS_SAMPLE_PATH]);
	}, 300_000);

	it('carries them into a bare repository, from which plain git clones the files', async () => {
		const fixture = lfsFixture();
		const path = join(makeTempRoot('export-lfs-bare'), 'release.git');
		const result = await invokePublish(fixture, { ...squashFlags('export-lfs-bare'), orphan: true, exportBare: path });
		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		expect(objectData(result.envelope)['export']).toEqual({ kind: 'bare', path, lfsObjects: 2 });
		expect(storedLfsObjects(join(path, 'lfs'))).toEqual(TIP_OBJECTS);
		if (!LFS_INSTALLED) return;
		const clone = join(makeTempRoot('export-lfs-clone'), 'clone');
		const cloned = plainGit(join(clone, '..'), ['clone', '--quiet', path, clone]);
		expect(cloned.status, cloned.stderr).toBe(0);
		expect(readFileSync(join(clone, ...LFS_SAMPLE_PATH.split('/')))).toEqual(Buffer.from(LFS_SAMPLE.content));
		expect(readFileSync(join(clone, ...LFS_EXTRA_PATH.split('/')))).toEqual(Buffer.from(LFS_EXTRA.content));
		expect(plainGit(clone, ['status', '--porcelain'])).toMatchObject({ status: 0, stdout: '' });
	}, 300_000);

	it('refuses an export whose tip needs an object the fork tree lacks or holds damaged, before the repository exists', async () => {
		const fixture = lfsFixture();
		const common = gitOut(fixture.treeDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
		const object = lfsObjectPath(join(common, 'lfs'), LFS_EXTRA.oid);
		const aside = `${object}.aside`;
		const path = join(makeTempRoot('export-lfs-missing'), 'release');
		// The checkout of the pin in the disposable fork needs the object; it is
		// taken away once the checks have passed, before the export.
		const hide = (checkpoint: string): void => {
			if (checkpoint === 'checks-passed') renameSync(object, aside);
		};
		try {
			const missing = await invokePublishLibrary(fixture, { export: { kind: 'bare', path }, checkpoint: hide });
			expect(missing.exitCode).toBe(2);
			expect(missing.envelope.errors[0]?.code).toBe('CK-E-LFS');
			expect(missing.envelope.errors[0]?.message).toContain(
				`${LFS_EXTRA_PATH}: sha256 ${LFS_EXTRA.oid} is not in the git-lfs storage of the fork tree`
			);
			expect(missing.envelope.errors[0]?.hint).toContain(`git -C ${fixture.treeDir} lfs fetch origin ${fixture.upstream.t1.sha}`);
			expect(existsSync(path)).toBe(false);
		} finally {
			if (existsSync(aside)) renameSync(aside, object);
		}
		const damage = (checkpoint: string): void => {
			if (checkpoint !== 'checks-passed') return;
			copyFileSync(object, aside);
			writeFileSync(object, Buffer.alloc(LFS_EXTRA.size, 0x41));
		};
		try {
			const damaged = await invokePublishLibrary(fixture, { export: { kind: 'repository', path }, checkpoint: damage });
			expect(damaged.exitCode).toBe(2);
			expect(damaged.envelope.errors[0]?.code).toBe('CK-E-LFS');
			expect(damaged.envelope.errors[0]?.message).toContain(
				`sha256 ${LFS_EXTRA.oid} in the git-lfs storage of the fork tree does not match its pointer`
			);
			expect(existsSync(path)).toBe(false);
		} finally {
			if (existsSync(aside)) {
				copyFileSync(aside, object);
				rmSync(aside);
			}
		}
		expect(statSync(object).size).toBe(LFS_EXTRA.size);
	}, 300_000);

	it('carries nothing of git-lfs under --no-lfs', async () => {
		const fixture = lfsFixture();
		const path = join(makeTempRoot('export-lfs-none'), 'release');
		const result = await invokePublish(fixture, { ...squashFlags('export-lfs-none'), noLfs: true, exportRepo: path });
		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		expect(objectData(result.envelope)).toMatchObject({
			export: { kind: 'repository', path, lfsObjects: 0 },
			lfs: { dropped: [LFS_EXTRA_PATH, LFS_SAMPLE_PATH], attributes: [LFS_ATTRIBUTES_PATH] }
		});
		expect(existsSync(join(path, '.git', 'lfs'))).toBe(false);
		const config = readFileSync(join(path, '.git', 'config'), 'utf8');
		expect(config).not.toMatch(/\[lfs\]|\[filter "lfs"\]/);
		expect(existsSync(join(path, '.git', 'hooks'))).toBe(false);
		expect(lfsNeeds(path, 'HEAD')).toEqual({ filtered: [], pointers: [], rules: [] });
		expect(plainGit(path, ['status', '--porcelain'])).toMatchObject({ status: 0, stdout: '' });
		if (!LFS_INSTALLED) return;
		expect(plainGit(path, ['lfs', 'ls-files'])).toMatchObject({ status: 0, stdout: '' });
	}, 300_000);

	it('leaves no export behind when --no-lfs fails closed', async (context) => {
		if (!LFS_INSTALLED) context.skip('git-lfs is not installed: check-tree refuses a tree whose top-level .gitattributes names filter=lfs');
		const fixture = makeCliFixture('export-lfs-macro', { upstream: { lfs: 'macro' } });
		excludeRuntime(fixture);
		configureRemote(fixture, null);
		const path = join(makeTempRoot('export-lfs-macro'), 'release');
		const refused = await invokePublish(fixture, { bot: true, branch: 'release/1.0.0', noLfs: true, exportRepo: path });
		expect(refused.exitCode).toBe(1);
		expect(refused.envelope.data).toMatchObject({ status: 'lfs-failed', export: null });
		expect(existsSync(path)).toBe(false);
	}, 300_000);
});

function squashFlags(label: string): PublishFlags {
	return { bot: true, branch: 'release/1.0.0', squash: true, author: RELEASE_AUTHOR, messageFile: messageFile(label), scrub: true };
}

/** The object ids an lfs storage holds, sorted. */
function storedLfsObjects(storage: string): readonly string[] {
	const objects = join(storage, 'objects');
	if (!existsSync(objects)) return [];
	return readdirSync(objects, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
}
