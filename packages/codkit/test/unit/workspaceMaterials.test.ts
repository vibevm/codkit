import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createWorkspace } from '../../src/lib/workspaceCreate.ts';
import { finishWorkspace } from '../../src/lib/workspaceFinish.ts';
import { removeWorkspace } from '../../src/lib/workspaceRemove.ts';
import { readWorkspaceMaterials, workspaceMaterialsSchema, writeWorkspaceMaterials } from '../../src/lib/workspaceMaterials.ts';
import { readWorkspaceRegistry } from '../../src/lib/workspaceRegistry.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import { workspaceConfig } from '../../src/lib/workspaceConfig.ts';
import { runSync } from '../../src/lib/syncEngine.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { projectType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { LFS_EXTRA, lfsObjectPath, provideLfsContent } from '../fixtures/lfsUpstream.ts';
import { makeInputRepository } from '../support/inputRepository.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { inputBlobRef } from '../../src/lib/workspaceInput.ts';
import { captureWorkspaceBuildOutputs } from '../../src/lib/workspaceBuildOutputs.ts';
import { readInputStore, writeInputStore } from '../../src/lib/inputsStore.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture(kind?: 'lfs' | 'fake-lfs' | 'empty' | 'input' | 'build') {
	const source = makeSyncFixture('workspace-material-source');
	if (kind === 'input') {
		const input = makeInputRepository('workspace-material-input');
		const path = join(source.patchesDir, 'codkit.json');
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), inputs: [input.declaration()] }, null, 2) + '\n');
		fixtureCommit(source.patchesDir, 'declare workspace input fixture', '2026-10-04T00:00:00Z');
	} else if (kind === 'lfs' || kind === 'fake-lfs') {
		provideLfsContent(source.patchesDir, [LFS_EXTRA]);
		writeFileSync(
			join(source.patchesDir, kind === 'lfs' ? '.gitattributes' : '.git/info/attributes'),
			'delta/own/asset.bin filter=lfs diff=lfs merge=lfs -text\n'
		);
		writeFileSync(join(source.patchesDir, 'delta/own/asset.bin'), LFS_EXTRA.content);
		fixtureCommit(source.patchesDir, 'saved LFS own fixture', '2026-10-04T00:00:00Z');
	} else if (kind === 'empty') {
		mkdirSync(join(source.patchesDir, 'delta/own/empty'), { recursive: true });
		writeFileSync(join(source.patchesDir, 'delta/own/empty/.gitkeep'), '');
		fixtureCommit(source.patchesDir, 'saved empty directory fixture', '2026-10-04T00:00:00Z');
	}
	const registryRoot = makeTempRoot('workspace-material-authority');
	const record = createWorkspace({
		registryRoot,
		directory: makeTempRoot('workspace-material-pairs'),
		name: 'task',
		patchesRepository: source.patchesDir,
		forkRepository: source.treeDir,
		owner: { id: 'fixture', session: 'fixture' },
		registration: readTypeManifest('stub', STUB_TYPE_MODULE)
	});
	const declared = loadConfig(record.patchset.path);
	if (declared === null) throw new Error('missing fixture config');
	const config = workspaceConfig(declared, record, registryRoot);
	const result = runSync({
		...(kind === 'input' ? { inputs: 'working' as const } : {}),
		fresh: false,
		dryRun: false,
		verbose: false,
		patchesDir: record.patchset.path,
		resolution: { path: record.fork.path, source: 'flag', exists: true, warning: null },
		config,
		type: projectType,
		out: new Output({
			command: 'load',
			version: 'fixture',
			jsonMode: false,
			streams: { writeOut: () => undefined, writeErr: () => undefined }
		})
	});
	expect(result.exitCode).toBe(0);
	if (kind === 'empty') mkdirSync(join(record.fork.path, config.typeConfig.ownRoot, 'empty'), { recursive: true });
	if (kind === 'build') {
		mkdirSync(join(record.fork.path, 'out-fixture/empty'), { recursive: true });
		writeFileSync(join(record.fork.path, 'out-fixture/artifact.bin'), 'retain compiled fixture output');
	}
	return { record, config, registryRoot, finish: () => finishWorkspace({ registryRoot, name: 'task', type: projectType }) };
}
it('removes verified materialized sources after the patchset checkout is gone and retains the external receipt', () => {
	const f = fixture();
	const finished = f.finish();
	const files = readWorkspaceMaterials(f.registryRoot, finished);
	expect(files.length).toBeGreaterThan(0);
	const first = files.find((file) => file.kind === 'source');
	if (first === undefined || first.kind !== 'source') throw new Error('no material fixture');
	expect(readFileSync(join(f.record.fork.path, first.path))).toEqual(readFileSync(join(f.record.patchset.path, first.source)));
	expect(() =>
		removeWorkspace({
			registryRoot: f.registryRoot,
			name: 'task',
			checkpoint: (stage) => {
				if (stage === 'patchset-removed') throw new Error('fixture interruption');
			}
		})
	).toThrow(/fixture interruption/);
	expect(existsSync(f.record.patchset.path)).toBe(false);
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
	expect(readWorkspaceMaterials(f.registryRoot, finished)).toEqual(files);
});

it('records hydrated LFS copies in v2 and refuses loss of their saved backing object', () => {
	const f = fixture('lfs');
	const finished = f.finish();
	const files = readWorkspaceMaterials(f.registryRoot, finished);
	const lfs = files.find((file) => file.kind === 'lfs-source');
	expect(lfs).toMatchObject({ kind: 'lfs-source', sha256: LFS_EXTRA.oid, bytes: LFS_EXTRA.size });
	const raw = { codkitWorkspaceMaterials: 1, id: f.record.id, finished: finished.finished, files };
	expect(workspaceMaterialsSchema.safeParse(raw).success).toBe(false);
	expect(workspaceMaterialsSchema.safeParse({ ...raw, codkitWorkspaceMaterials: 2 }).success).toBe(true);
	expect(() =>
		removeWorkspace({
			registryRoot: f.registryRoot,
			name: 'task',
			checkpoint: (stage) => {
				if (stage === 'patchset-removed') throw new Error('fixture LFS interruption');
			}
		})
	).toThrow(/fixture LFS interruption/);
	const backing = lfsObjectPath(join(f.record.patchset.commonDirectory, 'lfs'), LFS_EXTRA.oid);
	const bytes = readFileSync(backing);
	unlinkSync(backing);
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/backing object is missing/);
	expect(existsSync(f.record.fork.path)).toBe(true);
	writeFileSync(backing, bytes);
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
});
it('admits only saved empty directory anchors and refuses data added after finish', () => {
	const f = fixture('empty');
	const finished = f.finish();
	const files = readWorkspaceMaterials(f.registryRoot, finished);
	const dir = files.find((file) => file.kind === 'empty-directory');
	if (dir === undefined) throw new Error('no empty directory receipt');
	writeFileSync(join(f.record.fork.path, dir.path, 'human.txt'), 'preserve new work');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/directory changed/);
	expect(existsSync(f.record.patchset.path)).toBe(true);
	unlinkSync(join(f.record.fork.path, dir.path, 'human.txt'));
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
});
it('does not let local info/attributes declare cleanup authority for a saved pointer', () => {
	const f = fixture('fake-lfs');
	expect(f.finish).toThrow(/LFS bytes differ/);
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.state).toBe('active');
	expect(readFileSync(join(f.record.fork.path, f.config.typeConfig.ownRoot, 'asset.bin'))).toEqual(Buffer.from(LFS_EXTRA.content));
});

it('retains delivered input blobs after both checkouts disappear and rejects their kinds in old formats', () => {
	const f = fixture('input');
	const finished = f.finish();
	const files = readWorkspaceMaterials(f.registryRoot, finished);
	const input = files.find((file) => file.kind === 'input');
	if (input === undefined || input.kind !== 'input') throw new Error('no input receipt');
	for (const version of [1, 2])
		expect(
			workspaceMaterialsSchema.safeParse({ codkitWorkspaceMaterials: version, id: f.record.id, finished: finished.finished, files }).success
		).toBe(false);
	const bytes = readFileSync(join(f.record.fork.path, input.path));
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
	const result = runGit({ cwd: f.record.fork.commonDirectory, args: ['cat-file', 'blob', inputBlobRef(f.record.id, input.blob)] });
	expect(result.status).toBe(0);
	expect(Buffer.from(result.stdout)).toEqual(bytes);
});
it('refuses changed input delivery and loss of a retained blob ref without discarding work', () => {
	const f = fixture('input');
	const finished = f.finish();
	const input = readWorkspaceMaterials(f.registryRoot, finished).find((file) => file.kind === 'input');
	if (input === undefined || input.kind !== 'input') throw new Error('no input receipt');
	const path = join(f.record.fork.path, input.path);
	const bytes = readFileSync(path);
	writeFileSync(path, 'new input work');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/input material changed/);
	expect(existsSync(f.record.patchset.path)).toBe(true);
	writeFileSync(path, bytes);
	expect(runGit({ cwd: f.record.fork.path, args: ['update-ref', '-d', inputBlobRef(f.record.id, input.blob)] }).status).toBe(0);
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/retained blob ref/);
	expect(existsSync(f.record.fork.path)).toBe(true);
});
it('does not promote a forged Git-admin input cache into cleanup authority', () => {
	const f = fixture('input');
	const stored = readInputStore(f.record.fork.path, (text) => {
		throw new Error(text);
	});
	const original = stored[0];
	if (original === undefined) throw new Error('no input cache');
	writeInputStore(f.record.fork.path, [{ ...original, stamp: '0'.repeat(64) }]);
	expect(f.finish).toThrow(/delivery witness/);
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.state).toBe('active');
	writeInputStore(f.record.fork.path, stored);
	expect(f.finish().state).toBe('finished');
});

it('archives declared build files and exact empty directories in v4 before deletion', () => {
	const f = fixture('build');
	const finished = f.finish();
	const files = readWorkspaceMaterials(f.registryRoot, finished);
	const build = files.find((file) => file.kind === 'build-output' && file.entry === 'file');
	if (build === undefined || build.kind !== 'build-output') throw new Error('no build output receipt');
	expect(files.some((file) => file.kind === 'build-output' && file.entry === 'directory')).toBe(true);
	for (const version of [1, 2, 3])
		expect(
			workspaceMaterialsSchema.safeParse({ codkitWorkspaceMaterials: version, id: f.record.id, finished: finished.finished, files }).success
		).toBe(false);
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
	expect(readFileSync(join(f.registryRoot, 'workspace-output-bytes', `${build.sha256}.bin`), 'utf8')).toBe(
		'retain compiled fixture output'
	);
});
it('refuses changed build copies and missing archive data without deleting either root', () => {
	const f = fixture('build');
	const finished = f.finish();
	const build = readWorkspaceMaterials(f.registryRoot, finished).find((file) => file.kind === 'build-output' && file.entry === 'file');
	if (build === undefined || build.kind !== 'build-output') throw new Error('no build output receipt');
	const path = join(f.record.fork.path, build.path);
	const bytes = readFileSync(path);
	writeFileSync(path, 'new work');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/build output changed/);
	expect(existsSync(f.record.patchset.path)).toBe(true);
	writeFileSync(path, bytes);
	unlinkSync(join(f.registryRoot, 'workspace-output-bytes', `${build.sha256}.bin`));
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/output is missing/);
	expect(existsSync(f.record.fork.path)).toBe(true);
});
it('archives only leaf link text and never follows a declared output link outside the tree', () => {
	const f = fixture('build');
	const outside = makeTempRoot('workspace-output-external');
	writeFileSync(join(outside, 'keep.txt'), 'external content');
	symlinkSync(outside, join(f.record.fork.path, 'out-fixture/link'), process.platform === 'win32' ? 'junction' : 'dir');
	const finished = f.finish();
	const materials = readWorkspaceMaterials(f.registryRoot, finished);
	const link = materials.find((file) => file.kind === 'build-output' && file.entry === 'link');
	const linkText = readlinkSync(join(f.record.fork.path, 'out-fixture/link'));
	expect(link).toMatchObject({
		path: 'out-fixture/link',
		entry: 'link',
		linkText,
		sha256: createHash('sha256').update(linkText).digest('hex'),
		bytes: Buffer.byteLength(linkText)
	});
	expect(materials.some((file) => file.path.startsWith('out-fixture/link/'))).toBe(false);
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
	expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('external content');
});
it('does not reclassify indexed leaf links or their Git-projected descendants as build outputs', () => {
	const f = fixture('build');
	const outside = makeTempRoot('workspace-indexed-link-external');
	writeFileSync(join(outside, 'keep.txt'), 'external indexed-link content');
	const path = 'out-fixture/indexed-link';
	symlinkSync(outside, join(f.record.fork.path, path), process.platform === 'win32' ? 'junction' : 'dir');
	const blob = runGit({
		cwd: f.record.fork.path,
		args: ['hash-object', '-w', '--stdin'],
		input: readlinkSync(join(f.record.fork.path, path))
	});
	expect(blob.status).toBe(0);
	expect(
		runGit({ cwd: f.record.fork.path, args: ['update-index', '--add', '--cacheinfo', '120000', blob.stdout.trim(), path] }).status
	).toBe(0);
	const outputs = captureWorkspaceBuildOutputs(f.record, f.config, projectType, 'a'.repeat(64), f.registryRoot, new Set());
	expect(outputs.some((output) => output.path === 'out-fixture/artifact.bin')).toBe(true);
	expect(outputs.some((output) => output.path === path || output.path.startsWith(`${path}/`))).toBe(false);
	expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('external indexed-link content');
});
it('refuses edited saved material and unowned ignored content without deleting either checkout', () => {
	const f = fixture();
	const finished = f.finish();
	const file = readWorkspaceMaterials(f.registryRoot, finished).find((file) => file.kind === 'source');
	if (file === undefined || file.kind !== 'source') throw new Error('no material fixture');
	const path = join(f.record.fork.path, file.path);
	const bytes = readFileSync(path);
	writeFileSync(path, 'new unsaved material');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/material changed after finish/);
	expect(existsSync(f.record.patchset.path)).toBe(true);
	writeFileSync(path, bytes);
	const extra = join(f.record.fork.path, f.config.typeConfig.ownRoot, 'human-work.ts');
	writeFileSync(extra, 'preserve unrelated work');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/unowned data/);
	expect(readFileSync(extra, 'utf8')).toBe('preserve unrelated work');
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.state).toBe('finished');
});
it('refuses an unsaved source before sealing finish, including new files in an ignored own root', () => {
	const f = fixture();
	const extra = join(f.record.fork.path, f.config.typeConfig.ownRoot, 'new-unsaved.ts');
	writeFileSync(extra, 'new source work');
	expect(f.finish).toThrow(/not saved|not saved to|own\/upstream work/);
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.state).toBe('active');
	expect(readFileSync(extra, 'utf8')).toBe('new source work');
});
it('does not accept source-map forgery, future formats or overwrite an immutable receipt', () => {
	const f = fixture();
	const finished = f.finish();
	const files = readWorkspaceMaterials(f.registryRoot, finished);
	expect(
		workspaceMaterialsSchema.safeParse({ codkitWorkspaceMaterials: 5, id: f.record.id, finished: finished.finished, files }).success
	).toBe(false);
	expect(() => writeWorkspaceMaterials(f.registryRoot, finished, [])).toThrow(/foreign/);
	const first = files.find((file) => file.kind === 'source');
	if (first === undefined || first.kind !== 'source') throw new Error('no material fixture');
	expect(
		workspaceMaterialsSchema.safeParse({
			codkitWorkspaceMaterials: 1,
			id: f.record.id,
			finished: finished.finished,
			files: [{ ...first, path: '../foreign' }]
		}).success
	).toBe(false);
	const dir = join(f.registryRoot, 'workspace-materials', f.record.id);
	const name = readdirSync(dir).find((path) => path.endsWith('.json'));
	if (name === undefined) throw new Error('no material receipt');
	const path = join(dir, name);
	const original = readFileSync(path);
	const receipt = workspaceMaterialsSchema.parse(JSON.parse(original.toString('utf8')));
	writeFileSync(
		path,
		JSON.stringify({ ...receipt, files: receipt.files.map((file) => (file.kind === 'source' ? { ...file, source: 'codkit.json' } : file)) })
	);
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/source differs/);
	writeFileSync(path, '{ malformed receipt');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/not valid JSON/);
	writeFileSync(path, original);
	expect(existsSync(f.record.patchset.path)).toBe(true);
});
