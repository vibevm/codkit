/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-REMOVE */
// Removal keeps checkout guards through Git deletion and journals partial progress.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { acquireLock } from './lock.ts';
import type { LockHandle } from './lock.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { treeId } from './fingerprint.ts';
import { readTreeCache, treeCachePath } from './treeCache.ts';
import { readWorkspaceMaterials, verifyWorkspaceMaterials } from './workspaceMaterials.ts';
import type { WorkspaceMaterial } from './workspaceMaterials.ts';
import { workspaceLogPaths } from './workspaceLogs.ts';
import { workspaceRuntimePaths } from './workspaceRuntime.ts';
import { verifyWorkspaceCheckout } from './workspaceCreate.ts';
import { assertWorkspaceClean, refuseWorkspaceDaemons, verifyReceipt, workspaceOwnedPaths } from './workspaceFinish.ts';
import { findWorkspace, updateWorkspaceRegistry, workspaceRecordSchema } from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';

type Role = 'patchset' | 'fork';
const roles: readonly Role[] = ['patchset', 'fork'];

export function removeWorkspace(options: {
	readonly registryRoot: string;
	readonly name: string;
	readonly checkpoint?: (stage: 'journaled' | 'patchset-removed' | 'fork-removed') => void;
}): WorkspaceRecord {
	return updateWorkspaceRegistry(options.registryRoot, (registry, save) => {
		let record = findWorkspace(registry, options.name);
		if (record.state === 'removed') return record;
		if (record.state !== 'finished' && record.state !== 'removing') throw ckError('CONFIG', 'workspace must finish before removal');
		const locks = new Map<Role, LockHandle>();
		const materials = readWorkspaceMaterials(options.registryRoot, record);
		const extra = new Map<Role, readonly string[]>();
		const publish = (state: 'removing' | 'removed') => {
			record = workspaceRecordSchema.parse({ ...record, state, updatedAt: new Date().toISOString() });
			save(registry.workspaces.map((entry) => (entry.id === record.id ? record : entry)));
		};
		try {
			for (const role of roles) {
				if (!present(record[role].path)) {
					if (record.state !== 'removing') throw ckError('CONFIG', 'finished workspace checkout is missing');
					verifyAbsent(record, role);
					continue;
				}
				verifyWorkspaceCheckout(record, role, true);
				if (realpathSync(record[role].path) !== record[role].path) throw ckError('CONFIG', 'workspace removal path moved through an alias');
				locks.set(role, acquireLock(record[role].path, `workspace-${record.id}`, 'workspace remove'));
				const cache = role === 'patchset' ? readTreeCache(record.patchset.path, treeId(record.fork.path)) : null;
				extra.set(
					role,
					cache === null
						? []
						: [relative(record.patchset.path, treeCachePath(record.patchset.path, treeId(record.fork.path))).replaceAll('\\', '/')]
				);
				if (role === 'patchset')
					extra.set(role, [
						...(extra.get(role) ?? []),
						...workspaceLogPaths(options.registryRoot, record),
						...workspaceRuntimePaths(options.registryRoot, record)
					]);
				check(record, role, locks.get(role), extra.get(role) ?? [], materials, options.registryRoot);
			}
			for (const role of roles) preserveHead(record, role);
			publish('removing');
			options.checkpoint?.('journaled');
			for (const role of roles) {
				const lock = locks.get(role);
				if (lock === undefined) continue;
				check(record, role, lock, extra.get(role) ?? [], materials, options.registryRoot);
				// Force is necessary only for our verified receipt/cache and held lock files.
				// The physical inventory below refuses all other data, including ignored/empty paths.
				git(record[role].commonDirectory, [
					'--git-dir',
					record[role].commonDirectory,
					'worktree',
					'remove',
					'--force',
					'--',
					record[role].path
				]);
				verifyAbsent(record, role);
				options.checkpoint?.(role === 'patchset' ? 'patchset-removed' : 'fork-removed');
			}
			publish('removed');
			return record;
		} finally {
			for (const lock of [...locks.values()].reverse()) lock.release();
		}
	});
}

function check(
	record: WorkspaceRecord,
	role: Role,
	lock: LockHandle | undefined,
	extra: readonly string[],
	materials: WorkspaceMaterial[],
	authority: string
): void {
	if (role === 'patchset') {
		workspaceLogPaths(authority, record);
		workspaceRuntimePaths(authority, record);
	}
	const allowed = role === 'fork' ? [...extra, ...verifyWorkspaceMaterials(record, materials, authority)] : extra;
	verifyWorkspaceCheckout(record, role, true);
	verifyReceipt(record, role);
	refuseWorkspaceDaemons(record[role].path, record.id);
	assertWorkspaceClean(record[role].path, lock, allowed);
	if (git(record[role].path, ['rev-parse', 'HEAD']).trim() !== finishedHead(record, role))
		throw ckError('DIRTY-TREE', 'workspace HEAD changed after finish; finish again before removal');
	const paths = new Set([...workspaceOwnedPaths(record[role].path, lock, allowed), '.git']);
	const index = git(record[role].path, ['ls-files', '--stage', '-z']);
	for (const entry of index.split('\0').filter(Boolean)) {
		if (entry.startsWith('160000 ')) throw ckError('CONFIG', 'workspace removal refuses submodule checkouts');
		const tab = entry.indexOf('\t');
		if (tab < 0) throw ckError('CONFIG', 'workspace index inventory is invalid');
		paths.add(entry.slice(tab + 1));
	}
	const directories = new Set<string>();
	if (role === 'fork')
		for (const material of materials)
			if (material.kind === 'empty-directory' || (material.kind === 'build-output' && material.entry === 'directory'))
				directories.add(material.path);
	for (const path of paths) {
		const parts = path.split('/');
		for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join('/'));
	}
	const walk = (prefix: string) => {
		for (const entry of readdirSync(join(record[role].path, prefix), { withFileTypes: true })) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory() && directories.has(path)) walk(path);
			else if (!entry.isDirectory() && (entry.isFile() || entry.isSymbolicLink()) && paths.has(path)) continue;
			else throw ckError('DIRTY-TREE', `workspace contains unowned data, including ignored paths: ${path}`);
		}
	};
	walk('');
}
function finishedHead(record: WorkspaceRecord, role: Role): string {
	if (record.finished === undefined) throw ckError('CONFIG', 'workspace finish proof is missing');
	return role === 'patchset' ? record.finished.patchsetCommit : record.finished.forkCommit;
}
function preservedRef(record: WorkspaceRecord, role: Role): string {
	return `refs/codkit/workspace/${record.id}/finished/${role}`;
}
function preserveHead(record: WorkspaceRecord, role: Role): void {
	const ref = preservedRef(record, role);
	const result = runGit({
		cwd: record[role].commonDirectory,
		args: ['--git-dir', record[role].commonDirectory, 'rev-parse', '--verify', ref]
	});
	const head = finishedHead(record, role);
	if (result.status === 0) {
		if (result.stdout.trim() !== head) throw ckError('CONFIG', 'workspace preserved finish ref is foreign');
	} else git(record[role].commonDirectory, ['--git-dir', record[role].commonDirectory, 'update-ref', ref, head, '0'.repeat(40)]);
}
function verifyAbsent(record: WorkspaceRecord, role: Role): void {
	if (present(record[role].path)) throw ckError('CONFIG', 'workspace deletion did not remove its recorded path');
	const entries = git(record[role].commonDirectory, [
		'--git-dir',
		record[role].commonDirectory,
		'worktree',
		'list',
		'--porcelain',
		'-z'
	]).split('\0');
	if (entries.some((entry) => entry === `worktree ${record[role].path}` || entry === `worktree ${record[role].path.replaceAll('\\', '/')}`))
		throw ckError('CONFIG', 'missing workspace is still registered; refusing ambiguous removal recovery');
	if (
		git(record[role].commonDirectory, [
			'--git-dir',
			record[role].commonDirectory,
			'rev-parse',
			'--verify',
			preservedRef(record, role)
		]).trim() !== finishedHead(record, role)
	)
		throw ckError('CONFIG', 'removed workspace finish ref is missing or foreign');
}
function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}
function git(root: string, args: readonly string[]): string {
	const result = runGit({ cwd: root, args });
	if (result.status !== 0) throw ckError('CONFIG', `workspace removal refused: ${result.stderr.trim()}`);
	return result.stdout;
}
