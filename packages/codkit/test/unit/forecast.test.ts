/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Library and thin-command coverage for the unregistered forecast surface.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { forecastCommand } from '../../src/commands/forecast.ts';
import type { CommandContext, GlobalFlags } from '../../src/lib/command.ts';
import { EXIT_ENVIRONMENT } from '../../src/lib/command.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { DEFAULT_FORECAST_REF, forecastUpgrade } from '../../src/lib/forecast.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import type { Envelope } from '../../src/lib/jsonOut.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { encodePatchName, formatPatchHeader } from '../../src/lib/patchFormat.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const SHIFTED = 'src/shifted.ts';
const CONFLICT = 'src/conflict.ts';
const RESOURCE = 'resources/icon.bin';

type Fixture = { readonly root: string; readonly tree: string; readonly t1: string; readonly t2: string; readonly config: CodkitConfig };

function makeFixture(label: string): Fixture {
	const tree = makeTempRoot(`${label}-tree`);
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	write(tree, SHIFTED, 'a\nbase\nz\n');
	write(tree, CONFLICT, 'a\nbase\nz\n');
	write(tree, RESOURCE, 'upstream resource\n');
	const t1 = fixtureCommit(tree, 'fixture: forecast current pin', '2026-08-01T00:00:00Z');
	fixtureGit(tree, ['tag', 't1']);
	write(tree, SHIFTED, 'a\nbase\nz\nupstream-tail\n');
	write(tree, CONFLICT, 'a\nupstream\nz\n');
	rmSync(join(tree, RESOURCE));
	const t2 = fixtureCommit(tree, 'fixture: forecast future pin', '2026-08-02T00:00:00Z');
	fixtureGit(tree, ['tag', 't2']);

	const root = makeTempRoot(`${label}-patchset`);
	fixtureGit(root, ['init', '--quiet', '--initial-branch=ordinary-main', '.']);
	const conventions = join(root, 'codkit/config/conventions.json');
	mkdirSync(dirname(conventions), { recursive: true });
	copyFileSync(fileURLToPath(new URL('../../config/conventions.json', import.meta.url)), conventions);
	writePatch(root, SHIFTED, 'CK-workbench-901', 'alpha-owner', t1);
	writePatch(root, CONFLICT, 'CK-editor-901', 'beta-owner', t1);
	write(root, 'delta/resources/files/icon.bin', 'patchset resource\n');
	writeJson(root, 'delta/resources/map.json', {
		codkitResourceMap: 2,
		entries: [
			{
				id: 'CK-product-901',
				target: RESOURCE,
				source: 'delta/resources/files/icon.bin',
				type: 'modify',
				category: 'own',
				owner: 'alpha-owner',
				reason: 'forecast resource fixture',
				link: 'none',
				cause: 'none',
				pin: `t1@${t1}`,
				contractTests: ['fixture.resource']
			}
		]
	});
	fixtureCommit(root, 'fixture: forecast delta', '2026-08-03T00:00:00Z');

	const config: CodkitConfig = {
		codkitConfig: 1,
		pin: { tag: 't1', sha: t1, date: commitDate(tree, t1) },
		upstreamAnchorCommit: t1,
		ownDirName: 'patchset',
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	};
	return { root, tree, t1, t2, config };
}

function writePatch(root: string, target: string, id: string, owner: string, pin: string): void {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner,
		reason: 'forecast patch fixture',
		link: 'none',
		cause: 'none',
		pin: `t1@${pin}`,
		contractTests: []
	});
	const body = [`--- a/${target}`, `+++ b/${target}`, '@@ -1,3 +1,3 @@', ' a', '-base', '+codkit', ' z'].join('\n');
	write(root, `delta/patches/${encodePatchName(target)}`, `${header}${body}\n`);
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function writeJson(root: string, path: string, value: unknown): void {
	write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function commitDate(tree: string, sha: string): string {
	return fixtureGit(tree, ['show', '-s', '--format=%cs', sha]).stdout.trim();
}

type CommandRun = { readonly exitCode: number; readonly envelope: Envelope; readonly stdout: string; readonly stderr: string };

async function runCommand(fixture: Fixture, options: { readonly ref?: string; readonly ci?: boolean } = {}): Promise<CommandRun> {
	let stdout = '';
	let stderr = '';
	const out = new Output({
		command: 'forecast',
		version: 'test',
		jsonMode: true,
		streams: {
			writeOut(chunk) {
				stdout += chunk;
			},
			writeErr(chunk) {
				stderr += chunk;
			}
		}
	});
	const flags: GlobalFlags = { forkDir: null, patchesDir: null, json: true, ci: options.ci ?? false, verbose: false };
	const commandFlags = new Map<string, string>(options.ref === undefined ? [] : [['--ref', options.ref]]);
	const ctx: CommandContext = {
		toolRoot: fixture.root,
		locations: {
			patchesDir: { path: fixture.root, source: 'flag', exists: true, warning: null },
			forkDir: { path: fixture.tree, source: 'flag', exists: true, warning: null }
		},
		patchesDir: fixture.root,
		args: [],
		flags,
		commandFlags,
		env: {},
		config: fixture.config,
		out
	};
	let exitCode: number;
	try {
		exitCode = await forecastCommand.run(ctx);
	} catch (error) {
		if (isCkError(error)) out.addError(error.toPayload());
		else out.addError({ code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) });
		exitCode = EXIT_ENVIRONMENT;
	}
	out.finish(exitCode);
	return { exitCode, envelope: out.buildEnvelope(exitCode), stdout, stderr };
}

function orphanCommit(fixture: Fixture): string {
	const treeId = fixtureGit(fixture.tree, ['rev-parse', `${fixture.t1}^{tree}`]).stdout.trim();
	return fixtureGit(fixture.tree, ['commit-tree', treeId, '-m', 'fixture: unrelated root'], {
		GIT_AUTHOR_NAME: 'fixture',
		GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
		GIT_AUTHOR_DATE: '2026-08-04T00:00:00Z',
		GIT_COMMITTER_NAME: 'fixture',
		GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
		GIT_COMMITTER_DATE: '2026-08-04T00:00:00Z'
	}).stdout.trim();
}

afterAll(() => cleanupTempRoots());

describe('forecast surface', () => {
	it('resolves an explicit ref and returns a deterministic owner-grouped red report', () => {
		const fixture = makeFixture('forecast-explicit');
		const result = forecastUpgrade({ patchesDir: fixture.root, treeDir: fixture.tree, config: fixture.config, ref: 't2' });

		expect(result.exitCode).toBe(1);
		expect(result.report.ref).toEqual({ input: 't2', sha: fixture.t2, usedDefault: false });
		expect(result.report.counts).toEqual({
			total: 3,
			nonClean: 3,
			byOutcome: {
				clean: 0,
				shifted: 1,
				merged: 0,
				conflict: 1,
				'target-deleted': 1,
				'target-renamed': 0,
				'rule-broken': 0,
				'contract-failed': 0
			}
		});
		expect(result.report.owners.map((group) => [group.owner, group.artifacts.map((artifact) => artifact.outcome)])).toEqual([
			['alpha-owner', ['shifted', 'target-deleted']],
			['beta-owner', ['conflict']]
		]);
		for (const artifact of result.report.owners.flatMap((group) => group.artifacts)) {
			expect(artifact).toMatchObject({ cause: { sha: fixture.t2, approx: false } });
			expect(Object.keys(artifact).sort()).toEqual(['artifact', 'cause', 'id', 'layer', 'outcome', 'target']);
		}
	});

	it('returns green at the current pin and uses the exact local default ref when omitted', async () => {
		const fixture = makeFixture('forecast-default');
		const current = forecastUpgrade({ patchesDir: fixture.root, treeDir: fixture.tree, config: fixture.config, ref: fixture.t1 });
		expect(current).toMatchObject({ exitCode: 0, report: { counts: { total: 3, nonClean: 0 }, owners: [] } });

		fixtureGit(fixture.tree, ['update-ref', DEFAULT_FORECAST_REF, fixture.t2]);
		const run = await runCommand(fixture);
		expect(run.exitCode).toBe(1);
		expect(run.envelope.data).toMatchObject({ ref: { input: DEFAULT_FORECAST_REF, sha: fixture.t2, usedDefault: true } });
	});

	it('declares --ref and makes global CI require it explicitly', async () => {
		const fixture = makeFixture('forecast-ci');
		const run = await runCommand(fixture, { ci: true });

		expect(forecastCommand.commandFlags).toEqual(['--ref']);
		expect(run.exitCode).toBe(2);
		expect(run.envelope.errors[0]).toMatchObject({ code: 'CK-E-CONFIG', message: expect.stringContaining('requires an explicit --ref') });
	});

	it('maps unreachable and non-ancestor refs to exit 2 without fetching', async () => {
		const fixture = makeFixture('forecast-ref-errors');
		const missing = await runCommand(fixture, { ref: 'not-present-anywhere' });
		const unrelated = await runCommand(fixture, { ref: orphanCommit(fixture) });

		expect(missing.exitCode).toBe(2);
		expect(missing.envelope.errors[0]?.code).toBe('CK-E-PIN-UNREACHABLE');
		expect(unrelated.exitCode).toBe(2);
		expect(unrelated.envelope.errors[0]).toMatchObject({
			code: 'CK-E-PIN-UNREACHABLE',
			message: expect.stringContaining('not a descendant')
		});
	});

	it('leaves both repositories byte-for-byte unchanged', async () => {
		const fixture = makeFixture('forecast-immutable');
		write(fixture.root, 'dirty-sentinel.txt', 'patchset dirty\n');
		write(fixture.tree, 'tree-sentinel.txt', 'tree dirty\n');
		const before = {
			rootHead: runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.root }).stdout,
			rootRefs: runGit({ args: ['show-ref'], cwd: fixture.root }).stdout,
			rootStatus: runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.root }).stdout,
			rootIndex: readFileSync(join(fixture.root, '.git/index')),
			treeHead: runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.tree }).stdout,
			treeRefs: runGit({ args: ['show-ref'], cwd: fixture.tree }).stdout,
			treeStatus: runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.tree }).stdout,
			treeIndex: readFileSync(join(fixture.tree, '.git/index')),
			rootSentinel: readFileSync(join(fixture.root, 'dirty-sentinel.txt')),
			treeSentinel: readFileSync(join(fixture.tree, 'tree-sentinel.txt'))
		};

		const run = await runCommand(fixture, { ref: 't2' });

		expect(run.exitCode).toBe(1);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.root }).stdout).toBe(before.rootHead);
		expect(runGit({ args: ['show-ref'], cwd: fixture.root }).stdout).toBe(before.rootRefs);
		expect(runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.root }).stdout).toBe(before.rootStatus);
		expect(readFileSync(join(fixture.root, '.git/index'))).toEqual(before.rootIndex);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.tree }).stdout).toBe(before.treeHead);
		expect(runGit({ args: ['show-ref'], cwd: fixture.tree }).stdout).toBe(before.treeRefs);
		expect(runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.tree }).stdout).toBe(before.treeStatus);
		expect(readFileSync(join(fixture.tree, '.git/index'))).toEqual(before.treeIndex);
		expect(readFileSync(join(fixture.root, 'dirty-sentinel.txt'))).toEqual(before.rootSentinel);
		expect(readFileSync(join(fixture.tree, 'tree-sentinel.txt'))).toEqual(before.treeSentinel);
		for (const path of ['cycle/state.json', 'cycle/log', '.codkit', 'out']) expect(existsSync(join(fixture.root, path))).toBe(false);
		for (const path of ['.codkit', 'out']) expect(existsSync(join(fixture.tree, path))).toBe(false);
	});
});
