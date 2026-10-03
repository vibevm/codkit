/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-REGISTRY */
// User-controlled pair records; identities/namespaces never come from a patchset.
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { typeManifestSchema } from '@codkit/type-api';
import { revisionPinSchema } from './pinIdentity.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import { ckError } from './messages.ts';
import { acquirePathLock } from './lock.ts';
import { resolveContainedPath } from './pathSafety.ts';

export const WORKSPACE_REGISTRY_FILE = 'workspaces.json';
export const workspaceIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
	.brand<'WorkspaceId'>();
const absolute = z.string().min(1).refine(isAbsolute);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
export const workspaceCheckoutSchema = z.strictObject({
	codkitWorkspaceCheckout: z.literal(1),
	id: workspaceIdSchema,
	role: z.enum(['patchset', 'fork']),
	commonDirectory: absolute,
	baseCommit: commit
});
const checkout = z.strictObject({
	repository: absolute,
	commonDirectory: absolute,
	path: absolute,
	branch: z.string().min(1).nullable(),
	baseCommit: commit
});
export const workspaceRecordSchema = z
	.strictObject({
		id: workspaceIdSchema,
		name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
		state: z.enum(['creating', 'active', 'finished', 'removing', 'removed']),
		patchset: checkout,
		fork: checkout,
		type: z.strictObject({
			id: typeManifestSchema.shape.id,
			contractVersion: typeManifestSchema.shape.contractVersion,
			manifestSha256: z.string().regex(/^[0-9a-f]{64}$/)
		}),
		pin: revisionPinSchema,
		owner: z.strictObject({ id: z.string().min(1), session: z.string().min(1) }),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
		finished: z
			.strictObject({
				patchsetCommit: commit,
				forkCommit: commit,
				deltaFingerprint: z
					.string()
					.regex(/^[0-9a-f]{64}$/)
					.nullable(),
				at: z.iso.datetime()
			})
			.optional()
	})
	.superRefine((record, ctx) => {
		if (['finished', 'removing', 'removed'].includes(record.state) && record.finished === undefined)
			ctx.addIssue({ code: 'custom', message: 'finished/removal states require preserved finish proof' });
		if (record.patchset.branch !== workspaceTaskBranch(record.id) || record.fork.branch !== null)
			ctx.addIssue({ code: 'custom', message: 'workspace task branch/detached fork must match stable identity' });
		if (record.fork.baseCommit !== record.pin.sha) ctx.addIssue({ code: 'custom', message: 'workspace fork base must equal selected pin' });
		if (pathsOverlap(record.patchset.path, record.fork.path))
			ctx.addIssue({ code: 'custom', message: 'workspace checkouts must be disjoint' });
	});
export const workspaceRegistrySchema = z
	.strictObject({
		codkitWorkspaceRegistry: z.literal(1),
		revision: z.number().int().nonnegative(),
		workspaces: z.array(workspaceRecordSchema)
	})
	.superRefine((registry, ctx) => {
		const ids = new Set<string>();
		const names = new Set<string>();
		const roots: string[] = [];
		for (const record of registry.workspaces) {
			if (ids.has(record.id) || names.has(record.name.toLowerCase()))
				ctx.addIssue({ code: 'custom', message: 'workspace IDs/names must not repeat, including case aliases' });
			ids.add(record.id);
			names.add(record.name.toLowerCase());
			if (record.state === 'removed') continue;
			for (const path of [record.patchset.path, record.fork.path]) {
				if (roots.some((prior) => pathsOverlap(prior, path)))
					ctx.addIssue({ code: 'custom', message: 'workspace checkout roots must not overlap another pair' });
				roots.push(path);
			}
		}
	});
export type WorkspaceRecord = Readonly<z.infer<typeof workspaceRecordSchema>>;
export type WorkspaceRegistry = Readonly<z.infer<typeof workspaceRegistrySchema>>;

export function workspaceRegistryRoot(home: string = homedir()): string {
	return join(home, '.codkit');
}
export function workspaceTaskBranch(id: string): string {
	return `codkit/workspace/${workspaceIdSchema.parse(id)}/task`;
}
export function workspaceRefPrefixes(id: string) {
	const root = `codkit/workspace/${workspaceIdSchema.parse(id)}/`;
	return { generatedBranchPrefix: `${root}applied/`, cycleBranchPrefix: `${root}cycle/`, releaseRefPrefix: `${root}release/` };
}
export function readWorkspaceRegistry(root: string): WorkspaceRegistry {
	try {
		const read = readContainedFile(root, WORKSPACE_REGISTRY_FILE, { what: 'workspace registry' });
		if (read.state === 'absent') return { codkitWorkspaceRegistry: 1, revision: 0, workspaces: [] };
		const text = decodeUtf8Strict(read.bytes);
		if (text === null) throw new Error('workspace registry is not UTF-8');
		const registry = workspaceRegistrySchema.parse(JSON.parse(text));
		const physical = realpathSync(root);
		for (const record of registry.workspaces)
			for (const checkout of [record.patchset, record.fork])
				if ([checkout.path, checkout.repository, checkout.commonDirectory].some((path) => pathsOverlap(physical, path)))
					throw new Error('workspace registry must be disjoint from managed checkouts and repository administration');
		return registry;
	} catch (error) {
		throw ckError('CONFIG', error instanceof Error ? error.message : 'workspace registry is invalid');
	}
}
/** Serialize updates under the existing atomic generation lock, never under patchset authority. */
export function updateWorkspaceRegistry<T>(
	root: string,
	body: (current: WorkspaceRegistry, save: (next: readonly WorkspaceRecord[]) => void) => T
): T {
	const physical = realpathSync(root);
	const lockPath = resolveContainedPath(physical, 'workspaces.lock', { allowMissing: true });
	if (!lockPath.ok) throw ckError('CONFIG', 'workspace registry lock path is not contained');
	const lock = acquirePathLock(lockPath.absolute, 'workspace registry');
	try {
		let expected = readContainedFile(physical, WORKSPACE_REGISTRY_FILE, { what: 'workspace registry snapshot' });
		let current = readWorkspaceRegistry(physical);
		return body(current, (records) => {
			const observed = readContainedFile(physical, WORKSPACE_REGISTRY_FILE, { what: 'workspace registry compare barrier' });
			if (
				observed.state !== expected.state ||
				(observed.state === 'ok' && expected.state === 'ok' && !bytesEqual(observed.bytes, expected.bytes))
			)
				throw ckError('CONFIG', 'workspace registry changed outside the held update transaction');
			const next = workspaceRegistrySchema.parse({
				codkitWorkspaceRegistry: 1,
				revision: current.revision + 1,
				workspaces: [...records].sort((left, right) => left.name.localeCompare(right.name, 'en'))
			});
			writeContainedFileAtomic(physical, WORKSPACE_REGISTRY_FILE, {
				what: 'workspace registry',
				bytes: encodeUtf8(`${JSON.stringify(next, null, 2)}\n`)
			});
			current = next;
			expected = readContainedFile(physical, WORKSPACE_REGISTRY_FILE, { what: 'workspace registry published snapshot' });
		});
	} finally {
		lock.release();
	}
}
export function findWorkspace(registry: WorkspaceRegistry, name: string): WorkspaceRecord {
	const found = registry.workspaces.find((record) => record.name.toLowerCase() === name.toLowerCase() || record.id === name);
	if (found === undefined) throw ckError('CONFIG', `workspace is not registered: ${name}`);
	return found;
}
export function pathsOverlap(left: string, right: string): boolean {
	const normalizedLeft = process.platform === 'win32' ? left.toLowerCase() : left;
	const normalizedRight = process.platform === 'win32' ? right.toLowerCase() : right;
	const within = (parent: string, child: string): boolean => {
		const distance = relative(parent, child);
		return distance === '' || (distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance));
	};
	return within(normalizedLeft, normalizedRight) || within(normalizedRight, normalizedLeft);
}
