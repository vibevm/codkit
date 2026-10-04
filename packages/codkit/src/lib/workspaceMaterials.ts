/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-MATERIALS */
// User-authority receipts bind removable copies to immutable saved source blobs.
import { createHash } from 'node:crypto';
import { relative, posix } from 'node:path';
import { readdirSync } from 'node:fs';
import type { ProjectType } from '@codkit/type-api';
import { z } from 'zod';
import { hashContainedFile, readContainedFile, writeContainedFileExclusive } from './containedFile.ts';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.ts';
import { ownedRootsOf, ownCodeFilter } from './ownedRoots.ts';
import { listOwnFiles, ownSourceRoot, isDeliveredOwnFile } from './ownCopy.ts';
import { materializerOf, ownExtensionFiles } from './layers/ownExtensions.ts';
import { loadOwnManifest } from './layers/ownManifest.ts';
import { devChannelFile, loadOverlays, renderDevChannel } from './layers/overlay.ts';
import { overlayVarContext, pinCommitDate } from './syncEngine.ts';
import { runGit, runGitBytes } from './gitx.ts';
import { workspaceIdSchema, workspaceRecordSchema } from './workspaceRegistry.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import type { CodkitConfig } from './configFile.ts';
import { parseBaseConfig } from './configFile.ts';
import { ckError } from './messages.ts';
import { savedMaterialLfs } from './workspaceMaterialLfs.ts';
import { pointerObject } from './publishLfs.ts';
import type { LfsPointer } from './publishLfs.ts';
import { inspectInputCopies } from './inputsTree.ts';
import { inputBlobRef, workspaceInputMatches } from './workspaceInput.ts';
import { workspaceConfig } from './workspaceConfig.ts';

const pathSchema = z.string().refine((value) => repoRelativePathProblem(value) === null && value !== '.git' && !value.startsWith('.git/'));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const savedSource = z.strictObject({ source: pathSchema, sha256: digest });
const legacyMaterial = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('source'), path: pathSchema, source: pathSchema, sha256: digest }),
	z.strictObject({
		kind: z.literal('dev-channel'),
		path: pathSchema,
		sha256: digest,
		text: z.string(),
		sources: z.array(savedSource).min(1)
	})
]);
const material = z.union([
	legacyMaterial,
	z.strictObject({
		kind: z.literal('lfs-source'),
		path: pathSchema,
		source: pathSchema,
		sha256: digest,
		pointerSha256: digest,
		bytes: z.number().int().nonnegative()
	}),
	z.strictObject({ kind: z.literal('empty-directory'), path: pathSchema, source: pathSchema, sha256: digest })
]);
const legacyReceipt = z.strictObject({
	codkitWorkspaceMaterials: z.literal(1),
	id: workspaceIdSchema,
	finished: workspaceRecordSchema.shape.finished.unwrap(),
	files: z.array(legacyMaterial)
});
const currentReceipt = legacyReceipt.extend({ codkitWorkspaceMaterials: z.literal(2), files: z.array(material) });
const inputMaterial = z.strictObject({
	kind: z.literal('input'),
	path: pathSchema,
	sha256: digest,
	blob: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
	inputName: z.string().min(1),
	deliveryStamp: digest,
	configSha256: digest
});
const allMaterial = z.union([material, inputMaterial]);
const inputReceipt = legacyReceipt.extend({ codkitWorkspaceMaterials: z.literal(3), files: z.array(allMaterial) });
export const workspaceMaterialsSchema = z.union([legacyReceipt, currentReceipt, inputReceipt]).superRefine((value, ctx) => {
	const seen = new Set<string>();
	for (const file of value.files) {
		if (seen.has(file.path.toLowerCase())) ctx.addIssue({ code: 'custom', message: 'materialized paths must not repeat or case-alias' });
		seen.add(file.path.toLowerCase());
	}
});
export type WorkspaceMaterials = z.infer<typeof workspaceMaterialsSchema>;
export type WorkspaceMaterial = z.infer<typeof allMaterial>;

export function captureWorkspaceMaterials(
	record: WorkspaceRecord,
	config: CodkitConfig,
	type: ProjectType,
	commit: string,
	registryRoot: string
): WorkspaceMaterial[] {
	const pairs: { path: string; source: string }[] = [];
	const directories: { path: string; source: string }[] = [];
	for (const owned of ownedRootsOf(type, config.typeConfig, { treeDir: record.fork.path, pinSha: config.pin.sha })) {
		for (const file of listOwnFiles(ownSourceRoot(record.patchset.path, owned.deltaDir), {
			refuseSymlinks: true,
			keep: ownCodeFilter(owned)
		}))
			if (isDeliveredOwnFile(file)) pairs.push({ path: `${owned.path}/${file}`, source: `${owned.deltaDir}/${file}` });
			else if (file.endsWith('.gitkeep') || file === 'patchset.delta.json') {
				const parent = posix.dirname(file);
				directories.push({ path: parent === '.' ? owned.path : `${owned.path}/${parent}`, source: `${owned.deltaDir}/${file}` });
			}
	}
	const materializer = materializerOf(type);
	if (materializer !== null)
		for (const file of ownExtensionFiles(materializer, record.patchset.path, loadOwnManifest(record.patchset.path).extensions))
			pairs.push({ path: file.target, source: relative(record.patchset.path, file.source).replaceAll('\\', '/') });
	const files: WorkspaceMaterial[] = [];
	let lfs: ReadonlyMap<string, LfsPointer> | undefined;
	for (const pair of pairs) {
		pathSchema.parse(pair.path);
		pathSchema.parse(pair.source);
		const target = hashContainedFile(record.fork.path, pair.path, { what: 'materialized workspace copy' });
		if (target.state === 'absent') continue;
		const source = sourceHash(record.patchset.commonDirectory, commit, pair.source);
		if (source === target.sha256) files.push({ kind: 'source', ...pair, sha256: source });
		else {
			const pointer = pointerObject(sourceBytes(record.patchset.commonDirectory, commit, pair.source));
			if (pointer === null) throw ckError('DIRTY-TREE', `materialized workspace file is not saved to its patchset: ${pair.path}`);
			lfs ??= savedMaterialLfs(
				record.patchset.commonDirectory,
				commit,
				pairs.map((pair) => pair.source)
			);
			const saved = lfs.get(pair.source);
			if (saved === undefined || saved.oid !== target.sha256 || saved.size !== target.bytes)
				throw ckError('DIRTY-TREE', `materialized LFS bytes differ from the saved pointer: ${pair.path}`);
			files.push({ kind: 'lfs-source', ...pair, sha256: saved.oid, pointerSha256: source, bytes: saved.size });
		}
	}
	for (const directory of directories)
		if (!files.some((file) => file.path === directory.path) && emptyDirectory(record.fork.path, directory.path, true))
			files.push({ kind: 'empty-directory', ...directory, sha256: sourceHash(record.patchset.commonDirectory, commit, directory.source) });
	const overlays = loadOverlays(record.patchset.path, type);
	const rendered = renderDevChannel(
		type,
		record.fork.path,
		overlays,
		overlayVarContext(config, pinCommitDate(record.fork.path, config.pin.sha), commit),
		config.pin.sha
	);
	const devPath = devChannelFile(type);
	const devPresent =
		devPath === null ? false : hashContainedFile(record.fork.path, devPath, { what: 'workspace dev-channel presence' }).state === 'ok';
	if (rendered.text !== null && devPresent) {
		const path = relative(record.fork.path, rendered.path).replaceAll('\\', '/');
		const actual = hashContainedFile(record.fork.path, path, { what: 'workspace dev-channel copy' });
		const sha256 = createHash('sha256').update(rendered.text).digest('hex');
		if (actual.state !== 'ok' || actual.sha256 !== sha256)
			throw ckError('DIRTY-TREE', 'workspace dev-channel bytes differ from the saved overlay recipe');
		const sources = [...new Set(['codkit.json', ...overlays.map((overlay) => overlay.artifactPath)])].map((source) => {
			const hash = sourceHash(record.patchset.commonDirectory, commit, source);
			const current = hashContainedFile(record.patchset.path, source, { what: 'workspace saved overlay recipe' });
			if (current.state !== 'ok' || current.sha256 !== hash)
				throw ckError('DIRTY-TREE', 'workspace overlay recipe is not saved to its sealed commit');
			return { source, sha256: hash };
		});
		files.push({ kind: 'dev-channel', path, sha256, text: rendered.text, sources });
	}
	const context = workspaceConfig(config, record, registryRoot).workspace;
	if (context === undefined) throw ckError('CONFIG', 'workspace input capture lacks authority context');
	for (const copy of inspectInputCopies(record.fork.path, config.inputs ?? [], (text) => {
		throw ckError('CONFIG', text);
	})) {
		if (copy.recorded === null) {
			const dir = resolveContainedPath(record.fork.path, copy.input.to, { allowMissing: true });
			if (!dir.ok) throw ckError('CONFIG', 'workspace input directory is not contained');
			try {
				readdirSync(dir.absolute);
				throw ckError('CONFIG', 'workspace input directory has no delivery witness');
			} catch (error) {
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
			}
			continue;
		}
		if (copy.edits.length > 0) throw ckError('DIRTY-TREE', 'workspace input copy contains unsaved edits; restore or reload the input');
		if (!workspaceInputMatches(record.fork.path, copy.recorded, context))
			throw ckError('CONFIG', 'workspace input cache is not backed by its delivery witness');
		if (copy.recorded.mode === 'pinned' && copy.recorded.commit !== copy.input.ref)
			throw ckError('CONFIG', 'workspace input pin differs from its delivery');
		const configSha256 = sourceHash(record.patchset.commonDirectory, commit, 'codkit.json');
		for (const [path, blob] of Object.entries(copy.recorded.files)) {
			const target = `${copy.input.to}/${path}`;
			const sha256 = inputBlobHash(record, blob);
			const actual = hashContainedFile(record.fork.path, target, { what: 'workspace delivered input' });
			if (actual.state !== 'ok' || actual.sha256 !== sha256)
				throw ckError('DIRTY-TREE', 'workspace input bytes differ from their delivered blob');
			files.push({
				kind: 'input',
				path: target,
				sha256,
				blob,
				inputName: copy.input.name,
				deliveryStamp: copy.recorded.stamp,
				configSha256
			});
		}
	}
	return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}
export function writeWorkspaceMaterials(root: string, record: WorkspaceRecord, files: WorkspaceMaterial[]): void {
	const version = files.some((file) => file.kind === 'input')
		? 3
		: files.some((file) => file.kind === 'lfs-source' || file.kind === 'empty-directory')
			? 2
			: 1;
	const data = workspaceMaterialsSchema.parse({ codkitWorkspaceMaterials: version, id: record.id, finished: record.finished, files });
	const bytes = encodeUtf8(`${JSON.stringify(data, null, 2)}\n`);
	const path = receiptPath(record);
	if (!writeContainedFileExclusive(root, path, { what: 'workspace saved-material receipt', bytes })) {
		const previous = readContainedFile(root, path, { what: 'workspace saved-material receipt' });
		if (previous.state !== 'ok' || !bytesEqual(previous.bytes, bytes)) throw ckError('CONFIG', 'workspace material receipt is foreign');
	}
}
export function readWorkspaceMaterials(root: string, record: WorkspaceRecord): WorkspaceMaterial[] {
	const read = readContainedFile(root, receiptPath(record), { what: 'workspace saved-material receipt' });
	if (read.state === 'absent') return [];
	const text = decodeUtf8Strict(read.bytes);
	if (text === null) throw ckError('CONFIG', 'workspace material receipt is not UTF-8');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw ckError('CONFIG', 'workspace material receipt is not valid JSON');
	}
	const parsed = workspaceMaterialsSchema.safeParse(raw);
	const finished = workspaceRecordSchema.shape.finished.unwrap().parse(record.finished);
	if (!parsed.success || parsed.data.id !== record.id || JSON.stringify(parsed.data.finished) !== JSON.stringify(finished))
		throw ckError('CONFIG', 'workspace material receipt differs from its finish proof');
	return parsed.data.files;
}
export function verifyWorkspaceMaterials(record: WorkspaceRecord, files: WorkspaceMaterial[]): readonly string[] {
	if (record.finished === undefined) throw ckError('CONFIG', 'workspace finish proof is missing');
	let lfs: ReadonlyMap<string, LfsPointer> | undefined;
	for (const file of files) {
		if (file.kind === 'input') {
			const declared = decodeUtf8Strict(sourceBytes(record.patchset.commonDirectory, record.finished.patchsetCommit, 'codkit.json'));
			if (declared === null) throw ckError('CONFIG', 'saved input configuration is not UTF-8');
			const config = parseBaseConfig(JSON.parse(declared), 'saved workspace input config');
			if (!(config.inputs ?? []).some((input) => input.name === file.inputName && file.path.startsWith(`${input.to}/`)))
				throw ckError('CONFIG', 'workspace input receipt path is outside its saved declaration');
			if (
				sourceHash(record.patchset.commonDirectory, record.finished.patchsetCommit, 'codkit.json') !== file.configSha256 ||
				inputBlobHash(record, file.blob) !== file.sha256
			)
				throw ckError('CONFIG', 'workspace input receipt backing differs from its sealed evidence');
			const actual = hashContainedFile(record.fork.path, file.path, { what: 'workspace input removal barrier' });
			if (actual.state !== 'ok' || actual.sha256 !== file.sha256)
				throw ckError('DIRTY-TREE', 'workspace input material changed after finish');
			continue;
		}
		const sources =
			file.kind === 'dev-channel'
				? file.sources
				: [{ source: file.source, sha256: file.kind === 'lfs-source' ? file.pointerSha256 : file.sha256 }];
		for (const source of sources)
			if (sourceHash(record.patchset.commonDirectory, record.finished.patchsetCommit, source.source) !== source.sha256)
				throw ckError('CONFIG', 'workspace material receipt source differs from its saved Git blob');
		if (file.kind === 'dev-channel' && createHash('sha256').update(file.text).digest('hex') !== file.sha256)
			throw ckError('CONFIG', 'workspace generated material receipt digest differs from its retained bytes');
		if (file.kind === 'empty-directory') {
			if (!emptyDirectory(record.fork.path, file.path, false))
				throw ckError('DIRTY-TREE', `workspace directory changed after finish: ${file.path}`);
			continue;
		}
		if (file.kind === 'lfs-source') {
			lfs ??= savedMaterialLfs(
				record.patchset.commonDirectory,
				record.finished.patchsetCommit,
				files.flatMap((file) => (file.kind === 'lfs-source' ? [file.source] : []))
			);
			const pointer = lfs.get(file.source);
			if (pointer === undefined || pointer.oid !== file.sha256 || pointer.size !== file.bytes)
				throw ckError('CONFIG', 'workspace LFS receipt differs from the saved attribute/pointer evidence');
		}
		const actual = hashContainedFile(record.fork.path, file.path, { what: 'workspace material compare barrier' });
		if (actual.state !== 'ok' || actual.sha256 !== file.sha256 || (file.kind === 'lfs-source' && actual.bytes !== file.bytes))
			throw ckError('DIRTY-TREE', `workspace material changed after finish: ${file.path}`);
	}
	return files.map((file) => file.path);
}
function receiptPath(record: WorkspaceRecord): string {
	if (record.finished === undefined) throw ckError('CONFIG', 'workspace finish proof is missing');
	const key = createHash('sha256')
		.update(JSON.stringify({ id: record.id, finished: workspaceRecordSchema.shape.finished.unwrap().parse(record.finished) }))
		.digest('hex');
	return `workspace-materials/${record.id}/${key}.json`;
}
function sourceHash(common: string, commit: string, path: string): string {
	return createHash('sha256')
		.update(sourceBytes(common, commit, path))
		.digest('hex');
}
function inputBlobHash(record: WorkspaceRecord, blob: string): string {
	const common = record.fork.commonDirectory;
	const ref = runGit({ cwd: common, args: ['--git-dir', common, 'rev-parse', '--verify', inputBlobRef(record.id, blob)] });
	if (ref.status !== 0 || ref.stdout.trim() !== blob || git(common, ['cat-file', '-t', blob]) !== 'blob')
		throw ckError('CONFIG', 'workspace input retained blob ref is missing or foreign');
	const result = runGitBytes({ cwd: common, args: ['--git-dir', common, 'cat-file', 'blob', blob] });
	if (result.status !== 0) throw ckError('CONFIG', 'workspace input retained bytes are unavailable');
	return createHash('sha256').update(result.stdout).digest('hex');
}
function sourceBytes(common: string, commit: string, path: string): Uint8Array {
	const mode = git(common, ['--literal-pathspecs', 'ls-tree', '--format=%(objectmode)', commit, '--', path]);
	if (mode !== '100644' && mode !== '100755') throw ckError('CONFIG', `workspace material source is not a saved regular file: ${path}`);
	const blob = runGitBytes({ cwd: common, args: ['--git-dir', common, 'show', `${commit}:${path}`] });
	if (blob.status !== 0) throw ckError('CONFIG', 'workspace material source Git blob is unavailable');
	return blob.stdout;
}
function emptyDirectory(root: string, path: string, allowMissing: boolean): boolean {
	const resolved = resolveContainedPath(root, path, { allowMissing });
	if (!resolved.ok) throw ckError('CONFIG', 'workspace material directory is not contained');
	try {
		return readdirSync(resolved.absolute).length === 0;
	} catch (error) {
		if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
		throw ckError('CONFIG', 'workspace material directory is not a readable real directory');
	}
}
function git(common: string, args: readonly string[]): string {
	const result = runGit({ cwd: common, args: ['--git-dir', common, ...args] });
	if (result.status !== 0) throw ckError('CONFIG', result.stderr.trim());
	return result.stdout.trim();
}
