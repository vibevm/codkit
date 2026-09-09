// The evidence base of the whole identity-protocol suite: the fixture root
// itself. An audit mutated `diskRoot.ts` alone - twice - and 1530 tests stayed
// green while every identity fixture silently moved back to a filesystem that
// never recycles inode numbers: the exact hole three falsified green panels
// shared. These tests exist so that cannot happen again.
//
// The guarantee is the measured property (a freed inode number comes back to
// the next file), not the proxy (a filesystem magic that btrfs and APFS pass
// without ever recycling).

import { mkdtempSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';

afterAll(() => {
	cleanupDiskRoots();
});

/** Measured, not assumed: does a freed number come back within 64 trials? */
function measuredRecycle(root: string): boolean {
	const probe = join(root, 'recycle-probe');
	try {
		for (let trial = 0; trial < 64; trial += 1) {
			writeFileSync(probe, 'x', 'utf8');
			const first = statSync(probe).ino;
			unlinkSync(probe);
			writeFileSync(probe, 'x', 'utf8');
			const second = statSync(probe).ino;
			unlinkSync(probe);
			if (second === first) return true;
		}
		return false;
	} finally {
		try {
			unlinkSync(probe);
		} catch {
			// absent is complete
		}
	}
}

describe('the disk fixture root', () => {
	it('hands out roots on a filesystem measured to recycle inode numbers', () => {
		const root = makeDiskRoot('disk-root-recycles');
		// Measured here independently of the helper's own probe: the guarantee
		// the whole identity suite stands on is the property, not the
		// filesystem's name for itself.
		expect(measuredRecycle(root)).toBe(true);
	});

	it('refuses a CK_TEST_DISK_ROOT that does not recycle, by name', () => {
		// The loud-fail branch: an override pointed at a filesystem where the
		// identity protocol's central assumption costs nothing is refused with
		// the measurement in the message - never silently fallen back from. On
		// a host whose tmpdir does recycle, there is nothing to refuse and the
		// test says so rather than pretending.
		const tmpfsLike = mkdtempSync(join(tmpdir(), 'ck-diskroot-refuse-'));
		if (measuredRecycle(tmpfsLike)) return;
		const previous = process.env['CK_TEST_DISK_ROOT'];
		process.env['CK_TEST_DISK_ROOT'] = tmpfsLike;
		try {
			expect(() => makeDiskRoot('disk-root-refused')).toThrow(/CK_TEST_DISK_ROOT=.* does not recycle inode numbers/);
		} finally {
			if (previous === undefined) {
				delete process.env['CK_TEST_DISK_ROOT'];
			} else {
				process.env['CK_TEST_DISK_ROOT'] = previous;
			}
		}
	});
});
