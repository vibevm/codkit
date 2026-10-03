/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-REGISTRY */
// Exact receipt bytes, shared by lifecycle and ordinary writer guards.
import { realpathSync } from 'node:fs';
import { readContainedFile } from './containedFile.js';
import { bytesEqual, encodeUtf8 } from './bytes.js';
import { workspaceCheckoutSchema } from './workspaceRegistry.js';
import { ckError } from './messages.js';
export function verifyReceipt(record, role) {
    const checkout = record[role];
    const expected = encodeUtf8(`${JSON.stringify(workspaceCheckoutSchema.parse({
        codkitWorkspaceCheckout: 1,
        id: record.id,
        role,
        commonDirectory: checkout.commonDirectory,
        baseCommit: checkout.baseCommit
    }), null, 2)}\n`);
    const read = readContainedFile(checkout.path, '.codkit/workspace.json', { what: 'workspace checkout custody receipt' });
    if (read.state === 'absent' || !bytesEqual(read.bytes, expected))
        throw ckError('CONFIG', 'workspace custody receipt is missing or foreign');
}
export function workspaceForkReceipt(treeDir, record) {
    if (record === undefined)
        return [];
    if (realpathSync(treeDir) !== record.fork.path)
        return [];
    verifyReceipt(record, 'fork');
    return ['.codkit/workspace.json'];
}
