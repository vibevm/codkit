/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-REGISTRY */
// Exact receipt bytes, shared by lifecycle and ordinary writer guards.
import { realpathSync } from 'node:fs';
import { readContainedFile } from './containedFile.ts';
import { bytesEqual, encodeUtf8 } from './bytes.ts';
import { workspaceCheckoutSchema } from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { ckError } from './messages.ts';

export function verifyReceipt(record: WorkspaceRecord, role: 'patchset' | 'fork'): void {
	const checkout = record[role];
	const expected = encodeUtf8(
		`${JSON.stringify(
			workspaceCheckoutSchema.parse({
				codkitWorkspaceCheckout: 1,
				id: record.id,
				role,
				commonDirectory: checkout.commonDirectory,
				baseCommit: checkout.baseCommit
			}),
			null,
			2
		)}\n`
	);
	const read = readContainedFile(checkout.path, '.codkit/workspace.json', { what: 'workspace checkout custody receipt' });
	if (read.state === 'absent' || !bytesEqual(read.bytes, expected))
		throw ckError('CONFIG', 'workspace custody receipt is missing or foreign');
}
export function workspaceForkReceipt(treeDir: string, record: WorkspaceRecord | undefined): readonly string[] {
	if (record === undefined) return [];
	if (realpathSync(treeDir) !== record.fork.path) return [];
	verifyReceipt(record, 'fork');
	return ['.codkit/workspace.json'];
}
