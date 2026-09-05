/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-LOCK-CLAIM-OWNER */
// The claim grammar of the orphan-recovery election: the one fixed name every
// contender on a publication derives, the strict bytes a claim carries, the
// reader that parses a directory's claims, and the damage refusal that keeps
// the fixed name honest (PROP-010 ##DAEMON-LOCK-CLAIM-OWNER).
//
// Split from `containedGeneration.ts` along this seam: the election and the
// retirement are the generation module's one responsibility, and everything
// claim-shaped — name, bytes, reader, occupancy — is another. Nothing here
// opens the publication or decides recovery; identity arrives as the held
// `Stats` of the descriptor the caller keeps open.

import { readdirSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readContainedFile } from './containedFile.ts';
import { lstatIfPresent, refuse, sameFile } from './containedPath.ts';
import type { ContainedFileOptions, ContainedFileRead } from './containedPath.ts';

const CLAIM_INFIX = '.orphan-';
const CLAIM_SUFFIX = '.owner';
/** Canonical lowercase RFC 4122 - the shape both the writer and the reader of a claim nonce enforce. */
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_SCHEMA = 1;

/** Identity a recoverer publishes in its claim, so a successor can bury it. */
export type GenerationClaimant = {
	readonly pid: number;
	/**
	 * The nonce of the lock record this recoverer's caller is acquiring: a
	 * human-readable tie between a claim and the acquisition that published it.
	 * Diagnostic only - no decision reads it back, and with one fixed claim
	 * name per publication two contenders in one process do not get two claims
	 * (the second loses the election and gets none).
	 */
	readonly nonce: string;
};

/** The bytes of a claim: who is recovering, and the exact publication it recovers. */
export type OrphanClaimRecord = {
	readonly codkitOrphanClaim: 1;
	readonly dev: number;
	readonly ino: number;
	readonly pid: number;
	readonly nonce: string;
};

const orphanClaimSchema = z
	.object({
		codkitOrphanClaim: z.literal(CLAIM_SCHEMA),
		dev: z.number().int().nonnegative(),
		ino: z.number().int().nonnegative(),
		pid: z.number().int().positive(),
		nonce: z.string().regex(NONCE)
	})
	.strict();

/** Strict-parse claim bytes; undefined when they are not a claim at all. */
function parseClaimRecord(bytes: Uint8Array): OrphanClaimRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
	} catch {
		return undefined;
	}
	const parsed = orphanClaimSchema.safeParse(raw);
	return parsed.success ? parsed.data : undefined;
}

/** Whether a claim's bytes name exactly this publication. */
export function namesPublication(identity: Stats, record: OrphanClaimRecord): boolean {
	return identity.dev === record.dev && identity.ino === record.ino;
}

/**
 * The claim a contender publishes: one fixed name per publication, derived
 * from its dev/ino alone. The publisher's identity is NOT in the name - a
 * unique name per contender is what destroyed the election's atomicity.
 */
export function claimName(name: string, identity: Stats): string {
	const inode = `${identity.dev.toString(16)}-${identity.ino.toString(16)}`;
	return `${name}${CLAIM_INFIX}${inode}${CLAIM_SUFFIX}`;
}

/**
 * The claim record for a publication, checked before it is published so a
 * claim this module writes always parses as one this module reads. The nonce
 * and pid rules are the grammar's contract with its caller, enforced here
 * rather than promised in a comment.
 */
export function claimantRecord(claimant: GenerationClaimant, identity: Stats, options: ContainedFileOptions): OrphanClaimRecord {
	if (!Number.isInteger(claimant.pid) || claimant.pid <= 0) {
		refuse({ ...options, code: 'INTERNAL' }, 'the recovery claim pid must be a positive integer', 'pass the pid of the recovering process');
	}
	if (!NONCE.test(claimant.nonce)) {
		refuse(
			{ ...options, code: 'INTERNAL' },
			'the recovery claim nonce must be a canonical UUID',
			'pass the nonce of the lock record being published'
		);
	}
	return { codkitOrphanClaim: CLAIM_SCHEMA, dev: identity.dev, ino: identity.ino, pid: claimant.pid, nonce: claimant.nonce };
}

export type PublishedClaim = { readonly path: string; readonly record: OrphanClaimRecord; readonly shape: Stats };

/**
 * Every claim published beside `name`, whatever inode its bytes name.
 *
 * A name that does not parse as a claim is somebody else's file and is left
 * alone; a name that parses but is not a regular file is not one of ours
 * either, and neither is one whose bytes do not prove a publisher: a claim is
 * published exclusively as complete strict JSON, so anything else at a
 * claim-shaped name is damage, and damage is skipped and never buried. At the
 * one fixed claim name the election publishes at, damage still occupies the
 * name - observationally it blocks the election exactly like a live
 * competitor, only forever - which is why the caller refuses it by name as an
 * operator-repair state rather than reporting it as contention.
 */
export function readClaims(root: string, parent: string, name: string, segments: readonly string[]): PublishedClaim[] {
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return [];
	}
	const claims: PublishedClaim[] = [];
	for (const entry of entries) {
		if (!isClaimName(name, entry)) continue;
		const path = join(parent, entry);
		const shape = lstatIfPresent(path);
		if (shape === null || shape.isSymbolicLink() || !shape.isFile()) continue;
		let read: ContainedFileRead;
		try {
			read = readContainedFile(root, [...segments, entry].join('/'), { what: path });
		} catch (error) {
			// A peer burying this very claim unlinks it mid-read; that is a race,
			// not damage. Whatever still stands there after the failure is real.
			const after = lstatIfPresent(path);
			if (after !== null && sameFile(shape, after)) throw error;
			continue;
		}
		if (read.state !== 'ok') continue;
		const record = parseClaimRecord(read.bytes);
		if (record === undefined) continue;
		claims.push({ path, record, shape });
	}
	return claims;
}

/**
 * Whether `entry` is the claim-name shape for `name`: the publication's own
 * name, the claim infix, two hex groups (dev, ino), the claim suffix. The
 * inode values are decoration for the human - attribution lives in the bytes.
 */
function isClaimName(name: string, entry: string): boolean {
	const prefix = `${name}${CLAIM_INFIX}`;
	if (!entry.startsWith(prefix) || !entry.endsWith(CLAIM_SUFFIX)) return false;
	const middle = entry.slice(prefix.length, entry.length - CLAIM_SUFFIX.length);
	const parts = middle.split('-');
	return parts.length === 2 && /^[0-9a-f]+$/.test(parts[0] ?? '') && /^[0-9a-f]+$/.test(parts[1] ?? '');
}

/**
 * Refuse damage at the fixed claim name instead of reporting it as contention,
 * deciding occupancy from what stands there NOW - never from the stale scan
 * the pass planned its election from.
 *
 * A peer that publishes a valid claim at exactly this name inside the pass's
 * own window is a competitor, not damage: deciding from the stale scan
 * reported it as unattributable and told the operator to delete a live
 * recoverer's claim. The fresh read separates the states that actually occur:
 * nothing standing (the publication may proceed), a valid claim naming this
 * publication (a competitor - the exclusive publication answers it atomically,
 * and its publisher's claim is never deleted or hinted at), and damage.
 * Damage includes a claim whose bytes name an inode its own name does not
 * encode: `claimName` and `claimantRecord` are always built from one held
 * identity, so such a file is not this module's either - and left standing it
 * would occupy the fixed name forever while parsing as healthy.
 */
export function refuseUnattributableClaimName(
	root: string,
	parent: string,
	segments: readonly string[],
	claim: string,
	held: Stats,
	options: ContainedFileOptions
): void {
	const path = join(parent, claim);
	const standing = lstatIfPresent(path);
	if (standing === null) return;
	if (standing.isSymbolicLink()) {
		refuse(
			options,
			`the claim name ${path} is occupied by a symbolic link`,
			'remove the link manually; unattributable damage is never auto-deleted'
		);
	}
	if (!standing.isFile()) {
		refuse(
			options,
			`the claim name ${path} is occupied by ${describeEntry(standing)}`,
			'remove the entry manually; unattributable damage is never auto-deleted'
		);
	}
	let bytes: Uint8Array | null = null;
	try {
		const read: ContainedFileRead = readContainedFile(root, [...segments, claim].join('/'), { what: path });
		bytes = read.state === 'ok' ? read.bytes : null;
	} catch (error) {
		// A peer burying this very claim unlinks it mid-read; that is a race,
		// not damage, and the publication below answers it atomically.
		const after = lstatIfPresent(path);
		if (after !== null && sameFile(standing, after)) throw error;
	}
	if (bytes === null) return;
	const record = parseClaimRecord(bytes);
	if (record === undefined) {
		refuse(
			options,
			`the claim name ${path} is occupied by a file that does not parse as a claim`,
			'inspect and remove it manually; unattributable damage is never auto-deleted'
		);
	}
	if (record.dev !== held.dev || record.ino !== held.ino) {
		refuse(
			options,
			`the claim name ${path} is occupied by a claim whose bytes do not name the inode its own name encodes`,
			'inspect and remove it manually; unattributable damage is never auto-deleted'
		);
	}
}

/** The words a refusal names a non-regular occupant with. */
function describeEntry(shape: Stats): string {
	if (shape.isDirectory()) return 'a directory';
	if (shape.isFIFO()) return 'a named pipe';
	if (shape.isSocket()) return 'a socket';
	return 'a device entry';
}
