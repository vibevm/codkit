/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW */
// e2e: `codkit preview` through the real launcher (PROP-007 sec. 29
// ##CMD-PREVIEW, ##CMD-PREVIEW-HOST, ##CMD-PREVIEW-ISOLATION,
// ##CMD-PREVIEW-RECORD; FEAT-002 S88, S89).
//
// The host of the suite is a fake: an executable that writes its argv and its
// working directory to a file and exits. So the suite proves what the host was
// started with - the development path of the tree, the two isolation
// directories under the state directory, the artifact of a mode that needs one -
// from the host's side, and the record, the materialization and the restore from
// codkit's.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_DEFAULT_HOST, PREVIEW_INSTALLED_FILE, PREVIEW_PREPARED_MARKER } from '../fixtures/stubType.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { FAKE_HOST_OUT, makeFakeHost, readFakeHostReport } from '../support/fakeHost.ts';
import type { FakeHost } from '../support/fakeHost.ts';
import { makeGenericFixture } from '../support/genericFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

type Step = { name: string; state: string; detail: string };
type PreviewData = {
	mode: string;
	host: string | null;
	stateDir: string;
	workspace: string | null;
	artifact: string | null;
	steps: Step[];
	materialized: string[];
	restored: string[];
	launch: { command: string; args: string[] } | null;
	record: { pid: number; startedAt: string; path: string } | null;
};
type PreviewRecord = {
	codkitPreview: number;
	mode: string;
	host: string;
	pid: number;
	startedAt: string;
	treeId: string;
	workspace: string | null;
	artifact: string | null;
	launch: { command: string; args: string[] };
};

let fixture: CliFixture;
let host: FakeHost;
let reportsDir: string;
let reports = 0;

function data(envelope: { data: Record<string, unknown> }): PreviewData {
	return envelope.data as unknown as PreviewData;
}

/** A file of its own for every host the suite starts, so a late host never reports into another test. */
function nextReport(): string {
	reports += 1;
	return join(reportsDir, `host-${reports}.json`);
}

function stateDir(mode = 'development'): string {
	return fixture.patchesPath(`.codkit/preview/${mode}`);
}

/** The bytes the pin carries for the overlay target: what a dev tree has. */
function manifestAtPin(): string {
	return fixture.git(['show', `${fixture.upstream.t1.sha}:manifest.json`]).stdout;
}

function manifestInTree(): string {
	return readFileSync(fixture.treePath('manifest.json'), 'utf8');
}

/** The value after a flag of the host's argv. */
function valueOf(args: readonly string[], flag: string): string {
	const at = args.indexOf(flag);
	expect(at, `${flag} in ${args.join(' ')}`).toBeGreaterThanOrEqual(0);
	return args[at + 1] ?? '';
}

/** The variables the suite keeps out of a run: an operator's own host, and the report of a previous one. */
function quiet(extra: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
	return { CODKIT_PREVIEW_HOST: '', ...extra };
}

beforeAll(() => {
	fixture = makeCliFixture('preview');
	host = makeFakeHost('preview');
	reportsDir = makeTempRoot('preview-reports');
	const loaded = fixture.run(['load']);
	expect(loaded.status, loaded.stderr).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

// A run without `--wait` leaves the materialization in the tree on purpose;
// every scenario starts from a dev tree, so that one failure cannot cascade.
beforeEach(() => {
	if (manifestInTree() !== manifestAtPin()) {
		expect(fixture.run(['load', '--fresh']).status).toBe(0);
	}
});

describe('codkit preview', () => {
	it('launches the host detached over the materialized tree, in the isolated profile of the mode, and leaves the record', async () => {
		const report = nextReport();
		const { run, envelope } = fixture.json(['preview', '--no-build', '--host', host.executable], quiet({ [FAKE_HOST_OUT]: report }));

		expect(run.status, run.stderr).toBe(0);
		expect(envelope.errors).toEqual([]);
		const result = data(envelope);
		expect(result.steps.map((step) => step.name)).toEqual([
			'drift guard',
			'host',
			'overlay apply',
			'recipe',
			'artifact',
			'prepare',
			'launch'
		]);
		expect(result.steps.map((step) => step.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'skipped', 'skipped', 'ok']);
		expect(result.mode).toBe('development');
		expect(result.host).toBe(host.executable);
		expect(result.stateDir).toBe(stateDir());
		expect(result.workspace).toBeNull();
		expect(result.artifact).toBeNull();
		expect(result.materialized).toEqual(['manifest.json']);
		expect(result.restored).toEqual([]);
		expect(result.launch?.command).toBe(host.executable);
		expect(run.stderr).toContain('preview plan: drift guard -> host -> overlay apply -> recipe -> artifact -> prepare -> launch');
		expect(run.stderr).toContain(`preview state: ${stateDir()}`);

		// The record (##CMD-PREVIEW-RECORD).
		const recordPath = join(stateDir(), 'record.json');
		expect(result.record?.path).toBe(recordPath);
		const record = JSON.parse(readFileSync(recordPath, 'utf8')) as PreviewRecord;
		expect(record.codkitPreview).toBe(1);
		expect(record.mode).toBe('development');
		expect(record.host).toBe(host.executable);
		expect(record.pid).toBe(result.record?.pid);
		expect(record.pid).toBeGreaterThan(0);
		expect(record.treeId).toMatch(/^[0-9a-f]+$/u);
		expect(record.workspace).toBeNull();
		expect(record.artifact).toBeNull();
		expect(record.launch).toEqual(result.launch);
		expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);

		// What the host was started with (S88): the development path of the tree,
		// both isolation directories under the state directory, the tree as cwd.
		const seen = await readFakeHostReport(report);
		const args = seen.argv.slice(2);
		expect(args).toEqual(result.launch?.args);
		expect(valueOf(args, '--dev-path')).toBe(fixture.treeDir);
		expect(valueOf(args, '--user-data-dir').startsWith(`${stateDir()}`)).toBe(true);
		expect(valueOf(args, '--extensions-dir').startsWith(`${stateDir()}`)).toBe(true);
		expect(seen.cwd).toBe(fixture.treeDir);
		expect(seen.mode).toBe('development');

		// The materialization stays while the host runs: `status` names it as
		// the known materialization, and `load --fresh` is the way back.
		expect(manifestInTree()).not.toBe(manifestAtPin());
		const status = fixture.json(['status']);
		const upstream = status.envelope.data['upstream'] as { materializedOverlayTargets: string[] };
		expect(upstream.materializedOverlayTargets).toEqual(['manifest.json']);
		expect(status.run.stderr).toContain('manifest.json carries the exact overlay materialization codkit itself writes');
		expect(fixture.run(['load', '--fresh']).status).toBe(0);
		expect(manifestInTree()).toBe(manifestAtPin());
	}, 90_000);

	it('blocks under --wait until the host exits, then puts the overlay targets back; --workspace-dir reaches the host', async () => {
		const report = nextReport();
		const workspace = makeTempRoot('preview-workspace');
		const { run, envelope } = fixture.json(
			['preview', '--no-build', '--wait', '--host', host.executable, '--workspace-dir', workspace],
			quiet({ [FAKE_HOST_OUT]: report })
		);

		expect(run.status, run.stderr).toBe(0);
		const result = data(envelope);
		expect(result.steps.map((step) => step.name)).toEqual([
			'drift guard',
			'host',
			'overlay apply',
			'recipe',
			'artifact',
			'prepare',
			'launch',
			'restore'
		]);
		expect(result.restored).toEqual(['manifest.json']);
		expect(result.workspace).toBe(workspace);
		// The command returned after the host had exited: its report is there already.
		expect(existsSync(report)).toBe(true);
		const seen = await readFakeHostReport(report);
		expect(seen.argv.slice(2)).toContain(workspace);
		expect(run.stderr).toContain('the host exited with code 0');
		expect(run.stderr).toContain('preview restore: ok (manifest.json)');
		expect(manifestInTree()).toBe(manifestAtPin());
		expect(existsSync(fixture.treePath('manifest.overrides.json'))).toBe(true);
		expect(fixture.run(['status']).status).toBe(0);
	}, 90_000);

	it('recreates the state directory empty under --clean, before the launch', () => {
		const stale = join(stateDir(), 'user-data', 'stale.txt');
		mkdirSync(dirname(stale), { recursive: true });
		writeFileSync(stale, 'stale\n', 'utf8');
		const { run } = fixture.json(
			['preview', '--no-build', '--wait', '--clean', '--host', host.executable],
			quiet({ [FAKE_HOST_OUT]: nextReport() })
		);

		expect(run.status, run.stderr).toBe(0);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(join(stateDir(), 'record.json'))).toBe(true);
		expect(run.stderr).toContain('wiped first');
	}, 90_000);

	it('resolves a bare host name through CODKIT_PREVIEW_HOST and PATH, with the suffixes of the platform', () => {
		const pathVariable = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
		const { run, envelope } = fixture.json(['preview', '--no-build', '--wait'], {
			[FAKE_HOST_OUT]: nextReport(),
			CODKIT_PREVIEW_HOST: host.name,
			[pathVariable]: `${host.directory}${delimiter}${process.env[pathVariable] ?? ''}`
		});

		expect(run.status, run.stderr).toBe(0);
		expect(data(envelope).host).toBe(host.executable);
		expect(run.stderr).toContain('(CODKIT_PREVIEW_HOST)');
	}, 90_000);

	it('runs the preparation commands of the recipe in the tree, and reports a red one as CK-E-PACKAGE-FAILED without spawning', () => {
		rmSync(fixture.treePath(PREVIEW_PREPARED_MARKER), { force: true });
		const prepared = fixture.json(['preview', '--wait', '--host', host.executable], quiet({ [FAKE_HOST_OUT]: nextReport() }));

		expect(prepared.run.status, prepared.run.stderr).toBe(0);
		expect(data(prepared.envelope).steps.find((step) => step.name === 'prepare')?.state).toBe('ok');
		expect(readFileSync(fixture.treePath(PREVIEW_PREPARED_MARKER), 'utf8')).toBe('prepared\n');
		expect(prepared.run.stderr).toContain('[prepare] prepare: fixture preparation finished');

		const report = nextReport();
		const failed = fixture.json(
			['preview', '--host', host.executable],
			quiet({ [FAKE_HOST_OUT]: report, CODKIT_TEST_PREVIEW_PREPARE_FAIL: '1' })
		);

		expect(failed.run.status).toBe(1);
		expect(failed.envelope.errors.map((error) => error.code)).toEqual(['CK-E-PACKAGE-FAILED']);
		expect(failed.envelope.errors[0]?.message).toContain('prepare: exited 3');
		expect(failed.envelope.errors[0]?.message).toContain('fixture preparation failed');
		expect(existsSync(report)).toBe(false);
		const result = data(failed.envelope);
		expect(result.steps.find((step) => step.name === 'prepare')?.state).toBe('failed');
		expect(result.launch).toBeNull();
		expect(result.record).toBeNull();
		// A refusal before the launch leaves the tree as it was found.
		expect(result.restored).toEqual(['manifest.json']);
		expect(manifestInTree()).toBe(manifestAtPin());
		expect(fixture.run(['status']).status).toBe(0);
	}, 90_000);

	it('builds the distributable for a mode that needs it and hands the newest artifact to the recipe', async () => {
		rmSync(fixture.treePath('.build/package'), { recursive: true, force: true });
		rmSync(fixture.treePath('.build/app-1.tar'), { force: true });
		const atTip = readFileSync(fixture.treePath('package.json'), 'utf8');
		const report = nextReport();
		const { run, envelope } = fixture.json(
			['preview', '--mode', 'artifact', '--wait', '--host', host.executable],
			quiet({ [FAKE_HOST_OUT]: report })
		);

		expect(run.status, run.stderr).toBe(0);
		const result = data(envelope);
		expect(result.mode).toBe('artifact');
		expect(result.stateDir).toBe(stateDir('artifact'));
		expect(result.artifact).toBe(fixture.treePath('.build/app-1.tar'));
		expect(result.steps.find((step) => step.name === 'artifact')?.state).toBe('ok');
		// Both halves of the package build ran over the materialized target, with
		// the stamps of the type; the fixture packager exits 1 otherwise.
		expect(run.stderr).toContain('build: fixture packaging finished');
		expect(run.stderr).toContain('distributable: fixture packaging finished');
		expect(run.stderr).toContain(`build: BUILD_QUALITY=${fixture.upstream.t1.tag}`);

		const seen = await readFakeHostReport(report);
		expect(valueOf(seen.argv.slice(2), '--artifact')).toBe(result.artifact);
		expect(seen.mode).toBe('artifact');
		const installed = JSON.parse(readFileSync(join(stateDir('artifact'), 'extensions', PREVIEW_INSTALLED_FILE), 'utf8')) as {
			artifact: string;
		};
		expect(installed.artifact).toBe(result.artifact);

		// The residue of the packager is put back, and `--wait` restored the overlay.
		expect(readFileSync(fixture.treePath('package.json'), 'utf8')).toBe(atTip);
		expect(result.restored).toEqual(['manifest.json']);
		expect(manifestInTree()).toBe(manifestAtPin());
		expect(fixture.run(['status']).status).toBe(0);
	}, 120_000);

	it('refuses a recipe whose isolation directory leaves the state directory, before anything is spawned', () => {
		const report = nextReport();
		const { run, envelope } = fixture.json(
			['preview', '--no-build', '--host', host.executable],
			quiet({ [FAKE_HOST_OUT]: report, CODKIT_TEST_PREVIEW_BREAK_ISOLATION: '1' })
		);

		expect(run.status).toBe(2);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-PREVIEW-ISOLATION']);
		expect(envelope.errors[0]?.message).toContain('does not lie under the state directory');
		expect(envelope.errors[0]?.hint).toContain('nothing was spawned');
		expect(existsSync(report)).toBe(false);
		const result = data(envelope);
		expect(result.steps.find((step) => step.name === 'recipe')?.state).toBe('failed');
		expect(result.steps.map((step) => step.name)).not.toContain('launch');
		expect(result.launch).toBeNull();
		expect(result.record).toBeNull();
		expect(result.restored).toEqual(['manifest.json']);
		expect(manifestInTree()).toBe(manifestAtPin());
	}, 60_000);

	it('refuses when no host is found, naming what was tried (S89)', () => {
		const absent = fixture.json(['preview', '--no-build'], quiet());

		expect(absent.run.status).toBe(2);
		expect(absent.envelope.errors.map((error) => error.code)).toEqual(['CK-E-PREVIEW-HOST']);
		expect(absent.envelope.errors[0]?.message).toContain(`${PREVIEW_DEFAULT_HOST} on PATH`);
		expect(absent.envelope.errors[0]?.hint).toContain('--host');
		const result = data(absent.envelope);
		expect(result.host).toBeNull();
		expect(result.materialized).toEqual([]);
		expect(result.steps.map((step) => step.name)).toEqual(['drift guard', 'host']);
		expect(manifestInTree()).toBe(manifestAtPin());

		const missing = join(host.directory, 'no-such-host.cmd');
		const named = fixture.json(['preview', '--no-build', '--host', missing], quiet());
		expect(named.run.status).toBe(2);
		expect(named.envelope.errors[0]?.code).toBe('CK-E-PREVIEW-HOST');
		expect(named.envelope.errors[0]?.message).toContain(`--host: ${missing}`);
	}, 60_000);

	it('refuses an unknown mode and a workspace directory that does not exist, before any write', () => {
		const mode = fixture.json(['preview', '--no-build', '--mode', 'nowhere', '--host', host.executable], quiet());
		expect(mode.run.status).toBe(2);
		expect(mode.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(mode.envelope.errors[0]?.message).toContain('nowhere');
		expect(mode.envelope.errors[0]?.message).toContain('development, artifact');

		const workspace = fixture.json(
			['preview', '--no-build', '--host', host.executable, '--workspace-dir', join(host.directory, 'absent')],
			quiet()
		);
		expect(workspace.run.status).toBe(2);
		expect(workspace.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(workspace.envelope.errors[0]?.message).toContain('--workspace-dir names no directory');
		expect(manifestInTree()).toBe(manifestAtPin());
	}, 60_000);

	it('refuses over a fork tree that carries unextracted work, before it materializes anything', () => {
		const target = fixture.treePath('source/base/common/util.ts');
		const before = readFileSync(target, 'utf8');
		writeFileSync(target, `${before}// an edit nobody extracted\n`, 'utf8');
		try {
			const { run, envelope } = fixture.json(['preview', '--no-build', '--host', host.executable], quiet());

			expect(run.status).toBe(1);
			expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
			expect(data(envelope).materialized).toEqual([]);
			expect(manifestInTree()).toBe(manifestAtPin());
		} finally {
			writeFileSync(target, before, 'utf8');
		}
	}, 60_000);
});

describe('what a type without the capability refuses (S89)', () => {
	it('refuses with CK-E-TYPE-CAPABILITY naming the type and the capability, and writes nothing', () => {
		const generic = makeGenericFixture('preview-generic');
		const { run, envelope } = generic.json(['preview']);

		expect(run.status, run.stderr).toBe(2);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-TYPE-CAPABILITY']);
		expect(envelope.errors[0]?.message).toContain('generic');
		expect(envelope.errors[0]?.message).toContain('preview');
		expect(envelope.errors[0]?.hint).toContain('nothing was written');
		expect(existsSync(generic.patchesPath('.codkit/preview'))).toBe(false);
	}, 60_000);
});
