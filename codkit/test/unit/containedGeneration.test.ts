// Adversarial evidence for the generation election of
// `containedGeneration.ts` (PROP-010 ##DAEMON-CHANNEL-LOCK,
// ##DAEMON-LOCK-CLAIM-OWNER): the orphan recovery, the claim grammar, and the
// two ordered proofs that stand between an elected recoverer and the public
// unlink.
//
// Every guard in that module is held here by a test that fails when that
// guard alone is neutered, and each assertion names the guard it holds to:
// an election lost to an exclusive publication, a claim buried only on a
// provably absent publisher, a successor's generation never unlinked, a
// swapped parent never written into. Interleavings run through the module's
// seams - `beforeOpen` (between the pass-start shape check and the pin open),
// `afterOpen` (after the publication is held, before the claim scan),
// `afterElection` (after the claim is published and the election won, before
// the winner's proofs) and `afterClaimProof` (immediately before the public
// unlink) - or through a real SIGKILLed child. Never through a sleep.
//
// Every fixture here lives on a filesystem that can recycle inode numbers
// (`makeDiskRoot`, which fails loudly when none exists): the dev/ino identity
// this module stands on is exactly the property tmpfs gives away for free and
// a real `.codkit/locks` has to earn.

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { removeContainedFile, writeContainedFileExclusive } from '../../src/lib/containedFile.ts';
import {
	linkContainedFileExclusive,
	removeContainedHardlinkGeneration,
	removeContainedOrphanGeneration
} from '../../src/lib/containedGeneration.ts';
import { ordinarySwap } from '../support/ordinarySwap.ts';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';

afterAll(() => {
	cleanupDiskRoots();
});

const LOCKS = '.codkit/locks';
const PUBLIC = `${LOCKS}/daemon-0.lock`;
const EMITTED_GENERATION = fileURLToPath(new URL('../../dist/lib/containedGeneration.js', import.meta.url));
/** No process may carry this pid: it is above the kernel's own ceiling. */
const DEAD_PID = 4194305;
/** An inode no publication of this fixture ever uses. */
const FOREIGN_DEV = 0x11;
const FOREIGN_INO = 0x22;

/** A named pipe at `path`; the cheapest non-regular leaf. */
function plantFifo(path: string): void {
	mkdirSync(join(path, '..'), { recursive: true });
	execFileSync('mkfifo', [path]);
}

/** A holder killed between its two unlinks: public link left, owner gone. */
function orphan(label: string): { root: string; parent: string; publicPath: string } {
	const root = makeDiskRoot(label);
	const parent = join(root, ...LOCKS.split('/'));
	mkdirSync(parent, { recursive: true });
	writeFileSync(join(parent, 'daemon-0.lock'), '{"lock":1}\n', 'utf8');
	return { root, parent, publicPath: join(parent, 'daemon-0.lock') };
}

/** This process is the only pid that answers alive; every other is buried. */
const selfAlive = (pid: number): boolean => pid === process.pid;

function contender(pid: number = process.pid): { claimant: { pid: number; nonce: string }; claimantAlive: (pid: number) => boolean } {
	return { claimant: { pid, nonce: randomUUID() }, claimantAlive: selfAlive };
}

type PlantedClaim = { readonly dev: number; readonly ino: number; readonly pid: number; readonly nonce: string };

/** The bytes a real recoverer would have published, planted by hand. */
function claimBytes(record: PlantedClaim): string {
	return `${JSON.stringify({ codkitOrphanClaim: 1, ...record }, null, 2)}\n`;
}

/** A claim-shaped regular file beside the publication, named for `dev`/`ino`. */
function plantClaim(parent: string, name: string, record: PlantedClaim, nameDev = record.dev, nameIno = record.ino): string {
	const path = join(parent, `${name}.orphan-${nameDev.toString(16)}-${nameIno.toString(16)}.owner`);
	writeFileSync(path, claimBytes(record), 'utf8');
	return path;
}

/** The claim name a contender of this fixture derives for a publication. */
function derivedClaimName(publicPath: string): string {
	const shape = statSync(publicPath);
	return `daemon-0.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`;
}

describe('an orphaned lock generation is recovered by exactly one contender', () => {
	it('recovers a public generation whose owner link is gone', () => {
		const fixture = orphan('orphan-recover');
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(existsSync(fixture.publicPath)).toBe(false);
		// The finally cleanup: no claim file is left behind to wedge the next contender.
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('refuses an interleaved second contender while the first claim is live', () => {
		// What this pins: a live publisher owns the election even before it has
		// finished. The seam runs inside the first contender, after it has won
		// the election with its published claim and before its proofs; the
		// second contender - the same process, the same liveness oracle - pins
		// the same inode, reads that claim and exits at the live-claim check,
		// never reaching the election itself. The test reaching the election is
		// its sibling below.
		const fixture = orphan('orphan-election');
		let second: 'removed' | 'lost' | 'invalid' | null = null;
		const first = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			afterElection: () => {
				second = removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() });
			}
		});
		// The loser reports a lost election, not `invalid`: `invalid` is a hard
		// refusal one level up, and refusing here would wedge the channel that
		// this recovery exists to unwedge.
		expect(first).toBe('removed');
		expect(second).toBe('lost');
		expect(existsSync(fixture.publicPath)).toBe(false);
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('refuses a claim at the fixed name whose bytes name another inode than its own name', () => {
		// The wedge the residual of B12-4 left: a file that PARSES as a healthy
		// claim occupies the fixed claim name, but its bytes name an inode its
		// own name does not encode. Nothing this module writes can look like
		// that - the name and the bytes are always built from one held
		// identity - so it is damage, and leaving it be would report `stayed
		// contended` forever while it parses as healthy. The honest answer
		// refuses by name; deciding occupancy from a fresh read of the path is
		// what separates this from a live peer's valid claim, which is never
		// damage and never carries a delete hint.
		const fixture = orphan('orphan-occupied-mismatch');
		const shape = statSync(fixture.publicPath);
		const occupantNonce = randomUUID();
		const occupant = plantClaim(
			fixture.parent,
			'daemon-0.lock',
			{ dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: process.pid, nonce: occupantNonce },
			shape.dev,
			shape.ino
		);
		expect(() => removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toThrow(
			/the claim name .* is occupied by a claim whose bytes do not name the inode its own name encodes/
		);
		expect(readFileSync(occupant, 'utf8')).toBe(claimBytes({ dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: process.pid, nonce: occupantNonce }));
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('refuses unattributable damage at the fixed claim name instead of reporting contention', () => {
		// The wedge an audit named: bytes that do not parse as a claim occupy the
		// one fixed claim name, the exclusive publication can never land, and
		// answering 'lost' here would have the caller report three rounds of
		// 'stayed contended' for damage no contention produced. The honest
		// answer is a refusal that names the file for the operator to remove -
		// never a write over it, never an unlink reached, never a burial.
		const fixture = orphan('orphan-occupied-name');
		const squatter = join(fixture.parent, derivedClaimName(fixture.publicPath));
		writeFileSync(squatter, 'not json\n', 'utf8');
		expect(() => removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toThrow(
			/the claim name .* is occupied by a file that does not parse as a claim/
		);
		expect(readFileSync(squatter, 'utf8')).toBe('not json\n');
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('never buries the claim of a contender that may still be running', () => {
		// The whole point of the publisher in the claim's bytes is that a live
		// one is safe. A sweep that ignores liveness unlinks a live competitor's
		// claim and lets two contenders unlink one public name.
		const fixture = orphan('orphan-live-claim');
		const shape = statSync(fixture.publicPath);
		const live = plantClaim(fixture.parent, 'daemon-0.lock', { dev: shape.dev, ino: shape.ino, pid: process.pid, nonce: randomUUID() });
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('lost');
		expect(existsSync(live)).toBe(true);
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('ignores a live claim on an inode this publication does not use, and leaves it alone', () => {
		// Two guards at once, each with its own assertion: the inode conjunct in
		// the live-claim check (without it this live foreign claim would read as
		// contention and the recovery would report `lost`), and the liveness
		// filter of the sweep (without it this claim would be unlinked).
		const fixture = orphan('orphan-foreign-live');
		const foreign = plantClaim(fixture.parent, 'daemon-0.lock', {
			dev: FOREIGN_DEV,
			ino: FOREIGN_INO,
			pid: process.pid,
			nonce: randomUUID()
		});
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(existsSync(foreign)).toBe(true);
	});

	it('loses to a live claim that names this publication from a foreign name', () => {
		// The whole live-claim check as one statement: this claim's NAME encodes
		// an inode this publication does not use (so it does not occupy the
		// derived claim name and the election cannot refuse it), its publisher
		// is alive, and its BYTES name exactly this publication. Only the
		// live-claim check can refuse; deleting the whole statement lets this
		// contender win the election and unlink the publication. (The two
		// conjuncts each have their own test above; this one pins the guard as
		// a unit, which conjunct-level evidence cannot.)
		const fixture = orphan('orphan-live-claim-foreign-name');
		const shape = statSync(fixture.publicPath);
		const live = plantClaim(
			fixture.parent,
			'daemon-0.lock',
			{ dev: shape.dev, ino: shape.ino, pid: process.pid, nonce: randomUUID() },
			FOREIGN_DEV,
			FOREIGN_INO
		);
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('lost');
		expect(existsSync(live)).toBe(true);
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('never buries a claim that a live publisher replaced inside the sweep window', () => {
		// The sweep's decision was made from bytes read earlier; the unlink acts
		// on a path. In the window between them a peer can bury the dead claim
		// and publish its own live claim at the same fixed name, and unlinking
		// by path would bury a live publisher's claim - putting two contenders
		// in one election. The staged replacement is renamed in from another
		// name so its inode is provably not the dead claim's on every
		// filesystem: an in-place rewrite could recycle the number on one that
		// reuses inodes, which is the documented residual, not this test's
		// subject. The oracle is the instrument: the module calls it inside the
		// exact window.
		const fixture = orphan('orphan-sweep-replaced');
		const shape = statSync(fixture.publicPath);
		const claimPath = plantClaim(fixture.parent, 'daemon-0.lock', { dev: shape.dev, ino: shape.ino, pid: DEAD_PID, nonce: randomUUID() });
		const liveNonce = randomUUID();
		const staged = join(fixture.parent, 'staged-live-claim');
		writeFileSync(staged, claimBytes({ dev: shape.dev, ino: shape.ino, pid: process.pid, nonce: liveNonce }), 'utf8');
		let swapped = false;
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			claimantAlive: (pid) => {
				if (pid === DEAD_PID && !swapped) {
					swapped = true;
					renameSync(staged, claimPath);
				}
				return selfAlive(pid);
			}
		});
		// The replaced claim is live and names this publication: the next pass
		// must read it as a live competitor, never bury it and win.
		expect(outcome).toBe('lost');
		expect(readFileSync(claimPath, 'utf8')).toBe(claimBytes({ dev: shape.dev, ino: shape.ino, pid: process.pid, nonce: liveNonce }));
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('buries the claim of a contender that is provably gone and recovers', () => {
		// A recoverer killed between publishing its claim and unlinking the public
		// name. Before the claim carried a publisher this state was
		// indistinguishable from the live one above, and the channel refused
		// forever.
		const fixture = orphan('orphan-dead-claim');
		const shape = statSync(fixture.publicPath);
		plantClaim(fixture.parent, 'daemon-0.lock', { dev: shape.dev, ino: shape.ino, pid: DEAD_PID, nonce: randomUUID() });
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('sweeps a dead contender claim left on an inode this publication no longer uses', () => {
		// A recoverer killed after its unlink but before its `finally` leaves a
		// claim naming a freed inode. Nothing swept that litter, and a later
		// generation that landed on the same inode collided with it forever.
		const fixture = orphan('orphan-freed-inode');
		plantClaim(fixture.parent, 'daemon-0.lock', { dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: DEAD_PID, nonce: randomUUID() });
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('leaves a sibling that is not a claim alone and still recovers', () => {
		// Debris at a name that does not parse as a claim is somebody else's file:
		// it is neither swept nor allowed to block the election. `notaclaim` is
		// one middle group where the grammar demands exactly two.
		const fixture = orphan('orphan-debris');
		writeFileSync(join(fixture.parent, 'daemon-0.lock.orphan-notaclaim.owner'), 'debris\n', 'utf8');
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(existsSync(fixture.publicPath)).toBe(false);
		expect(readdirSync(fixture.parent)).toEqual(['daemon-0.lock.orphan-notaclaim.owner']);
	});

	it('leaves a claim-shaped sibling carrying an extra name group alone', () => {
		// Three middle groups fail the arity rule of the claim grammar. The bytes
		// are a valid dead claim's, so only the name rule can be refusing - and
		// the sibling must still be there afterwards.
		const fixture = orphan('orphan-arity');
		const sibling = join(fixture.parent, 'daemon-0.lock.orphan-11-22-33.owner');
		writeFileSync(sibling, claimBytes({ dev: 0x11, ino: 0x22, pid: DEAD_PID, nonce: randomUUID() }), 'utf8');
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(existsSync(sibling)).toBe(true);
	});

	it('leaves a claim-shaped sibling with a non-hex name group alone', () => {
		// The hex rule of the claim grammar: inode groups are dev/ino in hex.
		const fixture = orphan('orphan-hex');
		const sibling = join(fixture.parent, 'daemon-0.lock.orphan-11-2z.owner');
		writeFileSync(sibling, claimBytes({ dev: 0x11, ino: 0x22, pid: DEAD_PID, nonce: randomUUID() }), 'utf8');
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(existsSync(sibling)).toBe(true);
	});

	it('leaves a claim of another public name alone', () => {
		// The prefix rule: a claim belongs to one publication name, and a
		// sibling claim of `daemon-1.lock` is not parsed as this publication's.
		const fixture = orphan('orphan-foreign-public');
		const shape = statSync(fixture.publicPath);
		const sibling = join(fixture.parent, `daemon-1.lock.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`);
		writeFileSync(sibling, claimBytes({ dev: shape.dev, ino: shape.ino, pid: DEAD_PID, nonce: randomUUID() }), 'utf8');
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(existsSync(sibling)).toBe(true);
	});

	it('skips a non-regular file at a claim-shaped name instead of reading through it', () => {
		// The shape filter of the claim reader: a symlink at a claim-shaped name
		// is not one of ours, is never read through, and never blocks the
		// election of a claim name it does not occupy.
		const fixture = orphan('orphan-symlink-claim');
		const outside = makeDiskRoot('orphan-symlink-claim-out');
		const sentinel = join(outside, 'sentinel');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		symlinkSync(sentinel, join(fixture.parent, 'daemon-0.lock.orphan-11-22.owner'));
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
		expect(existsSync(join(fixture.parent, 'daemon-0.lock.orphan-11-22.owner'))).toBe(true);
	});

	it('recovers after a real recoverer is SIGKILLed between its claim and its unlink', () => {
		// The crash window itself, with a real signal and a real orphan: the atom
		// two independent audits proved wedged the channel permanently. The
		// child's claim is parsed back here, so the emitted writer and this
		// reader cross - the round-trip the grammar's contract stands on.
		const fixture = orphan('orphan-crash');
		const nonce = randomUUID();
		const child = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
					const { removeContainedOrphanGeneration } = await import(${JSON.stringify(EMITTED_GENERATION)});
					removeContainedOrphanGeneration(${JSON.stringify(fixture.root)}, ${JSON.stringify(PUBLIC)}, {
						what: 'lock',
						claimant: { pid: process.pid, nonce: ${JSON.stringify(nonce)} },
						claimantAlive: () => false,
						afterElection: () => process.kill(process.pid, 'SIGKILL')
					});
				`
			],
			{ timeout: 8000, encoding: 'utf8' }
		);
		// The instrument fired: the child really died inside the window, after
		// publishing its claim and before unlinking the public name.
		expect(child.signal).toBe('SIGKILL');
		// A claim is an ordinary file now, so the publication keeps nlink 1; the
		// claim's presence, not a second link, is the evidence on disk.
		expect(statSync(fixture.publicPath).nlink).toBe(1);
		const claimPath = join(fixture.parent, derivedClaimName(fixture.publicPath));
		const shape = statSync(fixture.publicPath);
		const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
		expect(claim).toEqual({ codkitOrphanClaim: 1, dev: shape.dev, ino: shape.ino, pid: child.pid, nonce });
		// A later contender proves the crashed publisher gone and recovers.
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('refuses a live generation that still has its owner link', () => {
		const fixture = orphan('orphan-live');
		linkSync(fixture.publicPath, join(fixture.parent, 'daemon-0.lock.owner'));
		// With claims being ordinary files, an extra hard link on the publication
		// has exactly one meaning: a holder is alive and holding it. Recovering
		// here would unlink a live winner's public name. The gate refuses before
		// the election: no claim is published and no descriptor opened for a
		// publication somebody else owns - the post-election link-count re-read
		// would refuse too, but only after this contender had raced an election
		// it had no business entering.
		let reached = false;
		expect(
			removeContainedOrphanGeneration(fixture.root, PUBLIC, {
				what: 'lock',
				...contender(),
				afterElection: () => {
					reached = true;
				}
			})
		).toBe('invalid');
		expect(reached).toBe(false);
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('refuses a non-regular publication instead of recovering it', () => {
		// On POSIX the pin open and the descriptor's own shape proof re-refuse
		// this FIFO one statement later, so this lstat gate is equivalent
		// redundancy there and load-bearing only where `O_NOFOLLOW` is 0
		// (win32) - the reached sentinel is what holds the invariant that the
		// election is never entered for a publication that was already
		// refused, whatever branch did the refusing.
		const fixture = orphan('orphan-fifo');
		renameSync(fixture.publicPath, join(fixture.parent, 'held'));
		plantFifo(fixture.publicPath);
		let reached = false;
		expect(
			removeContainedOrphanGeneration(fixture.root, PUBLIC, {
				what: 'lock',
				...contender(),
				afterElection: () => {
					reached = true;
				}
			})
		).toBe('invalid');
		expect(reached).toBe(false);
	});

	it('reports an absent generation as lost rather than removed', () => {
		const fixture = orphan('orphan-absent');
		renameSync(fixture.publicPath, join(fixture.parent, 'held'));
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('lost');
	});
});

describe("the winner's proofs stand between the election and the public unlink", () => {
	it('refuses to recover inside a parent swapped for another ordinary directory', () => {
		// The parent-identity re-proof after the claim is published. The second
		// link on the publication inode is added inside the seam and the
		// original's own name is removed in the same seam, so the replacement
		// carries the publication as its ONLY name: the pass-start gate sees a
		// singly linked publication, the post-election link-count re-read still
		// sees one, the inode-binding proof sees the held inode under the
		// public name - and only the parent comparison can refuse. Deleting it
		// would unlink the publication inside the swapped directory.
		const fixture = ordinarySwap('swap-orphan-parent', LOCKS, { name: 'daemon-0.lock', bytes: '{"lock":1}\n' });
		// Undo the fixture's pre-linked leaf: the gate must see a singly linked
		// publication at pass start.
		unlinkSync(join(fixture.replacement, 'daemon-0.lock'));
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			afterOpen: () => {
				linkSync(join(fixture.parent, 'daemon-0.lock'), join(fixture.replacement, 'daemon-0.lock'));
				unlinkSync(join(fixture.parent, 'daemon-0.lock'));
				fixture.swap();
			}
		});
		expect(outcome).toBe('invalid');
		fixture.expectReplacementUntouched();
	});

	it('reports a public name that vanished between the proofs and the unlink as lost', () => {
		// The ENOENT tolerance of the public unlink - the same shape the private
		// owner path already has. A name somebody else retired in the two
		// statements between the re-proof and the syscall is a lost election,
		// not a crash out of the module.
		const fixture = orphan('orphan-unlink-enoent');
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			afterClaimProof: () => {
				unlinkSync(fixture.publicPath);
			}
		});
		expect(outcome).toBe('lost');
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('refuses at the last proof a live owner that linked the publication during the election', () => {
		// The link count is re-read at the post-election proof, not trusted
		// from the pass-start gate's read: a holder that linked the publication
		// while this contender was publishing its claim shows in the fresh stat
		// alone. Deleting the re-read lets the winner unlink a live owner's
		// publication.
		const fixture = orphan('orphan-late-owner-link');
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			afterElection: () => {
				linkSync(fixture.publicPath, join(fixture.parent, 'daemon-0.lock.late-owner'));
			}
		});
		expect(outcome).toBe('invalid');
		expect(existsSync(fixture.publicPath)).toBe(true);
		expect(existsSync(join(fixture.parent, 'daemon-0.lock.late-owner'))).toBe(true);
		expect(statSync(fixture.publicPath).nlink).toBe(2);
	});

	it('never unlinks a successor publication under the public name', () => {
		// The zero-link classification of the pass-start gate, read live from
		// the held inode: a contender is paused after it has held the
		// publication while a winner retires it and publishes a fresh
		// generation under the public name (every step a real acquisition
		// takes: an exclusive private link, the old publication unlinked, the
		// new one linked). The held inode now has no name at all, which is a
		// lost election - never a refusal, and never an unlink of the
		// successor: the contender's proofs were about the publication it
		// held, and it never entered the successor's election.
		const fixture = orphan('orphan-successor');
		const successorNonce = 'b7c8d9e0-fa1b-4c2d-8e3f-334455667788';
		const successorOwner = `${PUBLIC}.${successorNonce}.owner`;
		const successorBytes = `${JSON.stringify({ codkitDaemonChannelLock: 1, key: '0'.repeat(64), pid: 424244, nonce: successorNonce })}\n`;
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			afterOpen: () => {
				removeContainedFile(fixture.root, PUBLIC, { what: 'lock' });
				expect(writeContainedFileExclusive(fixture.root, successorOwner, { what: 'lock', bytes: Buffer.from(successorBytes) })).toBe(true);
				expect(linkContainedFileExclusive(fixture.root, successorOwner, PUBLIC, { what: 'lock' })).toBe(true);
			}
		});
		expect(outcome).toBe('lost');
		// The live winner's publication survives byte for byte, its private link
		// survives, and the loser's claim was cleaned up by its own finally.
		expect(readFileSync(join(fixture.parent, 'daemon-0.lock'), 'utf8')).toBe(successorBytes);
		expect(existsSync(join(fixture.parent, `daemon-0.lock.${successorNonce}.owner`))).toBe(true);
		expect(readdirSync(fixture.parent).sort()).toEqual(['daemon-0.lock', `daemon-0.lock.${successorNonce}.owner`]);
	});

	it('never unlinks a successor published before the publication was held', () => {
		// The audit's own scenario, made deterministic: a contender held the
		// publication BEFORE a winner retired the orphan and published a fresh
		// generation under the public name, with nothing swept in between (a
		// live foreign claim is no competitor and no debris, so the pass never
		// restarts and re-pins). The held inode now has no name at all, and
		// the pass-start gate reads that live from the descriptor: a lost
		// election, whatever refusal vocabulary applies. Before the pin existed
		// the binding passed against a different file and the live winner's
		// lock was destroyed here.
		const fixture = orphan('orphan-early-successor');
		const successorNonce = 'c3d4e5f6-a7b8-4c9d-8e0f-112233445566';
		const successorOwner = `${PUBLIC}.${successorNonce}.owner`;
		const successorBytes = `${JSON.stringify({ codkitDaemonChannelLock: 1, key: '0'.repeat(64), pid: 424245, nonce: successorNonce })}\n`;
		// The instrument: a live claim on a foreign inode, swept by nothing and
		// competing for nothing - the module calls its oracle inside the exact
		// window between the pass-start stat and the election.
		plantClaim(fixture.parent, 'daemon-0.lock', { dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: process.pid, nonce: randomUUID() });
		let swapped = false;
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			claimantAlive: (pid) => {
				if (pid === process.pid && !swapped) {
					swapped = true;
					// Every step a real acquisition takes, in the order that
					// recycles the freed inode on a filesystem that does: the old
					// publication unlinked first, then the exclusive private link
					// created, then linked under the public name.
					removeContainedFile(fixture.root, PUBLIC, { what: 'lock' });
					expect(writeContainedFileExclusive(fixture.root, successorOwner, { what: 'lock', bytes: Buffer.from(successorBytes) })).toBe(
						true
					);
					expect(linkContainedFileExclusive(fixture.root, successorOwner, PUBLIC, { what: 'lock' })).toBe(true);
				}
				return selfAlive(pid);
			}
		});
		// The live successor must survive byte for byte, whatever verdict
		// vocabulary refuses this contender.
		expect(outcome).not.toBe('removed');
		expect(readFileSync(fixture.publicPath, 'utf8')).toBe(successorBytes);
		expect(existsSync(join(fixture.parent, `daemon-0.lock.${successorNonce}.owner`))).toBe(true);
	});

	it('reports a public name retired between the election and the proof as lost', () => {
		// The binding proof's absent-name tolerance: the pin opened at pass
		// start, so a name that vanishes between the election and the proof is
		// a lost election, never a refusal.
		const fixture = orphan('orphan-pin-enoent');
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			afterElection: () => {
				unlinkSync(fixture.publicPath);
			}
		});
		expect(outcome).toBe('lost');
		expect(readdirSync(fixture.parent)).toEqual([]);
	});

	it('refuses a publication that became a FIFO between the shape check and the pin open, in a child', () => {
		// `O_NONBLOCK` lets this open return; the descriptor's own shape is
		// what refuses. Neutering the flag turns this probe into a hung child
		// under a hard timeout - a red test, never a hung suite: an open of a
		// FIFO blocks inside a synchronous syscall, where no in-process
		// timeout can fire.
		const fixture = orphan('orphan-pin-fifo');
		const child = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
					const { execFileSync } = await import('node:child_process');
					const { renameSync } = await import('node:fs');
					const { removeContainedOrphanGeneration } = await import(${JSON.stringify(EMITTED_GENERATION)});
					const outcome = removeContainedOrphanGeneration(${JSON.stringify(fixture.root)}, ${JSON.stringify(PUBLIC)}, {
						what: 'lock',
						claimant: { pid: process.pid, nonce: ${JSON.stringify(randomUUID())} },
						claimantAlive: () => false,
						beforeOpen: () => {
							renameSync(${JSON.stringify(fixture.publicPath)}, ${JSON.stringify(join(fixture.parent, 'held'))});
							execFileSync('mkfifo', [${JSON.stringify(fixture.publicPath)}]);
						}
					});
					console.log('OUTCOME=' + outcome);
				`
			],
			{ timeout: 8000, encoding: 'utf8' }
		);
		// A NONBLOCK regression hangs the child; the hard timeout kills it and
		// this assertion goes red instead of the suite going quiet.
		expect(child.status).toBe(0);
		expect(child.stdout.trim()).toBe('OUTCOME=invalid');
		expect(statSync(fixture.publicPath).isFIFO()).toBe(true);
		expect(readFileSync(join(fixture.parent, 'held'), 'utf8')).toBe('{"lock":1}\n');
		expect(readdirSync(fixture.parent).sort()).toEqual(['daemon-0.lock', 'held']);
	});

	it('refuses a publication that became a symlink between the shape check and the pin open', () => {
		// `O_NOFOLLOW` makes this open fail rather than follow; the pin must
		// never pin - or unlink through - a link planted at the public name.
		const fixture = orphan('orphan-pin-symlink');
		const outside = makeDiskRoot('orphan-pin-symlink-out');
		const sentinel = join(outside, 'sentinel');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		const outcome = removeContainedOrphanGeneration(fixture.root, PUBLIC, {
			what: 'lock',
			...contender(),
			beforeOpen: () => {
				unlinkSync(fixture.publicPath);
				symlinkSync(sentinel, fixture.publicPath);
			}
		});
		expect(outcome).toBe('invalid');
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
		expect(existsSync(fixture.publicPath)).toBe(true);
	});

	it('leaves no descriptor behind when a recovery is refused mid-proof', () => {
		// The pin is a resource on every exit path; a descriptor leaked per
		// refusal would accumulate for a channel's lifetime. Counting this
		// process's own descriptors around a refused recovery is deterministic
		// here (this suite already requires the same /proc-based platform for
		// its FIFO probes).
		const warm = orphan('orphan-fd-warm');
		expect(
			removeContainedOrphanGeneration(warm.root, PUBLIC, {
				what: 'lock',
				...contender(),
				afterOpen: () => {
					linkSync(warm.publicPath, join(warm.parent, 'late-owner'));
				}
			})
		).toBe('invalid');
		const fixture = orphan('orphan-fd-hygiene');
		const before = readdirSync('/proc/self/fd').length;
		expect(
			removeContainedOrphanGeneration(fixture.root, PUBLIC, {
				what: 'lock',
				...contender(),
				afterOpen: () => {
					linkSync(fixture.publicPath, join(fixture.parent, 'late-owner'));
				}
			})
		).toBe('invalid');
		expect(readdirSync('/proc/self/fd').length).toBe(before);
	});
});

describe('the claim record grammar is a checker, not a comment', () => {
	it('refuses to publish a claim for a claimant whose nonce is not a canonical UUID', () => {
		// The writer's half of the contract: whatever this module publishes must
		// parse as a claim this module reads. A caller passing anything but a
		// canonical UUID nonce would publish claims no successor could attribute
		// - the wedge the claim grammar exists to prevent.
		const fixture = orphan('orphan-bad-nonce');
		expect(() =>
			removeContainedOrphanGeneration(fixture.root, PUBLIC, {
				what: 'lock',
				claimant: { pid: process.pid, nonce: 'NOT-A-UUID' },
				claimantAlive: selfAlive
			})
		).toThrow(/recovery claim nonce must be a canonical UUID/);
		expect(() =>
			removeContainedOrphanGeneration(fixture.root, PUBLIC, {
				what: 'lock',
				claimant: { pid: 0, nonce: randomUUID() },
				claimantAlive: selfAlive
			})
		).toThrow(/recovery claim pid must be a positive integer/);
		expect(existsSync(fixture.publicPath)).toBe(true);
		expect(readdirSync(fixture.parent)).toEqual(['daemon-0.lock']);
	});

	it.each([
		['an unknown field', { dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: DEAD_PID, nonce: randomUUID(), extra: true }],
		['a wrong schema literal', { codkitOrphanClaim: 2, dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: DEAD_PID, nonce: randomUUID() }],
		['a non-canonical nonce', { dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: DEAD_PID, nonce: 'NOT-A-UUID' }],
		['a non-integer pid', { dev: FOREIGN_DEV, ino: FOREIGN_INO, pid: DEAD_PID + 0.5, nonce: randomUUID() }],
		['a negative dev', { dev: -1, ino: FOREIGN_INO, pid: DEAD_PID, nonce: randomUUID() }],
		['a negative ino', { dev: FOREIGN_DEV, ino: -1, pid: DEAD_PID, nonce: randomUUID() }]
	])('leaves a claim-shaped file whose bytes carry %s alone', (_label, record) => {
		// The reader's half: attribution requires proof, and bytes that do not
		// parse against the strict schema prove nothing. Each rule is refused on
		// its own, so neutering any one conjunct turns this left-alone file into
		// swept debris and the existence assertion red. The NAME stays valid for
		// every row - a broken name would be filtered by the grammar before the
		// schema ever sees the bytes.
		const fixture = orphan(`orphan-schema-${_label.replaceAll(' ', '-')}`);
		const sibling = plantClaim(fixture.parent, 'daemon-0.lock', record as PlantedClaim, FOREIGN_DEV, FOREIGN_INO);
		expect(removeContainedOrphanGeneration(fixture.root, PUBLIC, { what: 'lock', ...contender() })).toBe('removed');
		expect(existsSync(sibling)).toBe(true);
	});
});

describe('the private-link election of the sibling retirement path', () => {
	it('refuses to publish a hard link into a swapped ordinary parent', () => {
		// Generation publication itself: the parent-identity check of
		// `linkContainedFileExclusive`.
		const fixture = ordinarySwap('swap-link', LOCKS, { name: 'daemon-0.lock.owner', bytes: '{"lock":1}\n' });
		expect(() =>
			linkContainedFileExclusive(fixture.root, `${LOCKS}/daemon-0.lock.owner`, `${LOCKS}/daemon-0.lock`, {
				what: 'lock',
				afterOpen: fixture.swap
			})
		).toThrow(/hard-link parent identity changed/);
		fixture.expectReplacementUntouched();
	});

	it('refuses a hard-link source that is not a regular file', () => {
		// The source-shape check: a FIFO or a symlink at the source name is not a
		// generation anyone may link into the public name.
		const fifoRoot = makeDiskRoot('link-source-fifo');
		const fifoParent = join(fifoRoot, ...LOCKS.split('/'));
		mkdirSync(fifoParent, { recursive: true });
		plantFifo(join(fifoParent, 'daemon-0.lock.owner'));
		expect(() => linkContainedFileExclusive(fifoRoot, `${LOCKS}/daemon-0.lock.owner`, `${LOCKS}/daemon-0.lock`, { what: 'lock' })).toThrow(
			/hard-link source must be a regular file/
		);
		expect(existsSync(join(fifoParent, 'daemon-0.lock'))).toBe(false);

		const linkRoot = makeDiskRoot('link-source-symlink');
		const linkParent = join(linkRoot, ...LOCKS.split('/'));
		mkdirSync(linkParent, { recursive: true });
		const elsewhere = makeDiskRoot('link-source-elsewhere');
		writeFileSync(join(elsewhere, 'target'), 'target\n', 'utf8');
		symlinkSync(join(elsewhere, 'target'), join(linkParent, 'daemon-0.lock.owner'));
		expect(() => linkContainedFileExclusive(linkRoot, `${LOCKS}/daemon-0.lock.owner`, `${LOCKS}/daemon-0.lock`, { what: 'lock' })).toThrow(
			/hard-link source must be a regular file/
		);
		expect(readFileSync(join(elsewhere, 'target'), 'utf8')).toBe('target\n');
	});

	it('refuses to retire a lock generation whose parent was swapped', () => {
		const publicName = 'daemon-0.lock';
		const ownerName = `${publicName}.owner`;
		const fixture = ordinarySwap('swap-generation', LOCKS, { name: publicName, bytes: '{"lock":1}\n' });
		linkSync(join(fixture.parent, publicName), join(fixture.parent, ownerName));
		// The owner link exists under the replacement too, on the same inode, so
		// the owner/published identity proof passes and only the parent check
		// can refuse.
		linkSync(join(fixture.parent, publicName), join(fixture.replacement, ownerName));
		const outcome = removeContainedHardlinkGeneration(fixture.root, `${LOCKS}/${publicName}`, `${LOCKS}/${ownerName}`, {
			what: 'lock',
			afterOpen: fixture.swap
		});
		expect(outcome).toBe('invalid');
		fixture.expectReplacementUntouched();
	});

	it('refuses to retire through an owner name that is not the publication', () => {
		// The owner/published identity check: a regular file at the owner name
		// with a different inode is not part of this generation, and the
		// retirement must not unlink it on its way to refusing.
		const root = makeDiskRoot('owner-foreign-inode');
		const parent = join(root, ...LOCKS.split('/'));
		mkdirSync(parent, { recursive: true });
		writeFileSync(join(parent, 'daemon-0.lock'), '{"lock":1}\n', 'utf8');
		writeFileSync(join(parent, 'daemon-0.lock.owner'), '{"something":"else"}\n', 'utf8');
		const outcome = removeContainedHardlinkGeneration(root, `${LOCKS}/daemon-0.lock`, `${LOCKS}/daemon-0.lock.owner`, { what: 'lock' });
		expect(outcome).toBe('invalid');
		expect(readFileSync(join(parent, 'daemon-0.lock.owner'), 'utf8')).toBe('{"something":"else"}\n');
		expect(readFileSync(join(parent, 'daemon-0.lock'), 'utf8')).toBe('{"lock":1}\n');
	});

	it('refuses to retire through an owner name that is not a regular file', () => {
		const root = makeDiskRoot('owner-fifo');
		const parent = join(root, ...LOCKS.split('/'));
		mkdirSync(parent, { recursive: true });
		writeFileSync(join(parent, 'daemon-0.lock'), '{"lock":1}\n', 'utf8');
		plantFifo(join(parent, 'daemon-0.lock.owner'));
		expect(removeContainedHardlinkGeneration(root, `${LOCKS}/daemon-0.lock`, `${LOCKS}/daemon-0.lock.owner`, { what: 'lock' })).toBe(
			'invalid'
		);
		expect(existsSync(join(parent, 'daemon-0.lock'))).toBe(true);
	});
});
