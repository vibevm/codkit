// e2e: PROP-013 sec. 5 hard-process interruption through the real launcher.
// Each recovery command is a fresh process; the matrix names durable phase and
// transaction boundaries rather than multiplying every internal write window.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CYCLE_TEST_CRASH_ENV, CYCLE_TEST_CRASH_EXIT_CODE, type CycleTestCrashCheckpoint } from '../../src/lib/cycleTestCrash.ts';
import { CYCLE_STATE_PATH } from '../../src/lib/cycleState.ts';
import {
	CODKIT_E2E_TEST_BUILD,
	CODKIT_E2E_TIMEOUT_MS,
	makeCliFixture,
	provideTreeDependencies,
	type CliFixture
} from '../support/cliFixture.ts';
import { excludeGenericRuntimeState, makeGenericFixture, provideGenericTreeDependencies } from '../support/genericFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const PROCESS_TIMEOUT_MS = '20000';
const DAEMON_PID_LOG = '.codkit/test-daemon-pids.log';
const MATRIX = [
	'init-state-written',
	'init-branch-created',
	'init-config-written',
	'init-config-staged',
	'init-bump-committed',
	'init-completed',
	'apply-classified-record-written',
	'apply-classified',
	'apply-committed',
	'deps-advisory-transition-commit-installed',
	'stabilize-run-finished',
	'stabilize-planned',
	'stabilize-transition-commit-installed',
	'terminal-commit-installed'
] as const satisfies readonly CycleTestCrashCheckpoint[];

const OLD_CONFIG_INIT_CHECKPOINTS = new Set<CycleTestCrashCheckpoint>(['init-state-written', 'init-branch-created']);

const fixtures: CliFixture[] = [];
let baselineDelta: Readonly<Record<string, string>>;

beforeAll(() => {
	const fixture = trackedFixture('cycle-crash-baseline');
	prepare(fixture);
	const completed = fixture.json(['cycle', 'start', fixture.upstream.t2.tag, '--ci'], testEnv(fixture));
	expect(completed.run.status, completed.run.stderr).toBe(0);
	expect(completed.envelope.data['status']).toBe('completed');
	baselineDelta = deltaBytes(fixture);
	assertNoDaemons(fixture);
}, 30_000);

afterAll(() => {
	for (const fixture of fixtures) {
		fixture.run(['build', 'down', '--channel', 'all'], testEnv(fixture));
	}
	cleanupTempRoots();
});

describe('cycle hard-crash resume matrix', () => {
	it.each(MATRIX)(
		'resumes byte-identically after %s in a new process',
		(checkpoint) => {
			const fixture = trackedFixture(`cycle-crash-${checkpoint}`);
			prepare(fixture);
			const crashed = fixture.run(
				['cycle', 'start', fixture.upstream.t2.tag, '--ci'],
				testEnv(fixture, {
					[CYCLE_TEST_CRASH_ENV]: checkpoint
				})
			);
			expect(crashed.status, `${checkpoint}\n${crashed.stderr}`).toBe(CYCLE_TEST_CRASH_EXIT_CODE);
			if (checkpoint.startsWith('init-')) {
				const config = JSON.parse(readFileSync(fixture.patchesPath('codkit.json'), 'utf8')) as { pin: { sha: string } };
				expect(config.pin.sha).toBe(OLD_CONFIG_INIT_CHECKPOINTS.has(checkpoint) ? fixture.upstream.t1.sha : fixture.upstream.t2.sha);
			}

			assertNoDaemons(fixture);
			const interrupted = fixture.json(['cycle', 'status'], testEnv(fixture));
			expect(interrupted.run.status, interrupted.run.stderr).toBe(0);
			expect(interrupted.envelope.data['status']).toBe('active');

			const resumed = fixture.json(['cycle', 'continue', '--ci'], testEnv(fixture));
			expect(resumed.run.status, `${checkpoint}\n${resumed.run.stderr}\n${resumed.run.stdout}`).toBe(0);
			expect(resumed.envelope.data).toMatchObject({ status: 'completed', phase: 'done' });
			assertCompleted(fixture);
		},
		35_000
	);

	it('resumes the resolve phase after its durable state endpoint', () => {
		const fixture = trackedFixture('cycle-crash-resolve-completed');
		prepare(fixture);
		const red = fixture.json(
			['cycle', 'start', fixture.upstream.t2.tag, '--ci'],
			testEnv(fixture, {
				STUB_HYGIENE_MODE: 'fail'
			})
		);
		expect(red.run.status, red.run.stderr).toBe(3);
		expect(red.envelope.data['phase']).toBe('resolve');
		assertNoDaemons(fixture);

		const crashed = fixture.run(
			['cycle', 'continue', '--ci'],
			testEnv(fixture, {
				[CYCLE_TEST_CRASH_ENV]: 'resolve-completed'
			})
		);
		expect(crashed.status, crashed.stderr).toBe(CYCLE_TEST_CRASH_EXIT_CODE);
		expect(fixture.json(['cycle', 'status'], testEnv(fixture)).envelope.data['phase']).toBe('deps-advisory');

		const resumed = fixture.json(['cycle', 'continue', '--ci'], testEnv(fixture));
		expect(resumed.run.status, `${resumed.run.stderr}\n${resumed.run.stdout}`).toBe(0);
		assertCompleted(fixture);
	}, 45_000);

	it('rejects unknown checkpoints before cycle mutation', () => {
		const fixture = trackedFixture('cycle-crash-unknown');
		prepare(fixture);
		const failed = fixture.json(
			['cycle', 'start', fixture.upstream.t2.tag, '--ci'],
			testEnv(fixture, {
				[CYCLE_TEST_CRASH_ENV]: 'unknown-checkpoint'
			})
		);
		expect(failed.run.status).toBe(2);
		expect(failed.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(fixture.patchGit(['branch', '--show-current']).stdout.trim()).toBe('main');
		expect(existsSync(fixture.patchesPath(CYCLE_STATE_PATH))).toBe(false);
	});

	it('rejects the test hook outside the test runtime', () => {
		// Outside the test build the stub type is out of reach as well (PROP-016
		// ##TYPE-TEST-SEAM), so this one is played over the second polygon, whose
		// type the release itself carries. What is proved is the refusal of the
		// crash hook by a run that is not a test build, and that is unchanged.
		const fixture = makeGenericFixture('cycle-crash-guard');
		excludeGenericRuntimeState(fixture);
		provideGenericTreeDependencies(fixture);
		const failed = fixture.json(['cycle', 'start', fixture.upstream.v2.tag, '--ci'], {
			[CYCLE_TEST_CRASH_ENV]: 'init-state-written'
		});
		expect(failed.run.status).toBe(2);
		expect(failed.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(failed.envelope.errors[0]?.message).toContain('disabled outside the test runtime');
		expect(existsSync(fixture.patchesPath(CYCLE_STATE_PATH))).toBe(false);
	});

	it('bounds a blocked test-build child below the harness timeout', () => {
		const fixture = trackedFixture('cycle-crash-timeout');
		prepare(fixture);
		const timedOut = fixture.run(['cycle', 'status'], {
			[CODKIT_E2E_TEST_BUILD]: '1',
			[CODKIT_E2E_TIMEOUT_MS]: '1'
		});
		expect(timedOut.status).toBe(2);
		expect(timedOut.stderr).toContain('test process exceeded 1 ms');
	});
});

function trackedFixture(label: string): CliFixture {
	const fixture = makeCliFixture(label);
	fixtures.push(fixture);
	return fixture;
}

function prepare(fixture: CliFixture): void {
	writeFileSync(fixture.patchesPath('.git/info/exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
	// The fixture's heavy runner is a deterministic script stub, but the real CI
	// engine still requires the dependency-directory precondition.
	provideTreeDependencies(fixture);
}

function assertCompleted(fixture: CliFixture): void {
	const status = fixture.json(['cycle', 'status'], testEnv(fixture));
	expect(status.run.status, status.run.stderr).toBe(0);
	expect(status.envelope.data).toMatchObject({ status: 'completed', phase: 'done' });
	expect(existsSync(fixture.patchesPath(CYCLE_STATE_PATH))).toBe(false);
	expect(fixture.patchGit(['status', '--short']).stdout).toBe('');
	expect(deltaBytes(fixture)).toEqual(baselineDelta);
	assertNoDaemons(fixture);
}

function deltaBytes(fixture: CliFixture): Readonly<Record<string, string>> {
	const listed = fixture.patchGit(['ls-files', '-z', '--', 'delta']);
	if (listed.status !== 0) throw new Error(listed.stderr);
	return Object.fromEntries(
		listed.stdout
			.split('\0')
			.filter((path) => path !== '')
			.map((path) => [path, readFileSync(fixture.patchesPath(path)).toString('base64')])
	);
}

function assertNoDaemons(fixture: CliFixture): void {
	const status = fixture.json(['build', 'status', '--channel', 'all'], testEnv(fixture));
	expect(status.run.status, status.run.stderr).toBe(0);
	const rows = status.envelope.data['channels'];
	if (!Array.isArray(rows)) throw new Error('build status channels missing');
	expect(rows.every((row) => row !== null && typeof row === 'object' && Reflect.get(row, 'state') === 'dead')).toBe(true);
	for (const pid of daemonPids(fixture)) expect(processIsAlive(pid), `fixture daemon pid ${pid} is still alive`).toBe(false);
	// Retire proved-dead identities immediately. Keeping numeric PIDs until the
	// suite teardown could confuse a later unrelated process that reused one.
	rmSync(fixture.patchesPath(DAEMON_PID_LOG), { force: true });
}

function testEnv(fixture: CliFixture, extra: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
	return {
		[CODKIT_E2E_TEST_BUILD]: '1',
		[CODKIT_E2E_TIMEOUT_MS]: PROCESS_TIMEOUT_MS,
		CODKIT_TEST_DAEMON_PID_LOG: fixture.patchesPath(DAEMON_PID_LOG),
		STUB_MODE: 'ok',
		...extra
	};
}

function daemonPids(fixture: CliFixture): readonly number[] {
	const path = fixture.patchesPath(DAEMON_PID_LOG);
	if (!existsSync(path)) return [];
	return [
		...new Set(
			readFileSync(path, 'utf8')
				.split('\n')
				.map(Number)
				.filter((pid) => Number.isInteger(pid) && pid > 0)
		)
	];
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
