/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-DAEMON-LOGS */
// Closed daemon generations retain log bytes outside removable checkouts.
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { z } from 'zod';
import { workspaceIdSchema, workspaceRegistryRoot, readWorkspaceRegistry } from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import type { DaemonRecord } from './buildRuntime.ts';
import { hashContainedFile, readContainedFile, writeContainedFileExclusive } from './containedFile.ts';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import { resolveContainedPath, safeBasenameProblem } from './pathSafety.ts';
import { ckError } from './messages.ts';
import { treeId } from './fingerprint.ts';

export const workspaceDaemonLogSchema = z.strictObject({
	codkitWorkspaceDaemonLog: z.literal(1),
	id: workspaceIdSchema,
	nonce: z.string().uuid(),
	channel: z.string().refine((name) => safeBasenameProblem(name) === null),
	patchsetPath: z.string().min(1),
	treePath: z.string().min(1),
	treeId: z.string().min(1),
	sha256: z.string().regex(/^[0-9a-f]{64}$/),
	bytes: z.number().int().nonnegative()
});
function blobPath(sha: string): string {
	return `workspace-log-bytes/${sha}.log`;
}
export function archiveWorkspaceLog(patchesDir: string, record: DaemonRecord, authority: string = workspaceRegistryRoot()): void {
	if (record.workspaceId === undefined) return;
	const workspace = readWorkspaceRegistry(authority).workspaces.find((entry) => entry.id === record.workspaceId);
	if (workspace === undefined || workspace.state === 'removed') throw ckError('CONFIG', 'daemon log workspace authority is unavailable');
	const path = `.codkit/build/${record.channel}.log`;
	const observed = readContainedFile(patchesDir, path, { what: 'closed workspace daemon log' });
	if (observed.state === 'absent') return;
	const sha256 = createHash('sha256').update(observed.bytes).digest('hex');
	const data = workspaceDaemonLogSchema.parse({
		codkitWorkspaceDaemonLog: 1,
		id: record.workspaceId,
		nonce: record.nonce,
		channel: record.channel,
		patchsetPath: realpathSync(patchesDir),
		treePath: record.treePath,
		treeId: record.treeId,
		sha256,
		bytes: observed.bytes.length
	});
	writeImmutable(authority, blobPath(sha256), observed.bytes);
	writeImmutable(authority, `workspace-logs/${data.id}/${data.nonce}-${sha256}.json`, encodeUtf8(`${JSON.stringify(data, null, 2)}\n`));
}
export function workspaceLogPaths(authority: string, record: WorkspaceRecord): readonly string[] {
	const directory = resolveContainedPath(authority, `workspace-logs/${record.id}`, { allowMissing: true });
	if (!directory.ok) throw ckError('CONFIG', 'workspace log authority directory is not contained');
	let names: string[];
	try {
		names = readdirSync(directory.absolute);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
		throw error;
	}
	const owned = new Map<string, { sha256: string; bytes: number }[]>();
	for (const name of names) {
		if (!/^[0-9a-f-]+-[0-9a-f]{64}\.json$/i.test(name)) throw ckError('CONFIG', 'workspace log receipt name is invalid');
		const read = readContainedFile(authority, `workspace-logs/${record.id}/${name}`, { what: 'workspace daemon log receipt' });
		if (read.state === 'absent') throw ckError('CONFIG', 'workspace log receipt disappeared');
		const text = decodeUtf8Strict(read.bytes);
		let raw: unknown;
		try {
			if (text === null) throw new Error();
			raw = JSON.parse(text);
		} catch {
			throw ckError('CONFIG', 'workspace log receipt is not UTF-8 JSON');
		}
		const parsed = workspaceDaemonLogSchema.safeParse(raw);
		if (!parsed.success || parsed.data.id !== record.id) throw ckError('CONFIG', 'workspace daemon log receipt is invalid or foreign');
		const receipt = parsed.data;
		if (name !== `${receipt.nonce}-${receipt.sha256}.json`)
			throw ckError('CONFIG', 'workspace log receipt filename differs from its generation');
		if (receipt.patchsetPath !== record.patchset.path || receipt.treePath !== record.fork.path) continue;
		if (receipt.treeId !== treeId(record.fork.path)) throw ckError('CONFIG', 'workspace log receipt tree identity is foreign');
		const archive = hashContainedFile(authority, blobPath(receipt.sha256), { what: 'retained workspace daemon log' });
		if (archive.state !== 'ok' || archive.sha256 !== receipt.sha256 || archive.bytes !== receipt.bytes)
			throw ckError('CONFIG', 'retained workspace daemon log is missing or changed');
		const entries = owned.get(receipt.channel) ?? [];
		entries.push(receipt);
		owned.set(receipt.channel, entries);
	}
	const paths: string[] = [];
	for (const [channel, snapshots] of owned)
		for (const path of [`.codkit/build/${channel}.log`, `.codkit/build/${channel}.log.1`]) {
			const current = hashContainedFile(record.patchset.path, path, { what: 'workspace log compare barrier' });
			if (current.state === 'absent') continue;
			if (!snapshots.some((snapshot) => snapshot.sha256 === current.sha256 && snapshot.bytes === current.bytes))
				throw ckError('DIRTY-TREE', `workspace log has changed or is unowned: ${path}`);
			paths.push(path);
		}
	return paths;
}
function writeImmutable(root: string, path: string, bytes: Uint8Array): void {
	if (writeContainedFileExclusive(root, path, { what: 'workspace retained log evidence', bytes })) return;
	const existing = readContainedFile(root, path, { what: 'workspace retained log evidence' });
	if (existing.state !== 'ok' || !bytesEqual(existing.bytes, bytes)) throw ckError('CONFIG', 'workspace log archive is foreign');
}
