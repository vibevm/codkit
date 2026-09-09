// e2e: `codkit check-tree` and `codkit clone` through the real launcher.
//
// The pseudo-patchset fixture supplies the config (pin and anchor), so the
// repository's own codkit.json is never involved: CODKIT_PATCHES_DIR points the
// process at the fixture. Contracts under test: PROP-007 sec. 3-4.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = join(packageRoot, 'bin', 'codkit.mjs');

type Run = { status: number; stdout: string; stderr: string };

type Envelope = {
	codkit: { schema: number; command: string; version: string };
	ok: boolean;
	exitCode: number;
	roots: { fork: { path: string; source: string; exists: boolean } | null };
	data: { checks?: { id: string; name: string; ok: boolean; info?: string }[]; outcome?: string; clean?: boolean };
	messages: { level: string; text: string }[];
	errors: { code: string; message: string; hint?: string }[];
};

let upstream: UpstreamFixture;
let patchsetFixture: string;
let bareMirror: string;

beforeAll(() => {
	upstream = makeUpstream(makeTempRoot('e2e-upstream'));
	patchsetFixture = makeTempRoot('e2e-patchset');
	makePatchSet(patchsetFixture, upstream);

	// A bare mirror is the clone source: a path, not a URL, but the same code path.
	const mirrorRoot = makeTempRoot('e2e-mirror');
	bareMirror = join(mirrorRoot, 'upstream.git');
	runGit({ args: ['clone', '--bare', '--quiet', upstream.dir, bareMirror], cwd: mirrorRoot, netAllowed: true });
});

afterAll(() => {
	cleanupTempRoots();
});

function runCli(args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Run {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	delete env['CODKIT_FORK_DIR'];
	// Read codkit.json from the fixture, not from this repository.
	env['CODKIT_PATCHES_DIR'] = patchsetFixture;
	Object.assign(env, extraEnv);

	const result = spawnSync(process.execPath, [launcher, ...args], { cwd: patchsetFixture, env, encoding: 'utf8' });
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseEnvelope(stdout: string): Envelope {
	return JSON.parse(stdout) as Envelope;
}

function headOf(tree: string): string {
	return runGit({ args: ['rev-parse', 'HEAD'], cwd: tree }).stdout.trim();
}

describe('codkit clone', () => {
	it('clones to the pin and is idempotent on the second run', () => {
		const target = join(makeTempRoot('clone-target'), 'fork-tree');

		const first = runCli(['clone', '--json', '--from', bareMirror, '--fork-dir', target]);
		expect(first.status).toBe(0);
		const firstEnvelope = parseEnvelope(first.stdout);
		expect(firstEnvelope.ok).toBe(true);
		expect(firstEnvelope.data.outcome).toBe('cloned');
		expect(firstEnvelope.errors).toEqual([]);
		// Detached exactly at the pin, not at the tip of the default branch.
		expect(headOf(target)).toBe(upstream.t1.sha);
		expect(headOf(target)).not.toBe(upstream.t2.sha);

		const second = runCli(['clone', '--json', '--from', bareMirror, '--fork-dir', target]);
		expect(second.status).toBe(0);
		const secondEnvelope = parseEnvelope(second.stdout);
		expect(secondEnvelope.data.outcome).toBe('already-present');
		expect(secondEnvelope.messages.some((message) => message.text === 'already present')).toBe(true);
		expect(headOf(target)).toBe(upstream.t1.sha);
	});

	it('refuses before doing anything in --ci mode', () => {
		const target = join(makeTempRoot('clone-ci'), 'fork-tree');
		const run = runCli(['clone', '--ci', '--json', '--from', bareMirror, '--fork-dir', target]);

		expect(run.status).toBe(2);
		const envelope = parseEnvelope(run.stdout);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-NET-FORBIDDEN']);
		expect(run.stderr).toContain('CK-E-NET-FORBIDDEN');
	});

	it('refuses a directory that holds something else', () => {
		const target = makeTempRoot('clone-occupied');
		writeFileSync(join(target, 'stranger.txt'), 'someone else lives here\n', 'utf8');

		const run = runCli(['clone', '--json', '--from', bareMirror, '--fork-dir', target]);

		expect(run.status).toBe(2);
		expect(parseEnvelope(run.stdout).errors.map((error) => error.code)).toEqual(['CK-E-NOT-A-REPO']);
	});

	// PROP-007 sec. 4 dropped --shallow-since: tree identity is decided by
	// reachability of the anchor commit, which a shallow clone cannot reach.
	it('refuses --shallow-since as an unknown flag', () => {
		const target = join(makeTempRoot('clone-shallow'), 'fork-tree');
		const run = runCli(['clone', '--json', '--from', bareMirror, '--shallow-since', '2026-01-01', '--fork-dir', target]);

		expect(run.status).toBe(2);
		expect(run.stdout).toBe('');
		expect(run.stderr).toContain('unknown flag --shallow-since');
		expect(existsSync(target)).toBe(false);
	});

	it('asks for a source when neither --from nor publishRemoteUrl is set', () => {
		const target = join(makeTempRoot('clone-no-source'), 'fork-tree');
		const run = runCli(['clone', '--json', '--fork-dir', target]);

		expect(run.status).toBe(2);
		const [error] = parseEnvelope(run.stdout).errors;
		expect(error?.code).toBe('CK-E-CONFIG');
		expect(error?.hint).toContain('--from');
	});
});

describe('codkit check-tree', () => {
	it('reports every check ok on the fixture tree', () => {
		const run = runCli(['check-tree', '--fork-dir', upstream.dir, '--json']);

		expect(run.status).toBe(0);
		const envelope = parseEnvelope(run.stdout);
		expect(envelope.ok).toBe(true);
		expect(envelope.roots.fork).toMatchObject({ path: upstream.dir, source: 'flag' });
		expect(envelope.data.checks?.map((check) => check.id)).toEqual(['repo', 'upstream', 'pin', 'fingerprints', 'lfs']);
		expect(envelope.data.checks?.every((check) => check.ok)).toBe(true);
		expect(envelope.data.clean).toBeUndefined();
	});

	it('uses the fork tree from the environment when no flag is given', () => {
		const run = runCli(['check-tree', '--json'], { CODKIT_FORK_DIR: upstream.dir });

		expect(run.status).toBe(0);
		expect(parseEnvelope(run.stdout).roots.fork).toMatchObject({ path: upstream.dir, source: 'env' });
	});

	it('exits 1 with a fixable verdict when --require-clean meets a dirty tree', () => {
		const scratch = join(upstream.dir, 'scratch-note.md');
		writeFileSync(scratch, 'left behind by a human\n', 'utf8');
		try {
			const run = runCli(['check-tree', '--require-clean', '--fork-dir', upstream.dir, '--json']);

			expect(run.status).toBe(1);
			const envelope = parseEnvelope(run.stdout);
			expect(envelope.data.clean).toBe(false);
			const [error] = envelope.errors;
			expect(error?.code).toBe('CK-E-DIRTY-TREE');
			expect(error?.hint).toContain('codkit save');
		} finally {
			rmSync(scratch, { force: true });
		}
	});

	it('exits 2 on a path that is not the fork tree', () => {
		const plain = makeTempRoot('not-a-tree');
		const run = runCli(['check-tree', '--fork-dir', plain, '--json']);

		expect(run.status).toBe(2);
		expect(parseEnvelope(run.stdout).errors.map((error) => error.code)).toEqual(['CK-E-NOT-A-REPO']);
	});
});

describe('codkit command flags', () => {
	it('refuses a command flag on a command that does not take it', () => {
		const run = runCli(['where', '--require-clean']);

		expect(run.status).toBe(2);
		expect(run.stderr).toContain("flag --require-clean is not a flag of command 'where'");
	});

	it('lists the new commands in the help', () => {
		const run = runCli([]);

		expect(run.status).toBe(0);
		for (const command of ['check-tree', 'clone', 'reresolve', 'cycle', 'forecast', 'rebase-onto-pin', 'publish']) {
			expect(run.stdout).toContain(command);
		}
	});
});
