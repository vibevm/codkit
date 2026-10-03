/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-CREATE */
// Journal reservation precedes Git mutations; retry verifies rather than overwrites.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveContainedPath } from './pathSafety.ts';
import { readContainedFile, writeContainedFileExclusive } from './containedFile.ts';
import { bytesEqual, encodeUtf8 } from './bytes.ts';
import { parseBaseConfig, CONFIG_FILE_NAME } from './configFile.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { readTypeManifest } from '../types/manifest.ts';
import type { RegisteredManifest } from '../types/manifest.ts';
import { effectiveRegistry } from '../types/registry.ts';
import {
	pathsOverlap,
	updateWorkspaceRegistry,
	workspaceCheckoutSchema,
	workspaceRecordSchema,
	workspaceTaskBranch,
	workspaceRefPrefixes
} from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';

export function createWorkspace(options: {
	readonly registryRoot: string;
	readonly directory: string;
	readonly name: string;
	readonly patchesRepository: string;
	readonly forkRepository: string;
	readonly patchsetRef?: string;
	readonly owner: { readonly id: string; readonly session: string };
	readonly registration?: RegisteredManifest;
	readonly checkpoint?: (stage: 'reserved' | 'patchset-created' | 'fork-created') => void;
}): WorkspaceRecord {
	const parent = realpathSync(options.directory);
	const patches = repository(options.patchesRepository);
	const fork = repository(options.forkRepository);
	const registry = realpathSync(options.registryRoot);
	for (const source of [patches.path, fork.path, patches.common, fork.common, registry])
		if (pathsOverlap(source, parent))
			throw ckError('CONFIG', 'workspace directory must be disjoint from source repositories, Git administration and registry');
	if (patches.common === fork.common) throw ckError('CONFIG', 'patchset and fork must be different repositories');
	return updateWorkspaceRegistry(registry, (current, save) => {
		const prior = current.workspaces.find((record) => record.name.toLowerCase() === options.name.toLowerCase());
		let record: WorkspaceRecord;
		if (prior !== undefined) {
			if (prior.state !== 'creating' || prior.owner.id !== options.owner.id || prior.owner.session !== options.owner.session)
				throw ckError('CONFIG', 'workspace name is already reserved; only its creating owner/session may resume');
			if (
				prior.patchset.commonDirectory !== patches.common ||
				prior.fork.commonDirectory !== fork.common ||
				dirname(prior.patchset.path) !== join(parent, prior.id) ||
				dirname(prior.fork.path) !== join(parent, prior.id)
			)
				throw ckError('CONFIG', 'workspace retry differs from recorded repository/directory custody');
			record = prior;
		} else {
			const commit = git(patches.path, ['rev-parse', '--verify', `${options.patchsetRef ?? 'HEAD'}^{commit}`]);
			const raw = git(patches.path, ['show', `${commit}:${CONFIG_FILE_NAME}`]);
			const config = parseBaseConfig(JSON.parse(raw), `${CONFIG_FILE_NAME}@${commit}`);
			const packageName = effectiveRegistry().get(config.type);
			const registration = options.registration ?? (packageName === undefined ? null : readTypeManifest(config.type, packageName));
			if (registration === null || registration.manifest.id !== config.type)
				throw ckError('TYPE-UNKNOWN', 'workspace type must have a matching trusted declaration');
			if (
				git(fork.path, ['rev-parse', '--verify', `${config.pin.sha}^{commit}`]) !== config.pin.sha ||
				git(fork.path, ['show', '-s', '--format=%cs', config.pin.sha]) !== config.pin.date
			)
				throw ckError('CONFIG', 'workspace fork does not contain the declared pin/date');
			const id = randomUUID();
			const home = join(parent, id);
			const now = new Date().toISOString();
			record = workspaceRecordSchema.parse({
				id,
				name: options.name,
				state: 'creating',
				patchset: {
					repository: patches.path,
					commonDirectory: patches.common,
					path: join(home, 'patchset'),
					branch: workspaceTaskBranch(id),
					baseCommit: commit
				},
				fork: { repository: fork.path, commonDirectory: fork.common, path: join(home, 'fork'), branch: null, baseCommit: config.pin.sha },
				type: { id: config.type, contractVersion: registration.manifest.contractVersion, manifestSha256: registration.sha256 },
				pin: config.pin,
				owner: options.owner,
				createdAt: now,
				updatedAt: now
			});
			save([...current.workspaces, record]);
		}
		options.checkpoint?.('reserved');
		const home = resolveContainedPath(parent, record.id, { allowMissing: true });
		if (!home.ok) throw ckError('CONFIG', 'reserved workspace directory is no longer contained');
		mkdirSync(join(parent, record.id), { recursive: true });
		ensureCheckout(record, 'patchset');
		options.checkpoint?.('patchset-created');
		ensureCheckout(record, 'fork');
		options.checkpoint?.('fork-created');
		const active = workspaceRecordSchema.parse({ ...record, state: 'active', updatedAt: new Date().toISOString() });
		save([...current.workspaces.filter((entry) => entry.id !== record.id), active]);
		return active;
	});
}

export function verifyWorkspaceCheckout(record: WorkspaceRecord, role: 'patchset' | 'fork', allowGenerated = false): void {
	const expected = record[role];
	const actual = repository(expected.path);
	if (actual.path !== realpathSync(expected.path) || actual.common !== expected.commonDirectory)
		throw ckError('CONFIG', 'workspace checkout is not registered in its recorded repository');
	const admin = git(expected.repository, ['worktree', 'list', '--porcelain', '-z']);
	const entries = admin.split('\0\0').map((entry) => entry.split('\0'));
	if (
		!entries.some((entry) => entry.includes(`worktree ${actual.path.replaceAll('\\', '/')}`) || entry.includes(`worktree ${actual.path}`))
	)
		throw ckError('CONFIG', 'workspace path is not an actual registered Git worktree');
	const branch = runGit({ cwd: expected.path, args: ['symbolic-ref', '--quiet', '--short', 'HEAD'] });
	const prefixes = workspaceRefPrefixes(record.id);
	const generated =
		allowGenerated &&
		role === 'fork' &&
		branch.status === 0 &&
		[prefixes.generatedBranchPrefix, prefixes.cycleBranchPrefix].some((prefix) => branch.stdout.trim().startsWith(prefix));
	if (expected.branch === null ? branch.status === 0 && !generated : branch.status !== 0 || branch.stdout.trim() !== expected.branch)
		throw ckError('CONFIG', 'workspace checkout branch/detached state differs from recorded custody');
}

function ensureCheckout(record: WorkspaceRecord, role: 'patchset' | 'fork'): void {
	const expected = record[role];
	if (!existsSync(expected.path)) {
		git(expected.repository, [
			'-c',
			'core.longpaths=true',
			'worktree',
			'add',
			...(expected.branch === null ? ['--detach'] : ['-b', expected.branch]),
			'--',
			expected.path,
			expected.baseCommit
		]);
	}
	verifyWorkspaceCheckout(record, role);
	const data = encodeUtf8(
		`${JSON.stringify(workspaceCheckoutSchema.parse({ codkitWorkspaceCheckout: 1, id: record.id, role, commonDirectory: expected.commonDirectory, baseCommit: expected.baseCommit }), null, 2)}\n`
	);
	const existing = readContainedFile(expected.path, '.codkit/workspace.json', { what: 'workspace checkout receipt' });
	if (existing.state === 'ok') {
		if (!bytesEqual(existing.bytes, data)) throw ckError('CONFIG', 'workspace checkout receipt is foreign');
	}
	const dirt = git(expected.path, ['status', '--porcelain', '--untracked-files=all'])
		.split('\n')
		.filter((line) => line !== '' && !(existing.state === 'ok' && line === '?? .codkit/workspace.json'));
	if (git(expected.path, ['rev-parse', 'HEAD']) !== expected.baseCommit || dirt.length > 0)
		throw ckError('CONFIG', 'creating workspace was changed; refusing to overwrite or clean it');
	if (
		existing.state === 'absent' &&
		!writeContainedFileExclusive(expected.path, '.codkit/workspace.json', { what: 'workspace checkout receipt', bytes: data })
	)
		throw ckError('CONFIG', 'workspace receipt creation raced with another owner');
}
function repository(path: string): { readonly path: string; readonly common: string } {
	const physical = realpathSync(path);
	return {
		path: realpathSync(git(physical, ['rev-parse', '--show-toplevel'])),
		common: realpathSync(git(physical, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
	};
}
function git(root: string, args: readonly string[]): string {
	const result = runGit({ cwd: root, args });
	if (result.status !== 0) throw ckError('CONFIG', `workspace Git operation refused: ${result.stderr.trim()}`);
	return result.stdout.trim();
}
