// e2e: codkit hooks install|check, and the pre-commit hook actually refusing a
// commit (PROP-007 sec. 19).
//
// The interesting case is the last one: a real `git commit` in the pseudo-patchset
// repository, with a staged patch whose change escaped its marker block. That is
// the only way to know the hook is wired the way git expects - installed,
// executable, and speaking through exit codes - rather than merely written.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitLocal } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { HOOK_MARKER } from '../../src/lib/hooksPatchSet.ts';
import { serializeCycleState } from '../../src/lib/cycleState.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { PATCH_FILE_NAME, PATCH_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture, STUB_TYPE_ENV, testBuildNodeDir } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

let fixture: CliFixture;

const PATCH_ARTIFACT = `delta/patches/${PATCH_FILE_NAME}`;

/**
 * The environment a commit in the fixture needs: an identity (the isolated git
 * of codkit sees no global config) and no CODKIT_FORK_DIR inherited from the
 * developer's shell, which would point the hook at a real tree.
 */
let COMMIT_ENV: GitEnv;

beforeAll(() => {
	fixture = makeCliFixture('hooks');
	// The hook runs `node "$CODKIT_LAUNCHER"`, so the `node` it finds is what
	// decides whether the run is a test build - and only a test build reaches
	// the stub type the fixture patch set declares (PROP-016 ##TYPE-TEST-SEAM).
	COMMIT_ENV = {
		GIT_AUTHOR_NAME: 'fixture',
		GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
		GIT_COMMITTER_NAME: 'fixture',
		GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
		CODKIT_FORK_DIR: '',
		...STUB_TYPE_ENV,
		PATH: `${testBuildNodeDir('hooks')}${delimiter}${process.env['PATH'] ?? ''}`
	};
});

afterAll(cleanupTempRoots);

function hookFile(name: string): string {
	return join(fixture.patchesDir, '.git', 'hooks', name);
}

function commit(message: string): { status: number; stdout: string; stderr: string } {
	return gitLocal({ args: ['commit', '--quiet', '--message', message], cwd: fixture.patchesDir, env: COMMIT_ENV });
}

describe('codkit hooks install|check', () => {
	it('installs both hooks, executable, and then reports them up to date', () => {
		const install = fixture.run(['hooks', 'install']);
		expect(install.status).toBe(0);
		expect(install.stdout).toContain('pre-commit');
		expect(install.stdout).toContain('installed');

		for (const name of ['pre-commit', 'commit-msg']) {
			expect(existsSync(hookFile(name))).toBe(true);
			expect(statSync(hookFile(name)).mode & 0o111).toBeGreaterThan(0);
			expect(readFileSync(hookFile(name), 'utf8').split('\n')[1]).toBe(HOOK_MARKER);
		}

		expect(fixture.run(['hooks', 'check']).status).toBe(0);
	});

	it('fails the check once a hook is edited, and install puts it back', () => {
		const path = hookFile('pre-commit');
		const saved = readFileSync(path, 'utf8');
		writeFileSync(path, `${saved}# somebody added a line\n`, 'utf8');

		const outcome = fixture.json(['hooks', 'check']);
		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(outcome.envelope.errors[0]?.message).toContain('out of date');

		expect(fixture.run(['hooks', 'install']).status).toBe(0);
		expect(readFileSync(path, 'utf8')).toBe(saved);
		expect(fixture.run(['hooks', 'check']).status).toBe(0);
	});

	it('refuses to overwrite a hook somebody else wrote, and leaves it alone', () => {
		const other = makeCliFixture('hooks-foreign');
		const path = join(other.patchesDir, '.git', 'hooks', 'pre-commit');
		mkdirSync(join(other.patchesDir, '.git', 'hooks'), { recursive: true });
		const theirs = '#!/bin/sh\n# the team lint hook\nexit 0\n';
		writeFileSync(path, theirs, 'utf8');
		chmodSync(path, 0o755);

		const outcome = other.json(['hooks', 'install']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.message).toContain('was not written by codkit');
		expect(readFileSync(path, 'utf8')).toBe(theirs);
	});

	it('reports a missing hook rather than pretending it is fine', () => {
		const other = makeCliFixture('hooks-missing');
		const outcome = other.json(['hooks', 'check']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.message)).toEqual([
			expect.stringContaining('pre-commit hook is not installed'),
			expect.stringContaining('commit-msg hook is not installed')
		]);
	});

	it('reports install and check inactive when Git executes a custom hooksPath', () => {
		const other = makeCliFixture('hooks-custom-effective');
		const external = other.patchesPath('.external-hooks');
		mkdirSync(external, { recursive: true });
		const sentinel = join(external, 'pre-commit');
		writeFileSync(sentinel, '#!/bin/sh\necho custom-effective >&2\nexit 7\n', 'utf8');
		chmodSync(sentinel, 0o755);
		other.patchGit(['config', 'core.hooksPath', external]);

		for (const mode of ['install', 'check']) {
			const outcome = other.json(['hooks', mode]);
			expect(outcome.run.status).toBe(1);
			expect(outcome.envelope.errors.every((error) => error.message.includes('inactive'))).toBe(true);
		}
		expect(existsSync(join(other.patchesDir, '.git', 'hooks', 'pre-commit'))).toBe(false);
		const attempted = gitLocal({
			args: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-m', 'probe'],
			cwd: other.patchesDir
		});
		expect(attempted.status).not.toBe(0);
		expect(attempted.stderr).toContain('custom-effective');
	});
});

describe('the installed pre-commit hook', () => {
	it('refuses a commit whose staged patch changes a line outside its block', () => {
		expect(fixture.run(['hooks', 'install']).status).toBe(0);

		const path = fixture.patchesPath(PATCH_ARTIFACT);
		const saved = readFileSync(path, 'utf8');
		try {
			writeFileSync(path, escapeTheBlock(saved), 'utf8');
			fixture.patchGit(['add', 'delta']);

			const started = Date.now();
			const refused = commit('feat: a patch that escaped its block');
			const elapsed = Date.now() - started;

			expect(refused.status).not.toBe(0);
			expect(refused.stderr).toContain('CK-E-HUNK-OUTSIDE-MARKER');
			expect(refused.stderr).toContain('commit refused');
			// PROP-012 ##NFR-PRECOMMIT-SPEED: this has to cost a fraction of a
			// second, or it will be worked around with --no-verify.
			expect(elapsed).toBeLessThan(2000);
		} finally {
			writeFileSync(path, saved, 'utf8');
			fixture.patchGit(['add', 'delta']);
		}
	});

	it('lets the same patch through once it is correct again', () => {
		// The working tree is back to the fixture patch and staged; nothing else
		// changed, so there is nothing to commit - which is a pass, not a refusal.
		const accepted = commit('chore: the patch is correct again');
		expect(accepted.stderr).not.toContain('commit refused');
		expect(accepted.stderr).not.toContain('CK-E-');
	});

	it('accepts a commit that stages a correct change of the delta', () => {
		const path = fixture.patchesPath('delta/own/hello.ts');
		writeFileSync(path, `${readFileSync(path, 'utf8')}\nexport const goodbye = 'bye';\n`, 'utf8');
		fixture.patchGit(['add', 'delta']);

		const accepted = commit('feat: more own code');
		expect(accepted.status).toBe(0);
		expect(fixture.patchGit(['log', '-1', '--format=%s']).stdout.trim()).toBe('feat: more own code');
	});

	it('stamps no cycle trailer when no cycle is running', () => {
		expect(fixture.patchGit(['log', '-1', '--format=%B']).stdout).not.toContain('Codkit-Cycle');
	});

	it('stamps the cycle trailer while a cycle is running', () => {
		mkdirSync(fixture.patchesPath('cycle'), { recursive: true });
		const sourcePin = (JSON.parse(readFileSync(fixture.patchesPath('codkit.json'), 'utf8')) as { pin: CycleState['sourcePin'] }).pin;
		const state: CycleState = {
			codkitCycleState: 2,
			sourcePin,
			targetPin: { tag: '1.136.0', sha: 'f'.repeat(40), date: '2026-08-27' },
			branch: 'codkit/cycle/1.136.0',
			startedAt: '2026-08-31T10:00:00.000Z',
			updatedAt: '2026-08-31T10:01:00.000Z',
			phase: 'apply',
			nextAction: 'continue the cycle',
			transaction: null,
			artifacts: {
				clean: [],
				shifted: [],
				merged: [],
				conflict: [],
				'target-deleted': [],
				'target-renamed': [],
				'rule-broken': [],
				'contract-failed': []
			},
			resolved: [],
			renames: []
		};
		writeFileSync(fixture.patchesPath('cycle/state.json'), serializeCycleState(state), 'utf8');
		const path = fixture.patchesPath('delta/own/hello.ts');
		writeFileSync(path, `${readFileSync(path, 'utf8')}\nexport const third = 3;\n`, 'utf8');
		fixture.patchGit(['add', 'delta']);

		expect(commit('feat: work inside a cycle').status).toBe(0);
		expect(fixture.patchGit(['log', '-1', '--format=%B']).stdout).toContain('Codkit-Cycle: 1.136.0');
	});

	it('refuses a commit whose Cause trailer is not a sha', () => {
		const path = fixture.patchesPath('delta/own/hello.ts');
		writeFileSync(path, `${readFileSync(path, 'utf8')}\nexport const fourth = 4;\n`, 'utf8');
		fixture.patchGit(['add', 'delta']);

		const refused = commit('fix: adapt to upstream\n\nCause: last tuesday');
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('must be a 40-character upstream sha');
	});
});

/**
 * Move the first added line of the sample patch in front of its own begin
 * marker: the diff still applies, the hunk counts are untouched, and the line
 * now lands outside the block - which is exactly CK-E-HUNK-OUTSIDE-MARKER.
 */
function escapeTheBlock(patch: string): string {
	const begin = `+\t\t// codkit:begin ${PATCH_ID}`;
	const body = '+\t\t// (hook body lives in own/ code; this block only delegates)';
	if (!patch.includes(`${begin}\n${body}`)) {
		throw new Error('the fixture patch no longer has the shape this test edits');
	}
	return patch.replace(`${begin}\n${body}`, `${body}\n${begin}`);
}
