import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { acquireLock, acquirePathLock, isOwnedLockHandle, lockPath, readLock } from '../../src/lib/lock.ts';
import { PATCHSET_WRITER_LOCK_ID } from '../../src/lib/patchsetWriter.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
it('refuses an unknown foreign lock owner instead of assuming another checkout scope is idle', () => {
	const root = makeTempRoot('checkout-unknown');
	const seed = acquireLock(root, 'fork-old', 'seed');
	seed.release();
	writeFileSync(lockPath(root, 'fork-old'), 'unreadable ownership record');
	expect(() => acquireLock(root, 'fork-new', 'sync')).toThrow(/unknown owner/);
	expect(readLock(lockPath(root, PATCHSET_WRITER_LOCK_ID))).toBeNull();
});
it('refuses a second tree writer on the same checkout, even in the same process', () => {
	const root = makeTempRoot('checkout-writer');
	const first = acquireLock(root, 'fork-a', 'save');
	try {
		expect(() => acquireLock(root, 'fork-b', 'sync')).toThrow(/already working/);
	} finally {
		first.release();
	}
	const next = acquireLock(root, 'fork-b', 'sync');
	next.release();
	expect(readLock(lockPath(root, PATCHSET_WRITER_LOCK_ID))).toBeNull();
});
it('allows explicit nested capabilities and keeps the guard until every child releases', () => {
	const root = makeTempRoot('checkout-nested');
	const parent = acquireLock(root, 'cycle-global', 'cycle');
	const child = acquireLock(root, 'fork-a', 'cycle', undefined, parent);
	parent.release();
	expect(isOwnedLockHandle(parent)).toBe(false);
	expect(isOwnedLockHandle(child)).toBe(true);
	expect(() => acquireLock(root, 'fork-b', 'save')).toThrow();
	child.release();
	child.release();
	expect(readLock(lockPath(root, PATCHSET_WRITER_LOCK_ID))).toBeNull();
});
it('refuses copied, released and foreign-checkout parent capabilities', () => {
	const root = makeTempRoot('checkout-parent');
	const other = makeTempRoot('checkout-other');
	const parent = acquireLock(root, 'cycle-global', 'cycle');
	try {
		expect(() => acquireLock(root, 'fork-a', 'cycle', undefined, { ...parent })).toThrow(/owned by this process/);
		expect(() => acquireLock(other, 'fork-a', 'cycle', undefined, parent)).toThrow(/does not own this patchset/);
	} finally {
		parent.release();
	}
	expect(() => acquireLock(root, 'fork-a', 'cycle', undefined, parent)).toThrow(/owned by this process/);
});
it('shares writer exclusion through a physical directory alias but allows separate checkouts', () => {
	const root = makeTempRoot('checkout-physical');
	const aliases = makeTempRoot('checkout-alias');
	const alias = join(aliases, 'same');
	symlinkSync(root, alias, 'junction');
	const first = acquireLock(root, 'fork-a', 'save');
	try {
		expect(() => acquireLock(alias, 'fork-b', 'sync')).toThrow();
		const separate = acquireLock(makeTempRoot('checkout-independent'), 'fork-b', 'sync');
		separate.release();
	} finally {
		first.release();
	}
});
it('refuses a live legacy tree-lock owner and unwinds failed reservations', () => {
	const root = makeTempRoot('checkout-legacy');
	const old = acquirePathLock(lockPath(root, 'fork-old'), 'legacy save');
	try {
		expect(() => acquireLock(root, 'fork-new', 'sync')).toThrow(/owns this patchset checkout/);
	} finally {
		old.release();
	}
	expect(readLock(lockPath(root, PATCHSET_WRITER_LOCK_ID))).toBeNull();
	const fresh = acquireLock(root, 'fork-new', 'sync');
	fresh.release();
});
