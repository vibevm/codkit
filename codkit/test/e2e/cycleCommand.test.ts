// e2e: the four `codkit cycle` subcommands through the real launcher.
// Contract: PROP-007 sec. 14; resumable phase engine: PROP-009 sec. 4.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { STATUS_PART_PATH, STATUSBAR_PART_PATH } from '../fixtures/makeUpstream.ts';
import { PATCH_FILE_NAME } from '../fixtures/makePatchSet.ts';
import { readCycleApplyRecord } from '../../src/lib/cycleEngineRecord.ts';
import { readCycleTerminalRecord } from '../../src/lib/cycleEngineTerminal.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { regeneratePatch } from '../../src/lib/patchGenerate.ts';
import { encodePatchName } from '../../src/lib/patchFormat.ts';
import { makeCliFixture, provideTreeDependencies, runCli } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

describe('codkit cycle command grammar', () => {
	it('advertises the complete subcommand roster', () => {
		const run = runCli(makeTempRoot('cycle-help'), []);

		expect(run.status).toBe(0);
		expect(run.stdout).toContain('cycle');
		for (const word of ['start <tag-or-sha>', 'continue', 'status', 'restart --yes']) {
			expect(run.stdout).toContain(word);
		}
		for (const surface of ['forecast', 'rebase-onto-pin', 'publish']) {
			expect(run.stdout).toContain(surface);
		}
	});

	it('rejects missing/extra arguments and confines --yes to restart', () => {
		const root = makeTempRoot('cycle-usage');
		for (const args of [
			['cycle'],
			['cycle', 'start'],
			['cycle', 'continue', 'extra'],
			['cycle', 'status', '--yes'],
			['cycle', 'restart', 'extra', '--yes']
		]) {
			const run = runCli(root, ['--patches-dir', root, ...args]);
			expect(run.status, `${args.join(' ')}\n${run.stderr}`).toBe(2);
			expect(run.stderr).toContain('usage:');
		}
	});
});

describe('codkit cycle status', () => {
	it('reports an absent cycle with the resolved fork-tree source', () => {
		const fixture = makeCliFixture('cycle-status-absent');
		const { run, envelope } = fixture.json(['cycle', 'status']);

		expect(run.status).toBe(0);
		expect(envelope.roots.fork).toMatchObject({ path: fixture.treeDir, source: 'flag' });
		expect(envelope.data['status']).toBe('absent');
		expect(envelope.data['phase']).toBeNull();
		expect(envelope.data['counts']).toBeTypeOf('object');
		expect(envelope.data['nextAction']).toContain('cycle start');
		expect(envelope.data['commits']).toEqual([]);
		expect(envelope.data['red']).toEqual([]);
	});
});

describe('codkit cycle start and restart', () => {
	it('uses a custom branch prefix, reports a full red stop, and requires --yes to restart', () => {
		const fixture = makeCliFixture('cycle-restart');
		excludeRuntimeState(fixture.patchesDir);
		setCycleBranchPrefix(fixture.patchesDir, 'fixture/upgrade/');
		provideTreeDependencies(fixture);

		const started = fixture.json(['cycle', 'start', fixture.upstream.t2.tag, '--ci'], {
			STUB_MODE: 'ok',
			STUB_HYGIENE_MODE: 'fail'
		});
		expect(started.run.status, started.run.stderr).toBe(3);
		expect(started.envelope.roots.fork).toMatchObject({ path: fixture.treeDir, source: 'flag' });
		expect(started.envelope.data['status']).toBe('stopped');
		expect(started.envelope.data['phase']).toBe('resolve');
		expect(started.envelope.data['counts']).toBeTypeOf('object');
		expect(started.envelope.data['nextAction']).toBeTypeOf('string');
		expect((started.envelope.data['commits'] as unknown[]).length).toBeGreaterThan(0);
		expect((started.envelope.data['red'] as unknown[]).length).toBeGreaterThan(0);
		expect(fixture.patchGit(['branch', '--show-current']).stdout.trim()).toBe(`fixture/upgrade/${fixture.upstream.t2.tag}`);

		const status = fixture.json(['cycle', 'status']);
		expect(status.run.status).toBe(0);
		expect(status.envelope.data['status']).toBe('active');
		expect(status.envelope.data['phase']).toBe('resolve');

		const unconfirmed = fixture.json(['cycle', 'restart']);
		expect(unconfirmed.run.status).toBe(2);
		expect(unconfirmed.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(unconfirmed.envelope.errors[0]?.hint).toContain('--yes');

		const restarted = fixture.json(['cycle', 'restart', '--yes']);
		expect(restarted.run.status, restarted.run.stderr).toBe(0);
		expect(restarted.envelope.data['status']).toBe('restarted');
		expect(restarted.envelope.data['removedState']).toBe(true);
		expect(fixture.json(['cycle', 'status']).envelope.data['status']).toBe('absent');
	});
});

describe('codkit cycle continue', () => {
	it('resumes a red stabilization stop and completes when the checks turn green', () => {
		const fixture = makeCliFixture('cycle-continue');
		excludeRuntimeState(fixture.patchesDir);
		provideTreeDependencies(fixture);
		const stopped = fixture.run(['cycle', 'start', fixture.upstream.t2.tag, '--ci'], {
			STUB_MODE: 'ok',
			STUB_HYGIENE_MODE: 'fail'
		});
		expect(stopped.status, stopped.stderr).toBe(3);

		const resumed = fixture.json(['cycle', 'continue', '--ci'], { STUB_MODE: 'ok' });
		expect(resumed.run.status, resumed.run.stderr).toBe(0);
		expect(resumed.envelope.data['status']).toBe('completed');
		expect(resumed.envelope.data['phase']).toBe('done');
		expect(resumed.envelope.data['red']).toEqual([]);
		expect((resumed.envelope.data['commits'] as unknown[]).length).toBeGreaterThan(0);
		const status = fixture.json(['cycle', 'status']);
		expect(status.envelope.data['status']).toBe('completed');
		expect(status.envelope.data['phase']).toBe('done');
		expect(status.envelope.data['commit']).toMatch(/^[0-9a-f]{40}$/);
		expect(status.envelope.data['checklist']).toHaveLength(4);
	}, 15_000);

	it('uses the persisted R<100 preview as the second unchanged continue acknowledgement', () => {
		const fixture = makeCliFixture('cycle-rename-review');
		excludeRuntimeState(fixture.patchesDir);
		provideTreeDependencies(fixture);
		addRenamePatch(fixture);
		const referencePath = 'delta/own/test/rename-path.test.ts';
		const materializedReference = fixture.treePath('src/vs/patchset/test/rename-path.test.ts');
		const synced = fixture.json(['sync']);
		expect(synced.run.status, synced.run.stderr).toBe(0);
		expect(readFileSync(materializedReference, 'utf8')).toContain(STATUS_PART_PATH);
		const first = fixture.json(['cycle', 'start', fixture.upstream.t2.tag, '--ci']);
		expect(first.run.status, first.run.stderr).toBe(3);
		expect(first.envelope.data['stop']).toBe('rename-review');
		const token = readCycleApplyRecord(fixture.patchesDir)?.reviewToken;
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(readFileSync(materializedReference, 'utf8')).toContain(STATUS_PART_PATH);

		const second = fixture.json(['cycle', 'continue', '--ci']);
		expect(second.run.status, `${second.run.stderr}\n${JSON.stringify(second.envelope.data)}`).toBe(0);
		expect(second.envelope.data['status']).toBe('completed');
		expect(readFileSync(fixture.patchesPath(`delta/patches/${encodePatchName(STATUSBAR_PART_PATH)}`), 'utf8')).toContain(
			'statusbarPart.ts'
		);
		const reference = readFileSync(fixture.patchesPath(referencePath), 'utf8');
		expect(reference).not.toContain(STATUS_PART_PATH);
		expect(reference).toContain(STATUSBAR_PART_PATH);
		expect(readFileSync(materializedReference, 'utf8')).toBe(reference);
		const renameCommit = fixture.patchGit(['log', '--format=%H', '--grep=follow upstream renames', '--max-count=1']).stdout.trim();
		expect(renameCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(fixture.patchGit(['show', `${renameCommit}:${referencePath}`]).stdout).toContain(STATUSBAR_PART_PATH);
	}, 20_000);

	it.each([
		['accepted rename path', 'src/vs/patchset/test/rename-path.test.ts'],
		['unrelated own path', 'src/vs/patchset/hello.ts']
	] as const)(
		'does not overwrite a tampered %s while delivering rename-owned bytes',
		(_label, treePath) => {
			const fixture = makeCliFixture(`cycle-rename-own-tamper-${treePath.endsWith('hello.ts') ? 'unrelated' : 'accepted'}`);
			excludeRuntimeState(fixture.patchesDir);
			provideTreeDependencies(fixture);
			addRenamePatch(fixture);
			const synced = fixture.json(['sync']);
			expect(synced.run.status, synced.run.stderr).toBe(0);
			const target = fixture.treePath(treePath);
			const before = readFileSync(target, 'utf8');
			const first = fixture.json(['cycle', 'start', fixture.upstream.t2.tag, '--ci']);
			expect(first.run.status, first.run.stderr).toBe(3);
			expect(first.envelope.data['stop']).toBe('rename-review');
			writeFileSync(target, 'tampered own bytes\n', 'utf8');

			const blocked = fixture.json(['cycle', 'continue', '--ci']);
			expect(blocked.run.status, blocked.run.stderr).toBe(1);
			expect(blocked.envelope.errors[0]?.code).toBe('CK-E-DIRTY-TREE');
			expect(readFileSync(target, 'utf8')).toBe('tampered own bytes\n');

			writeFileSync(target, before, 'utf8');
			const resumed = fixture.json(['cycle', 'continue', '--ci']);
			expect(resumed.run.status, resumed.run.stderr).toBe(0);
			expect(resumed.envelope.data['status']).toBe('completed');
		},
		30_000
	);

	it('accepts a completed receipt after a no-ff merge and clears it before the next target', () => {
		const fixture = makeCliFixture('cycle-historical-terminal');
		excludeRuntimeState(fixture.patchesDir);
		provideTreeDependencies(fixture);
		const completed = fixture.json(['cycle', 'start', fixture.upstream.t2.tag, '--ci']);
		expect(completed.run.status, completed.run.stderr).toBe(0);
		const cycleBranch = `codkit/cycle/${fixture.upstream.t2.tag}`;
		expect(fixture.patchGit(['switch', '--quiet', 'main']).status).toBe(0);
		const unrelated = fixture.json(['cycle', 'status']);
		expect(unrelated.run.status).toBe(1);
		expect(unrelated.envelope.errors[0]?.code).toBe('CK-E-ARTIFACT-BROKEN');
		fixtureGit(fixture.patchesDir, ['merge', '--quiet', '--no-ff', cycleBranch, '-m', 'fixture: merge completed cycle'], {
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.test',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.test'
		});
		const merged = fixture.json(['cycle', 'status']);
		expect(merged.run.status, merged.run.stderr).toBe(0);
		expect(merged.envelope.data['status']).toBe('completed');

		const humanLog = fixture.patchesPath(`cycle/log/${fixture.upstream.t2.tag}.md`);
		const exactLog = readFileSync(humanLog, 'utf8');
		writeFileSync(humanLog, `${exactLog}tampered\n`, 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: alter final output', '2026-02-07T00:00:00Z');
		expect(fixture.json(['cycle', 'status']).run.status).toBe(1);
		writeFileSync(humanLog, exactLog, 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: restore final output', '2026-02-07T00:01:00Z');

		writeFileSync(join(fixture.upstream.dir, 'historical-t3.txt'), 't3\n', 'utf8');
		fixtureCommit(fixture.upstream.dir, 'fixture: historical t3', '2026-02-08T00:00:00Z');
		fixtureGit(fixture.upstream.dir, ['tag', 't3']);
		const fetched = runGit({ args: ['fetch', '--quiet', '--tags', 'origin'], cwd: fixture.treeDir, netAllowed: true });
		if (fetched.status !== 0) throw new Error(fetched.stderr);
		const next = fixture.json(['cycle', 'start', 't3', '--ci'], { STUB_HYGIENE_MODE: 'fail' });
		expect(next.run.status, next.run.stderr).toBe(3);
		expect(readCycleTerminalRecord(fixture.patchesDir)).toBeNull();
		expect(readCycleApplyRecord(fixture.patchesDir)?.targetPin.tag).toBe('t3');
	}, 30_000);

	it('invalidates the rename acknowledgement when the preview bytes change', () => {
		const fixture = makeCliFixture('cycle-rename-review-changed');
		excludeRuntimeState(fixture.patchesDir);
		provideTreeDependencies(fixture);
		const artifact = addRenamePatch(fixture);
		expect(fixture.json(['cycle', 'start', fixture.upstream.t2.tag, '--ci']).run.status).toBe(3);
		const firstToken = readCycleApplyRecord(fixture.patchesDir)?.reviewToken;
		writeFileSync(artifact, readFileSync(artifact, 'utf8').replace('review token fixture', 'changed review token fixture'), 'utf8');

		const changed = fixture.json(['cycle', 'continue', '--ci']);
		expect(changed.run.status, changed.run.stderr).toBe(3);
		expect(changed.envelope.data['stop']).toBe('rename-review');
		expect(readCycleApplyRecord(fixture.patchesDir)?.reviewToken).not.toBe(firstToken);
	}, 15_000);

	it('keeps resource rename review stopped until the map is actually edited', () => {
		const fixture = makeCliFixture('cycle-resource-review');
		excludeRuntimeState(fixture.patchesDir);
		provideTreeDependencies(fixture);
		const mapPath = addRenamedResource(fixture);
		const first = fixture.json(['cycle', 'start', fixture.upstream.t2.tag, '--ci']);
		expect(first.run.status, first.run.stderr).toBe(3);
		expect(first.envelope.data['stop']).toBe('resource-rename-review');
		const unchanged = fixture.json(['cycle', 'continue', '--ci']);
		expect(unchanged.run.status, unchanged.run.stderr).toBe(3);
		expect(unchanged.envelope.data['stop']).toBe('resource-rename-review');

		const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { entries: Array<{ id: string; target: string }> };
		const entry = map.entries.find((candidate) => candidate.id === 'CK-workbench-906');
		if (entry === undefined) throw new Error('resource fixture entry missing');
		entry.target = STATUSBAR_PART_PATH;
		writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
		const resumed = fixture.json(['cycle', 'continue', '--ci']);
		expect(resumed.run.status, resumed.run.stderr).toBe(0);
		expect(resumed.envelope.data['status']).toBe('completed');
	}, 20_000);
});

describe('codkit cycle exit classes', () => {
	it('uses exit 1 for a malformed committed cycle artifact', () => {
		const fixture = makeCliFixture('cycle-malformed-artifact');
		excludeRuntimeState(fixture.patchesDir);
		const patch = fixture.patchesPath(`delta/patches/${PATCH_FILE_NAME}`);
		writeFileSync(patch, readFileSync(patch, 'utf8').replace('# id: CK-workbench-901', '# id: malformed'), 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: malformed committed patch', '2026-02-04T00:00:00Z');
		const { run, envelope } = fixture.json(['cycle', 'start', fixture.upstream.t2.tag]);
		expect(run.status, run.stderr).toBe(1);
		expect(envelope.errors[0]?.code).toBe('CK-E-ARTIFACT-BROKEN');
	});

	it('uses exit 1 when committed cycle state is malformed during status', () => {
		const fixture = makeCliFixture('cycle-malformed-state');
		mkdirSync(fixture.patchesPath('cycle'), { recursive: true });
		writeFileSync(fixture.patchesPath('cycle/state.json'), '{"codkitCycleState":2}\n', 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: malformed committed cycle state', '2026-02-05T00:00:00Z');
		const { run, envelope } = fixture.json(['cycle', 'status']);
		expect(run.status, run.stderr).toBe(1);
		expect(envelope.errors[0]?.file).toBe('cycle/state.json');
	});

	it('does not call missing state a completed cycle without a terminal receipt', () => {
		const fixture = makeCliFixture('cycle-missing-receipt');
		const { run, envelope } = fixture.json(['cycle', 'continue']);
		expect(run.status).not.toBe(0);
		expect(envelope.data['status']).not.toBe('completed');
		expect(envelope.errors[0]?.code).toBe('CK-E-CONFIG');
	});

	it('uses exit 1 for a dirty patchset checkout', () => {
		const fixture = makeCliFixture('cycle-dirty');
		excludeRuntimeState(fixture.patchesDir);
		writeFileSync(fixture.patchesPath('uncommitted.txt'), 'dirty\n', 'utf8');

		const { run, envelope } = fixture.json(['cycle', 'start', fixture.upstream.t2.tag]);
		expect(run.status).toBe(1);
		expect(envelope.errors[0]?.code).toBe('CK-E-DIRTY-TREE');
	});

	it('uses exit 2 when the target commit is unreachable', () => {
		const fixture = makeCliFixture('cycle-unreachable');
		excludeRuntimeState(fixture.patchesDir);
		const { run, envelope } = fixture.json(['cycle', 'start', '0000000000000000000000000000000000000000']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-PIN-UNREACHABLE');
	});
});

function setCycleBranchPrefix(patchesDir: string, prefix: string): void {
	const path = `${patchesDir}/codkit.json`;
	const document = JSON.parse(readFileSync(path, 'utf8')) as { cycleBranchPrefix: string };
	document.cycleBranchPrefix = prefix;
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
	fixtureCommit(patchesDir, 'fixture: custom cycle branch prefix', '2026-02-01T00:00:00Z');
}

function excludeRuntimeState(patchesDir: string): void {
	// The generated fixture intentionally has no tracked .gitignore. Real patchset
	// repositories exclude codkit runtime state, so reproduce that repository-
	// private fact without adding a fixture-only tracked file.
	writeFileSync(join(patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
}

function addRenamePatch(fixture: ReturnType<typeof makeCliFixture>): string {
	const source = fixture.git(['show', `${fixture.upstream.t1.sha}:${STATUS_PART_PATH}`]);
	if (source.status !== 0) throw new Error(source.stderr);
	const header = [
		'# codkit-patch: 2',
		'# id: CK-workbench-905',
		'# type: hook',
		'# category: follow',
		'# owner: workbench-core',
		'# reason: review token fixture',
		'# link: none',
		'# cause: none',
		`# pin: ${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
		'# contract-tests: none',
		''
	].join('\n');
	const generated = regeneratePatch({
		targetPath: STATUS_PART_PATH,
		pinBytes: Buffer.from(source.stdout),
		pinExists: true,
		curBytes: Buffer.from(`${source.stdout}// codkit:begin CK-workbench-905\n// codkit status hook\n// codkit:end CK-workbench-905\n`),
		header,
		existingBytes: null,
		tmpDir: makeTempRoot('cycle-rename-patch')
	});
	if (generated.unchanged) throw new Error('rename patch generation produced no bytes');
	const artifact = fixture.patchesPath(`delta/patches/${encodePatchName(STATUS_PART_PATH)}`);
	writeFileSync(artifact, generated.bytes);
	writeFileSync(
		fixture.patchesPath('delta/own/test/rename-path.test.ts'),
		`const guardedUpstreamPath = '${STATUS_PART_PATH}';\nvoid guardedUpstreamPath;\n`,
		'utf8'
	);
	fixtureCommit(fixture.patchesDir, 'fixture: add rename review patch', '2026-02-02T00:00:00Z');
	return artifact;
}

function addRenamedResource(fixture: ReturnType<typeof makeCliFixture>): string {
	const mapPath = fixture.patchesPath('delta/resources/map.json');
	const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { entries: unknown[] };
	map.entries.push({
		id: 'CK-workbench-906',
		target: STATUS_PART_PATH,
		source: 'delta/resources/files/status-part.txt',
		type: 'modify',
		category: 'own',
		owner: 'workbench-core',
		reason: 'fixture resource follows an upstream rename',
		link: 'none',
		cause: 'none',
		pin: `${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
		contractTests: ['fixture.guard.icon']
	});
	writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
	writeFileSync(fixture.patchesPath('delta/resources/files/status-part.txt'), 'fixture resource override\n', 'utf8');
	fixtureCommit(fixture.patchesDir, 'fixture: add renamed resource', '2026-02-03T00:00:00Z');
	return mapPath;
}
