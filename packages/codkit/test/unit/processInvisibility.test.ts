/** @scope spec://codkit/modules/codkit/PROP-010#root */
// An invisible process is never certified dead.
//
// The audit finding: `EACCES`/`EPERM` reading /proc/<pid>/cmdline means "exists,
// not visible to you" (hidepid, another uid), and the /proc probe collapsed it
// into "no such process" - so a live daemon was certified dead, its record
// retired by `up`, and a duplicate watcher started over the same tree. The ps
// and Windows probes already fail closed; the /proc errno discrimination is the
// guard, and it is what the first two blocks below pin.
//
// The /proc branch has no options seam in production (it is taken whenever the
// platform is linux and /proc exists), so its failure modes are driven the way
// the contained-guard tests drive the emitted runtime: a child process over
// `dist/` whose `node:fs` import is fault-injected through a module loader.
// Nothing here sleeps or races; every barrier is a fault or a real, stable
// process-table entry.

import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { downChannel, readPass, statusOf, upChannel, type ChannelConfig, type SpawnedDaemon } from '../../src/lib/buildWrap.ts';
import { DAEMON_RECORD_SCHEMA_VERSION, recordPath, type DaemonRecord } from '../../src/lib/buildRuntime.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const CHANNEL: ChannelConfig = {
	name: 'transpile',
	script: 'watch-client-transpile',
	passStart: [/^start$/],
	passEnd: [/^end$/],
	errorLine: [/^error: (.+)$/],
	errorCountLine: [],
	falseEndGuards: []
};

const EMITTED = fileURLToPath(new URL('../../dist/lib/buildWrap.js', import.meta.url));

function fixture(label: string): { readonly patchesDir: string; readonly treeDir: string } {
	const patchesDir = makeTempRoot(`${label}-patches`);
	const treeDir = makeTempRoot(`${label}-tree`);
	writeFileSync(join(treeDir, 'package.json'), JSON.stringify({ scripts: { 'watch-client-transpile': 'fixture' } }), 'utf8');
	return { patchesDir, treeDir };
}

function plantedRecord(current: ReturnType<typeof fixture>, pid: number, startedAt = '2026-09-01T00:00:00.000Z'): DaemonRecord {
	return {
		codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
		channel: CHANNEL.name,
		script: CHANNEL.script,
		pid,
		cmdline: CHANNEL.script,
		startedAt,
		treeId: 'fixture-tree',
		treePath: current.treeDir,
		nonce: 'a1b2c3d4-e5f6-4a1b-8c2d-0123456789ab'
	};
}

function plant(current: ReturnType<typeof fixture>, record: DaemonRecord): Uint8Array {
	const path = recordPath(current.patchesDir, CHANNEL.name);
	mkdirSync(dirname(path), { recursive: true });
	const bytes = new Uint8Array(Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
	writeFileSync(path, bytes);
	return bytes;
}

const ownTree = (current: ReturnType<typeof fixture>) => ({ expectedTreeId: 'fixture-tree', expectedTreePath: current.treeDir }) as const;

// ---------------------------------------------------------------------------
// A real process-table entry that exists but publishes no identity
// ---------------------------------------------------------------------------

/**
 * A kernel thread: listed by /proc, alive for the life of the machine, and
 * carrying an EMPTY cmdline - the exact "it exists, and it is not ours" shape
 * the /proc reader has to keep apart from "no such process". Returns null when
 * no kernel thread is visible (a pid-namespace container); the caller falls
 * back to an owned process whose argv answers for the same branch.
 */
function identityLessPid(): number | null {
	if (process.platform !== 'linux') return null;
	for (const name of readdirSync('/proc')) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number.parseInt(name, 10);
		let cmdline = '';
		try {
			cmdline = readFileSync(join('/proc', name, 'cmdline'), 'utf8');
		} catch {
			continue;
		}
		if (cmdline === '') return pid;
	}
	return null;
}

describe('a process that exists but cannot be identified is never dead', () => {
	it('keeps the channel unknown, refuses every lifecycle action, and starts no duplicate daemon', async () => {
		const current = fixture('invisible-identityless');
		let owned: ChildProcess | null = null;
		let pid = identityLessPid();
		if (pid === null) {
			// Same branch, driven by an owned process whose argv does not carry the
			// recorded script: identity is readable and still not ours.
			owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
			pid = owned.pid ?? 0;
		}
		expect(pid).toBeGreaterThan(0);
		const bytes = plant(current, plantedRecord(current, pid as number));
		const path = recordPath(current.patchesDir, CHANNEL.name);
		const beforeMtime = statSync(path).mtimeMs;
		let spawns = 0;
		const spawned = (): SpawnedDaemon => {
			spawns += 1;
			return { pid: 99999, terminate: () => undefined };
		};

		try {
			const probe = ownTree(current);
			const observed = statusOf(current.patchesDir, CHANNEL.name, probe);
			// Not dead - dead would retire the record and license a second watcher -
			// and not living or starting either: identity is simply not proven.
			expect(observed).toMatchObject({ state: 'unknown' });
			expect(observed.detail).toMatch(/belongs to another process|not proven/);

			// `up` refuses twice, spawning nothing: no duplicate daemon is started.
			const first = upChannel({ ...current, treeId: 'fixture-tree' }, CHANNEL, { spawn: spawned });
			const second = upChannel({ ...current, treeId: 'fixture-tree' }, CHANNEL, { spawn: spawned });
			expect(first).toMatchObject({ ok: false });
			expect(second).toMatchObject({ ok: false });
			expect(String((first as { reason: string }).reason)).toMatch(/identity is not proven/);
			expect(spawns).toBe(0);

			await expect(downChannel(current.patchesDir, CHANNEL.name, probe)).rejects.toThrow(/identity is not proven/);
			await expect(readPass(current.patchesDir, CHANNEL, { timeoutMs: 0, probe })).rejects.toThrow(/refusing to read or certify/);

			// No record was retired anywhere on the way: same bytes, same mtime.
			expect(readFileSync(path)).toEqual(Buffer.from(bytes));
			expect(statSync(path).mtimeMs).toBe(beforeMtime);
		} finally {
			if (owned !== null) {
				owned.kill('SIGKILL');
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Fault-injected /proc errno discrimination, over the emitted runtime
// ---------------------------------------------------------------------------

/**
 * Run `statusOf` from the emitted runtime in a child process whose copy of
 * buildWrap sees a fault-injected `node:fs`: reads of /proc/<pid>/cmdline fail
 * with the chosen errno, and (optionally) the process table omits the pid.
 *
 * The loader is the seam: production takes the /proc branch whenever the
 * platform is linux, and no options seam reaches it, so the failure is injected
 * at the module boundary exactly where the kernel would deliver it.
 */
function probeEmitted(
	patchesDir: string,
	pid: number,
	options: { readonly errno?: 'EACCES' | 'EPERM' | 'ENOENT'; readonly hideFromTable?: boolean } = {}
): string {
	const harness = makeTempRoot('proc-fault');
	writeFileSync(
		join(harness, 'fs-shim.mjs'),
		[
			"import * as realFs from 'node:fs';",
			'const pid = process.env.CK_PROC_PID;',
			'const errno = process.env.CK_PROC_ERRNO;',
			'const hide = process.env.CK_PROC_HIDE_TABLE === "1";',
			'const cmdlinePath = `/proc/${pid}/cmdline`;',
			'export const existsSync = realFs.existsSync;',
			'export const readlinkSync = realFs.readlinkSync;',
			'export function readFileSync(path, opts) {',
			'  if (path === cmdlinePath && errno !== undefined && errno !== "") {',
			'    throw Object.assign(new Error(`fault-injected ${errno} reading ${path}`), { code: errno });',
			'  }',
			'  return realFs.readFileSync(path, opts);',
			'}',
			'export function readdirSync(path, opts) {',
			'  const entries = realFs.readdirSync(path, opts);',
			'  if (hide && path === "/proc") return entries.filter((name) => String(name) !== String(pid));',
			'  return entries;',
			'}'
		].join('\n'),
		'utf8'
	);
	writeFileSync(
		join(harness, 'shim-loader.mjs'),
		[
			'export function resolve(specifier, context, nextResolve) {',
			"  const parent = context.parentURL ?? '';",
			"  if ((specifier === 'node:fs' || specifier === 'fs') && parent.endsWith('buildWrap.js')) {",
			"    return { url: new URL('./fs-shim.mjs', import.meta.url).href, shortCircuit: true };",
			'  }',
			'  return nextResolve(specifier, context);',
			'}'
		].join('\n'),
		'utf8'
	);
	writeFileSync(
		join(harness, 'register.mjs'),
		"import { register } from 'node:module';\nregister('./shim-loader.mjs', import.meta.url);\n",
		'utf8'
	);
	const script = `
		const { statusOf } = await import(${JSON.stringify(EMITTED)});
		try {
			const observed = statusOf(${JSON.stringify(patchesDir)}, ${JSON.stringify(CHANNEL.name)}, {});
			console.log('STATE ' + observed.state);
		} catch (error) {
			const hint = error && typeof error.toPayload === 'function' ? error.toPayload().hint : '';
			console.log('THREW ' + (error && error.message ? error.message : String(error)) + (hint ? ' :: ' + hint : ''));
		}
	`;
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env['CK_PROC_PID'] = String(pid);
	env['CK_PROC_ERRNO'] = options.errno ?? '';
	env['CK_PROC_HIDE_TABLE'] = options.hideFromTable ? '1' : '0';
	return execFileSync(process.execPath, ['--import', join(harness, 'register.mjs'), '--input-type=module', '-e', script], {
		env,
		encoding: 'utf8',
		timeout: 8000
	}).trim();
}

// The /proc branch exists only on linux; elsewhere production probes through ps
// or PowerShell, and the fault-injected fs would never be consulted.
const onProc = process.platform === 'linux' && existsSync('/proc');

describe('the /proc probe discriminates "invisible" from "absent"', () => {
	it.skipIf(!onProc).each(['EACCES', 'EPERM'] as const)('refuses on %s instead of certifying the daemon dead', (errno) => {
		const current = fixture(`proc-fault-${errno}`);
		plant(current, plantedRecord(current, 424_242));
		const outcome = probeEmitted(current.patchesDir, 424_242, { errno });
		// The refusal names the unreadable process and leaves the record alone;
		// "dead" here is precisely the audit's duplicate-watcher leak.
		expect(outcome).toMatch(/^THREW cannot inspect process 424242/);
		expect(outcome).not.toMatch(/dead/);
		expect(outcome).toContain('Daemon records were left untouched');
	});

	it.skipIf(!onProc)('still answers dead for a pid the kernel says is gone: the refusal is reserved for invisibility', () => {
		const current = fixture('proc-fault-enoent');
		plant(current, plantedRecord(current, 424_242));
		expect(probeEmitted(current.patchesDir, 424_242, { errno: 'ENOENT' })).toBe('STATE dead');
	});

	it.skipIf(!onProc)('keeps a probeable leader living even when the process table hides it', () => {
		const current = fixture('proc-fault-hidden-table');
		// A real leader answering with the recorded argv (hidepid=1 shape: the
		// table omits it, the direct read still works).
		const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', CHANNEL.script], {
			detached: true,
			stdio: 'ignore'
		});
		try {
			expect(leader.pid).toBeGreaterThan(0);
			plant(current, plantedRecord(current, leader.pid as number));
			expect(probeEmitted(current.patchesDir, leader.pid as number, { hideFromTable: true })).toBe('STATE living');
		} finally {
			try {
				process.kill(-(leader.pid as number), 'SIGKILL');
			} catch {
				// Already gone, which is what we wanted.
			}
		}
	});
});
