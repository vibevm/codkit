// The per-tree lock (PROP-006 sec. 2, ##LOCK-MECHANISM).

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import {
	acquireLock,
	acquirePathLock,
	assertOwnedLockHandle,
	isOwnedLockHandle,
	lockPath,
	lockWriteFailure,
	readLock,
	withLock
} from '../../src/lib/lock.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

/** A pid that is not running. Linux caps pids well below this by default. */
const DEAD_PID = 999999;

const TREE_ID = '0123456789abcdef';

type WorkerMessage =
	| { readonly kind: 'ready'; readonly id: number }
	| { readonly kind: 'outcome'; readonly id: number; readonly status: 'acquired'; readonly nonce: string }
	| { readonly kind: 'outcome'; readonly id: number; readonly status: 'error'; readonly code?: string; readonly message: string };

const CONTENDER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
	const { acquirePathLock, lockPath } = await import(workerData.moduleUrl);
	const gates = new Int32Array(workerData.gates);
	try {
		const handle = acquirePathLock(lockPath(workerData.patchset, workerData.treeId), 'worker-' + workerData.id, () => {
			parentPort.postMessage({ kind: 'ready', id: workerData.id });
			Atomics.wait(gates, workerData.id, 0);
		});
		parentPort.postMessage({ kind: 'outcome', id: workerData.id, status: 'acquired', nonce: handle.info.nonce });
		Atomics.wait(gates, 2, 0);
		handle.release();
	} catch (error) {
		parentPort.postMessage({
			kind: 'outcome',
			id: workerData.id,
			status: 'error',
			code: error && error.code,
			message: error instanceof Error ? error.message : String(error)
		});
	}
})().catch((error) => {
	parentPort.postMessage({ kind: 'outcome', id: workerData.id, status: 'error', message: String(error) });
});
`;

afterAll(() => {
	cleanupTempRoots();
});

describe('acquireLock', () => {
	it.each(['EACCES', 'EPERM', 'EROFS'])('maps %s runtime-lock failures to TREE-READONLY', (code) => {
		const cause = Object.assign(new Error(`${code}: fixture lock refusal`), { code });
		const error = lockWriteFailure(cause, '/work/patchset');

		expect(isCkError(error) && error.code).toBe('TREE-READONLY');
		expect(isCkError(error) && error.message).toContain('/work/patchset/.codkit');
		expect(isCkError(error) && error.hint).toContain('mount /work/patchset/.codkit read-write');
	});

	it('does not relabel unrelated lock I/O failures', () => {
		const cause = Object.assign(new Error('ENOSPC: fixture disk full'), { code: 'ENOSPC' });
		expect(lockWriteFailure(cause, '/work/patchset')).toBe(cause);
	});

	it('issues an unforgeable live in-process capability', () => {
		const root = makeTempRoot('lock-capability');
		const handle = acquireLock(root, TREE_ID, 'capability');
		expect(isOwnedLockHandle(handle)).toBe(true);
		expect(() => assertOwnedLockHandle(handle, 'cycle apply')).not.toThrow();
		const clone = { path: handle.path, info: handle.info, release() {} };
		expect(isOwnedLockHandle(clone)).toBe(false);
		expect(() => assertOwnedLockHandle(clone, 'cycle apply')).toThrow(/live lock handle/);
		handle.release();
		expect(isOwnedLockHandle(handle)).toBe(false);
		expect(() => assertOwnedLockHandle(handle, 'cycle apply')).toThrow(/live lock handle/);
	});

	it('creates the lock file with pid, start time and command', () => {
		const patchset = makeTempRoot('lock-basic');
		const handle = acquireLock(patchset, TREE_ID, 'sync');

		expect(handle.path).toBe(lockPath(patchset, TREE_ID));
		expect(existsSync(handle.path)).toBe(true);
		const written = JSON.parse(readFileSync(handle.path, 'utf8')) as Record<string, unknown>;
		expect(written['pid']).toBe(process.pid);
		expect(written['command']).toBe('sync');
		expect(typeof written['startedAt']).toBe('string');
		expect(typeof written['nonce']).toBe('string');

		handle.release();
		expect(existsSync(handle.path)).toBe(false);
		// Releasing twice is not an error.
		handle.release();
	});

	it.each(['../escape', '..', 'a/b', 'a\\b', 'CON', 'nul.txt'])('rejects unsafe lock id %s before any write', (id) => {
		const patchset = makeTempRoot('lock-unsafe-id');
		const outside = makeTempRoot('lock-unsafe-id-outside');
		const sentinel = join(outside, 'sentinel.txt');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		expect(() => acquireLock(patchset, id, 'unsafe')).toThrow(/unsafe lock id/);
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
		expect(existsSync(join(patchset, '.codkit'))).toBe(false);
	});

	it.each(['codkit', 'locks'] as const)('does not follow a symlinked .codkit %s ancestor', (level) => {
		const patchset = makeTempRoot('lock-symlink');
		const outside = makeTempRoot('lock-symlink-outside');
		const sentinel = join(outside, 'sentinel.txt');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		// NTFS junctions exercise directory reparse refusal without symlink privilege.
		const linkKind = process.platform === 'win32' ? 'junction' : 'dir';
		if (level === 'codkit') symlinkSync(outside, join(patchset, '.codkit'), linkKind);
		else {
			mkdirSync(join(patchset, '.codkit'));
			symlinkSync(outside, join(patchset, '.codkit', 'locks'), linkKind);
		}
		expect(() => acquireLock(patchset, TREE_ID, 'symlink')).toThrow(/unsafe lock path|symlink/);
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
		expect(existsSync(join(outside, `${TREE_ID}.lock`))).toBe(false);
	});

	it('refuses while a live process holds it', () => {
		const patchset = makeTempRoot('lock-busy');
		const first = acquireLock(patchset, TREE_ID, 'sync');
		try {
			expect(() => acquireLock(patchset, TREE_ID, 'save')).toThrowError(/pid \d+/);
			try {
				acquireLock(patchset, TREE_ID, 'save');
			} catch (error) {
				expect(isCkError(error) && error.code).toBe('LOCKED');
				expect(isCkError(error) && error.hint).toContain(String(process.pid));
			}
		} finally {
			first.release();
		}
	});

	it('takes over a lock whose owner is gone, with a warning', () => {
		const patchset = makeTempRoot('lock-stale');
		const path = lockPath(patchset, TREE_ID);
		acquireLock(patchset, TREE_ID, 'sync').release();
		writeFileSync(path, JSON.stringify({ pid: DEAD_PID, startedAt: '2026-01-01T00:00:00.000Z', command: 'sync' }), 'utf8');

		const warnings: string[] = [];
		const handle = acquireLock(patchset, TREE_ID, 'sync', (text) => warnings.push(text));

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('stale lock');
		expect(warnings[0]).toContain(String(DEAD_PID));
		expect(readLock(path)?.pid).toBe(process.pid);
		handle.release();
	});

	it('takes over a lock file that names nobody', () => {
		const patchset = makeTempRoot('lock-broken');
		const path = lockPath(patchset, TREE_ID);
		acquireLock(patchset, TREE_ID, 'sync').release();
		writeFileSync(path, 'not json at all', 'utf8');

		const warnings: string[] = [];
		acquireLock(patchset, TREE_ID, 'sync', (text) => warnings.push(text)).release();

		expect(warnings[0]).toContain('unreadable owner');
		expect(existsSync(path)).toBe(false);
	});

	it('serializes contenders that both inspected the same stale generation', async () => {
		const patchset = makeTempRoot('lock-stale-race');
		const path = lockPath(patchset, TREE_ID);
		const stale = acquirePathLock(path, 'seed');
		writeFileSync(path, JSON.stringify({ ...stale.info, pid: DEAD_PID }), 'utf8');

		const gates = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
		const gateView = new Int32Array(gates);
		const moduleUrl = new URL('../../src/lib/lock.ts', import.meta.url).href;
		const workers = [0, 1].map(
			(id) => new Worker(CONTENDER_SOURCE, { eval: true, workerData: { id, gates, moduleUrl, treeId: TREE_ID, patchset } })
		);

		try {
			const ready = await Promise.all(workers.map(nextMessage));
			expect(ready).toEqual([
				{ kind: 'ready', id: 0 },
				{ kind: 'ready', id: 1 }
			]);

			const firstOutcome = nextMessage(workers[0]!);
			openGate(gateView, 0);
			const first = await firstOutcome;
			expect(first).toMatchObject({ kind: 'outcome', id: 0, status: 'acquired' });

			const secondOutcome = nextMessage(workers[1]!);
			openGate(gateView, 1);
			const second = await secondOutcome;
			expect(second).toMatchObject({ kind: 'outcome', id: 1, status: 'error', code: 'LOCKED' });
			expect(readLock(path)?.nonce).toBe(first.kind === 'outcome' && first.status === 'acquired' ? first.nonce : undefined);
		} finally {
			openGate(gateView, 0);
			openGate(gateView, 1);
			openGate(gateView, 2);
			await Promise.all(workers.map((worker) => worker.terminate()));
			stale.release();
		}
	});

	it('does not let an old handle release a successor generation', () => {
		const patchset = makeTempRoot('lock-release-race');
		const path = lockPath(patchset, TREE_ID);
		const first = acquirePathLock(path, 'first');

		// Model a completed stale takeover: the old public name is gone, while
		// its handle still retains the private ownership link.
		rmSync(path);
		const successor = acquirePathLock(path, 'successor');
		first.release();

		expect(readLock(path)?.nonce).toBe(successor.info.nonce);
		successor.release();
		expect(existsSync(path)).toBe(false);
	});
});

describe('withLock', () => {
	it('releases the lock when the body throws', () => {
		const patchset = makeTempRoot('lock-throw');
		expect(() =>
			withLock(patchset, TREE_ID, 'sync', () => {
				expect(existsSync(lockPath(patchset, TREE_ID))).toBe(true);
				throw new Error('boom');
			})
		).toThrowError('boom');

		expect(existsSync(lockPath(patchset, TREE_ID))).toBe(false);
		// And the next command can take it.
		withLock(patchset, TREE_ID, 'sync', () => 0);
	});

	it('returns the value of the body', () => {
		const patchset = makeTempRoot('lock-value');
		expect(withLock(patchset, TREE_ID, 'sync', () => 42)).toBe(42);
	});
});

function nextMessage(worker: Worker): Promise<WorkerMessage> {
	return new Promise((resolve, reject) => {
		worker.once('message', (message: WorkerMessage) => resolve(message));
		worker.once('error', reject);
	});
}

function openGate(gates: Int32Array, index: number): void {
	Atomics.store(gates, index, 1);
	Atomics.notify(gates, index);
}
