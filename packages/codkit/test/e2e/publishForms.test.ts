// The three forms of a release (PROP-007 ##PUBLISH-FORMS): one commit without
// a parent, upstream's history with one squashed commit, upstream's history
// with the generated one - published into local bare remotes.

import { afterAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import {
	RELEASE_AUTHOR,
	RELEASE_MESSAGE_LF,
	configureRemote,
	emptyRemote,
	excludeRuntime,
	gitOut,
	infoLines,
	invokePublish,
	invokePublishLibrary,
	messageFile,
	objectData,
	ownPatchSetCommit,
	reachableObjects,
	refSha,
	releaseTag,
	storedObjects,
	upstreamRemote
} from '../support/publishFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

describe('publish --orphan', () => {
	it('refuses --orphan without --squash before any gate', async () => {
		const fixture = makeCliFixture('forms-orphan-gate');
		excludeRuntime(fixture);
		// No remote, no bot flag and a global --ci: each would be refused on its
		// own, and the refusal of --orphan comes before all of them.
		configureRemote(fixture, null);
		const refused = await invokePublish(fixture, { orphan: true, ci: true });
		expect(refused.exitCode).toBe(2);
		expect(refused.envelope.errors).toHaveLength(1);
		expect(refused.envelope.errors[0]).toMatchObject({ code: 'CK-E-CONFIG', message: '--orphan needs --squash' });
		expect(refused.envelope.errors[0]?.hint).toContain('--squash');
		const library = await invokePublishLibrary(fixture, { orphan: true, ci: true, confirmed: false });
		expect(library.exitCode).toBe(2);
		expect(library.envelope.errors[0]?.message).toBe('--orphan needs --squash');
	}, 300_000);

	it('publishes one commit without a parent that carries only the objects it reaches, and repeats as a no-op', async () => {
		const fixture = makeCliFixture('forms-orphan');
		excludeRuntime(fixture);
		ownPatchSetCommit(fixture, 'forms-orphan');
		const remote = emptyRemote('forms-orphan');
		configureRemote(fixture, remote);
		const flags = {
			bot: true,
			release: '1.0.0',
			branch: 'nimbus/one/1.0.0',
			squash: true,
			orphan: true,
			author: RELEASE_AUTHOR,
			messageFile: messageFile('forms-orphan'),
			scrub: true
		};

		const first = await invokePublish(fixture, flags);
		expect(first.exitCode, JSON.stringify(first.envelope.errors)).toBe(0);
		const data = objectData(first.envelope);
		const tip = refSha(remote, 'refs/heads/nimbus/one/1.0.0');
		expect(tip).toBe(data['tip']);
		if (tip === null) return;
		expect(refSha(remote, releaseTag(fixture, '1.0.0'))).toBe(tip);
		// One commit without a parent, signed by the owner, with his message and no trailer.
		expect(gitOut(remote, ['rev-list', '--parents', '-n', '1', tip])).toBe(tip);
		expect(gitOut(remote, ['rev-list', '--count', tip])).toBe('1');
		expect(gitOut(remote, ['log', '-1', '--format=%an <%ae>%n%cn <%ce>', tip])).toBe(`${RELEASE_AUTHOR}\n${RELEASE_AUTHOR}`);
		expect(gitOut(remote, ['log', '-1', '--format=%B', tip])).toBe(RELEASE_MESSAGE_LF.trimEnd());
		const squash = data['squash'] as { parent: string | null; tree: string; unsquashedTip: string; author: string };
		expect(squash).toMatchObject({ parent: null, author: RELEASE_AUTHOR });
		expect(gitOut(remote, ['rev-parse', `${tip}^{tree}`])).toBe(squash.tree);
		expect(infoLines(first.envelope)).toContain(
			`squash: ${squash.unsquashedTip.slice(0, 12)} -> ${tip.slice(0, 12)} without a parent (tree ${squash.tree.slice(0, 12)})`
		);
		// The push into an empty repository carried only what the commit reaches:
		// its tree and nothing of upstream's history.
		expect(storedObjects(remote)).toEqual(reachableObjects(remote, tip));
		expect(gitOut(remote, ['cat-file', '-t', tip])).toBe('commit');
		expect(refSha(remote, `${fixture.upstream.t1.sha}^{commit}`)).toBeNull();

		const repeat = await invokePublish(fixture, flags);
		expect(repeat.exitCode, JSON.stringify(repeat.envelope.errors)).toBe(0);
		expect(repeat.envelope.data).toMatchObject({ status: 'up-to-date', tip, pushedBranch: false, pushedTag: false });

		// The same flags without --orphan make the commit on the pin over the same tree.
		const upstream = upstreamRemote(fixture, 'forms-orphan-pin');
		configureRemote(fixture, upstream);
		const onPin = await invokePublish(fixture, { ...flags, orphan: false });
		expect(onPin.exitCode, JSON.stringify(onPin.envelope.errors)).toBe(0);
		const pinned = objectData(onPin.envelope)['squash'] as { parent: string | null; tree: string; unsquashedTip: string };
		expect(pinned).toMatchObject({ parent: fixture.upstream.t1.sha, tree: squash.tree, unsquashedTip: squash.unsquashedTip });
		const pinnedTip = refSha(upstream, 'refs/heads/nimbus/one/1.0.0');
		expect(pinnedTip).not.toBe(tip);
		expect(gitOut(upstream, ['rev-list', '--parents', '-n', '1', pinnedTip ?? ''])).toBe(`${pinnedTip ?? ''} ${fixture.upstream.t1.sha}`);
	}, 300_000);
});
