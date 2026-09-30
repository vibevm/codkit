// The three forms of a release, each with and without the content git-lfs
// tracks (PROP-007 ##PUBLISH-FORMS, ##PUBLISH-NO-LFS, ##PUBLISH-NO-LFS-REWRITE,
// ##PUBLISH-NO-LFS-FAIL-CLOSED), published into local bare remotes from a
// fixture whose upstream carries git-lfs content the way VS Code does.
//
// The cases share one fixture and run in order: the case of the one commit
// compares its trees with the ones the case of the squashed commit on the pin
// recorded, because a commit without a parent differs from it by the parent
// alone.

import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import {
	LFS_ATTRIBUTES,
	LFS_ATTRIBUTES_PATH,
	LFS_ATTRIBUTES_WITHOUT_RULE,
	LFS_EXTRA_PATH,
	LFS_MACRO_PATH,
	LFS_SAMPLE,
	LFS_SAMPLE_PATH
} from '../fixtures/lfsUpstream.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import {
	RELEASE_AUTHOR,
	configureRemote,
	emptyRemote,
	excludeRuntime,
	gitOut,
	infoLines,
	invokePublish,
	lfsNeeds,
	messageFile,
	objectData,
	ownPatchSetCommit,
	reachableObjects,
	refSha,
	storedObjects,
	upstreamRemote
} from '../support/publishFixture.ts';
import type { PublishFlags } from '../support/publishFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const DROPPED = [LFS_EXTRA_PATH, LFS_SAMPLE_PATH];
const LFS_REPORT = { dropped: DROPPED, attributes: [LFS_ATTRIBUTES_PATH] };
const REWRITE_DIFF = `M\t${LFS_ATTRIBUTES_PATH}\nD\t${LFS_EXTRA_PATH}\nD\t${LFS_SAMPLE_PATH}`;
const LFS_INSTALLED = runGit({ args: ['lfs', 'version'], cwd: process.cwd() }).status === 0;

type Squash = { readonly parent: string | null; readonly tree: string; readonly unsquashedTip: string; readonly author: string };

let shared: CliFixture | null = null;
/** The trees the case of the squashed commit on the pin published, for the case of the one commit. */
const squashedTrees = new Map<'keep' | 'no-lfs', { readonly tree: string; readonly unsquashedTip: string }>();

function lfsFixture(): CliFixture {
	if (shared === null) {
		shared = makeCliFixture('no-lfs', { upstream: { lfs: 'rule' } });
		excludeRuntime(shared);
	}
	return shared;
}

describe('publish --no-lfs in each form', () => {
	it('upstream history + generated history: one generated commit leaves the git-lfs content out', async () => {
		const fixture = lfsFixture();
		const remote = upstreamRemote(fixture, 'no-lfs-generated');
		configureRemote(fixture, remote);
		const sha = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		const pin = fixture.upstream.t1.sha;

		const keep = await publishTwice(fixture, { bot: true, branch: 'release/keep' });
		const keepTip = tipOf(remote, 'release/keep', keep);
		expect(objectData(keep)).toMatchObject({ squash: null, lfs: null });
		const generated = gitOut(remote, ['log', '--reverse', '--format=%s', `${pin}..${keepTip}`]).split('\n');
		expect(generated).toHaveLength(4);
		expect(generated).not.toContain('codkit: leave out git-lfs content');
		expect(gitOut(remote, ['show', `${keepTip}:${LFS_SAMPLE_PATH}`])).toBe(LFS_SAMPLE.pointer.trimEnd());
		expect(gitOut(remote, ['show', `${keepTip}:${LFS_ATTRIBUTES_PATH}`])).toBe(LFS_ATTRIBUTES.trimEnd());

		const dropped = await publishTwice(fixture, { bot: true, branch: 'release/no-lfs', noLfs: true });
		const tip = tipOf(remote, 'release/no-lfs', dropped);
		// The pin, the same generated commits, then the one commit of --no-lfs.
		expect(gitOut(remote, ['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${keepTip}`);
		expect(gitOut(remote, ['rev-list', '--count', `${pin}..${tip}`])).toBe('5');
		expect(gitOut(remote, ['log', '-1', '--format=%B', tip])).toBe(
			`codkit: leave out git-lfs content\n\nCodkit-Patchset-Commit: ${sha}\nCodkit-Upstream-Pin: t1@${pin}`
		);
		expect(gitOut(remote, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%aI|%cI', tip])).toBe(
			`codkit <codkit@patchset.invalid>|codkit <codkit@patchset.invalid>|${gitOut(remote, ['log', '-1', '--format=%cI', pin])}|${gitOut(remote, ['log', '-1', '--format=%cI', pin])}`
		);
		expect(gitOut(remote, ['diff-tree', '-r', '--name-status', keepTip, tip])).toBe(REWRITE_DIFF);
		expect(gitOut(remote, ['show', `${tip}:${LFS_ATTRIBUTES_PATH}`])).toBe(LFS_ATTRIBUTES_WITHOUT_RULE.trimEnd());
		expect(lfsNeeds(remote, tip)).toEqual({ filtered: [], pointers: [], rules: [] });
		expect(objectData(dropped)).toMatchObject({ squash: null, lfs: LFS_REPORT });
		expect(infoLines(dropped)).toEqual(
			expect.arrayContaining([
				`no-lfs: ${LFS_ATTRIBUTES_PATH}: 1 rule(s) removed`,
				'no-lfs: 2 git-lfs path(s) left out, 1 attribute file(s) changed',
				`no-lfs: ${keepTip.slice(0, 12)} -> ${tip.slice(0, 12)} (tree ${gitOut(remote, ['rev-parse', `${tip}^{tree}`]).slice(0, 12)})`
			])
		);
	}, 300_000);

	it('upstream history + one commit: the squashed tree is left without the git-lfs content', async () => {
		const fixture = lfsFixture();
		const remote = upstreamRemote(fixture, 'no-lfs-squash');
		configureRemote(fixture, remote);
		const squash = squashFlags('no-lfs-squash');

		const keep = await publishTwice(fixture, { ...squash, branch: 'release/keep' });
		const keepTip = tipOf(remote, 'release/keep', keep);
		const keepSquash = objectData(keep)['squash'] as Squash;
		expect(keepSquash).toMatchObject({ parent: fixture.upstream.t1.sha, author: RELEASE_AUTHOR });
		expect(objectData(keep)['lfs']).toBeNull();
		expect(gitOut(remote, ['rev-list', '--parents', '-n', '1', keepTip])).toBe(`${keepTip} ${fixture.upstream.t1.sha}`);
		expect(lfsNeeds(remote, keepTip)).toEqual({ filtered: DROPPED, pointers: DROPPED, rules: [LFS_ATTRIBUTES_PATH] });

		const dropped = await publishTwice(fixture, { ...squash, branch: 'release/no-lfs', noLfs: true });
		const tip = tipOf(remote, 'release/no-lfs', dropped);
		const droppedSquash = objectData(dropped)['squash'] as Squash;
		expect(droppedSquash).toMatchObject({
			parent: fixture.upstream.t1.sha,
			unsquashedTip: keepSquash.unsquashedTip,
			author: RELEASE_AUTHOR
		});
		expect(gitOut(remote, ['rev-parse', `${tip}^{tree}`])).toBe(droppedSquash.tree);
		expect(gitOut(remote, ['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${fixture.upstream.t1.sha}`);
		expect(gitOut(remote, ['diff-tree', '-r', '--name-status', keepTip, tip])).toBe(REWRITE_DIFF);
		expect(lfsNeeds(remote, tip)).toEqual({ filtered: [], pointers: [], rules: [] });
		expect(objectData(dropped)['lfs']).toEqual(LFS_REPORT);
		squashedTrees.set('keep', { tree: keepSquash.tree, unsquashedTip: keepSquash.unsquashedTip });
		squashedTrees.set('no-lfs', { tree: droppedSquash.tree, unsquashedTip: droppedSquash.unsquashedTip });
	}, 300_000);

	it('one commit: the same trees as on the pin, without a parent and without upstream history', async () => {
		const fixture = lfsFixture();
		const remote = emptyRemote('no-lfs-orphan');
		configureRemote(fixture, remote);
		const orphan = { ...squashFlags('no-lfs-orphan'), orphan: true };

		const keep = await publishTwice(fixture, { ...orphan, branch: 'release/keep' });
		const keepTip = tipOf(remote, 'release/keep', keep);
		expect(gitOut(remote, ['rev-list', '--parents', '-n', '1', keepTip])).toBe(keepTip);
		// Only what the commit reaches came in: its tree, with the pointers - no history.
		expect(storedObjects(remote)).toEqual(reachableObjects(remote, keepTip));
		expect(lfsNeeds(remote, keepTip).pointers).toEqual(DROPPED);
		const keepSquash = objectData(keep)['squash'] as Squash;
		expect(keepSquash.parent).toBeNull();
		expect(squashedTrees.get('keep'), 'the case of the squashed commit on the pin runs first').toEqual({
			tree: keepSquash.tree,
			unsquashedTip: keepSquash.unsquashedTip
		});

		const dropped = await publishTwice(fixture, { ...orphan, branch: 'release/no-lfs', noLfs: true });
		const tip = tipOf(remote, 'release/no-lfs', dropped);
		expect(gitOut(remote, ['rev-list', '--parents', '-n', '1', tip])).toBe(tip);
		expect(gitOut(remote, ['diff-tree', '-r', '--name-status', keepTip, tip])).toBe(REWRITE_DIFF);
		expect(lfsNeeds(remote, tip)).toEqual({ filtered: [], pointers: [], rules: [] });
		const droppedSquash = objectData(dropped)['squash'] as Squash;
		expect(droppedSquash.parent).toBeNull();
		expect(squashedTrees.get('no-lfs')).toEqual({ tree: droppedSquash.tree, unsquashedTip: droppedSquash.unsquashedTip });
		expect(objectData(dropped)['lfs']).toEqual(LFS_REPORT);
		expect(refSha(remote, `${fixture.upstream.t1.sha}^{commit}`)).toBeNull();
	}, 300_000);
});

describe('publish --no-lfs where there is nothing to leave out, or where it cannot', () => {
	it('changes nothing on a tree without git-lfs content: no commit, the same tree, a line that says so', async () => {
		const fixture = makeCliFixture('no-lfs-none');
		excludeRuntime(fixture);
		ownPatchSetCommit(fixture, 'no-lfs-none');
		const remote = upstreamRemote(fixture, 'no-lfs-none');
		configureRemote(fixture, remote);

		const plain = await invokePublish(fixture, { bot: true, branch: 'release/generated' });
		expect(plain.exitCode, JSON.stringify(plain.envelope.errors)).toBe(0);
		const same = await invokePublish(fixture, { bot: true, branch: 'release/generated', noLfs: true });
		expect(same.exitCode, JSON.stringify(same.envelope.errors)).toBe(0);
		expect(same.envelope.data).toMatchObject({
			status: 'up-to-date',
			tip: objectData(plain.envelope)['tip'],
			lfs: { dropped: [], attributes: [] }
		});
		expect(infoLines(same.envelope)).toContain('no-lfs: the tree carries no git-lfs content and no git-lfs rule; nothing was left out');

		const squash = squashFlags('no-lfs-none');
		const squashed = await invokePublish(fixture, { ...squash, branch: 'release/squashed' });
		expect(squashed.exitCode, JSON.stringify(squashed.envelope.errors)).toBe(0);
		const again = await invokePublish(fixture, { ...squash, branch: 'release/squashed', noLfs: true });
		expect(again.exitCode, JSON.stringify(again.envelope.errors)).toBe(0);
		expect(again.envelope.data).toMatchObject({
			status: 'up-to-date',
			tip: objectData(squashed.envelope)['tip'],
			lfs: { dropped: [], attributes: [] }
		});
	}, 300_000);

	it('fails closed on a rule the rewrite does not remove, and pushes nothing', async (context) => {
		// The macro sits in the top-level .gitattributes, which check-tree reads
		// to refuse a tree that needs git-lfs where git-lfs is not installed.
		if (!LFS_INSTALLED) context.skip('git-lfs is not installed: check-tree refuses a tree whose top-level .gitattributes names filter=lfs');
		const fixture = makeCliFixture('no-lfs-macro', { upstream: { lfs: 'macro' } });
		excludeRuntime(fixture);
		const remote = upstreamRemote(fixture, 'no-lfs-macro');
		configureRemote(fixture, remote);
		const rule = '.gitattributes:1 ([attr]lfsdata filter=lfs diff=lfs merge=lfs -text)';

		for (const flags of [
			{ bot: true, branch: 'release/generated', noLfs: true },
			{ ...squashFlags('no-lfs-macro'), branch: 'release/squashed', noLfs: true }
		]) {
			const refused = await invokePublish(fixture, flags);
			expect(refused.exitCode).toBe(1);
			expect(refused.envelope.data).toMatchObject({ status: 'lfs-failed', tip: null, lfs: { dropped: [LFS_MACRO_PATH], attributes: [] } });
			expect(refused.envelope.errors).toEqual([
				expect.objectContaining({ code: 'CK-E-CONFIG', message: `--no-lfs left a rule that names filter=lfs: ${rule}` })
			]);
			expect(refused.envelope.errors[0]?.hint).toContain('nothing was pushed or exported');
			expect(refSha(remote, `refs/heads/${flags.branch}`)).toBeNull();
		}
	}, 300_000);
});

function squashFlags(label: string): PublishFlags {
	return { bot: true, squash: true, author: RELEASE_AUTHOR, messageFile: messageFile(label), scrub: true };
}

/** A publish and its repeat: the repeat answers up-to-date with the same tip. */
async function publishTwice(fixture: CliFixture, flags: PublishFlags): Promise<Awaited<ReturnType<typeof invokePublish>>['envelope']> {
	const first = await invokePublish(fixture, flags);
	expect(first.exitCode, JSON.stringify(first.envelope.errors)).toBe(0);
	expect(first.envelope.data).toMatchObject({ status: 'published', pushedBranch: true });
	const repeat = await invokePublish(fixture, flags);
	expect(repeat.exitCode, JSON.stringify(repeat.envelope.errors)).toBe(0);
	expect(repeat.envelope.data).toMatchObject({ status: 'up-to-date', tip: objectData(first.envelope)['tip'], pushedBranch: false });
	return first.envelope;
}

function tipOf(remote: string, branch: string, envelope: Awaited<ReturnType<typeof invokePublish>>['envelope']): string {
	const tip = refSha(remote, `refs/heads/${branch}`);
	expect(tip).toMatch(/^[0-9a-f]{40}$/);
	expect(tip).toBe(objectData(envelope)['tip']);
	return tip ?? '';
}
