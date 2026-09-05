/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-LOCK-CLAIM-OWNER */
// The hard-link election every contained lock generation is published and
// retired through (PROP-010 ##DAEMON-CHANNEL-LOCK, ##DAEMON-LOCK-CLAIM-OWNER).
//
// A generation is one inode with two names: the public name whoever wants the
// lock races for, and a private owner name only its holder may unlink. The
// election is the link itself - exactly one contender creates a name, so
// exactly one wins.
//
// The rule the recovery path below exists to hold, and the one an audit
// falsified twice:
//
//   every artifact this protocol publishes carries a provable owner.
//
// The public lock does: its bytes name a pid and a nonce, checked with the
// caller's liveness oracle. The claim a recoverer publishes does too - not in
// its name, which must stay shared so contenders can collide on it, but in its
// bytes: strict JSON naming the publisher's pid and nonce and the exact
// dev/ino of the publication being recovered.
//
// The election is an atomic primitive, not a read-then-act. The claim is
// published exclusively, so of two contenders on one publication exactly one
// publication lands and the other gets EEXIST and reports a lost election
// before it ever reaches the public unlink. An earlier design put the
// publisher in the claim's NAME; the name became unique per contender, nothing
// collided, the EEXIST branch became dead code, and the election degenerated
// into a directory scan taken before either contender had published - two
// contenders then both unlinked the public lock name. Identity lives in the
// bytes; the name stays shared.
//
// An inode number is an identity only while the inode is held: an open
// descriptor keeps it allocated. Two audits proved the recovery's re-proof
// hollow when it compared numbers taken from two path stats: on a filesystem
// that reuses inode numbers (ext4 recycles a freed number to the next file in
// the same directory essentially always; tmpfs never does) a successor
// publication can carry the very number the claim recorded, and the "same
// file" comparison then passes against a different file - two contenders both
// unlinked one public name. The publication is therefore held open at PASS START,
// where the pass takes its identity: opened `O_RDONLY | O_NOFOLLOW |
// O_NONBLOCK` before the claim's name and bytes are derived from it, and held
// across the election, the proofs and the unlink. Two contenders that held open
// the same inode derive the same claim name and collide in the election; a
// contender whose held inode is no longer the one standing at the public
// name has simply lost, and the pre-unlink comparison of the public name
// against the held descriptor is a real identity proof - it can differ, and it
// refuses when it does. (An earlier round opened the descriptor after the
// election instead: the open then held whatever stood at the name by then,
// and the proof compared that against itself - a tautology on every
// filesystem, caught only by the link-count re-read beside it. Measured on
// ext4 with that hold in place and the re-read deleted: 16/120 double
// acquires; the re-read was the guard that actually closed the reproduced
// failure. Both guards stand now, each measured alone.)
//
// What each removal actually re-proves: the private-link retirement pins the
// publication before its own election and re-proves the parent's identity and
// the public name's inode after; the orphan recovery re-proves the parent's
// identity and the public name against the held-open descriptor - including
// its link count, re-read there rather than trusted from the pass-start read -
// immediately before its public unlink. The abandoned-claim sweep re-proves
// each file it removes is still the one its record was read from, but not the
// parent; the `finally` below retires this contender's own claim under the
// same re-proof - the shape it published is captured when the publication
// lands, so a peer's claim that took the fixed name in the window is never
// unlinked by it.
//
// Nothing here decides policy: liveness is an injected oracle, and the caller
// keeps its own diagnostics vocabulary.
import { closeSync, fstatSync, linkSync, openSync, statSync, unlinkSync } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { encodeUtf8 } from './bytes.js';
import { writeContainedFileExclusive } from './containedFile.js';
import { NOFOLLOW, NONBLOCK, ensureAdminDirectory, errnoOf, lstatIfPresent, messageOf, refuse, sameFile, statIfPresent, unlinkIfPresent } from './containedPath.js';
import { claimName, claimantRecord, namesPublication, readClaims, refuseUnattributableClaimName } from './containedClaim.js';
/** One sweep of dead claims, then one recovery on the tree it left behind. */
const RECOVERY_PASSES = 2;
/** Create a contained hard link only when the destination is absent. */
export function linkContainedFileExclusive(root, sourceRelative, targetRelative, options) {
    const sourceSegments = sourceRelative.split('/');
    const targetSegments = targetRelative.split('/');
    const sourceName = sourceSegments.pop() ?? '';
    const targetName = targetSegments.pop() ?? '';
    if (sourceSegments.join('/') !== targetSegments.join('/'))
        refuse(options, 'hard-link endpoints must share one contained parent', 'use sibling lock names');
    const parent = ensureAdminDirectory(root, sourceSegments, options);
    const parentShape = statSync(parent);
    const source = join(parent, sourceName);
    const target = join(parent, targetName);
    const shape = lstatIfPresent(source);
    if (shape === null)
        refuse(options, 'the hard-link source is absent', 'retry the acquisition; a peer may have retired the generation');
    if (shape.isSymbolicLink() || !shape.isFile())
        refuse(options, 'hard-link source must be a regular file', 'repair the lock generation');
    options.afterOpen?.();
    const verifiedParent = ensureAdminDirectory(root, sourceSegments, options);
    if (!sameFile(parentShape, statSync(verifiedParent)))
        refuse(options, 'hard-link parent identity changed', 'retry after inspecting the lock directory');
    try {
        linkSync(source, target);
        return true;
    }
    catch (error) {
        if (errnoOf(error) === 'EEXIST')
            return false;
        throw error;
    }
}
/**
 * Elect one stale-generation remover through its private hard-link name.
 *
 * `owner-missing` is not a failure: it is the state a publication is left in
 * when its owner died between the two unlinks below, and it is recoverable by
 * `removeContainedOrphanGeneration` rather than by refusing forever.
 *
 * The publication is held open before this contender's own election - the owner
 * unlink below - and held across both unlinks, so the public-name comparison
 * before the final unlink is against the held descriptor, never against a
 * pass-start stat whose number a successor could have recycled.
 */
export function removeContainedHardlinkGeneration(root, publicRelative, ownerRelative, options) {
    const publicSegments = publicRelative.split('/');
    const ownerSegments = ownerRelative.split('/');
    const publicName = publicSegments.pop() ?? '';
    const ownerName = ownerSegments.pop() ?? '';
    if (publicSegments.join('/') !== ownerSegments.join('/'))
        return 'invalid';
    const parent = ensureAdminDirectory(root, publicSegments, { ...options, create: false });
    const parentShape = statIfPresent(parent);
    if (parentShape === null)
        return 'lost';
    const publicPath = join(parent, publicName);
    const ownerPath = join(parent, ownerName);
    const owner = lstatIfPresent(ownerPath);
    const published = lstatIfPresent(publicPath);
    if (published === null || published.isSymbolicLink() || !published.isFile())
        return 'invalid';
    if (owner === null)
        return 'owner-missing';
    if (owner.isSymbolicLink() || !owner.isFile() || !sameFile(owner, published))
        return 'invalid';
    let handle;
    try {
        handle = openSync(publicPath, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
    }
    catch (error) {
        const code = errnoOf(error);
        if (code === 'ENOENT')
            return 'lost';
        if (code === 'ELOOP' || (NOFOLLOW === 0 && code === 'EPERM'))
            return 'invalid';
        refuse(options, `cannot open the publication to hold its inode: ${messageOf(error)}`, 'check the lock directory');
    }
    try {
        const held = fstatSync(handle);
        if (!held.isFile())
            return 'invalid';
        options.afterOpen?.();
        const verifiedParent = ensureAdminDirectory(root, publicSegments, { ...options, create: false });
        const verifiedShape = statIfPresent(verifiedParent);
        if (verifiedShape === null || !sameFile(parentShape, verifiedShape))
            return 'invalid';
        try {
            unlinkSync(ownerPath);
        }
        catch (error) {
            if (errnoOf(error) === 'ENOENT')
                return 'lost';
            throw error;
        }
        const current = lstatIfPresent(publicPath);
        if (current === null || !sameFile(current, held))
            return 'lost';
        try {
            unlinkSync(publicPath);
        }
        catch (error) {
            // The same tolerance the orphan path's public unlink has: a name
            // somebody else retired in the two statements between the re-proof
            // and the syscall is a lost election, not a raw errno out of the
            // module.
            if (errnoOf(error) === 'ENOENT')
                return 'lost';
            throw error;
        }
        return 'removed';
    }
    finally {
        closeSync(handle);
    }
}
/**
 * Recover a publication whose private owner link is gone.
 *
 * A holder retires a generation by unlinking its private name and then the
 * public one. A process killed between those two calls leaves a valid public
 * file that no owner link claims, and refusing it forever wedges whatever the
 * publication guards.
 *
 * The election is an exclusive publication of one claim name derived from the
 * publication's dev/ino alone. Every contender that held the same inode open
 * derives the same name, so exactly one contender's publication lands and
 * every other gets EEXIST and loses - the same atomic shape the private link's
 * unlink performs, with the identity it needs carried in the claim's bytes
 * rather than its name. A contender that held a different inode open derives a
 * different name and cannot collide with this one - but it also holds a
 * descriptor that keeps its own inode allocated, so the pre-unlink proof below
 * refuses it before any unlink is reachable.
 *
 * Each pass pins the publication where it takes the identity: the descriptor
 * is opened before the claim's name and bytes are derived from it and kept
 * until the pass's every exit. While it is open the inode cannot be freed, so
 * its number cannot be handed to a successor, and the pre-unlink comparison of
 * the public name against the descriptor is a real identity proof rather than
 * two reusable integers.
 *
 * The claims other contenders leave behind are three distinct cases that must
 * not collapse into one answer:
 *
 *   * a claim whose publisher may still be alive is a lost election - retry;
 *   * a claim whose publisher is provably gone is debris from a recoverer
 *     killed mid-recovery, and burying it is the whole point of naming the
 *     publisher: it is removed - after re-proving the file at that path is
 *     still the one the record was read from - and the pass repeats on what
 *     is left;
 *   * any other extra hard link on the publication is a live owner holding
 *     it - with claims being ordinary files, that is the only thing nlink > 1
 *     can mean - and it is refused.
 *
 * The middle case is the one an audit proved missing twice. Without it a
 * SIGKILLed recoverer's anonymous claim was indistinguishable from a live
 * competitor's, every later contender read `lost`, and the channel refused
 * `stayed contended after 3 attempts` forever.
 */
export function removeContainedOrphanGeneration(root, publicRelative, options) {
    const segments = publicRelative.split('/');
    const name = segments.pop() ?? '';
    const parent = ensureAdminDirectory(root, segments, { ...options, create: false });
    const parentShape = statIfPresent(parent);
    if (parentShape === null)
        return 'lost';
    const publicPath = join(parent, name);
    for (let pass = 0; pass < RECOVERY_PASSES; pass += 1) {
        const shape = lstatIfPresent(publicPath);
        if (shape === null)
            return 'lost';
        // Pass-start shape refusal. On POSIX the pin open below re-refuses a
        // symlink (ELOOP) and the descriptor's own fstat re-refuses a FIFO or a
        // directory, so this lstat is equivalent redundancy there; where
        // `O_NOFOLLOW` is 0 (win32) it is the only symlink defence at the public
        // name, which is why it stands before the open.
        if (shape.isSymbolicLink() || !shape.isFile())
            return 'invalid';
        // The pin. Opened at pass start, where the identity is taken, closed on
        // every exit below: across the claim scan, the election, the proofs and
        // the unlink the publication's inode cannot be freed, so its number
        // cannot be handed to a successor. On Windows this guarantee is weaker
        // and untested (CK-A04): `O_NOFOLLOW` is 0 there, so a symlink planted
        // at the publication in the check-then-open window is followed rather
        // than refused, and an open handle interacts with deletion differently
        // than a POSIX descriptor does.
        options.beforeOpen?.();
        let handle;
        try {
            handle = openSync(publicPath, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
        }
        catch (error) {
            const code = errnoOf(error);
            if (code === 'ENOENT')
                return 'lost';
            if (code === 'ELOOP' || (NOFOLLOW === 0 && code === 'EPERM'))
                return 'invalid';
            refuse(options, `cannot open the publication to hold its inode: ${messageOf(error)}`, 'check the lock directory');
        }
        try {
            // Every later use of "the publication this pass is recovering" is
            // this descriptor's file, never a path stat: the claim's name and
            // bytes derive from it, so two contenders that held the same inode open
            // derive the same claim name and collide in the election, and a
            // contender whose held inode was retired under the public name
            // loses at the proof below rather than unlinking a successor.
            const held = fstatSync(handle);
            if (!held.isFile())
                return 'invalid';
            options.afterOpen?.();
            const claims = readClaims(root, parent, name, segments);
            // A live publisher owns the election even before it has finished; only a
            // publisher proven gone may be buried, and a reused pid reads as alive.
            if (claims.some((claim) => namesPublication(held, claim.record) && options.claimantAlive(claim.record.pid)))
                return 'lost';
            const abandoned = claims.filter((claim) => !options.claimantAlive(claim.record.pid));
            if (abandoned.length > 0) {
                // Debris of contenders that can never finish - including claims left
                // on inodes this publication no longer uses, which is the acquisition
                // litter nothing used to sweep. The record was read earlier: re-prove
                // the file standing at that path is still the one it came from before
                // removing it, so a live successor's claim that took the fixed name
                // in the window is never buried by a stale decision.
                for (const claim of abandoned) {
                    const standing = lstatIfPresent(claim.path);
                    if (standing !== null && sameFile(standing, claim.shape))
                        unlinkIfPresent(claim.path);
                }
                continue;
            }
            // The link count is read live from the held inode. No name at all:
            // the publication was retired while this pass held it, which is a
            // lost election, not a refusal. More than one name: a live owner -
            // with claims being ordinary files, an extra hard link on the
            // publication is the only thing it can mean.
            if (held.nlink === 0)
                return 'lost';
            if (held.nlink !== 1)
                return 'invalid';
            const claim = claimName(name, held);
            refuseUnattributableClaimName(root, parent, segments, claim, held, options);
            const record = claimantRecord(options.claimant, held, options);
            const claimPath = join(parent, claim);
            const published = writeContainedFileExclusive(root, [...segments, claim].join('/'), {
                what: claimPath,
                bytes: encodeUtf8(`${JSON.stringify(record, null, 2)}\n`)
            });
            // The election: exactly one contender's exclusive publication lands.
            // Everybody else is told so here, before any unlink is reachable.
            if (!published)
                return 'lost';
            // The shape this contender published, for the re-proved retirement
            // in the finally below.
            const claimShape = lstatIfPresent(claimPath);
            try {
                options.afterElection?.();
                const verifiedParent = ensureAdminDirectory(root, segments, { ...options, create: false });
                const verifiedShape = statIfPresent(verifiedParent);
                if (verifiedShape === null || !sameFile(parentShape, verifiedShape))
                    return 'invalid';
                // Inode binding: the unlink below may only take the held
                // publication. A successor that retired it and published its own
                // generation under the public name lands here and loses - its
                // file is a different inode, because the pin kept this one from
                // being recycled into it. The link count is re-read at this
                // proof, not trusted from the gate's read: a live owner that
                // linked the publication during the election shows in this stat
                // and not in that one.
                const current = lstatIfPresent(publicPath);
                if (current === null || !sameFile(current, held))
                    return 'lost';
                if (current.nlink !== 1)
                    return 'invalid';
                // Fires after both proofs and immediately before the public
                // unlink (test seam): this is the only place the ENOENT
                // tolerance below can be expressed deterministically, and a
                // tolerance nobody can fire is a tolerance nobody can prove.
                options.afterClaimProof?.();
                try {
                    unlinkSync(publicPath);
                }
                catch (error) {
                    if (errnoOf(error) === 'ENOENT')
                        return 'lost';
                    throw error;
                }
                return 'removed';
            }
            finally {
                // This contender's own claim, re-proved before it is retired:
                // the unlink is by path, and a peer that buried this claim and
                // published its own at the same fixed name in the window must
                // not lose its claim to this cleanup - the same re-proof the
                // sweep already makes. The finally must never throw over the
                // result it wraps, so the re-proof lives inside the same
                // swallow-ENOENT discipline unlinkIfPresent has.
                const standing = lstatIfPresent(claimPath);
                if (standing !== null && claimShape !== null && sameFile(standing, claimShape))
                    unlinkIfPresent(claimPath);
            }
        }
        finally {
            closeSync(handle);
        }
    }
    // Claims kept reappearing across both passes: a live contender is racing.
    return 'lost';
}
