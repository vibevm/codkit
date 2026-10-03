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

afterAll(cleanupTempRoots);
function fixture() {
	const source = makeSyncFixture('workspace-cli-source');
	const home = makeTempRoot('workspace-cli-home');
	const directory = makeTempRoot('workspace-cli-pairs');
	const env = withStubType({ HOME: home, USERPROFILE: home });
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
});
