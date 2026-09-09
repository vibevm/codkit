// Fixture roots on a filesystem that recycles inode numbers.
//
// The identity protocol under test - dev/ino bindings, link counting, the
// hard-link elections of PROP-010 ##DAEMON-CHANNEL-LOCK - is only meaningfully
// exercised on a filesystem where a freed inode number can be handed to the
// next file: on tmpfs the numbers come from a monotone counter and are never
// reused, so a guard whose soundness depends on that recycling runs in the one
// place its central assumption costs nothing. That is how a falsified inode
// binding stayed green for three consecutive rounds: every fixture root in
// this suite came from `os.tmpdir()`, which is tmpfs on this machine and on
// modern Linux defaults, while a real `.codkit/locks` lives on the
// repository's own filesystem.
//
// "Not tmpfs" is a proxy, not the property: btrfs and APFS allocate inode
// numbers from a monotone per-volume counter and never reuse them either, and
// overlayfs synthesises its numbers. The helper therefore measures the
// property itself - create, unlink, create again, and require the same number
// back within a bounded number of trials - and a candidate that cannot show
// recycling is unusable, whatever its filesystem magic says.
//
// This module picks such a root EXPLICITLY and fails loudly when none can be
// found. A silent fallback to `tmpdir()` is not a smaller version of the
// guarantee; it is the hole itself.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Bounded trials: a recycling filesystem hands the number back essentially immediately; a non-recycling one never does. */
const REUSE_TRIALS = 64;
/** The measured answer per candidate, so one process probes a directory once. */
const measured = new Map<string, boolean>();

/**
 * Whether a freed inode number comes back to the next file in `candidate`,
 * measured, not inferred from the filesystem type.
 */
function recyclesInodeNumbers(candidate: string): boolean {
	const key = realpathSync(candidate);
	const known = measured.get(key);
	if (known !== undefined) return known;
	const probe = join(key, `.ck-recycle-probe-${process.pid.toString(36)}`);
	let answer = false;
	try {
		for (let trial = 0; trial < REUSE_TRIALS && !answer; trial += 1) {
			writeFileSync(probe, 'x', 'utf8');
			const first = statSync(probe).ino;
			unlinkSync(probe);
			writeFileSync(probe, 'x', 'utf8');
			const second = statSync(probe).ino;
			unlinkSync(probe);
			answer = second === first;
		}
	} catch {
		answer = false;
	}
	measured.set(key, answer);
	return answer;
}

const created: string[] = [];

/**
 * Create a fixture root on a filesystem measured to recycle inode numbers,
 * failing loudly when no such root exists. `CK_TEST_DISK_ROOT` overrides the
 * candidate list for environments where `/var/tmp` is not what this machine
 * makes of it; an override that does not recycle is refused by name, not
 * fallen back from.
 */
export function makeDiskRoot(label: string): string {
	const override = process.env['CK_TEST_DISK_ROOT'];
	const candidates = override !== undefined && override !== '' ? [override] : ['/var/tmp', process.env['TMPDIR'] ?? '', tmpdir()];
	for (const candidate of candidates) {
		if (candidate === '') continue;
		let usable = true;
		try {
			usable = recyclesInodeNumbers(candidate);
		} catch {
			usable = false;
		}
		if (!usable) {
			if (override !== undefined && override !== '') {
				throw new Error(
					`CK_TEST_DISK_ROOT=${override} does not recycle inode numbers (measured: create/unlink/create, ` +
						`${REUSE_TRIALS} trials); identity fixtures are meaningless there - point it at a disk filesystem that does`
				);
			}
			continue;
		}
		try {
			const base = realpathSync(mkdtempSync(join(realpathSync(candidate), `ck-${label}-`)));
			created.push(base);
			// The same deep, unrelated nesting as `makeTempRoot`: nothing may
			// rely on a flat layout on this root either.
			const nested = join(base, 'deep', 'nested', `d${Math.random().toString(36).slice(2, 10)}`);
			mkdirSync(nested, { recursive: true });
			return nested;
		} catch {
			continue;
		}
	}
	throw new Error(
		`no fixture root that recycles inode numbers found for '${label}' (tried: ${candidates.join(', ')}); ` +
			'set CK_TEST_DISK_ROOT to a writable directory on such a filesystem - do not point it at tmpfs'
	);
}

/** Remove everything makeDiskRoot handed out during this test file. */
export function cleanupDiskRoots(): void {
	while (created.length > 0) {
		const path = created.pop();
		if (path === undefined) {
			continue;
		}
		rmSync(path, { recursive: true, force: true });
	}
}
