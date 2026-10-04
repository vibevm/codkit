/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-BUILD-OUTPUTS */
// Declared output snapshots retain bytes/link text before permitting exact cleanup.
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { z } from 'zod';
import type { ProjectType } from '@codkit/type-api';
import type { CodkitConfig } from './configFile.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { ownedRootsOf, ownedRootOf, isBuildOutput } from './ownedRoots.ts';
import { matchesPatternList } from './conventionsFile.ts';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.ts';
import { hasGitSegment } from './inputsDeclaration.ts';
import { readContainedFile, writeContainedFileExclusive, hashContainedFile } from './containedFile.ts';
import { bytesEqual, encodeUtf8 } from './bytes.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';

export const workspaceBuildOutputSchema = z
	.strictObject({
		kind: z.literal('build-output'),
		path: z.string().refine((path) => repoRelativePathProblem(path) === null && !hasGitSegment(path)),
		entry: z.enum(['file', 'link', 'directory']),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		bytes: z.number().int().nonnegative(),
		mode: z.number().int().min(0).max(511),
		linkText: z.string().nullable(),
		configSha256: z.string().regex(/^[0-9a-f]{64}$/),
		manifestSha256: z.string().regex(/^[0-9a-f]{64}$/)
	})
	.superRefine((value, ctx) => {
		if ((value.entry !== 'link' && value.linkText !== null) || (value.entry === 'link' && value.linkText === null))
			ctx.addIssue({ code: 'custom', message: 'output kind/link snapshot differs' });
	});
export type WorkspaceBuildOutput = z.infer<typeof workspaceBuildOutputSchema>;

export function captureWorkspaceBuildOutputs(
	record: WorkspaceRecord,
	config: CodkitConfig,
	type: ProjectType,
	configSha256: string,
	authority: string,
	alreadyOwned: ReadonlySet<string>
): WorkspaceBuildOutput[] {
	const roots = ownedRootsOf(type, config.typeConfig, { treeDir: record.fork.path, pinSha: config.pin.sha });
	const declared = [
		...type.layout.cleanupWhitelist,
		...type.build.packageOutputs,
		...(type.build.packageTargets ?? []).flatMap((target) => target.outputs ?? [])
	];
	const entries = new Set([...untracked(record.fork.path, false), ...untracked(record.fork.path, true)]);
	const index = runGit({ cwd: record.fork.path, args: ['ls-files', '--cached', '-z'] });
	if (index.status !== 0) throw ckError('CONFIG', 'cannot list indexed workspace output paths');
	const tracked = new Set(index.stdout.split('\0').filter(Boolean));
	const links = new Set<string>();
	const empty = (prefix: string): void => {
		const directory = prefix === '' ? { ok: true, absolute: record.fork.path } : resolveContainedPath(record.fork.path, prefix);
		if (!directory.ok) throw ckError('CONFIG', 'workspace output directory moved');
		const children = readdirSync(directory.absolute, { withFileTypes: true });
		if (prefix !== '' && children.length === 0) entries.add(`${prefix}/`);
		for (const child of children) {
			const path = prefix === '' ? child.name : `${prefix}/${child.name}`;
			if (child.isSymbolicLink()) {
				links.add(path);
				if (!tracked.has(path)) entries.add(path);
			} else if (child.isDirectory() && child.name !== '.git' && child.name !== '.codkit') empty(path);
		}
	};
	empty('');
	const outputs: WorkspaceBuildOutput[] = [];
	for (const listed of [...entries].sort()) {
		// Git for Windows can enumerate junction target children; archive only the physical leaf link.
		if ([...links].some((link) => listed.startsWith(`${link}/`))) continue;
		const path = listed.endsWith('/') ? listed.slice(0, -1) : listed;
		if (tracked.has(path) || alreadyOwned.has(path) || path.startsWith('.codkit/')) continue;
		const owned = ownedRootOf(roots, path);
		const withinOwn = owned !== null && isBuildOutput(owned, listed.slice(owned.path.length + 1));
		if (!withinOwn && !matchesPatternList(listed, declared)) continue;
		const current = snapshot(record.fork.path, path);
		const data = workspaceBuildOutputSchema.parse({
			kind: 'build-output',
			path,
			...current,
			configSha256,
			manifestSha256: record.type.manifestSha256
		});
		const content =
			data.entry === 'directory'
				? new Uint8Array()
				: data.entry === 'link'
					? encodeUtf8(data.linkText ?? '')
					: readBytes(record.fork.path, path);
		if (hash(content) !== data.sha256 || content.length !== data.bytes)
			throw ckError('DIRTY-TREE', 'workspace output changed during archive capture');
		const target = archivePath(data.sha256);
		if (!writeContainedFileExclusive(authority, target, { what: 'retained workspace build output', bytes: content })) {
			const previous = readContainedFile(authority, target, { what: 'retained workspace build output' });
			if (previous.state !== 'ok' || !bytesEqual(previous.bytes, content)) throw ckError('CONFIG', 'workspace output archive is foreign');
		}
		if (!sameSnapshot(data, snapshot(record.fork.path, path))) throw ckError('DIRTY-TREE', 'workspace output moved while being archived');
		outputs.push(data);
	}
	return outputs;
}
export function verifyWorkspaceBuildOutput(record: WorkspaceRecord, output: WorkspaceBuildOutput, authority: string): void {
	if (output.manifestSha256 !== record.type.manifestSha256) throw ckError('CONFIG', 'workspace output type custody differs');
	const archive = hashContainedFile(authority, archivePath(output.sha256), { what: 'retained workspace output compare barrier' });
	if (archive.state !== 'ok' || archive.sha256 !== output.sha256 || archive.bytes !== output.bytes)
		throw ckError('CONFIG', 'retained workspace output is missing or changed');
	if (!sameSnapshot(output, snapshot(record.fork.path, output.path)))
		throw ckError('DIRTY-TREE', 'workspace build output changed after finish');
}
function snapshot(root: string, path: string) {
	const parent = posix.dirname(path);
	const directory = parent === '.' ? { ok: true, absolute: realpathSync(root) } : resolveContainedPath(root, parent);
	if (!directory.ok) throw ckError('CONFIG', 'workspace output parent is not contained');
	const absolute = `${directory.absolute}/${posix.basename(path)}`;
	const stat = lstatSync(absolute);
	if (stat.isSymbolicLink()) {
		const linkText = readlinkSync(absolute);
		const content = encodeUtf8(linkText);
		return { entry: 'link' as const, linkText, sha256: hash(content), bytes: content.length, mode: stat.mode & 0o777 };
	}
	if (stat.isDirectory()) {
		if (readdirSync(absolute).length !== 0) throw ckError('DIRTY-TREE', 'workspace output directory is no longer empty');
		return { entry: 'directory' as const, linkText: null, sha256: hash(new Uint8Array()), bytes: 0, mode: stat.mode & 0o777 };
	}
	if (!stat.isFile()) throw ckError('CONFIG', 'workspace output is not a regular file or leaf link');
	const data = hashContainedFile(root, path, { what: 'workspace output snapshot' });
	if (data.state !== 'ok') throw ckError('DIRTY-TREE', 'workspace output disappeared');
	return { entry: 'file' as const, linkText: null, sha256: data.sha256, bytes: data.bytes, mode: stat.mode & 0o777 };
}
function sameSnapshot(
	left: Pick<WorkspaceBuildOutput, 'entry' | 'linkText' | 'sha256' | 'bytes' | 'mode'>,
	right: Pick<WorkspaceBuildOutput, 'entry' | 'linkText' | 'sha256' | 'bytes' | 'mode'>
): boolean {
	return (
		left.entry === right.entry &&
		left.linkText === right.linkText &&
		left.sha256 === right.sha256 &&
		left.bytes === right.bytes &&
		left.mode === right.mode
	);
}
function readBytes(root: string, path: string): Uint8Array {
	const data = readContainedFile(root, path, { what: 'workspace build output content' });
	if (data.state !== 'ok') throw ckError('DIRTY-TREE', 'workspace output disappeared');
	return data.bytes;
}
function hash(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}
function archivePath(sha: string): string {
	return `workspace-output-bytes/${sha}.bin`;
}
function untracked(root: string, ignored: boolean): readonly string[] {
	const result = runGit({ cwd: root, args: ['ls-files', '--others', ...(ignored ? ['--ignored'] : []), '--exclude-standard', '-z'] });
	if (result.status !== 0) throw ckError('CONFIG', 'cannot list workspace output candidates');
	return result.stdout.split('\0').filter(Boolean);
}
