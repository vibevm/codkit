/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-REPOSITORY-COORDINATION */
import { acquirePathLock, readLock } from './lock.js';
import { isCkError } from './messages.js';
/** Waiting does not grant custody: every retry uses the original hard-link protocol. */
export function acquireWorkspaceCoordinationLock(path, command, mayWait, onWarn) {
    const deadline = performance.now() + 300_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
        try {
            return acquirePathLock(path, command, onWarn);
        }
        catch (error) {
            if (!isCkError(error) || error.code !== 'LOCKED' || performance.now() >= deadline)
                throw error;
            const holder = readLock(path);
            if (holder === null || holder.nonce === undefined || holder.pid === process.pid || !mayWait(holder))
                throw error;
            Atomics.wait(pause, 0, 0, 50);
        }
    }
}
