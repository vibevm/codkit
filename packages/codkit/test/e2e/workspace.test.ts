// PROP-020 WORKSPACE-CLI: real launcher and isolated disposable Git pairs.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { z } from 'zod';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { runCli, withStubType } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { readWorkspaceRegistry, workspaceRecordSchema } from '../../src/lib/workspaceRegistry.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { DEPENDENCY_ROOTS } from '../fixtures/stubType.ts';
import { depsReceiptsOf } from '../../src/lib/ciEngine.ts';
import { dirname } from 'node:path';

afterAll(cleanupTempRoots);
// Whole-scenario budget for slow native hosts; keep the ordinary 60s default.
const cycleScenarioTimeoutMs = Number(process.env['CODKIT_WORKSPACE_CYCLE_TEST_TIMEOUT_MS'] ?? '60000');
if (!Number.isSafeInteger(cycleScenarioTimeoutMs) || cycleScenarioTimeoutMs < 60_000) {
	throw new Error('CODKIT_WORKSPACE_CYCLE_TEST_TIMEOUT_MS must be an integer of at least 60000');
}
function fixture() {
	const source = makeSyncFixture('workspace-cli-source');
	const home = makeTempRoot('workspace-cli-home');
	const directory = makeTempRoot('workspace-cli-pairs');
	// The isolated home has no developer Git identity. Cycle commits need the
	// same explicit fixture identity on every host and in every subprocess.
	const env = withStubType({
		HOME: home,
		USERPROFILE: home,
		GIT_AUTHOR_NAME: 'fixture',
		GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
		GIT_COMMITTER_NAME: 'fixture',
		GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
	});
	const run = (args: readonly string[]) => runCli(directory, ['--json', 'workspace', ...args], env);
	const create = () =>
		run([
			'create',
			'Task',
			'--patches-dir',
			source.patchesDir,
			'--fork-dir',
			source.treeDir,
			'--dir',
			directory,
			'--owner',
			'fixture-owner',
			'--session',
			'fixture-session'
		]);
	return { source, home, directory, env, run, create };
}
function workspace(stdout: string) {
	return z.object({ data: z.object({ workspace: workspaceRecordSchema }) }).parse(JSON.parse(stdout)).data.workspace;
}
it('creates, inspects, finishes and removes a pair through the shipped launcher', () => {
	const f = fixture();
	const created = f.create();
	expect(created.status, created.stderr).toBe(0);
	const record = workspace(created.stdout);
	expect(record.state).toBe('active');
	expect(f.run(['show', record.id]).status).toBe(0);
	expect(workspace(f.run(['show', 'task']).stdout)).toEqual(record);
	const listed = f.run(['list']);
	expect(JSON.parse(listed.stdout)).toMatchObject({ data: { codkitWorkspaceRegistry: 1, workspaces: [{ id: record.id }] } });
	expect(f.run(['remove', 'task']).status).toBe(2);
	const finished = f.run(['finish', 'task']);
	expect(finished.status, finished.stderr).toBe(0);
	expect(workspace(finished.stdout).state).toBe('finished');
	const removed = f.run(['remove', record.id]);
	expect(removed.status, removed.stderr).toBe(0);
	expect(workspace(removed.stdout).state).toBe('removed');
	expect(existsSync(record.patchset.path)).toBe(false);
	expect(existsSync(record.fork.path)).toBe(false);
	expect(f.run(['remove', 'task']).status).toBe(0);
});
it('inspects without ambient settings/config/adapter and refuses misleading external root flags', () => {
	const home = makeTempRoot('workspace-cli-empty');
	const cwd = makeTempRoot('workspace-cli-empty-cwd');
	const env = { HOME: home, USERPROFILE: home, CODKIT_PATCHES_DIR: 'invalid-ambient', CODKIT_FORK_DIR: 'invalid-ambient' };
	const empty = runCli(cwd, ['--json', 'workspace', 'list'], env);
	expect(empty.status, empty.stderr).toBe(0);
	expect(JSON.parse(empty.stdout)).toMatchObject({ data: { codkitWorkspaceRegistry: 1, revision: 0, workspaces: [] } });
	expect(existsSync(join(home, '.codkit'))).toBe(false);
	mkdirSync(join(home, '.codkit'));
	writeFileSync(join(home, '.codkit/settings.json'), '{ malformed settings');
	writeFileSync(join(cwd, 'codkit.json'), '{ malformed config');
	expect(runCli(cwd, ['workspace', 'list'], env).status).toBe(0);
	expect(runCli(cwd, ['workspace', 'list', '--patches-dir', cwd], env).status).toBe(2);
	expect(runCli(cwd, ['workspace', 'show'], env).status).toBe(2);
	expect(runCli(cwd, ['workspace', 'list', '--registry-dir', cwd], env).status).toBe(2);
});
it('preserves dirty work and refuses a changed saved type declaration before finish', () => {
	const f = fixture();
	const created = f.create();
	expect(created.status, created.stderr).toBe(0);
	const record = workspace(created.stdout);
	const registry = join(f.home, '.codkit/workspaces.json');
	const original = readFileSync(registry);
	writeFileSync(
		registry,
		JSON.stringify({
			...readWorkspaceRegistry(join(f.home, '.codkit')),
			workspaces: [{ ...record, type: { ...record.type, manifestSha256: '0'.repeat(64) } }]
		})
	);
	const foreign = f.run(['finish', 'task']);
	expect(foreign.status).toBe(2);
	expect(foreign.stderr).toContain('no adapter has been imported');
	expect(f.run(['show', 'task']).status).toBe(0);
	writeFileSync(registry, original);
	writeFileSync(join(record.patchset.path, 'human-work.txt'), 'preserve work');
	expect(f.run(['finish', 'task']).status).toBe(1);
	expect(f.run(['remove', 'task']).status).toBe(2);
	expect(readFileSync(join(record.patchset.path, 'human-work.txt'), 'utf8')).toBe('preserve work');
});
it('rejects incomplete create arguments before registry or Git changes and a registry inside the source', () => {
	const f = fixture();
	expect(f.run(['create', 'task', '--patches-dir', f.source.patchesDir, '--fork-dir', f.source.treeDir, '--dir', f.directory]).status).toBe(
		2
	);
	expect(existsSync(join(f.home, '.codkit'))).toBe(false);
	const invalidRef = f.run([
		'create',
		'task',
		'--patches-dir',
		f.source.patchesDir,
		'--fork-dir',
		f.source.treeDir,
		'--dir',
		f.directory,
		'--owner',
		'fixture',
		'--session',
		'session',
		'--ref',
		'refs/heads/absent'
	]);
	expect(invalidRef.status).toBe(2);
	expect(readWorkspaceRegistry(join(f.home, '.codkit')).workspaces).toEqual([]);
	const inside = runCli(
		f.directory,
		[
			'workspace',
			'create',
			'task',
			'--patches-dir',
			f.source.patchesDir,
			'--fork-dir',
			f.source.treeDir,
			'--dir',
			f.directory,
			'--owner',
			'fixture',
			'--session',
			'session'
		],
		withStubType({ HOME: f.source.patchesDir, USERPROFILE: f.source.patchesDir })
	);
	expect(inside.status).toBe(2);
	expect(inside.stderr).toContain('registry must be disjoint');
	expect(readWorkspaceRegistry(join(f.source.patchesDir, '.codkit')).workspaces).toEqual([]);
});

it('selects named roots through where without consulting ambient settings and refuses root conflicts', () => {
	const f = fixture();
	const created = f.create();
	expect(created.status, created.stderr).toBe(0);
	const record = workspace(created.stdout);
	writeFileSync(join(f.home, '.codkit/settings.json'), '{ invalid ambient settings');
	const env = { ...f.env, CODKIT_PATCHES_DIR: 'wrong-root', CODKIT_FORK_DIR: 'wrong-root' };
	const selected = runCli(f.directory, ['--json', '--workspace=task', 'where'], env);
	expect(selected.status, selected.stderr).toBe(0);
	expect(JSON.parse(selected.stdout)).toMatchObject({
		codkit: { schema: 2, type: 'stub' },
		roots: { patches: { path: record.patchset.path, source: 'flag' }, fork: { path: record.fork.path, source: 'flag' } },
		data: { workspace: { id: record.id, name: 'Task' } }
	});
	expect(runCli(f.directory, ['--workspace', 'task', 'where', '--fork-dir', record.fork.path], env).status).toBe(2);
	expect(runCli(f.directory, ['--workspace', 'task', 'workspace', 'list'], env).status).toBe(2);
	expect(runCli(f.directory, ['where', '--workspace'], env).status).toBe(2);
});

it('loads into UUID refs without rewriting config, protects neighbouring work and preserves its receipt on fresh load', () => {
	const f = fixture();
	const created = f.create();
	expect(created.status, created.stderr).toBe(0);
	const record = workspace(created.stdout);
	const config = readFileSync(join(record.patchset.path, 'codkit.json'));
	const receipt = readFileSync(join(record.fork.path, '.codkit/workspace.json'));
	const run = (...args: string[]) => runCli(f.directory, ['--workspace', 'task', ...args], f.env);
	const loaded = run('load');
	expect(loaded.status, loaded.stderr + loaded.stdout).toBe(0);
	const branch = runGit({ cwd: record.fork.path, args: ['symbolic-ref', '--short', 'HEAD'] });
	expect(branch.stdout.trim()).toBe(`codkit/workspace/${record.id}/applied/${record.pin.tag}`);
	expect(run('load').status).toBe(0);
	const work = join(record.fork.path, '.codkit/human-work.txt');
	writeFileSync(work, 'preserve human work');
	expect(run('load').status).toBe(1);
	expect(readFileSync(work, 'utf8')).toBe('preserve human work');
	unlinkSync(work);
	const fresh = run('load', '--fresh');
	expect(fresh.status, fresh.stderr + fresh.stdout).toBe(0);
	expect(readFileSync(join(record.fork.path, '.codkit/workspace.json'))).toEqual(receipt);
	expect(readFileSync(join(record.patchset.path, 'codkit.json'))).toEqual(config);
	expect(readFileSync(join(f.source.patchesDir, 'codkit.json'))).toEqual(config);
	const finished = f.run(['finish', 'task']);
	expect(finished.status, finished.stderr).toBe(0);
	expect(workspace(finished.stdout).finished?.deltaFingerprint).toMatch(/^[0-9a-f]{64}$/);
	expect(run('where').status).toBe(2);
	const removed = f.run(['remove', 'task']);
	expect(removed.status, removed.stderr).toBe(0);
	expect(existsSync(record.fork.path)).toBe(false);
});

it('binds a real daemon to its workspace and refuses a copied record in another pair before teardown', () => {
	const f = fixture();
	const created = f.create();
	expect(created.status, created.stderr).toBe(0);
	const first = workspace(created.stdout);
	const other = f.run([
		'create',
		'Other',
		'--patches-dir',
		f.source.patchesDir,
		'--fork-dir',
		f.source.treeDir,
		'--dir',
		f.directory,
		'--owner',
		'fixture-owner',
		'--session',
		'other-session'
	]);
	expect(other.status, other.stderr).toBe(0);
	const second = workspace(other.stdout);
	const run = (name: string, ...args: string[]) =>
		runCli(f.directory, ['--json', '--workspace', name, ...args], { ...f.env, STUB_MODE: 'ok' });
	try {
		const started = run('task', 'build', 'up', '--channel', 'transpile');
		expect(started.status, started.stderr).toBe(0);
		const source = join(first.patchset.path, '.codkit/build/transpile.json');
		const bytes = readFileSync(source);
		expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ codkitBuildDaemon: 2, workspaceId: first.id, treePath: first.fork.path });
		const own = run('task', 'build', 'status', '--channel', 'transpile');
		expect(JSON.parse(own.stdout)).toMatchObject({ data: { channels: [{ state: 'living' }] } });
		expect(f.run(['finish', 'task']).status).toBe(2);
		const target = join(second.patchset.path, '.codkit/build/transpile.json');
		mkdirSync(join(second.patchset.path, '.codkit/build'), { recursive: true });
		writeFileSync(target, bytes);
		const foreign = run('other', 'build', 'status', '--channel', 'transpile');
		expect(JSON.parse(foreign.stdout)).toMatchObject({ data: { channels: [{ state: 'unknown', treeMatches: false }] } });
		expect(run('other', 'build', 'down', '--channel', 'transpile').status).toBe(2);
		expect(readFileSync(target)).toEqual(bytes);
		expect(JSON.parse(run('task', 'build', 'status', '--channel', 'transpile').stdout)).toMatchObject({
			data: { channels: [{ state: 'living' }] }
		});
	} finally {
		const stopped = run('task', 'build', 'down', '--channel', 'transpile');
		expect(stopped.status, stopped.stderr).toBe(0);
		const finished = f.run(['finish', 'task']);
		expect(finished.status, finished.stderr).toBe(0);
		const removed = f.run(['remove', 'task']);
		expect(removed.status, removed.stderr).toBe(0);
	}
});

it('publishes a named workspace snapshot into its UUID release namespace without moving caller or source checkouts', () => {
	const f = fixture();
	writeFileSync(join(f.source.patchesDir, 'NAMED-PUBLISH.txt'), 'isolated named publish fixture');
	fixtureCommit(f.source.patchesDir, 'named publish polygon', '2026-10-04T00:00:00Z');
	const created = f.create();
	expect(created.status, created.stderr).toBe(0);
	const record = workspace(created.stdout);
	const head = (root: string) => runGit({ cwd: root, args: ['rev-parse', 'HEAD'] }).stdout.trim();
	const before = [head(record.patchset.path), head(record.fork.path), head(f.source.patchesDir), head(f.source.treeDir)];
	const target = join(makeTempRoot('named-workspace-export'), 'release');
	const published = runCli(
		f.directory,
		['--json', '--workspace', 'task', 'publish', 'HEAD', '--yes-i-am-publish-bot', '--export-repo', target],
		f.env
	);
	expect(published.status, published.stderr + published.stdout).toBe(0);
	expect(JSON.parse(published.stdout)).toMatchObject({
		data: { branch: expect.stringContaining(`codkit/workspace/${record.id}/release/`) }
	});
	expect([head(record.patchset.path), head(record.fork.path), head(f.source.patchesDir), head(f.source.treeDir)]).toEqual(before);
	expect(runGit({ cwd: target, args: ['branch', '--show-current'] }).stdout).toContain(`codkit/workspace/${record.id}/release/`);
	const finished = f.run(['finish', 'task']);
	expect(finished.status, finished.stderr + finished.stdout).toBe(0);
	const removed = f.run(['remove', 'task']);
	expect(removed.status, removed.stderr + removed.stdout).toBe(0);
});

it('starts, inspects and restarts a named cycle using only workspace UUID refs', () => {
	const f = fixture();
	const created = f.create();
	expect(created.status, created.stderr).toBe(0);
	const record = workspace(created.stdout);
	for (const path of depsReceiptsOf(DEPENDENCY_ROOTS)) {
		const full = join(record.fork.path, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, '{"lockfileVersion":3}\n');
	}
	const run = (...args: string[]) =>
		runCli(f.directory, ['--json', '--workspace', 'task', ...args], { ...f.env, STUB_MODE: 'ok', STUB_HYGIENE_MODE: 'fail' });
	const started = run('cycle', 'start', f.source.upstream.t2.tag, '--ci');
	expect(started.status, started.stderr + started.stdout).toBe(3);
	expect(runGit({ cwd: record.patchset.path, args: ['branch', '--show-current'] }).stdout).toContain(
		`codkit/workspace/${record.id}/cycle/`
	);
	const status = run('cycle', 'status');
	expect(status.status, status.stderr).toBe(0);
	const restarted = run('cycle', 'restart', '--yes');
	expect(restarted.status, restarted.stderr + restarted.stdout).toBe(0);
	expect(run('cycle', 'status').status).toBe(0);
	const original = readFileSync(join(f.source.patchesDir, 'codkit.json'), 'utf8');
	expect(original).not.toContain(`codkit/workspace/${record.id}/`);
});

it(
	'continues a stopped named cycle through completion with workspace-bound build cleanup',
	() => {
		const f = fixture();
		const created = f.create();
		expect(created.status, created.stderr).toBe(0);
		const record = workspace(created.stdout);
		for (const path of depsReceiptsOf(DEPENDENCY_ROOTS)) {
			const full = join(record.fork.path, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, '{"lockfileVersion":3}\n');
		}
		const run = (args: readonly string[], extra: Readonly<Record<string, string>> = {}) =>
			runCli(f.directory, ['--json', '--workspace', 'task', ...args], { ...f.env, STUB_MODE: 'ok', ...extra });
		const started = run(['cycle', 'start', f.source.upstream.t2.tag, '--ci'], { STUB_HYGIENE_MODE: 'fail' });
		expect(started.status, started.stderr + started.stdout).toBe(3);
		const resumed = run(['cycle', 'continue', '--ci']);
		expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
		expect(JSON.parse(resumed.stdout)).toMatchObject({ data: { status: 'completed', phase: 'done' } });
		expect(run(['cycle', 'status']).status).toBe(0);
		expect(readFileSync(join(f.source.patchesDir, 'codkit.json'), 'utf8')).not.toContain(`codkit/workspace/${record.id}/`);
		const stale = f.run(['finish', 'task']);
		expect(stale.status).toBe(2);
		expect(stale.stderr).toContain('save/apply evidence is stale');
		const reloaded = run(['load', '--fresh']);
		expect(reloaded.status, reloaded.stderr + reloaded.stdout).toBe(0);
		const finished = f.run(['finish', 'task']);
		expect(finished.status, finished.stderr + finished.stdout).toBe(0);
		const removed = f.run(['remove', 'task']);
		expect(removed.status, removed.stderr + removed.stdout).toBe(0);
	},
	cycleScenarioTimeoutMs
);
