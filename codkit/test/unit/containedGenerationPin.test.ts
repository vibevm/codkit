// Adversarial evidence for the pass-start pin of `containedGeneration.ts`
// (PROP-010 ##DAEMON-CHANNEL-LOCK, ##DAEMON-LOCK-CLAIM-OWNER): the suite this
// chain added when it learned that a hold opened AFTER the election compares
// whatever stands at the name against itself - a tautology on every
// filesystem - and that the guard actually carrying the reproduced failure
// was the link-count re-read beside it.
//
// The instruments here are deliberately recycling-free: every successor is a
// different file object moved in by name, with the held original kept alive
// under another name, so each assertion holds on every filesystem - the flaky
// pin an audit rejected ("RED alone, GREEN beside its siblings") is not
// rebuilt on the same luck.
//
// Every fixture lives on the disk fixture root (`makeDiskRoot`), which is
// measured - not assumed - to recycle inode numbers.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	linkContainedFileExclusive,
	removeContainedHardlinkGeneration,
	removeContainedOrphanGeneration
} from '../../src/lib/containedGeneration.ts';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';

afterAll(() => {
	cleanupDiskRoots();
});

const LOCKS = '.codkit/locks';
const PUBLIC = `${LOCKS}/daemon-0.lock`;
/** No process may carry this pid: it is above the kernel's own ceiling. */
const DEAD_PID = 4194305;

function orphan(label: string): { root: string; parent: string; publicPath: string } {
	const root = makeDiskRoot(label);
	const parent = join(root, ...LOCKS.split('/'));
	mkdirSync(parent, { recursive: true });
	writeFileSync(join(parent, 'daemon-0.lock'), '{"lock":1}\n', 'utf8');
	return { root, parent, publicPath: join(parent, 'daemon-0.lock') };
}

const contender = { claimant: { pid: process.pid, nonce: randomUUID() }, claimantAlive: (pid: number): boolean => pid === process.pid };

function successorFixture(): { bytes: string; ownerName: string } {
	const nonce = randomUUID();
	const bytes = `${JSON.stringify({ codkitDaemonChannelLock: 1, key: '0'.repeat(64), channel: 'probe', pid: 424298, nonce })}\n`;
	return { bytes, ownerName: `daemon-0.lock.${nonce}.owner` };
}

describe('the pass-start pin makes the pre-unlink proof a real identity proof', () => {
	it('refuses to unlink a successor the held claim does not name', () => {
		// The deterministic pin of the inode binding. A contender pauses after
		// winning its election; the publication it held is retired and a
		// successor - a DIFFERENT file object, with the original kept alive
		// under 'x-held' so its number cannot be recycled into anything - takes
		// the public name. Only the binding can refuse, and it must: the
		// contender's claim names the held inode, not the successor. Neutering
		// the binding (identity from a path stat at the proof) makes this test
		// red on every filesystem, no recycling luck involved.
		const fixture = orphan('pin-successor-orphan');
		const successor = successorFixture();
		let claimNamed = '';
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender,
			afterElection: () => {
				const shape = statSync(fixture.publicPath);
				const claimPath = join(fixture.parent, `daemon-0.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`);
				claimNamed = JSON.parse(readFileSync(claimPath, 'utf8')).ino.toString();
				renameSync(fixture.publicPath, join(fixture.parent, 'x-held'));
				writeFileSync(fixture.publicPath, successor.bytes, 'utf8');
			}
		});
		expect(outcome).toBe('lost');
		// The successor survives byte for byte, the held original survives
		// under its holding name, and the contender's claim named the held
		// inode - the unlink it never made would have taken a file its own
		// claim did not name.
		expect(readFileSync(fixture.publicPath, 'utf8')).toBe(successor.bytes);
		expect(readFileSync(join(fixture.parent, 'x-held'), 'utf8')).toBe('{"lock":1}\n');
		expect(statSync(fixture.publicPath).ino.toString()).not.toBe(claimNamed);
		expect(readdirSync(fixture.parent).sort()).toEqual(['daemon-0.lock', 'x-held']);
	});

	it('loses to a live successor generation, not only to an orphan', () => {
		// The same window with the successor owned: nlink 2. The binding
		// refuses before the link count is ever read, which is what separates
		// the held proof from the tautology it replaced - there, this case
		// survived only because the re-read link count caught it one statement
		// later.
		const fixture = orphan('pin-successor-live');
		const successor = successorFixture();
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender,
			afterElection: () => {
				renameSync(fixture.publicPath, join(fixture.parent, 'x-held'));
				writeFileSync(fixture.publicPath, successor.bytes, 'utf8');
				linkSync(fixture.publicPath, join(fixture.parent, successor.ownerName));
			}
		});
		expect(outcome).toBe('lost');
		expect(readFileSync(fixture.publicPath, 'utf8')).toBe(successor.bytes);
		expect(existsSync(join(fixture.parent, successor.ownerName))).toBe(true);
		expect(statSync(fixture.publicPath).nlink).toBe(2);
	});

	it('elects two contenders that held the same inode onto one claim name', () => {
		// The election's atomicity under the pin: the claim name derives from
		// the held identity, so a second contender on the same inode derives
		// the same name. The first is paused after publishing its claim; the
		// second sees that live claim and loses before its own publication -
		// the collision the fixed name exists to force.
		const fixture = orphan('pin-same-inode-collision');
		let second: string | null = null;
		const first = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender,
			afterElection: () => {
				second = removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender });
			}
		});
		expect(first).toBe('removed');
		expect(second).toBe('lost');
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('never retires a claim a peer replaced at the fixed name', () => {
		// The winner's own `finally` unlinks its claim by path; the sweep has
		// re-proved since REPAIR-013, and the retirement now re-proves too: the
		// shape published by the election is captured when the publication
		// lands, and the cleanup unlinks only that file. A peer's claim that
		// took the fixed name in the window survives the winner's exit.
		const fixture = orphan('pin-finally-reproof');
		const shape = statSync(fixture.publicPath);
		const claimPath = join(fixture.parent, `daemon-0.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`);
		const heldClaim = join(fixture.parent, 'contender-claim-held');
		const peerClaim = `${JSON.stringify({ codkitOrphanClaim: 1, dev: shape.dev, ino: shape.ino, pid: process.pid, nonce: randomUUID() }, null, 2)}\n`;
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender,
			afterClaimProof: () => {
				// The contender's claim is renamed away ALIVE - not unlinked -
				// before the peer's takes the fixed name, so the peer's inode
				// is provably not the contender's on every filesystem: an
				// unlink+create in one directory could recycle the number.
				renameSync(claimPath, heldClaim);
				writeFileSync(claimPath, peerClaim, 'utf8');
			}
		});
		expect(outcome).toBe('removed');
		expect(readFileSync(claimPath, 'utf8')).toBe(peerClaim);
		// The contender's own claim is skipped at the fixed name and survives
		// under its holding name: the cleanup unlinked nothing it could not
		// prove was its own.
		expect(existsSync(heldClaim)).toBe(true);
		expect(existsSync(fixture.publicPath)).toBe(false);
	});
});

describe('the fresh occupancy read separates a competitor from damage', () => {
	it('refuses a directory planted at the fixed claim name as a directory', () => {
		// The refusal names the state it refuses: a directory is not "a file
		// that does not parse as a claim", and an operator following the old
		// hint against one got EISDIR.
		const fixture = orphan('occupy-directory');
		const shape = statSync(fixture.publicPath);
		mkdirSync(join(fixture.parent, `daemon-0.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`));
		expect(() => removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender })).toThrow(
			/the claim name .* is occupied by a directory/
		);
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('refuses a FIFO planted at the fixed claim name as a named pipe', () => {
		const fixture = orphan('occupy-fifo');
		const shape = statSync(fixture.publicPath);
		execFileSync('mkfifo', [join(fixture.parent, `daemon-0.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`)]);
		expect(() => removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender })).toThrow(
			/the claim name .* is occupied by a named pipe/
		);
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('refuses a symlink planted at the fixed claim name as a symbolic link', () => {
		const fixture = orphan('occupy-symlink');
		const outside = makeDiskRoot('occupy-symlink-out');
		const sentinel = join(outside, 'sentinel');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		const shape = statSync(fixture.publicPath);
		symlinkSync(sentinel, join(fixture.parent, `daemon-0.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`));
		expect(() => removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender })).toThrow(
			/the claim name .* is occupied by a symbolic link/
		);
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
	});

	it('rethrows a claim read that failed while the file still stands', () => {
		// The mid-read race tolerance of the claim reader: a read that fails
		// while the file provably still stands (here: mode 000, which no peer
		// race can produce) is a real error and must escape, not be skipped as
		// damage. Requires a non-root runner, which this suite already assumes
		// for its /proc-based FIFO probes.
		const fixture = orphan('claim-read-eacces');
		const shape = statSync(fixture.publicPath);
		const path = join(fixture.parent, `daemon-0.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`);
		writeFileSync(
			path,
			`${JSON.stringify({ codkitOrphanClaim: 1, dev: shape.dev, ino: shape.ino, pid: DEAD_PID, nonce: randomUUID() }, null, 2)}\n`,
			'utf8'
		);
		chmodSync(path, 0o000);
		try {
			expect(() => removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender })).toThrow(/EACCES/);
		} finally {
			chmodSync(path, 0o644);
		}
		expect(existsSync(fixture.publicPath)).toBe(true);
	});
});

describe('the private-link election refuses what it cannot prove, by name', () => {
	it('refuses a hard-link source from another directory as a shape rule', () => {
		// The endpoints rule of the exclusive linker: cross-directory endpoints
		// are an argument-shape error this module's own callers must never
		// produce, which is exactly why nothing green held it before.
		const root = makeDiskRoot('link-endpoints');
		expect(() =>
			linkContainedFileExclusive(root, `${LOCKS}/daemon-0.lock.owner`, `${LOCKS}/nested/daemon-0.lock`, { what: 'lock' })
		).toThrow(/hard-link endpoints must share one contained parent/);
	});

	it('refuses to retire a generation whose public and owner names live in different directories', () => {
		// The same argument-shape rule on the retirement path: it returned
		// 'invalid' silently and nothing held it.
		const root = makeDiskRoot('retire-endpoints');
		expect(removeContainedHardlinkGeneration(root, `${LOCKS}/daemon-0.lock`, `${LOCKS}/nested/daemon-0.lock.owner`, { what: 'lock' })).toBe(
			'invalid'
		);
	});

	it('names an absent hard-link source as absent, not as a non-regular file', () => {
		// Reachable in production between the exclusive owner publication and
		// the link: a peer removing the owner file in that window is not a
		// shape problem, and "must be a regular file" sent the operator
		// hunting a FIFO that does not exist.
		const root = makeDiskRoot('link-source-absent');
		expect(() => linkContainedFileExclusive(root, `${LOCKS}/daemon-0.lock.owner`, `${LOCKS}/daemon-0.lock`, { what: 'lock' })).toThrow(
			/the hard-link source is absent/
		);
	});
});
