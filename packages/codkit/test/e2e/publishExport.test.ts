// `publish --export-bare <dir>` and `--export-repo <dir>` (PROP-007
// ##PUBLISH-EXPORT): the release written into a new local repository the
// command creates, with no remote configured at all.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGitBytes } from '../../src/lib/gitx.ts';
import { ckError } from '../../src/lib/messages.ts';
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
	messageFile,
	objectData,
	ownPatchSetCommit,
	plainGit,
	reachableObjects,
	refSha,
	releaseTag,
	storedObjects,
	treeFiles
} from '../support/publishFixture.ts';
import type { PublishFlags } from '../support/publishFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const BRANCH = 'release/1.0.0';
const BRANCH_REF = `refs/heads/${BRANCH}`;

let shared: CliFixture | null = null;
function plainFixture(): CliFixture {
	if (shared === null) {
		shared = makeCliFixture('export');
		excludeRuntime(shared);
		ownPatchSetCommit(shared, 'export');
		// No publishRemoteUrl anywhere: an export neither needs nor reads it.
		configureRemote(shared, null);
	}
	return shared;
}

describe('publish export refusals', () => {
	it('refuses both flags before any gate, and a directory it may not use before any work', async () => {
		const fixture = plainFixture();
		const free = join(makeTempRoot('export-refusals'), 'release');
		const both = await invokePublish(fixture, { exportBare: free, exportRepo: free, ci: true });
		expect(both.exitCode).toBe(2);
		expect(both.envelope.errors).toEqual([
			expect.objectContaining({ code: 'CK-E-CONFIG', message: '--export-bare and --export-repo exclude each other' })
		]);

		// The two gates of the release bot stay, and their words name the export.
		const ci = await invokePublish(fixture, { exportRepo: free, bot: true, ci: true });
		expect(ci.envelope.errors[0]).toMatchObject({ code: 'CK-E-NET-FORBIDDEN' });
		expect(ci.envelope.errors[0]?.message).toContain('an export into a local repository included');
		const bot = await invokePublish(fixture, { exportRepo: free });
		expect(bot.envelope.errors[0]).toMatchObject({ code: 'CK-E-CONFIG', message: 'publish requires --yes-i-am-publish-bot' });
		expect(bot.envelope.errors[0]?.hint).toContain('into a new local repository');

		const occupied = makeTempRoot('export-occupied');
		writeFileSync(join(occupied, 'keep.txt'), 'someone else\n', 'utf8');
		const file = join(makeTempRoot('export-file'), 'release.txt');
		writeFileSync(file, 'a file\n', 'utf8');
		const cases: readonly (readonly [PublishFlags, string])[] = [
			[{ exportBare: occupied }, `the export directory is not empty: ${occupied}`],
			[{ exportRepo: file }, `the export path is not a directory: ${file}`],
			[{ exportRepo: join(makeTempRoot('export-parent'), 'absent', 'release') }, 'the parent of the export directory does not exist'],
			[{ exportRepo: fixture.patchesPath('release') }, 'is inside the patch-set directory'],
			[{ exportBare: fixture.treePath('release') }, 'is inside the fork tree'],
			[{ exportBare: fixture.treePath('source') }, 'is not empty'],
			[{ exportRepo: free, orphan: true }, '--orphan needs --squash']
		];
		for (const [flags, text] of cases) {
			const refused = await invokePublish(fixture, { bot: true, ...flags });
			expect(refused.exitCode, text).toBe(2);
			expect(refused.envelope.errors[0]?.code, text).toBe('CK-E-CONFIG');
			expect(refused.envelope.errors[0]?.message, text).toContain(text);
		}
		expect(readdirSync(occupied)).toEqual(['keep.txt']);
		expect(existsSync(free)).toBe(false);
		expect(existsSync(fixture.patchesPath('release'))).toBe(false);
		expect(existsSync(fixture.treePath('release'))).toBe(false);
	}, 300_000);
});

describe('publish --export-bare and --export-repo', () => {
	it('exports a bare repository that holds the release branch, the tag and nothing else, and refuses a second run', async () => {
		const fixture = plainFixture();
		const path = join(makeTempRoot('export-bare'), 'release.git');
		const flags: PublishFlags = { ...squashFlags('export-bare'), exportBare: path, release: '1.0.0' };

		const result = await invokePublish(fixture, flags);
		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		const data = objectData(result.envelope);
		expect(data).toMatchObject({
			status: 'published',
			branch: BRANCH,
			pushedBranch: false,
			pushedTag: false,
			observedBranch: null,
			observedTag: null,
			export: { kind: 'bare', path, lfsObjects: 0 }
		});
		const tip = String(data['tip']);
		expect(infoLines(result.envelope)).toContain(
			`published: ${BRANCH_REF} -> ${tip}; ${releaseTag(fixture, '1.0.0')}; into the new bare repository ${path}`
		);
		expect(gitOut(path, ['rev-parse', '--is-bare-repository'])).toBe('true');
		expect(gitOut(path, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(
			`${BRANCH_REF} ${tip}\n${releaseTag(fixture, '1.0.0')} ${tip}`
		);
		expect(gitOut(path, ['symbolic-ref', 'HEAD'])).toBe(BRANCH_REF);
		expect(gitOut(path, ['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${fixture.upstream.t1.sha}`);
		assertStandalone(fixture, path, path);
		expect(gitOut(path, ['config', '--local', '--get', 'core.longpaths'])).toBe('true');

		const again = await invokePublish(fixture, flags);
		expect(again.exitCode).toBe(2);
		expect(again.envelope.errors[0]?.message).toBe(`the export directory is not empty: ${path}`);
		expect(refSha(path, BRANCH_REF)).toBe(tip);
	}, 300_000);

	it('exports a repository with its working tree checked out, which plain git sees clean', async () => {
		const fixture = plainFixture();
		const path = join(makeTempRoot('export-repo'), 'release');
		mkdirSync(path);
		const result = await invokePublish(fixture, { bot: true, branch: BRANCH, exportRepo: path });
		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		const tip = String(objectData(result.envelope)['tip']);
		expect(objectData(result.envelope)['export']).toEqual({ kind: 'repository', path, lfsObjects: 0 });
		expect(gitOut(path, ['symbolic-ref', 'HEAD'])).toBe(BRANCH_REF);
		expect(gitOut(path, ['rev-parse', 'HEAD'])).toBe(tip);
		expect(gitOut(path, ['for-each-ref', '--format=%(refname)'])).toBe(BRANCH_REF);
		// The history of upstream, then the generated commits.
		expect(gitOut(path, ['rev-list', '--count', tip])).toBe(
			String(Number(gitOut(path, ['rev-list', '--count', fixture.upstream.t1.sha])) + 4)
		);
		assertStandalone(fixture, path, join(path, '.git'));
		for (const [key, value] of [
			['core.longpaths', 'true'],
			['core.autocrlf', 'false'],
			['core.eol', 'lf']
		] as const) {
			expect(gitOut(path, ['config', '--local', '--get', key]), key).toBe(value);
		}
		assertCheckedOut(path, tip);
	}, 300_000);

	it('exports one commit without a parent, whose repository does not hold the pin', async () => {
		const fixture = plainFixture();
		const path = join(makeTempRoot('export-orphan'), 'release');
		const result = await invokePublish(fixture, { ...squashFlags('export-orphan'), orphan: true, exportRepo: path });
		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		const tip = String(objectData(result.envelope)['tip']);
		expect(gitOut(path, ['rev-list', '--parents', '--all'])).toBe(tip);
		expect(refSha(path, `${fixture.upstream.t1.sha}^{commit}`)).toBeNull();
		assertStandalone(fixture, path, join(path, '.git'));
		assertCheckedOut(path, tip);
	}, 300_000);

	it('leaves no directory behind when a run fails after the repository was created', async () => {
		const fixture = plainFixture();
		const interrupt = {
			checkpoint(checkpoint: string): void {
				if (checkpoint === 'export-created') throw ckError('INTERNAL', 'the test stops the run once the repository exists');
			}
		};
		const created = join(makeTempRoot('export-failed-new'), 'release');
		let seen = false;
		const fresh = await invokePublishLibrary(fixture, {
			export: { kind: 'repository', path: created },
			checkpoint(checkpoint) {
				if (checkpoint === 'export-created') seen = existsSync(join(created, '.git'));
				interrupt.checkpoint(checkpoint);
			}
		});
		expect(fresh.exitCode).toBe(2);
		expect(fresh.envelope.errors[0]?.message).toBe('the test stops the run once the repository exists');
		expect(seen, 'the repository existed when the run stopped').toBe(true);
		expect(existsSync(created)).toBe(false);

		const empty = makeTempRoot('export-failed-empty');
		const kept = await invokePublishLibrary(fixture, { export: { kind: 'bare', path: empty }, checkpoint: interrupt.checkpoint });
		expect(kept.exitCode).toBe(2);
		expect(existsSync(empty)).toBe(true);
		expect(readdirSync(empty)).toEqual([]);
	}, 300_000);
});

function squashFlags(label: string): PublishFlags {
	return { bot: true, branch: BRANCH, squash: true, author: RELEASE_AUTHOR, messageFile: messageFile(label), scrub: true };
}

/**
 * The repository stands alone: only the objects its refs reach, stored in it;
 * no alternates, no remote, no path of the patch set or the fork tree in its
 * configuration, no hook and no reflog.
 */
function assertStandalone(fixture: CliFixture, path: string, gitDir: string): void {
	const tips = gitOut(path, ['for-each-ref', '--format=%(objectname)']).split('\n');
	const reachable = [...new Set(tips.flatMap((tip) => reachableObjects(path, tip)))].sort();
	expect(storedObjects(path)).toEqual(reachable);
	expect(existsSync(join(gitDir, 'objects', 'info', 'alternates'))).toBe(false);
	expect(gitOut(path, ['remote'])).toBe('');
	const config = readFileSync(join(gitDir, 'config'), 'utf8');
	for (const foreign of [fixture.treeDir, fixture.patchesDir, 'remote', 'alternate']) expect(config).not.toContain(foreign);
	expect(existsSync(join(gitDir, 'hooks')) ? readdirSync(join(gitDir, 'hooks')) : []).toEqual([]);
	expect(existsSync(join(gitDir, 'logs'))).toBe(false);
	expect(plainGit(path, ['fsck', '--full', '--no-dangling']).status).toBe(0);
}

/**
 * The working tree is the release tree byte for byte, and plain git sees it
 * clean - with the configuration of this machine, and with a global one that
 * turns every text file to CRLF, as the owner's workstation has.
 */
function assertCheckedOut(path: string, tip: string): void {
	const files = treeFiles(path, tip);
	expect(gitOut(path, ['ls-files']).split('\n')).toEqual(files);
	for (const file of files) {
		const blob = runGitBytes({ args: ['cat-file', 'blob', `${tip}:${file}`], cwd: path });
		expect(Buffer.from(readFileSync(join(path, ...file.split('/')))).equals(Buffer.from(blob.stdout)), file).toBe(true);
	}
	expect(plainGit(path, ['status', '--porcelain'])).toMatchObject({ status: 0, stdout: '' });
	const crlf = join(makeTempRoot('export-crlf-config'), 'gitconfig');
	writeFileSync(crlf, '[core]\n\tautocrlf = true\n', 'utf8');
	expect(plainGit(path, ['status', '--porcelain'], { GIT_CONFIG_GLOBAL: crlf })).toMatchObject({ status: 0, stdout: '' });
}
