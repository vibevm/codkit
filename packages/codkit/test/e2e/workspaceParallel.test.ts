// SOURCE-PLAN Phase3 gate: two real task pairs load/build/save independently.
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { z } from 'zod';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { runCli, withStubType } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { workspaceRecordSchema } from '../../src/lib/workspaceRegistry.ts';
import { runGit } from '../../src/lib/gitx.ts';

afterAll(cleanupTempRoots);
const resultSchema = z.object({ status: z.number(), stdout: z.string(), stderr: z.string() });
const runnerUrl = new URL('../support/cliFixture.ts', import.meta.url).href;
const runner = `
const { runCli } = await import(process.argv[1]);
process.stdout.write(JSON.stringify(runCli(process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4]))));
`;

// Reuse the existing runner's launcher, test condition and ambient-root isolation.
// Separate wrappers let its synchronous CLI children execute concurrently.
function parallelCli(cwd: string, args: readonly string[], env: Readonly<Record<string, string>>) {
	return new Promise<z.infer<typeof resultSchema>>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			['--input-type=module', '-e', runner, runnerUrl, cwd, JSON.stringify(args), JSON.stringify(env)],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true
			}
		);
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			stderr += chunk;
		});
		child.once('error', reject);
		child.once('close', (code) => {
			if (code !== 0) {
				reject(new Error(`parallel CLI wrapper exited ${code}: ${stderr}`));
				return;
			}
			try {
				resolve(resultSchema.parse(JSON.parse(stdout)));
			} catch (error) {
				reject(error);
			}
		});
	});
}

it('loads, builds and saves two named pairs concurrently without crossing task custody', async () => {
	const source = makeSyncFixture('workspace-parallel-source');
	const home = makeTempRoot('workspace-parallel-home');
	const directory = makeTempRoot('workspace-parallel-pairs');
	const env = withStubType({ HOME: home, USERPROFILE: home, STUB_MODE: 'ok' });
	const records = ['First', 'Second'].map((name) => {
		const created = runCli(
			directory,
			[
				'--json',
				'workspace',
				'create',
				name,
				'--patches-dir',
				source.patchesDir,
				'--fork-dir',
				source.treeDir,
				'--dir',
				directory,
				'--owner',
				'fixture-owner',
				'--session',
				name
			],
			env
		);
		expect(created.status, created.stderr + created.stdout).toBe(0);
		return z.object({ data: z.object({ workspace: workspaceRecordSchema }) }).parse(JSON.parse(created.stdout)).data.workspace;
	});
	const run = (name: string, ...args: string[]) => runCli(directory, ['--json', '--workspace', name, ...args], env);
	const both = async (...args: string[]) => {
		const results = await Promise.all(
			records.map((record) => parallelCli(directory, ['--json', '--workspace', record.name, ...args], env))
		);
		for (const result of results) expect(result.status, result.stderr + result.stdout).toBe(0);
	};
	const original = readFileSync(join(source.patchesDir, 'delta/own/hello.ts'));
	try {
		await both('load');
		await both('build', 'up', '--channel', 'transpile');
		const daemons = records.map((record) =>
			z
				.object({ pid: z.number(), workspaceId: z.string(), treePath: z.string() })
				.parse(JSON.parse(readFileSync(join(record.patchset.path, '.codkit/build/transpile.json'), 'utf8')))
		);
		expect(new Set(daemons.map((record) => record.pid)).size).toBe(2);
		for (const [index, record] of records.entries()) {
			expect(daemons[index]).toMatchObject({ workspaceId: record.id, treePath: record.fork.path });
			expect(JSON.parse(run(record.name, 'build', 'status', '--channel', 'transpile').stdout)).toMatchObject({
				data: { channels: [{ state: 'living' }] }
			});
			writeFileSync(
				join(record.fork.path, 'source/own/hello.ts'),
				Buffer.concat([original, Buffer.from(`\nexport const task${index} = ${index};\n`)])
			);
		}
		await both('save');
		for (const [index, record] of records.entries()) {
			const own = readFileSync(join(record.patchset.path, 'delta/own/hello.ts'), 'utf8');
			expect(own).toContain(`task${index}`);
			expect(own).not.toContain(`task${1 - index}`);
		}
		expect(readFileSync(join(source.patchesDir, 'delta/own/hello.ts'))).toEqual(original);
		const first = records[0];
		const second = records[1];
		if (first === undefined || second === undefined) throw new Error('parallel fixture requires two pairs');
		const human = join(first.fork.path, '.codkit/human-work.txt');
		writeFileSync(human, 'preserve unowned workspace data');
		const foreign = run(first.name, 'save');
		expect(foreign.status).toBe(1);
		expect(JSON.parse(foreign.stdout)).toMatchObject({
			errors: [{ code: 'CK-E-NEW-FILE-IN-UPSTREAM-ZONE', file: '.codkit/human-work.txt' }]
		});
		expect(readFileSync(human, 'utf8')).toBe('preserve unowned workspace data');
		unlinkSync(human);
		runGit({ cwd: first.fork.path, args: ['add', '-f', '.codkit/workspace.json'] });
		const staged = run(first.name, 'save');
		expect(staged.status).toBe(1);
		expect(JSON.parse(staged.stdout)).toMatchObject({
			errors: [{ code: 'CK-E-NEW-FILE-IN-UPSTREAM-ZONE', file: '.codkit/workspace.json' }]
		});
		runGit({ cwd: first.fork.path, args: ['reset', '--quiet', 'HEAD', '--', '.codkit/workspace.json'] });
		expect(run(first.name, 'build', 'down', '--channel', 'transpile').status).toBe(0);
		expect(JSON.parse(run(second.name, 'build', 'status', '--channel', 'transpile').stdout)).toMatchObject({
			data: { channels: [{ state: 'living' }] }
		});
	} finally {
		for (const record of records) {
			const stopped = run(record.name, 'build', 'down', '--channel', 'transpile');
			expect(stopped.status, stopped.stderr + stopped.stdout).toBe(0);
		}
	}
});
