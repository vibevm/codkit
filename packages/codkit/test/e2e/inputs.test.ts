// End to end: the inputs of a patch set (PROP-007 ##INPUTS, ##CMD-LOAD-INPUTS,
// ##CMD-INPUTS-PIN, ##CMD-STATUS-INPUTS, ##INPUTS-GENERATED; PROP-008
// ##INPUTS-LOAD). `load`, `status`, `save` and `inputs pin` run through the real
// CLI over two project types - the stub of the first family and `generic` - so
// nothing here leans on one type; `publish` runs in process over a local bare
// remote. The input is a tiny repository with a Node build.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { publishCommand } from '../../src/commands/publish.ts';
import type { CommandContext } from '../../src/lib/command.ts';
import { EXIT_ENVIRONMENT } from '../../src/lib/command.ts';
import type { InputConfig } from '../../src/lib/configFile.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import type { Envelope } from '../../src/lib/jsonOut.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture, Envelope as CliEnvelope, Run } from '../support/cliFixture.ts';
import { makeGenericFixture } from '../support/genericFixture.ts';
import { makeInputRepository } from '../support/inputRepository.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

it('inputs-only restores a missing projection without overwriting unextracted marker work or generated history', () => {
	const polygon = makeCliFixture('inputs-only-preserve-marker');
	const repo = makeInputRepository('inputs-only-preserve-marker');
	declare(polygon, [repo.declaration()]);
	const loaded = polygon.json(['load']);
	expect(loaded.run.status, text(loaded.run)).toBe(0);
	const target = 'source/base/common/util.ts';
	writeFileSync(polygon.patchesPath('input-marker-body.txt'), 'export const unextracted = 1;\n');
	const authored = polygon.json([
		'marker',
		'new',
		target,
		'--id',
		'CK-base-996',
		'--type',
		'extend',
		'--owner',
		'shell-core',
		'--reason',
		'input recovery guard',
		'--line',
		'1',
		'--body-file',
		'input-marker-body.txt'
	]);
	expect(authored.run.status, text(authored.run)).toBe(0);
	const before = readFileSync(polygon.treePath(target), 'utf8');
	const head = polygon.git(['rev-parse', 'HEAD']).stdout;
	unlinkSync(polygon.treePath('handbook/guide.md'));
	const restored = polygon.json(['load', '--inputs-only']);
	expect(restored.run.status, text(restored.run)).toBe(0);
	expect(restored.envelope.data['status']).toBe('inputs-refreshed');
	expect(readFileSync(polygon.treePath('handbook/guide.md'), 'utf8')).toContain('# Guide');
	expect(readFileSync(polygon.treePath(target), 'utf8')).toBe(before);
	expect(polygon.git(['rev-parse', 'HEAD']).stdout).toBe(head);
}, 600000);

/** What the scenarios need of a fixture; both polygons answer it. */
type Polygon = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly json: (args: readonly string[], env?: Readonly<Record<string, string>>) => { run: Run; envelope: CliEnvelope };
	readonly git: (args: readonly string[]) => { status: number; stdout: string; stderr: string };
	readonly treePath: (relative: string) => string;
	readonly patchesPath: (relative: string) => string;
};

const POLYGONS: readonly (readonly [string, (label: string) => Polygon])[] = [
	['stub', (label) => makeCliFixture(label)],
	['generic', (label) => makeGenericFixture(label)]
];

function declare(polygon: Polygon, inputs: readonly InputConfig[]): void {
	const path = polygon.patchesPath('codkit.json');
	const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	writeFileSync(path, `${JSON.stringify({ ...config, inputs }, null, 2)}\n`, 'utf8');
}

function inputsOf(envelope: CliEnvelope): readonly Record<string, unknown>[] {
	return (envelope.data['inputs'] as Record<string, unknown>[] | undefined) ?? [];
}

function text(run: Run): string {
	return `${run.stdout}\n${run.stderr}`;
}

describe.each(POLYGONS)('load delivers the inputs (%s)', (label, make) => {
	it('builds from the working tree, skips an unchanged build, puts back an edit, and takes the pin on request', () => {
		const polygon = make(`inputs-load-${label}`);
		const repo = makeInputRepository(`inputs-load-${label}`);
		repo.write('pages/guide.md', '# Guide\n\nAn edit nobody committed yet.\n');
		declare(polygon, [repo.declaration()]);

		const first = polygon.json(['load']);
		expect(first.run.status, text(first.run)).toBe(0);
		expect(inputsOf(first.envelope)).toEqual([
			{ name: 'pages', to: 'handbook', mode: 'working', commit: null, files: 3, written: 3, removed: 0, built: true }
		]);
		expect(readFileSync(polygon.treePath('handbook/guide.md'), 'utf8')).toContain('An edit nobody committed yet.');
		expect(readFileSync(polygon.treePath('handbook/index.txt'), 'utf8')).toBe('pages: guide.md, topics\nhelper: carried in\n');
		// Delivered untracked and hidden: git does not see it, so no guard does.
		expect(polygon.git(['status', '--porcelain', '--untracked-files=all']).stdout).not.toContain('handbook');
		expect(repo.builds()).toBe(1);

		const again = polygon.json(['load']);
		expect(again.run.status, text(again.run)).toBe(0);
		expect(inputsOf(again.envelope)[0]).toMatchObject({ built: false, written: 0, removed: 0 });
		expect(repo.builds()).toBe(1);

		const clean = polygon.json(['status']);
		expect(clean.run.status, text(clean.run)).toBe(0);
		expect(inputsOf(clean.envelope)[0]).toMatchObject({ name: 'pages', edits: [], delivered: { mode: 'working', commit: null, files: 3 } });
		expect(text(clean.run)).toContain('uncommitted change(s); the pin does not carry them');

		// An edit in the directory: status names it, save refuses it, load puts the input back.
		writeFileSync(polygon.treePath('handbook/guide.md'), 'edited in the fork tree\n', 'utf8');
		const edited = polygon.json(['status']);
		expect(edited.run.status).toBe(1);
		expect(inputsOf(edited.envelope)[0]?.['edits']).toEqual([{ path: 'handbook/guide.md', kind: 'edited' }]);
		const saved = polygon.json(['save']);
		expect(saved.run.status).toBe(1);
		expect(saved.envelope.errors[0]?.code).toBe('CK-E-DIRTY-TREE');
		expect(saved.envelope.errors[0]?.message).toContain('in the directories of inputs were changed in the fork tree');
		expect(readFileSync(polygon.treePath('handbook/guide.md'), 'utf8')).toBe('edited in the fork tree\n');
		const restored = polygon.json(['load']);
		expect(restored.run.status, text(restored.run)).toBe(0);
		expect(text(restored.run)).toContain(`handbook/guide.md was edited in the fork tree; the load puts back the bytes of ${repo.dir}`);
		expect(readFileSync(polygon.treePath('handbook/guide.md'), 'utf8')).toContain('An edit nobody committed yet.');
		expect(repo.builds()).toBe(1);

		const pinned = polygon.json(['load', '--inputs', 'pinned']);
		expect(pinned.run.status, text(pinned.run)).toBe(0);
		expect(inputsOf(pinned.envelope)[0]).toMatchObject({ mode: 'pinned', commit: repo.head(), built: true });
		expect(readFileSync(polygon.treePath('handbook/guide.md'), 'utf8')).toBe('# Guide\n\nThe first page.\n');
		expect(repo.builds()).toBe(2);

		const skipped = polygon.json(['load', '--no-inputs']);
		expect(skipped.run.status, text(skipped.run)).toBe(0);
		expect(inputsOf(skipped.envelope)).toEqual([]);
		expect(readFileSync(polygon.treePath('handbook/guide.md'), 'utf8')).toBe('# Guide\n\nThe first page.\n');

		const fresh = polygon.json(['load', '--fresh']);
		expect(fresh.run.status, text(fresh.run)).toBe(0);
		expect(inputsOf(fresh.envelope)[0]).toMatchObject({ mode: 'working', built: true, files: 3 });
		expect(readFileSync(polygon.treePath('handbook/guide.md'), 'utf8')).toContain('An edit nobody committed yet.');
		expect(repo.builds()).toBe(3);
	}, 300_000);
});

describe('inputs pin and the status of a pin', () => {
	it('refuses uncommitted content, moves the pin to HEAD, and status says when the pin is behind', () => {
		const polygon = makeCliFixture('inputs-pin');
		const repo = makeInputRepository('inputs-pin');
		const first = repo.head();
		declare(polygon, [repo.declaration()]);
		repo.write('pages/guide.md', '# Guide\n\nThe second edition.\n');

		const refused = polygon.json(['inputs', 'pin', 'pages']);
		expect(refused.run.status).toBe(2);
		expect(refused.envelope.errors[0]?.message).toContain('has 1 uncommitted change(s); a pin names committed content only');
		expect(refused.run.stdout + refused.run.stderr).toContain('uncommitted: pages/guide.md');
		expect(loadConfig(polygon.patchesDir)?.inputs?.[0]?.ref).toBe(first);

		const second = repo.commit('pages: the second edition');
		const behind = polygon.json(['status']);
		expect(inputsOf(behind.envelope)[0]?.['repositoryState']).toMatchObject({ pin: 'behind', behind: 1, head: second });
		expect(text(behind.run)).toContain(`the pin ${first.slice(0, 12)} is 1 commit(s) behind HEAD ${second.slice(0, 12)}`);

		const moved = polygon.json(['inputs', 'pin', 'pages']);
		expect(moved.run.status, text(moved.run)).toBe(0);
		expect(moved.envelope.data).toMatchObject({ changed: true, inputs: [{ name: 'pages', from: first, to: second, moved: true }] });
		expect(loadConfig(polygon.patchesDir)?.inputs?.[0]?.ref).toBe(second);
		const unchanged = polygon.json(['inputs', 'pin', '--all']);
		expect(unchanged.run.status).toBe(0);
		expect(unchanged.envelope.data).toMatchObject({ changed: false, inputs: [{ name: 'pages', moved: false }] });
		expect(inputsOf(polygon.json(['status']).envelope)[0]?.['repositoryState']).toMatchObject({ pin: 'at-head' });

		const usage = polygon.json(['inputs', 'pin']);
		expect(usage.run.status).toBe(2);
		expect(usage.envelope.errors[0]?.message).toContain('needs the names of inputs, or --all');
		expect(polygon.json(['inputs', 'pin', 'absent']).envelope.errors[0]?.message).toContain('declares no input named absent');
	}, 300_000);
});

describe('publish takes the inputs from their pinned commits', () => {
	it('adds one commit per input to the history, and the squashed release carries the input', async () => {
		const fixture = makeCliFixture('inputs-publish');
		const repo = makeInputRepository('inputs-publish');
		const pinned = repo.head();
		repo.write('pages/guide.md', '# Guide\n\nA working-tree edit the release must not carry.\n');
		declareAndCommit(fixture, repo.declaration(), 1);
		const remote = makeRemote(fixture, 'inputs-publish');
		configureRemote(fixture, remote);

		const history = await invoke(fixture, {});
		expect(history.exitCode, JSON.stringify(history.envelope.errors)).toBe(0);
		const sha = fixture.patchGit(['rev-parse', 'HEAD']).stdout.trim();
		const tip = remoteSha(remote, `refs/heads/codkit/release/${sha.slice(0, 12)}+${fixture.upstream.t1.tag}`);
		expect(tip).toMatch(/^[0-9a-f]{40}$/);
		if (tip === null) return;
		expect(remoteOut(remote, ['log', '-1', '--format=%B', tip])).toBe(
			[
				`codkit: input pages handbook`,
				'',
				`Codkit-Input: pages@${pinned}`,
				`Codkit-Patchset-Commit: ${sha}`,
				`Codkit-Upstream-Pin: t1@${fixture.upstream.t1.sha}`
			].join('\n')
		);
		expect(remoteOut(remote, ['show', `${tip}:handbook/guide.md`])).toBe('# Guide\n\nThe first page.');
		expect(remoteOut(remote, ['show', `${tip}:handbook/index.txt`])).toBe('pages: guide.md, topics\nhelper: carried in');
		expect(history.envelope.data).toMatchObject({ inputs: [{ name: 'pages', commit: pinned, to: 'handbook', files: 3 }] });

		const squashed = await invoke(fixture, { squash: true, scrub: true, branch: 'rc/with-pages' });
		expect(squashed.exitCode, JSON.stringify(squashed.envelope.errors)).toBe(0);
		const release = remoteSha(remote, 'refs/heads/rc/with-pages');
		expect(release).toMatch(/^[0-9a-f]{40}$/);
		if (release === null) return;
		expect(remoteOut(remote, ['rev-list', '--parents', '-n', '1', release])).toBe(`${release} ${fixture.upstream.t1.sha}`);
		expect(remoteOut(remote, ['ls-tree', '-r', '--name-only', release, '--', 'handbook']).split('\n')).toEqual([
			'handbook/guide.md',
			'handbook/index.txt',
			'handbook/topics/setup.md'
		]);
		expect(squashed.envelope.data).toMatchObject({ inputs: [{ name: 'pages', commit: pinned, files: 3 }], scrub: { leftovers: [] } });
	}, 600_000);

	it('refuses a ref the repository lacks, a failing build and a place the pin owns, before any remote write', async () => {
		const fixture = makeCliFixture('inputs-publish-refusals');
		const repo = makeInputRepository('inputs-publish-refusals');
		const remote = makeRemote(fixture, 'inputs-publish-refusals');
		configureRemote(fixture, remote);
		const cases: readonly (readonly [Partial<InputConfig>, string])[] = [
			[{ ref: 'f'.repeat(40) }, `input pages: ${'f'.repeat(40)} is not a commit of`],
			[{ env: { INPUT_BUILD_LOG: repo.buildLog, INPUT_BUILD_FAIL: '1' } }, 'input pages: build command 1 exited 3'],
			[{ to: 'README.md' }, 'input pages: to README.md meets paths the pin carries']
		];
		let day = 2;
		for (const [overrides, message] of cases) {
			declareAndCommit(fixture, repo.declaration(overrides), day);
			day += 1;
			const refused = await invoke(fixture, {});
			expect(refused.exitCode, message).toBe(2);
			expect(refused.envelope.errors.map((error) => error.message).join('\n'), message).toContain(message);
			expect(remoteOut(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/codkit/release/'])).toBe('');
		}
	}, 600_000);
});

function declareAndCommit(fixture: CliFixture, input: InputConfig, day: number): void {
	declare(fixture, [input]);
	fixtureCommit(fixture.patchesDir, `fixture: the input ${input.name}`, `2026-04-0${day}T00:00:00Z`);
}

type Invocation = { readonly exitCode: number; readonly envelope: Envelope };

async function invoke(fixture: CliFixture, flags: { squash?: boolean; scrub?: boolean; branch?: string }): Promise<Invocation> {
	const config = loadConfig(fixture.patchesDir);
	if (config === null) throw new Error('fixture config disappeared');
	const out = new Output({ command: 'publish', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
	const commandFlags = new Map<string, string | true>([['--yes-i-am-publish-bot', true]]);
	if (flags.branch !== undefined) commandFlags.set('--branch', flags.branch);
	if (flags.squash === true) {
		const message = join(makeTempRoot('inputs-publish-message'), 'message.txt');
		writeFileSync(message, 'Release with pages\n', 'utf8');
		commandFlags.set('--squash', true);
		commandFlags.set('--author', 'Release Bot <release@example.org>');
		commandFlags.set('--message-file', message);
	}
	if (flags.scrub === true) commandFlags.set('--scrub', true);
	const context: CommandContext = {
		toolRoot: fixture.patchesDir,
		locations: {
			patchesDir: { path: fixture.patchesDir, source: 'flag', exists: true, warning: null },
			forkDir: { path: fixture.treeDir, source: 'flag', exists: true, warning: null }
		},
		patchesDir: fixture.patchesDir,
		args: ['HEAD'],
		flags: { forkDir: fixture.treeDir, patchesDir: fixture.patchesDir, json: true, ci: false, verbose: false },
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

function configureRemote(fixture: CliFixture, remote: string): void {
	writeFileSync(join(fixture.patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
	writeFileSync(fixture.patchesPath('codkit.local.json'), `${JSON.stringify({ publishRemoteUrl: remote }, null, 2)}\n`, 'utf8');
}

function makeRemote(fixture: CliFixture, label: string): string {
	const remote = join(makeTempRoot(`${label}-remote`), 'publish.git');
	const result = runGit({ args: ['clone', '--bare', '--quiet', fixture.upstream.dir, remote], cwd: fixture.patchesDir, netAllowed: true });
	expect(result.status, result.stderr).toBe(0);
	return remote;
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
