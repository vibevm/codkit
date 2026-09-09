// unit: the patchset git hooks (PROP-007 sec. 19).
//
// Two things are under test and both are about restraint: the hooks fail open,
// and they never take a file that is not theirs. A hook that blocks a checkout
// without node_modules, or that overwrites somebody's own pre-commit, is
// uninstalled by the first person it inconveniences - and then it guards
// nothing at all.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CYCLE_STATE_PATH, serializeCycleState } from '../../src/lib/cycleState.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { runGit } from '../../src/lib/gitx.ts';
import {
	CAUSE_TRAILER,
	CYCLE_TRAILER,
	HOOK_MARKER,
	HOOK_NAMES,
	appendTrailer,
	cycleTag,
	hookPath,
	hookScript,
	inspectHook,
	inspectHooks,
	installHooks,
	isOurs,
	runCommitMsg
} from '../../src/lib/hooksPatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

let root: string;

beforeEach(() => {
	root = makeTempRoot('hooks');
	runGit({ args: ['init', '--quiet', '--initial-branch=main', '.'], cwd: root });
});

afterAll(cleanupTempRoots);

const SHA = '08d4889f9ec4a1685d257b9b95de036c8e1ce1e5';
const SOURCE_SHA = '1'.repeat(40);

describe('the hook scripts', () => {
	it('put the shebang first and the ownership marker under it', () => {
		for (const name of HOOK_NAMES) {
			const lines = hookScript(name, { patchesDir: root, forkDir: root }).split('\n');
			// The kernel needs the shebang on line one, so the marker is line two.
			expect(lines[0]).toBe('#!/bin/sh');
			expect(lines[1]).toBe(HOOK_MARKER);
		}
	});

	it('fail open when node or the launcher is missing', () => {
		for (const name of HOOK_NAMES) {
			const script = hookScript(name, { patchesDir: root, forkDir: root });
			expect(script).toContain('command -v node');
			expect(script).toContain('skipping the codkit checks');
			// Both guards end the hook with a zero status, never a refusal.
			expect(script.split('exit 0').length).toBeGreaterThan(2);
		}
	});

	it('quote the paths they carry, so a directory with a space still works', () => {
		const script = hookScript('pre-commit', { patchesDir: "/tmp/a dir/it's", forkDir: '/tmp/fork dir', launcher: '/tmp/launcher.mjs' });
		expect(script).toContain(`CODKIT_ROOT='/tmp/a dir/it'\\''s'`);
		expect(script).toContain(`CODKIT_FORK='/tmp/fork dir'`);
		expect(script).toContain(`CODKIT_LAUNCHER='/tmp/launcher.mjs'`);
	});

	it('call codkit rather than reimplementing a check in sh', () => {
		expect(hookScript('pre-commit', { patchesDir: root, forkDir: root })).toContain('verify --staged-fast');
		expect(hookScript('commit-msg', { patchesDir: root, forkDir: root })).toContain('hooks commit-msg "$1"');
	});

	it('refuse the commit on exit 1 and let it through on anything else', () => {
		const script = hookScript('pre-commit', { patchesDir: root, forkDir: root });
		expect(script).toContain('if [ "$status" -eq 1 ]; then');
		expect(script).toContain('letting the commit through');
	});
});

describe('installHooks', () => {
	it('writes both hooks, executable, and is a no-op the second time', () => {
		const first = installHooks({ patchesDir: root, forkDir: root });
		expect(first.map((report) => report.action)).toEqual(['written', 'written']);
		for (const name of HOOK_NAMES) {
			const path = hookPath(root, name);
			expect(existsSync(path)).toBe(true);
			expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
		}

		expect(installHooks({ patchesDir: root, forkDir: root }).map((report) => report.action)).toEqual(['unchanged', 'unchanged']);
		expect(inspectHooks({ patchesDir: root, forkDir: root }).map((report) => report.state)).toEqual(['ok', 'ok']);
	});

	it('rewrites a hook of ours that is out of date', () => {
		installHooks({ patchesDir: root, forkDir: root });
		const path = hookPath(root, 'pre-commit');
		writeFileSync(path, `#!/bin/sh\n${HOOK_MARKER}\n# an older codkit wrote this\nexit 0\n`, 'utf8');

		expect(inspectHook('pre-commit', { patchesDir: root, forkDir: root }).state).toBe('stale');
		expect(installHooks({ patchesDir: root, forkDir: root })[0]?.action).toBe('written');
		expect(inspectHook('pre-commit', { patchesDir: root, forkDir: root }).state).toBe('ok');
	});

	it('never touches a hook somebody else wrote', () => {
		const path = hookPath(root, 'pre-commit');
		mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
		const theirs = '#!/bin/sh\n# our team lint hook\nexit 0\n';
		writeFileSync(path, theirs, 'utf8');
		chmodSync(path, 0o755);

		const reports = installHooks({ patchesDir: root, forkDir: root });
		expect(reports[0]).toMatchObject({ name: 'pre-commit', state: 'foreign', action: 'refused' });
		expect(readFileSync(path, 'utf8')).toBe(theirs);
		// The other hook is still installed: one foreign file blocks one hook.
		expect(reports[1]?.action).toBe('written');
	});

	it('recognizes its own marker anywhere in the header', () => {
		expect(isOurs(`#!/bin/sh\n${HOOK_MARKER}\n`)).toBe(true);
		expect(isOurs(`#!/bin/sh\n# something\n# else\n${HOOK_MARKER}\n`)).toBe(true);
		expect(isOurs('#!/bin/sh\n# our team lint hook\n')).toBe(false);
	});
});

describe('commit-msg', () => {
	it('leaves the message alone when no cycle is running', () => {
		expect(cycleTag(root)).toBeNull();
		expect(runCommitMsg(root, 'chore: something\n')).toEqual({ exitCode: 0, messages: [], rewritten: null });
	});

	it('reads the target tag from canonical cycle state', () => {
		writeCycle();
		expect(cycleTag(root)).toBe('1.136.0');

		const outcome = runCommitMsg(root, 'feat(codkit): something\n');
		expect(outcome.exitCode).toBe(0);
		expect(outcome.rewritten).toBe(`feat(codkit): something\n\n${CYCLE_TRAILER}: 1.136.0\n`);
	});

	it('fails open for invalid JSON, because a hook is not a validator', () => {
		mkdirSync(join(root, 'cycle'), { recursive: true });
		writeFileSync(join(root, ...CYCLE_STATE_PATH.split('/')), '{ this is not json', 'utf8');
		expect(cycleTag(root)).toBeNull();
		expect(runCommitMsg(root, 'chore: x\n').rewritten).toBeNull();
	});

	it('fails open for noncanonical cycle state', () => {
		const path = cycleStateFile();
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, `${JSON.stringify(cycleState())}\n`, 'utf8');
		expect(cycleTag(root)).toBeNull();
		expect(runCommitMsg(root, 'chore: x\n').rewritten).toBeNull();
	});

	it('fails open for cycle state that is not valid UTF-8', () => {
		const path = cycleStateFile();
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, Uint8Array.from([0xc3, 0x28, 0x0a]));
		expect(cycleTag(root)).toBeNull();
		expect(runCommitMsg(root, 'chore: x\n').rewritten).toBeNull();
	});

	it('fails open when the cycle state path is a symlink', () => {
		const outsideRoot = makeTempRoot('hooks-outside-state');
		const outsideState = join(outsideRoot, 'state.json');
		writeFileSync(outsideState, serializeCycleState(cycleState()), 'utf8');
		mkdirSync(join(root, 'cycle'), { recursive: true });
		symlinkSync(outsideState, cycleStateFile());
		expect(cycleTag(root)).toBeNull();
		expect(runCommitMsg(root, 'chore: x\n').rewritten).toBeNull();
	});

	it('does not redefine the cycle state path or parse a partial state locally', () => {
		const source = readFileSync(new URL('../../src/lib/hooksPatchSet.ts', import.meta.url), 'utf8');
		expect(source).not.toContain(`CYCLE_STATE_PATH = 'cycle/state.json'`);
		expect(source).not.toContain('JSON.parse(');
		expect(source).toContain("import { readCycleState } from './cycleState.ts'");
	});

	it('does not stamp the trailer twice', () => {
		writeCycle();
		expect(runCommitMsg(root, `feat: x\n\n${CYCLE_TRAILER}: 1.136.0\n`).rewritten).toBeNull();
	});

	it('joins an existing trailer block instead of starting a new one', () => {
		writeCycle();
		const outcome = runCommitMsg(root, `feat: x\n\n${CAUSE_TRAILER}: ${SHA}\n`);
		expect(outcome.rewritten).toBe(`feat: x\n\n${CAUSE_TRAILER}: ${SHA}\n${CYCLE_TRAILER}: 1.136.0\n`);
	});

	it('refuses a commit whose Cause trailer is not a sha', () => {
		const outcome = runCommitMsg(root, `fix: x\n\n${CAUSE_TRAILER}: last tuesday\n`);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.messages.join('\n')).toContain('must be a 40-character upstream sha');
		expect(outcome.rewritten).toBeNull();
	});

	it('accepts a Cause trailer that is a sha', () => {
		expect(runCommitMsg(root, `fix: x\n\n${CAUSE_TRAILER}: ${SHA}\n`).exitCode).toBe(0);
	});

	it('ignores the comment lines git strips from the message', () => {
		const message = `fix: x\n\n# ${CAUSE_TRAILER}: not a sha\n# Please enter the commit message\n`;
		expect(runCommitMsg(root, message).exitCode).toBe(0);
	});

	it('appends after the last real line, before the comments git will drop', () => {
		expect(appendTrailer('subject\n\nbody\n\n# a comment\n', 'X: 1')).toBe('subject\n\nbody\n\nX: 1\n\n# a comment\n');
	});
});

function cycleState(): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: '1.135.0', sha: SOURCE_SHA, date: '2026-08-13' },
		targetPin: { tag: '1.136.0', sha: SHA, date: '2026-08-20' },
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
}

function cycleStateFile(): string {
	return join(root, ...CYCLE_STATE_PATH.split('/'));
}

function writeCycle(): void {
	const path = cycleStateFile();
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, serializeCycleState(cycleState()), 'utf8');
}
