// Real publish transactions against local bare remotes. The command is invoked
// through its CommandDefinition until the final shared argv/main integration atom.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { publishCommand } from '../../src/commands/publish.ts';
import type { CommandContext } from '../../src/lib/command.ts';
import { EXIT_ENVIRONMENT } from '../../src/lib/command.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import type { Envelope } from '../../src/lib/jsonOut.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { runPublish } from '../../src/lib/publish.ts';
import type { PublishOptions, PublishResult } from '../../src/lib/publish.ts';
import { EXAMPLE_PART_PATH, fixtureCommit } from '../fixtures/makeUpstream.ts';
import { OWN_UNIT_ID, PATCH_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture, provideTreeDependencies } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

afterAll(cleanupTempRoots);

describe('publish command gates', () => {
	it('requires the bot flag and configured remote, and rejects global --ci', async () => {
		const missingRemote = makeCliFixture('publish-gate-remote');
		excludeRuntime(missingRemote);
		const absent = await invoke(missingRemote, { bot: true });
		expect(absent.exitCode).toBe(2);
		expect(absent.envelope.errors[0]?.message).toContain('publishRemoteUrl');

		const fixture = makeCliFixture('publish-gate-bot');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-gate');
		configureRemote(fixture, remote);
		const bot = await invoke(fixture);
		expect(bot.exitCode).toBe(2);
		expect(bot.envelope.errors[0]?.message).toContain('--yes-i-am-publish-bot');

		const ci = await invoke(fixture, { bot: true, ci: true });
		expect(ci.exitCode).toBe(2);
		expect(ci.envelope.errors[0]?.code).toBe('CK-E-NET-FORBIDDEN');

		const semver = await invoke(fixture, { bot: true, release: '01.2.3' });
		expect(semver.exitCode).toBe(2);
		expect(semver.envelope.errors[0]?.message).toContain('strict semver');

		for (const args of [[], ['HEAD', 'extra']]) {
			const usage = await invoke(fixture, { bot: true, args });
			expect(usage.exitCode).toBe(2);
			expect(usage.envelope.errors[0]?.message).toContain('exactly one immutable patchset ref');
		}
		const profile = await invoke(fixture, { bot: true, profile: 'everything' });
		expect(profile.exitCode).toBe(2);
		expect(profile.envelope.errors[0]?.message).toContain('unknown publish profile');
	}, 300_000);

	it('does one failing remote preflight before lock, scratch, branch, or remote mutation', async () => {
		const fixture = makeCliFixture('publish-preflight');
		excludeRuntime(fixture);
		const missing = join(makeTempRoot('publish-missing-remote'), 'absent.git');
		configureRemote(fixture, missing);
		const head = fixture.git(['rev-parse', 'HEAD']).stdout.trim();

		const result = await invoke(fixture, { bot: true });

		expect(result.exitCode).toBe(2);
		expect(result.envelope.errors[0]?.message).toContain('cannot inspect publish remote');
		expect(fixture.git(['rev-parse', 'HEAD']).stdout.trim()).toBe(head);
		expect(fixture.git(['rev-parse', '--verify', releaseBranch(fixture)]).status).not.toBe(0);
		expect(publishScratch(fixture)).toEqual([]);
		expect(existsSync(missing)).toBe(false);
	}, 300_000);
});

describe('publish generated branch', () => {
	it('publishes canonical full verify history and repeats as a no-op', async () => {
		const fixture = makeCliFixture('publish-verify');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-verify');
		configureRemote(fixture, remote, 'local/must-not-name-release/');
		dirtyCallerFork(fixture, 'verify');
		const callerBefore = callerForkState(fixture);
		const scratchBefore = systemPublishScratch(fixture);

		const first = await invoke(fixture, { bot: true });
		expect(first.exitCode, JSON.stringify(first.envelope.errors)).toBe(0);
		expect(callerForkState(fixture)).toEqual(callerBefore);
		expect(systemPublishScratch(fixture)).toEqual(scratchBefore);
		expect(first.envelope.data).toMatchObject({ status: 'published', pushedBranch: true, pushedTag: false });
		const sha = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		const branch = `${releaseBranch(fixture, sha)}`;
		const tip = remoteSha(remote, branch);
		expect(tip).toMatch(/^[0-9a-f]{40}$/);

		const subjects = remoteOut(remote, ['log', '--reverse', '--format=%s', `${fixture.upstream.t1.sha}..${tip}`]).split('\n');
		expect(subjects).toHaveLength(4);
		expect(subjects[1]).toBe('codkit: own code source/own');
		expect(subjects[2]).toContain('manifest.json');
		expect(subjects[3]).toContain('app-icon.bin');
		const history = remoteOut(remote, ['log', '--format=%B', `${fixture.upstream.t1.sha}..${tip}`]);
		expect(history).toContain(`Codkit-Patchset-Commit: ${sha}`);
		expect(history).toContain(`Codkit-Upstream-Pin: t1@${fixture.upstream.t1.sha}`);
		expect(remoteOut(remote, ['show', `${tip}:source/own/hello.ts`])).toBe(
			readFileSync(fixture.patchesPath('delta/own/hello.ts'), 'utf8').trimEnd()
		);

		const repeat = await invoke(fixture, { bot: true });
		expect(repeat.exitCode).toBe(0);
		expect(repeat.envelope.data).toMatchObject({ status: 'up-to-date', pushedBranch: false, pushedTag: false });
		expect(remoteSha(remote, branch)).toBe(tip);
	}, 300_000);

	it('S38 - leaves the codkit licence notice out of the release branch', async () => {
		// PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION: `standards load` puts the
		// notice in delta/own/, from where every generated branch carries it into
		// the tree - except the one `publish` builds, which is a release.
		const fixture = makeCliFixture('publish-licence-notice');
		excludeRuntime(fixture);
		writeFileSync(fixture.patchesPath('delta/own/LICENSE-CODKIT.md'), '# Codkit licence notice\n', 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: codkit licence notice in own code', '2026-02-07T00:00:00Z');
		const remote = makeRemote(fixture, 'publish-licence-notice');
		configureRemote(fixture, remote, 'local/must-not-name-release/');

		const published = await invoke(fixture, { bot: true });
		expect(published.exitCode, JSON.stringify(published.envelope.errors)).toBe(0);
		const sha = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		const tip = remoteSha(remote, releaseBranch(fixture, sha));
		expect(tip, 'the release branch was not pushed').toMatch(/^[0-9a-f]{40}$/);
		if (tip === null) return;

		// The own commit is there, with the own code - and without the notice.
		expect(remoteOut(remote, ['show', `${tip}:source/own/hello.ts`]).length).toBeGreaterThan(0);
		const listed = remoteOut(remote, ['ls-tree', '-r', '--name-only', tip]).split('\n');
		expect(listed).not.toContain('source/own/LICENSE-CODKIT.md');

		// The developer tree, which `load` materialises, does carry it.
		expect(fixture.run(['load']).status).toBe(0);
		expect(readFileSync(fixture.treePath('source/own/LICENSE-CODKIT.md'), 'utf8')).toBe('# Codkit licence notice\n');
	}, 300_000);

	it('runs the real build profile before publishing', async () => {
		const fixture = makeCliFixture('publish-build');
		excludeRuntime(fixture);
		provideTreeDependencies(fixture);
		const supply = fixture.treePath('node_modules/fixture-supply/package.json');
		mkdirSync(join(supply, '..'), { recursive: true });
		writeFileSync(supply, '{"private":true}\n', 'utf8');
		const supplyBefore = readFileSync(supply);
		const remote = makeRemote(fixture, 'publish-build');
		configureRemote(fixture, remote);

		const result = await invoke(fixture, { bot: true, profile: 'build' });

		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		const steps = objectData(result.envelope)['steps'] as { name: string; state: string }[];
		expect(steps.find((step) => step.name === 'compile')?.state).toBe('ok');
		expect(steps.find((step) => step.name === 'product tests')?.state).toBe('ok');
		expect(remoteSha(remote, releaseBranch(fixture))).toMatch(/^[0-9a-f]{40}$/);
		expect(readFileSync(supply)).toEqual(supplyBefore);
	}, 300_000);

	it('does not push when selected checks are red', async () => {
		const fixture = makeCliFixture('publish-red');
		excludeRuntime(fixture);
		provideTreeDependencies(fixture);
		const supply = fixture.treePath('node_modules/fixture-supply/package.json');
		mkdirSync(join(supply, '..'), { recursive: true });
		writeFileSync(supply, '{"private":true,"red":false}\n', 'utf8');
		const supplyBefore = readFileSync(supply);
		const remote = makeRemote(fixture, 'publish-red');
		configureRemote(fixture, remote);
		dirtyCallerFork(fixture, 'red');
		const callerBefore = callerForkState(fixture);
		const scratchBefore = systemPublishScratch(fixture);
		const before = process.env['STUB_HYGIENE_MODE'];
		process.env['STUB_HYGIENE_MODE'] = 'fail';
		try {
			const result = await invoke(fixture, { bot: true, profile: 'build', release: '1.0.0' });
			expect(result.exitCode).toBe(1);
		} finally {
			if (before === undefined) delete process.env['STUB_HYGIENE_MODE'];
			else process.env['STUB_HYGIENE_MODE'] = before;
		}
		expect(remoteSha(remote, releaseBranch(fixture))).toBeNull();
		expect(remoteSha(remote, releaseTag(fixture, '1.0.0'))).toBeNull();
		expect(callerForkState(fixture)).toEqual(callerBefore);
		expect(readFileSync(supply)).toEqual(supplyBefore);
		expect(systemPublishScratch(fixture)).toEqual(scratchBefore);
	}, 300_000);

	it('rejects a duplicate non-canonical patch before publishing any ref', async () => {
		const fixture = makeCliFixture('publish-duplicate-patch');
		excludeRuntime(fixture);
		const patches = fixture.patchesPath('delta/patches');
		const original = readdirSync(patches).find((name) => name.endsWith('.ckpatch'));
		expect(original).toBeDefined();
		writeFileSync(join(patches, 'duplicate-target.ckpatch'), readFileSync(join(patches, original ?? '')), 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: duplicate patch target', '2026-02-05T00:00:00Z');
		const remote = makeRemote(fixture, 'publish-duplicate-patch');
		configureRemote(fixture, remote);

		const result = await invoke(fixture, { bot: true });

		expect(result.exitCode).toBe(1);
		expect(result.envelope.errors.some((error) => error.code === 'CK-E-ARTIFACT-BROKEN')).toBe(true);
		expect(result.envelope.errors[0]?.message).toContain('does not canonically encode target');
		expect(remoteSha(remote, releaseBranch(fixture))).toBeNull();
	}, 300_000);

	it('rejects a patch id already owned by the canonical own manifest', async () => {
		const fixture = makeCliFixture('publish-own-id-collision');
		excludeRuntime(fixture);
		const patches = fixture.patchesPath('delta/patches');
		const artifact = readdirSync(patches).find((name) => name.endsWith('.ckpatch'));
		expect(artifact).toBeDefined();
		const path = join(patches, artifact ?? '');
		writeFileSync(path, readFileSync(path, 'utf8').replace(`# id: ${PATCH_ID}`, `# id: ${OWN_UNIT_ID}`), 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: collide patch and own ids', '2026-02-06T00:00:00Z');
		const remote = makeRemote(fixture, 'publish-own-id-collision');
		configureRemote(fixture, remote);

		const result = await invoke(fixture, { bot: true, release: '4.0.0' });

		expect(result.exitCode).toBe(1);
		expect(result.envelope.errors[0]?.code).toBe('CK-E-ARTIFACT-BROKEN');
		expect(result.envelope.errors[0]?.message).toContain(`generated artifact id ${OWN_UNIT_ID}`);
		expect(result.envelope.errors[0]?.message).toContain('patchset.delta.json unit');
		expect(remoteSha(remote, releaseBranch(fixture))).toBeNull();
		expect(remoteSha(remote, releaseTag(fixture, '4.0.0'))).toBeNull();
	}, 300_000);
});

describe('publish remote transaction', () => {
	it('creates an immutable local-contract tag and treats the same tip as a no-op', async () => {
		const fixture = makeCliFixture('publish-tag');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-tag');
		configureRemote(fixture, remote);

		const first = await invoke(fixture, { bot: true, release: '1.2.3' });
		expect(first.exitCode).toBe(0);
		const branchTip = remoteSha(remote, releaseBranch(fixture));
		expect(remoteSha(remote, releaseTag(fixture, '1.2.3'))).toBe(branchTip);
		remoteOk(remote, ['update-ref', '-d', releaseBranch(fixture)]);

		const repaired = await invoke(fixture, { bot: true, release: '1.2.3' });
		expect(repaired.exitCode).toBe(0);
		expect(repaired.envelope.data).toMatchObject({ status: 'published', pushedBranch: true, pushedTag: false });
		expect(remoteSha(remote, releaseBranch(fixture))).toBe(branchTip);

		const repeat = await invoke(fixture, { bot: true, release: '1.2.3' });
		expect(repeat.exitCode).toBe(0);
		expect(repeat.envelope.data).toMatchObject({ status: 'up-to-date', pushedBranch: false, pushedTag: false });
	}, 300_000);

	it('rejects a different immutable tag before writing the release branch', async () => {
		const fixture = makeCliFixture('publish-tag-collision');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-tag-collision');
		configureRemote(fixture, remote);
		remoteOk(remote, ['update-ref', releaseTag(fixture, '2.0.0'), fixture.upstream.t1.sha]);

		const result = await invoke(fixture, { bot: true, release: '2.0.0' });

		expect(result.exitCode).toBe(1);
		expect(objectData(result.envelope)['status']).toBe('tag-collision');
		expect(result.envelope.errors[0]?.message).toContain('immutable tag');
		expect(remoteSha(remote, releaseBranch(fixture))).toBeNull();
		expect(remoteSha(remote, releaseTag(fixture, '2.0.0'))).toBe(fixture.upstream.t1.sha);
	}, 300_000);

	it('rejects a branch lease race as environment failure', async () => {
		const fixture = makeCliFixture('publish-lease');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-lease');
		configureRemote(fixture, remote);
		const config = requiredConfig(fixture);

		const result = await invokeLibrary(fixture, config, {
			checkpoint(checkpoint) {
				if (checkpoint === 'before-branch-push') remoteOk(remote, ['update-ref', releaseBranch(fixture), fixture.upstream.t1.sha]);
			}
		});

		expect(result.exitCode).toBe(2);
		expect(result.envelope.errors[0]?.message).toContain('branch push failed');
		expect(remoteSha(remote, releaseBranch(fixture))).toBe(fixture.upstream.t1.sha);
	}, 300_000);

	it('refreshes tags after checks and performs zero branch writes on a tag race', async () => {
		const fixture = makeCliFixture('publish-tag-race');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-tag-race');
		configureRemote(fixture, remote);
		const config = requiredConfig(fixture);

		const result = await invokeLibrary(
			fixture,
			config,
			{
				checkpoint(checkpoint) {
					if (checkpoint === 'checks-passed') remoteOk(remote, ['update-ref', releaseTag(fixture, '2.1.0'), fixture.upstream.t1.sha]);
				}
			},
			'2.1.0'
		);

		expect(result.exitCode).toBe(1);
		expect(result.result?.status).toBe('tag-collision');
		expect(remoteSha(remote, releaseBranch(fixture))).toBeNull();
		expect(remoteSha(remote, releaseTag(fixture, '2.1.0'))).toBe(fixture.upstream.t1.sha);
	}, 300_000);

	it('keeps the branch untouched when a tag conflicts immediately before its push', async () => {
		const fixture = makeCliFixture('publish-tag-push-race');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-tag-push-race');
		configureRemote(fixture, remote);
		const result = await invokeLibrary(
			fixture,
			requiredConfig(fixture),
			{
				checkpoint(checkpoint) {
					if (checkpoint === 'before-tag-push') remoteOk(remote, ['update-ref', releaseTag(fixture, '2.2.0'), fixture.upstream.t1.sha]);
				}
			},
			'2.2.0'
		);

		expect(result.exitCode).toBe(2);
		expect(result.envelope.errors[0]?.message).toContain('tag push failed');
		expect(remoteSha(remote, releaseBranch(fixture))).toBeNull();
		expect(remoteSha(remote, releaseTag(fixture, '2.2.0'))).toBe(fixture.upstream.t1.sha);
	}, 300_000);

	it('recovers idempotently from a tag-only partial after a branch lease race', async () => {
		const fixture = makeCliFixture('publish-partial');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-partial');
		configureRemote(fixture, remote);
		const config = requiredConfig(fixture);
		const partial = await invokeLibrary(
			fixture,
			config,
			{
				checkpoint(checkpoint) {
					if (checkpoint === 'before-branch-push') remoteOk(remote, ['update-ref', releaseBranch(fixture), fixture.upstream.t1.sha]);
				}
			},
			'3.0.0'
		);
		expect(partial.exitCode).toBe(2);
		const tagTip = remoteSha(remote, releaseTag(fixture, '3.0.0'));
		expect(tagTip).toMatch(/^[0-9a-f]{40}$/);
		expect(remoteSha(remote, releaseBranch(fixture))).toBe(fixture.upstream.t1.sha);

		const resumed = await invoke(fixture, { bot: true, release: '3.0.0' });
		expect(resumed.exitCode).toBe(0);
		expect(resumed.envelope.data).toMatchObject({ pushedBranch: true, pushedTag: false });
		expect(remoteSha(remote, releaseBranch(fixture))).toBe(tagTip);
	}, 300_000);
});

describe('publish disposable fork', () => {
	it('gives the disposable fork long paths and the git-lfs content of the tree it is cloned from', async () => {
		// PROP-007 ##PUBLISH-DISPOSABLE-FORK: codkit's git reads no global or
		// system config, so what the fork needs is in its own.
		const fixture = makeCliFixture('publish-disposable-fork');
		excludeRuntime(fixture);
		const remote = makeRemote(fixture, 'publish-disposable-fork');
		configureRemote(fixture, remote);
		const common = fixture.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
		mkdirSync(join(common, 'lfs', 'objects'), { recursive: true });
		const lfs = fixture.git(['lfs', 'version']).status === 0;
		const before = systemPublishScratch(fixture);
		let forkConfig = '';

		const result = await invokeLibrary(fixture, requiredConfig(fixture), {
			checkpoint(checkpoint) {
				if (checkpoint !== 'checks-passed') return;
				const scratch = systemPublishScratch(fixture).filter((name) => !before.includes(name));
				expect(scratch).toHaveLength(1);
				forkConfig = remoteOut(join(tmpdir(), scratch[0] ?? '', 'fork'), ['config', '--local', '--list']);
			}
		});

		expect(result.exitCode, JSON.stringify(result.envelope.errors)).toBe(0);
		const settings = forkConfig.split('\n');
		expect(settings).toContain('core.longpaths=true');
		if (!lfs) return;
		expect(settings).toEqual(
			expect.arrayContaining([
				'filter.lfs.clean=git-lfs clean -- %f',
				'filter.lfs.smudge=git-lfs smudge -- %f',
				'filter.lfs.process=git-lfs filter-process',
				'filter.lfs.required=true',
				`lfs.storage=${join(common, 'lfs')}`
			])
		);
	}, 300_000);
});

describe('publish clean release', () => {
	it('refuses a malformed clean release before the network gate', async () => {
		const fixture = makeCliFixture('publish-clean-gates');
		excludeRuntime(fixture);
		// No remote at all: a refusal that reached the ls-remote gate would name it instead.
		configureCleanRemote(fixture, join(makeTempRoot('publish-clean-gates-remote'), 'absent.git'), []);
		const message = messageFile('publish-clean-gates');
		const squash = { squash: true, author: RELEASE_AUTHOR, messageFile: message };
		const cases: readonly (readonly [InvocationOptions, string])[] = [
			[{ scrub: true }, '--scrub needs --squash'],
			[{ squash: true, author: RELEASE_AUTHOR }, '--squash needs --author and --message-file'],
			[{ author: RELEASE_AUTHOR, messageFile: message }, 'belong to --squash'],
			[{ ...squash, author: 'Иван Петров' }, '--author expects'],
			[{ ...squash, messageFile: join(message, '..', 'absent.txt') }, '--message-file cannot be read'],
			[{ branch: 'codkit/applied/rc' }, 'collides with the patch-set namespace codkit/applied/'],
			[{ branch: 'codkit' }, 'collides with the patch-set namespace'],
			[{ branch: 'nimbus/rc..1' }, 'not a valid branch name']
		];
		for (const [options, text] of cases) {
			const result = await invoke(fixture, { bot: true, ...options });
			expect(result.exitCode, text).toBe(2);
			expect(result.envelope.errors[0]?.message, text).toContain(text);
		}
		// An exclusion never takes an upstream file out of the release.
		configureCleanRemote(fixture, join(makeTempRoot('publish-clean-gates-remote'), 'absent.git'), ['manifest.json']);
		const upstream = await invoke(fixture, { bot: true, ...squash, scrub: true });
		expect(upstream.exitCode).toBe(2);
		expect(upstream.envelope.errors[0]?.message).toContain(
			'publish.exclude entry manifest.json names manifest.json, which the pin carries'
		);
	}, 300_000);

	it('publishes one scrubbed commit on the pin under its own name, repeats as a no-op and refuses leftovers', async () => {
		const fixture = makeCliFixture('publish-clean');
		excludeRuntime(fixture);
		const hello = fixture.patchesPath('delta/own/hello.ts');
		writeFileSync(
			hello,
			`${readFileSync(hello, 'utf8')}\n/**\n * The greeting of the fixture\n * (spec://fixture/FEAT-001#GREETING).\n` +
				` * @implements spec://fixture/FEAT-001#HELLO\n */\nexport const greeting = 'hello';\n`,
			'utf8'
		);
		// Bare references the patch set learns from its own spec document and inventory.
		writeFileSync(
			hello,
			`${readFileSync(hello, 'utf8')}// FEAT-001 GR-PLAIN: the greeting is plain text (intervention CK-shell-902).\nexport const plain = true;\n`,
			'utf8'
		);
		writeFileSync(
			fixture.patchesPath('delta/own/test/GUIDE.md'),
			'# Guide\n\nThe greeting follows the rule of FEAT-001 section 2.\n',
			'utf8'
		);
		const spec = fixture.patchesPath('vibevm/vibespecs/modules/fixture/FEAT-001-greeting.xml');
		mkdirSync(join(spec, '..'), { recursive: true });
		writeFileSync(
			spec,
			'<spec><title id="root">fixture FEAT-001: The greeting</title><GR-GREETING fact="true">g</GR-GREETING><GR-PLAIN fact="true">p</GR-PLAIN></spec>\n',
			'utf8'
		);
		writeFileSync(fixture.patchesPath('delta/own/test/NOTES.md'), 'The fixture specs live in vibevm/vibespecs.\n', 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: own code for a clean release', '2026-02-08T00:00:00Z');
		const remote = makeRemote(fixture, 'publish-clean');
		configureCleanRemote(fixture, remote, ['source/own/test/NOTES.md']);
		const flags: InvocationOptions = {
			bot: true,
			release: '1.0.0',
			branch: 'nimbus/rc/1.0.0',
			squash: true,
			author: RELEASE_AUTHOR,
			messageFile: messageFile('publish-clean'),
			scrub: true
		};

		const first = await invoke(fixture, flags);
		expect(first.exitCode, JSON.stringify(first.envelope.errors)).toBe(0);
		const data = objectData(first.envelope);
		expect(data).toMatchObject({ status: 'published', branch: 'nimbus/rc/1.0.0', pushedBranch: true, pushedTag: true });
		const tip = remoteSha(remote, 'refs/heads/nimbus/rc/1.0.0');
		expect(tip).toBe(data['tip']);
		if (tip === null) return;
		expect(remoteSha(remote, releaseTag(fixture, '1.0.0'))).toBe(tip);
		// One commit straight on the pin, signed by the owner, with his message and no trailer.
		expect(remoteOut(remote, ['rev-list', '--parents', '-n', '1', tip])).toBe(`${tip} ${fixture.upstream.t1.sha}`);
		expect(remoteOut(remote, ['log', '-1', '--format=%an <%ae>%n%cn <%ce>', tip])).toBe(`${RELEASE_AUTHOR}\n${RELEASE_AUTHOR}`);
		expect(remoteOut(remote, ['log', '-1', '--format=%B', tip])).toBe(RELEASE_MESSAGE_LF.trimEnd());
		expect(data['squash']).toMatchObject({ parent: fixture.upstream.t1.sha, author: RELEASE_AUTHOR });
		// Nothing of the tooling in the tree; the excluded note is not there; the prose is.
		expect(runGit({ args: ['grep', '-i', '-E', 'codkit:(begin|end)|spec://|vibevm', tip], cwd: remote }).status).toBe(1);
		expect(runGit({ args: ['grep', '-w', '-E', 'FEAT-001|GR-PLAIN|GR-GREETING|CK-shell-902', tip], cwd: remote }).status).toBe(1);
		const files = remoteOut(remote, ['ls-tree', '-r', '--name-only', tip]).split('\n');
		expect(files).toContain('source/own/hello.ts');
		expect(files).not.toContain('source/own/test/NOTES.md');
		expect(remoteOut(remote, ['show', `${tip}:source/own/hello.ts`])).toContain(
			" * The greeting of the fixture.\n */\nexport const greeting = 'hello';\n// the greeting is plain text.\nexport const plain = true;"
		);
		expect(remoteOut(remote, ['show', `${tip}:source/own/test/GUIDE.md`])).toBe('# Guide\n\nThe greeting follows the rule.');
		expect(remoteOut(remote, ['show', `${tip}:${EXAMPLE_PART_PATH}`])).toContain(
			'// (hook body lives in own/ code; this block only delegates)'
		);
		const scrub = data['scrub'] as {
			files: { path: string; markers: number }[];
			excluded: string[];
			leftovers: unknown[];
			vocabulary: { [source: string]: number };
		};
		const groups = { parenthetical: 1, lead: 1, sentence: 0, preposition: 0 };
		expect(scrub.files).toContainEqual({ path: 'source/own/hello.ts', markers: 0, specRefs: 2, droppedLines: 2, groups });
		expect(scrub.files).toContainEqual({
			path: 'source/own/test/GUIDE.md',
			markers: 0,
			specRefs: 0,
			droppedLines: 0,
			groups: { parenthetical: 0, lead: 0, sentence: 0, preposition: 1 }
		});
		expect(scrub.vocabulary).toMatchObject({ documents: 1, facts: 2, modules: 1 });
		expect(scrub.files.find((file) => file.path === EXAMPLE_PART_PATH)?.markers).toBeGreaterThanOrEqual(2);
		expect(scrub.excluded).toEqual(['source/own/test/NOTES.md']);
		expect(scrub.leftovers).toEqual([]);

		// The same patchset commit, author and message make the same commit.
		const repeat = await invoke(fixture, flags);
		expect(repeat.exitCode, JSON.stringify(repeat.envelope.errors)).toBe(0);
		expect(repeat.envelope.data).toMatchObject({ status: 'up-to-date', tip, pushedBranch: false, pushedTag: false });

		// A reference in code is a leftover: the publish stops with its line, and nothing moves.
		writeFileSync(
			hello,
			`${readFileSync(hello, 'utf8')}export const address = 'spec://fixture/FEAT-001#IN-CODE';\nexport const rule = 'GR-PLAIN';\n`,
			'utf8'
		);
		fixtureCommit(fixture.patchesDir, 'fixture: a spec reference in code', '2026-02-09T00:00:00Z');
		const refused = await invoke(fixture, flags);
		expect(refused.exitCode).toBe(1);
		expect(objectData(refused.envelope)['status']).toBe('scrub-failed');
		expect(refused.envelope.errors.map((error) => error.message)).toContainEqual(
			expect.stringMatching(/^the scrubbed release still carries tooling: source\/own\/hello\.ts:\d+: export const address = 'spec:\/\//)
		);
		expect(refused.envelope.errors.map((error) => error.message)).toContainEqual(
			expect.stringMatching(
				/^the scrubbed release still carries a reference \(GR-PLAIN\): source\/own\/hello\.ts:\d+: export const rule = 'GR-PLAIN';$/
			)
		);
		expect(remoteSha(remote, 'refs/heads/nimbus/rc/1.0.0')).toBe(tip);
		expect(remoteSha(remote, releaseTag(fixture, '1.0.0'))).toBe(tip);
	}, 300_000);
});

/** A Cyrillic identity: the name has to reach the commit as it was typed. */
const RELEASE_AUTHOR = 'Иван Петров <ivan.petrov@example.org>';
const RELEASE_MESSAGE = 'Выпуск 1.0.0\r\n\r\nОдин коммит поверх апстрима, без следов инструмента.\r\n\r\n';
const RELEASE_MESSAGE_LF = 'Выпуск 1.0.0\n\nОдин коммит поверх апстрима, без следов инструмента.\n';

function messageFile(label: string): string {
	const path = join(makeTempRoot(`${label}-message`), 'message-ru.txt');
	writeFileSync(path, RELEASE_MESSAGE, 'utf8');
	return path;
}

function configureCleanRemote(fixture: CliFixture, remote: string, exclude: readonly string[]): void {
	writeFileSync(
		fixture.patchesPath('codkit.local.json'),
		`${JSON.stringify({ publishRemoteUrl: remote, publish: { exclude } }, null, 2)}\n`,
		'utf8'
	);
}

type InvocationOptions = {
	readonly bot?: boolean;
	readonly ci?: boolean;
	readonly profile?: string;
	readonly release?: string;
	readonly args?: readonly string[];
	readonly branch?: string;
	readonly squash?: boolean;
	readonly author?: string;
	readonly messageFile?: string;
	readonly scrub?: boolean;
};
type Invocation = { readonly exitCode: number; readonly envelope: Envelope };

async function invoke(fixture: CliFixture, options: InvocationOptions = {}): Promise<Invocation> {
	const config = requiredConfig(fixture);
	const out = output();
	const commandFlags = new Map<string, string | true>();
	if (options.bot === true) commandFlags.set('--yes-i-am-publish-bot', true);
	if (options.profile !== undefined) commandFlags.set('--profile', options.profile);
	if (options.release !== undefined) commandFlags.set('--release', options.release);
	if (options.branch !== undefined) commandFlags.set('--branch', options.branch);
	if (options.squash === true) commandFlags.set('--squash', true);
	if (options.author !== undefined) commandFlags.set('--author', options.author);
	if (options.messageFile !== undefined) commandFlags.set('--message-file', options.messageFile);
	if (options.scrub === true) commandFlags.set('--scrub', true);
	const context: CommandContext = {
		toolRoot: fixture.patchesDir,
		locations: {
			patchesDir: { path: fixture.patchesDir, source: 'flag', exists: true, warning: null },
			forkDir: { path: fixture.treeDir, source: 'flag', exists: true, warning: null }
		},
		patchesDir: fixture.patchesDir,
		args: options.args ?? ['HEAD'],
		flags: { forkDir: fixture.treeDir, patchesDir: fixture.patchesDir, json: true, ci: options.ci === true, verbose: false },
		commandFlags,
		env: {},
		config,
		type: stubProjectType,
		out
	};
	let exitCode: number;
	try {
		exitCode = await publishCommand.run(context);
	} catch (error) {
		if (!isCkError(error)) throw error;
		out.addError(error.toPayload());
		exitCode = EXIT_ENVIRONMENT;
	}
	return { exitCode, envelope: out.buildEnvelope(exitCode) };
}

async function invokeLibrary(
	fixture: CliFixture,
	config: CodkitConfig,
	extra: Pick<PublishOptions, 'checkpoint'>,
	release: string | null = null
): Promise<Invocation & { readonly result: PublishResult | null }> {
	const out = output();
	let result: PublishResult | null = null;
	let exitCode: number;
	try {
		result = await runPublish({ ...libraryOptions(fixture, config, 'verify', release), ...extra, out });
		exitCode = result.exitCode;
	} catch (error) {
		if (!isCkError(error)) throw error;
		out.addError(error.toPayload());
		exitCode = EXIT_ENVIRONMENT;
	}
	return { result, exitCode, envelope: out.buildEnvelope(exitCode) };
}

function libraryOptions(fixture: CliFixture, config: CodkitConfig, profile: 'verify' | 'build', release: string | null): PublishOptions {
	return {
		patchesDir: fixture.patchesDir,
		resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null },
		config,
		type: stubProjectType,
		out: output(),
		patchSetRef: 'HEAD',
		profile,
		release,
		confirmed: true,
		ci: false,
		verbose: false
	};
}

function output(): Output {
	return new Output({ command: 'publish', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
}

function requiredConfig(fixture: CliFixture): CodkitConfig {
	const config = loadConfig(fixture.patchesDir);
	if (config === null) throw new Error('fixture config disappeared');
	return config;
}

function excludeRuntime(fixture: CliFixture): void {
	writeFileSync(join(fixture.patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
}

function configureRemote(fixture: CliFixture, remote: string, releaseRefPrefix?: string): void {
	writeFileSync(
		fixture.patchesPath('codkit.local.json'),
		`${JSON.stringify({ publishRemoteUrl: remote, ...(releaseRefPrefix === undefined ? {} : { releaseRefPrefix }) }, null, 2)}\n`,
		'utf8'
	);
}

function makeRemote(fixture: CliFixture, label: string): string {
	const remote = join(makeTempRoot(`${label}-remote`), 'publish.git');
	const result = runGit({ args: ['clone', '--bare', '--quiet', fixture.upstream.dir, remote], cwd: fixture.patchesDir, netAllowed: true });
	expect(result.status, result.stderr).toBe(0);
	return remote;
}

function releaseBranch(fixture: CliFixture, sha = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim()): string {
	return `refs/heads/codkit/release/${sha.slice(0, 12)}+${fixture.upstream.t1.tag}`;
}

function releaseTag(fixture: CliFixture, release: string): string {
	return `refs/tags/patchset-v${release}+${fixture.upstream.t1.tag}`;
}

function remoteSha(remote: string, ref: string): string | null {
	const result = runGit({ args: ['rev-parse', '--verify', ref], cwd: remote });
	return result.status === 0 ? result.stdout.trim() : null;
}

function remoteOut(remote: string, args: readonly string[]): string {
	const result = runGit({ args, cwd: remote });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.trimEnd();
}

function remoteOk(remote: string, args: readonly string[]): void {
	const result = runGit({ args, cwd: remote });
	expect(result.status, result.stderr).toBe(0);
}

function publishScratch(fixture: CliFixture): readonly string[] {
	const path = fixture.patchesPath('.codkit/tmp');
	if (!existsSync(path)) return [];
	return readdirSync(path).filter((name) => name.startsWith('publish-'));
}

function systemPublishScratch(fixture: CliFixture): readonly string[] {
	const sha = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim().slice(0, 12);
	return readdirSync(tmpdir())
		.filter((name) => name.startsWith(`codkit-publish-${sha}-`))
		.sort();
}

function dirtyCallerFork(fixture: CliFixture, label: string): void {
	const tracked = fixture.treePath('README.md');
	writeFileSync(tracked, `${readFileSync(tracked, 'utf8')}\nstaged caller ${label}\n`, 'utf8');
	expect(fixture.git(['add', '--', 'README.md']).status).toBe(0);
	writeFileSync(tracked, `${readFileSync(tracked, 'utf8')}unstaged caller ${label}\n`, 'utf8');
	writeFileSync(fixture.treePath(`caller-${label}.txt`), `untracked caller ${label}\n`, 'utf8');
}

function callerForkState(fixture: CliFixture): Record<string, string> {
	const untracked = fixture
		.git(['ls-files', '--others', '--exclude-standard', '-z'])
		.stdout.split('\0')
		.filter((path) => path !== '');
	return {
		head: fixture.git(['rev-parse', 'HEAD']).stdout,
		headName: fixture.git(['symbolic-ref', '-q', 'HEAD']).stdout,
		status: fixture.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout,
		staged: fixture.git(['diff', '--cached', '--binary']).stdout,
		unstaged: fixture.git(['diff', '--binary']).stdout,
		readme: readFileSync(fixture.treePath('README.md'), 'utf8'),
		untrackedBytes: JSON.stringify(untracked.map((path) => [path, readFileSync(fixture.treePath(path)).toString('base64')]))
	};
}

function objectData(envelope: Envelope): { [key: string]: unknown } {
	return envelope.data !== null && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
		? (envelope.data as { [key: string]: unknown })
		: {};
}
