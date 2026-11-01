// e2e: codkit ci (PROP-007 sec. 17, PROP-011).
//
// The real CLI over the fixture triple, with the fork tree standing in for a
// mounted one: `ci` brings it to the pin from scratch, materializes the overlay
// targets into the generated branch and runs every check, all without a network
// call - gitx refuses those by construction, so the air gap needs no simulation
// here beyond never allowing one.
//
// The build profile runs the same stub watchers the build tests use, so a
// "compilation pass" costs milliseconds and its outcome is chosen by STUB_MODE.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { STUB_CHANNELS_TYPE_MODULE } from '../fixtures/stubTypeChannels.ts';
import { STUB_TYPE_ID } from '../fixtures/stubType.ts';
import { makeCliFixture, provideTreeDependencies } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const OVERLAY_ARTIFACT = 'delta/overlays/manifest.json.overlay.json';

/** The step list of the verify profile, in the order PROP-011 sec. 3 fixes. */
const VERIFY_STEPS = ['fork tree', 'safe.directory', 'check-tree', 'fresh apply', 'verify', 'pin guard', 'effective diff'];

/** Generous, and never the 600s default: the stub finishes a pass in 200 ms. */
const TIMEOUT = ['--timeout', '20'];

const CHANNEL_NAMES = ['transpile', 'typecheck', 'addons', 'extras'] as const;

/** A commit identity for the fixture repository; gitx isolates the machine's. */
const IDENTITY: GitEnv = {
	GIT_AUTHOR_NAME: 'fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_AUTHOR_DATE: '2026-01-03T00:00:00Z',
	GIT_COMMITTER_NAME: 'fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_DATE: '2026-01-03T00:00:00Z'
};

type Step = { name: string; state: string; detail: string };

function steps(envelope: { data: Record<string, unknown> }): Step[] {
	return (envelope.data as { steps: Step[] }).steps;
}

function stepOf(envelope: { data: Record<string, unknown> }, name: string): Step | undefined {
	return steps(envelope).find((entry) => entry.name === name);
}

function stateOf(envelope: { data: Record<string, unknown> }, name: string): string {
	const step = stepOf(envelope, name);
	if (step === undefined) {
		throw new Error(`no step named ${name}`);
	}
	return step.state;
}

afterAll(() => {
	cleanupTempRoots();
});

describe('codkit ci --profile verify', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('ci-verify');
	});

	it('runs every step in order and leaves the overlay target materialized on the branch', () => {
		const { run, envelope } = fixture.json(['ci']);

		expect(run.status).toBe(0);
		expect(envelope.errors).toEqual([]);
		expect(steps(envelope).map((step) => step.name)).toEqual(VERIFY_STEPS);
		expect(stateOf(envelope, 'check-tree')).toBe('ok');
		expect(stateOf(envelope, 'fresh apply')).toBe('ok');
		expect(stateOf(envelope, 'verify')).toBe('ok');
		// Both guards state that they did not run rather than passing silently.
		expect(stateOf(envelope, 'pin guard')).toBe('skipped');
		expect(stateOf(envelope, 'effective diff')).toBe('skipped');
		// The human output numbers the steps as they run.
		expect(run.stderr).toContain('step 1/7 fork tree');
		expect(run.stderr).toContain('step 5/7 verify');

		// Channel 2 of the config-overlay layer: the target is on the branch, in
		// the tab serialization, and the work tree agrees with it.
		const onHead = fixture.git(['show', 'HEAD:manifest.json']).stdout;
		expect(onHead.startsWith('{\n\t"displayName": "Fixture PatchSet"')).toBe(true);
		expect(JSON.parse(onHead)['patchsetUpstreamPin']).toBe('t1');
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
	});

	it('is repeatable: a second run over the same tree is another green run', () => {
		const { run, envelope } = fixture.json(['ci']);

		expect(run.status).toBe(0);
		expect(stateOf(envelope, 'fresh apply')).toBe('ok');
	});

	it('refuses a profile it does not have', () => {
		const { run, envelope } = fixture.json(['ci', '--profile', 'everything']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(envelope.errors[0]?.hint).toContain('verify, build');
	});

	it('refuses a tree that carries work nobody extracted: ci trees are disposable', () => {
		const path = fixture.treePath('source/base/common/util.ts');
		const original = readFileSync(path, 'utf8');
		writeFileSync(path, `${original}\n// edited in the ci tree by hand\n`, 'utf8');
		try {
			const { run, envelope } = fixture.json(['ci']);

			expect(run.status).toBe(1);
			expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
			expect(envelope.errors[0]?.hint).toContain('ci trees must be disposable');
			expect(stateOf(envelope, 'fresh apply')).toBe('failed');
			// It stopped there: verify never ran.
			expect(steps(envelope).map((step) => step.name)).toEqual(VERIFY_STEPS.slice(0, 4));
		} finally {
			writeFileSync(path, original, 'utf8');
		}
	});

	it('stops with CK-E-OVERLAY-DRIFT when an artifact no longer describes the pin', () => {
		const artifact = fixture.patchesPath(OVERLAY_ARTIFACT);
		const original = readFileSync(artifact, 'utf8');
		const document = JSON.parse(original) as { operations: { expectUpstream?: unknown }[] };
		const first = document.operations[0];
		if (first !== undefined) {
			first.expectUpstream = 'Something Upstream Never Said';
		}
		writeFileSync(artifact, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
		try {
			const { run, envelope } = fixture.json(['ci']);

			expect(run.status).toBe(1);
			expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-OVERLAY-DRIFT']);
			expect(stateOf(envelope, 'fresh apply')).toBe('failed');
		} finally {
			writeFileSync(artifact, original, 'utf8');
		}
	});
});

describe('codkit ci: the pin guard', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('ci-pin-guard');
		// A base branch of the pseudo-patchset whose pin is the other upstream tag:
		// the race PROP-011 sec. 3 guards against, without an upgrade cycle.
		const configPath = fixture.patchesPath('codkit.json');
		const original = readFileSync(configPath, 'utf8');
		const document = JSON.parse(original) as { pin: { tag: string; sha: string; date: string } };
		patchGit(fixture, ['checkout', '--quiet', '-b', 'base-pin']);
		writeFileSync(
			configPath,
			`${JSON.stringify({ ...document, pin: { ...document.pin, tag: fixture.upstream.t2.tag, sha: fixture.upstream.t2.sha } }, null, 2)}\n`,
			'utf8'
		);
		patchGit(fixture, ['add', '--', 'codkit.json']);
		patchGit(fixture, ['commit', '--quiet', '--message', 'fixture: the base branch moved the pin'], IDENTITY);
		patchGit(fixture, ['checkout', '--quiet', 'main']);
		expect(readFileSync(configPath, 'utf8')).toBe(original);
	});

	it('fails with the rebase hint when the base ref carries another pin', () => {
		const { run, envelope } = fixture.json(['ci', '--pin-guard-base', 'base-pin']);

		expect(run.status).toBe(1);
		expect(stateOf(envelope, 'pin guard')).toBe('failed');
		expect(envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(envelope.errors[0]?.message).toContain(`branch pin ${fixture.upstream.t1.tag} != target branch pin ${fixture.upstream.t2.tag}`);
		expect(envelope.errors[0]?.hint).toContain('codkit rebase-onto-pin');
		// The checks before it passed; only the guard is red.
		expect(stateOf(envelope, 'verify')).toBe('ok');
	});

	it('passes when the base ref carries the same pin', () => {
		const { run, envelope } = fixture.json(['ci', '--pin-guard-base', 'main']);

		expect(run.status).toBe(0);
		expect(stateOf(envelope, 'pin guard')).toBe('ok');
	});

	it('is an environment failure when the base ref does not exist', () => {
		const { run, envelope } = fixture.json(['ci', '--pin-guard-base', 'no-such-ref']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-CONFIG');
	});
});

describe('codkit ci --effective-diff', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('ci-effective-diff');
		// The change under review: one added artifact, which the committed state
		// of the pseudo-patchset - the base of the diff - does not carry.
		writeFileSync(
			fixture.patchesPath('delta/overlays/product-probe.json.overlay.json'),
			`${JSON.stringify(
				{
					codkitOverlay: 2,
					id: 'CK-product-905',
					target: 'manifest.json',
					type: 'modify',
					category: 'own',
					owner: 'product',
					reason: 'fixture: an artifact added by the change under review',
					link: 'none',
					cause: 'none',
					pin: `${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
					contractTests: ['fixture.guard.product'],
					operations: [{ op: 'set', path: ['patchsetEffectiveDiffProbe'], value: 'yes', expectUpstream: { $absent: true } }]
				},
				null,
				2
			)}\n`,
			'utf8'
		);
	});

	it('writes the code diff of the applied states and the inventory diff', () => {
		const { run, envelope } = fixture.json(['ci', '--effective-diff', 'main']);

		expect(run.status).toBe(0);
		expect(stateOf(envelope, 'effective diff')).toBe('ok');

		const patch = readFileSync(fixture.patchesPath('.codkit/out/effective-diff.patch'), 'utf8');
		const inventory = readFileSync(fixture.patchesPath('.codkit/out/inventory-diff.md'), 'utf8');

		// The diff a reviewer reads: the target of the added artifact, changed.
		expect(patch).toContain('manifest.json');
		expect(patch).toContain('+\t"patchsetEffectiveDiffProbe": "yes"');
		// And the inventory diff naming the artifact itself.
		expect(inventory).toContain('CK-product-905');
		expect(inventory).toContain('added');

		const reported = (envelope.data as { effectiveDiff?: { base: string; patch: string; stat: string } }).effectiveDiff;
		expect(reported?.base).toBe('main');
		expect(reported?.stat).toContain('manifest.json');
	});
});

describe('codkit ci --profile build', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('ci-build');
	});

	afterAll(() => {
		fixture.run(['build', 'down', '--channel', 'all']);
		for (const channel of CHANNEL_NAMES) {
			const path = fixture.patchesPath(`.codkit/build/${channel}.json`);
			if (!existsSync(path)) {
				continue;
			}
			const record = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
			try {
				process.kill(-record.pid, 'SIGKILL');
			} catch {
				// Already gone, which is what we wanted.
			}
		}
	});

	it('refuses to build without node_modules, and does not try to install them', () => {
		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT]);

		expect(run.status).toBe(2);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-DEPS-MISSING']);
		// The message names the receipts of the type's own dependency roots, both
		// of them here, and not a directory the engine assumed.
		expect(envelope.errors[0]?.message).toBe(
			'dependencies missing; provide node_modules/.package-lock.json, vendor/node_modules/.package-lock.json ' +
				'via cache/mount (air-gapped supply kit)'
		);
		expect(stateOf(envelope, 'dependencies')).toBe('failed');
		// Nothing was compiled: the run stopped before the daemons.
		expect(steps(envelope).some((step) => step.name === 'compile')).toBe(false);
	});

	it('names only the dependency root the tree is missing when the other one is there', () => {
		// The defect this covers: a tree with `node_modules` restored and a second
		// install root absent was told to "provide node_modules", which is exactly
		// what it already had.
		const receipt = fixture.treePath('node_modules/.package-lock.json');
		mkdirSync(dirname(receipt), { recursive: true });
		writeFileSync(receipt, '{"lockfileVersion":3}\n', 'utf8');

		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT]);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.message).toBe(
			'dependencies missing; provide vendor/node_modules/.package-lock.json via cache/mount (air-gapped supply kit)'
		);
		expect(stepOf(envelope, 'dependencies')?.detail).toBe('no vendor/node_modules/.package-lock.json in the fork tree');

		rmSync(receipt, { force: true });
	});

	it('raises exactly the compile channels the project type names', () => {
		// PROP-016 ##TYPE-BUILD-CHANNELS: the pair the engine used to carry as a
		// module constant is the answer of one family. This run is the same run
		// with one thing changed - a type whose `defaultChannels` are two other
		// channels of the same profile - and the pass it makes is theirs.
		provideTreeDependencies(fixture);

		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], {
			STUB_MODE: 'ok',
			CODKIT_TEST_TYPE_PACKAGE: `${STUB_TYPE_ID}=${STUB_CHANNELS_TYPE_MODULE}`
		});

		expect(run.status).toBe(0);
		expect(stateOf(envelope, 'compile')).toBe('ok');
		expect(stepOf(envelope, 'compile')?.detail).toBe('2 channel(s), one pass each, no errors');
		// The two channels the variant names, and not the transpile channel the
		// engine used to start whatever the type said.
		expect(run.stderr).toContain('--- typecheck: pass');
		expect(run.stderr).toContain('--- extras: pass');
		expect(run.stderr).not.toContain('--- transpile: pass');
		expect(run.stderr).toContain('[watch] build finished');
	});

	it('runs one pass through the daemons and stops them', () => {
		// The supply kit, as a fixture: npm receipts represent the restored cache,
		// and --fresh keeps them (the cleanup whitelist protects node_modules).
		provideTreeDependencies(fixture);

		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], { STUB_MODE: 'ok' });

		expect(run.status).toBe(0);
		expect(stateOf(envelope, 'dependencies')).toBe('ok');
		expect(stateOf(envelope, 'upstream hygiene')).toBe('ok');
		expect(stateOf(envelope, 'overlay apply')).toBe('ok');
		expect(stateOf(envelope, 'compile')).toBe('ok');
		expect(stateOf(envelope, 'product tests')).toBe('ok');
		expect(run.stderr).toContain('Finished transpilation with 0 errors');
		expect(run.stderr).toContain('hygiene: fixture check passed before overlay materialization');
		expect(run.stderr).toContain('product-tests: fixture own and contract tests passed');

		// The container leaves no daemon behind.
		const status = fixture.json(['build', 'status']);
		expect((status.envelope.data as { channels: { state: string }[] }).channels.every((row) => row.state === 'dead')).toBe(true);
		for (const channel of CHANNEL_NAMES) {
			expect(existsSync(fixture.patchesPath(`.codkit/build/${channel}.json`))).toBe(false);
		}
	});

	it('waits for the producer pass before launching a channel that imports its cold output', () => {
		const cold = makeCliFixture('ci-cold-provider');
		provideTreeDependencies(cold);
		const { run, envelope } = cold.json(['ci', '--profile', 'build', ...TIMEOUT], { STUB_MODE: 'ci-order' });
		expect(run.status, run.stderr).toBe(0);
		expect(stateOf(envelope, 'compile')).toBe('ok');
		expect(run.stderr.indexOf('--- transpile: pass')).toBeLessThan(run.stderr.indexOf('typecheck: started'));
		expect(readFileSync(cold.treePath('node_modules/ci-provided.cjs'), 'utf8')).toContain('ready: true');
		const status = cold.json(['build', 'status']);
		expect((status.envelope.data as { channels: { state: string }[] }).channels.every((row) => row.state === 'dead')).toBe(true);
	}, 60000);

	it('replaces the exact overlay materialization a previous build left instead of refusing the tree', () => {
		// The stabilize phase of a cycle runs the build profile on the same tree
		// pass after pass; the materialized targets of one pass are codkit's own
		// bytes, not a developer's work (PROP-005 ##OVERLAY-KNOWN-MATERIALIZATION).
		// The tree in development mode, then the materialization over it: the
		// shape a cycle leaves between two stabilization passes.
		expect(fixture.run(['load', '--fresh']).status).toBe(0);
		provideTreeDependencies(fixture);
		expect(fixture.run(['overlay', 'apply', 'manifest.json']).status).toBe(0);
		expect(fixture.git(['status', '--porcelain']).stdout).toContain('manifest.json');

		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], { STUB_MODE: 'ok' });

		expect(
			run.status,
			`${run.stderr}
${JSON.stringify(envelope.errors)}`
		).toBe(0);
		expect(stateOf(envelope, 'fresh apply')).toBe('ok');
		expect(run.stderr).toContain('fresh apply: manifest.json carries the exact overlay materialization; this run replaces it');
	});

	it('fails before overlay materialization when upstream hygiene is red', () => {
		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], {
			STUB_MODE: 'ok',
			STUB_HYGIENE_MODE: 'fail'
		});

		expect(run.status).toBe(1);
		expect(stateOf(envelope, 'upstream hygiene')).toBe('failed');
		expect(steps(envelope).some((step) => step.name === 'overlay apply')).toBe(false);
		expect(steps(envelope).some((step) => step.name === 'compile')).toBe(false);
	});

	it('fails when the upstream product-test runner is red', () => {
		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], {
			STUB_MODE: 'ok',
			STUB_PRODUCT_TEST_MODE: 'fail'
		});

		expect(run.status).toBe(1);
		expect(stateOf(envelope, 'upstream hygiene')).toBe('ok');
		expect(stateOf(envelope, 'compile')).toBe('ok');
		expect(stateOf(envelope, 'product tests')).toBe('failed');
	});

	it('reports the lock as unchanged on the next run', () => {
		const { envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], { STUB_MODE: 'ok' });
		const step = steps(envelope).find((entry) => entry.name === 'dependencies');

		expect(step?.state).toBe('ok');
		expect(step?.detail).toContain('lock unchanged');
	});

	it('exits 1 on compilation errors and still stops the daemons', () => {
		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], { STUB_MODE: 'errors' });

		expect(run.status).toBe(1);
		expect(stateOf(envelope, 'compile')).toBe('failed');
		expect(run.stderr).toContain('error TS2322');

		const status = fixture.json(['build', 'status']);
		expect((status.envelope.data as { channels: { state: string }[] }).channels.every((row) => row.state === 'dead')).toBe(true);
	});

	it('warns when the manifests moved away from what the last run saw, and still installs nothing', () => {
		// The record is codkit's memory of the lock state of this tree; a run whose
		// manifests hash to something else is exactly the "lock changed" case. The
		// manifests themselves cannot be edited here: they live at the pin, and the
		// fresh step of the same run would put them back.
		const path = fixture.patchesPath('.codkit/build/deps-hash.json');
		const record = JSON.parse(readFileSync(path, 'utf8')) as { hash: string };
		writeFileSync(path, `${JSON.stringify({ ...record, hash: 'f'.repeat(64) }, null, 2)}\n`, 'utf8');

		const { run, envelope } = fixture.json(['ci', '--profile', 'build', ...TIMEOUT], { STUB_MODE: 'ok' });

		expect(run.status).toBe(0);
		expect(stateOf(envelope, 'dependencies')).toBe('warned');
		expect(run.stderr).toContain('lock changed; refresh node_modules out of band');
		// The record was brought up to date, so the warning is raised once per
		// change rather than on every run after it.
		expect((JSON.parse(readFileSync(path, 'utf8')) as { hash: string }).hash).toBe(record.hash);
	});
});

/** git in the pseudo-patchset repository, with an optional commit identity. */
function patchGit(fixture: CliFixture, args: readonly string[], env?: GitEnv): void {
	const result = runGit(env === undefined ? { args, cwd: fixture.patchesDir } : { args, cwd: fixture.patchesDir, env });
	expect(result.stderr + result.stdout, `git ${args.join(' ')}`).toBeDefined();
	expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
}
