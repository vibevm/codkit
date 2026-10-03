/** @scope spec://codkit/modules/codkit/PROP-020#PATCHSET-WRITER */
// One physical checkout writer; nested scopes borrow only an issued capability.
import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquirePathLock, assertOwnedLockHandle, isAlive, lockPath, readLock } from './lock.js';
import { ckError } from './messages.js';
export const PATCHSET_WRITER_LOCK_ID = 'patchset-checkout-writer';
const leases = new WeakMap();
export function reservePatchsetWriter(patchesDir, requestedPath, command, warn, parent) {
    const path = lockPath(patchesDir, PATCHSET_WRITER_LOCK_ID);
    let lease;
    if (parent !== undefined) {
        assertOwnedLockHandle(parent, 'nested patchset writer');
        const owned = leases.get(parent);
        if (owned === undefined || owned.lock.path !== path)
            throw ckError('LOCKED', 'parent capability does not own this patchset checkout');
        assertOwnedLockHandle(owned.lock, 'patchset writer');
        lease = owned;
        lease.references += 1;
    }
    else {
        const lock = acquirePathLock(path, command, warn);
        try {
            // Older processes own tree locks without this checkout guard. Never overlap them.
            for (const name of readdirSync(dirname(path))) {
                if (!name.endsWith('.lock') || join(dirname(path), name) === path)
                    continue;
                const candidate = join(dirname(path), name);
                let shape;
                try {
                    shape = lstatSync(candidate);
                }
                catch (error) {
                    if (error.code === 'ENOENT')
                        continue;
                    throw error;
                }
                if (!shape.isFile() || shape.isSymbolicLink())
                    throw ckError('LOCKED', 'foreign checkout lock is not a regular file');
                const prior = readLock(candidate);
                if (prior === null && candidate !== requestedPath)
                    throw ckError('LOCKED', 'another checkout lock has an unknown owner; inspect that lock before writing');
                if (prior !== null && isAlive(prior.pid))
                    throw ckError('LOCKED', `another command owns this patchset checkout: pid ${prior.pid} running "${prior.command}"`, `wait for pid ${prior.pid} to finish, or use a separate patchset worktree for another writing task`);
            }
        }
        catch (error) {
            lock.release();
            throw error;
        }
        lease = { lock, references: 1 };
    }
    let consumed = false;
    const drop = () => {
        lease.references -= 1;
        if (lease.references === 0)
            lease.lock.release();
    };
    return {
        cancel: () => {
            if (consumed)
                return;
            consumed = true;
            drop();
        },
        attach: (handle) => {
            if (consumed)
                throw ckError('LOCKED', 'patchset writer reservation has already been consumed');
            assertOwnedLockHandle(handle, 'patchset writer attachment');
            consumed = true;
            leases.set(handle, lease);
            const release = handle.release;
            let released = false;
            handle.release = () => {
                if (released)
                    return;
                release();
                released = true;
                leases.delete(handle);
                drop();
            };
        }
    };
}
