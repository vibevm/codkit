import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const source = makeSyncFixture('workspace-material-source');
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
		workspaceMaterialsSchema.safeParse({ codkitWorkspaceMaterials: 2, id: f.record.id, finished: finished.finished, files }).success
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
