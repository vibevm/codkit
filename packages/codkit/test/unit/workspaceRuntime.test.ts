import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createWorkspace } from '../../src/lib/workspaceCreate.ts';
import { finishWorkspace } from '../../src/lib/workspaceFinish.ts';
import { removeWorkspace } from '../../src/lib/workspaceRemove.ts';
import { workspaceClosedRuntimeSchema } from '../../src/lib/workspaceRuntime.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { projectType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const source = makeSyncFixture('workspace-runtime-source');
	const authority = makeTempRoot('workspace-runtime-authority');
	const record = createWorkspace({
		registryRoot: authority,
		directory: makeTempRoot('workspace-runtime-pairs'),
		name: 'task',
		patchesRepository: source.patchesDir,
		forkRepository: source.treeDir,
		owner: { id: 'fixture', session: 'fixture' },
		registration: readTypeManifest('stub', STUB_TYPE_MODULE)
	});
	const dir = join(record.patchset.path, '.codkit/build');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'deps-hash.json');
	const data = {
		codkitDepsHash: 1,
		treeId: treeId(record.fork.path),
		treePath: record.fork.path,
		hash: 'a'.repeat(64),
		updatedAt: '2026-10-04T00:00:00Z'
	};
	writeFileSync(path, `${JSON.stringify(data)}\n`);
	return { record, authority, path, data, finish: () => finishWorkspace({ registryRoot: authority, name: 'task', type: projectType }) };
}
it('retains recognized dependency runtime outside the pair and rejects edits after finish', () => {
	const f = fixture();
	const bytes = readFileSync(f.path);
	f.finish();
	writeFileSync(f.path, 'new runtime work');
	expect(() => removeWorkspace({ registryRoot: f.authority, name: 'task' })).toThrow(/runtime or its retained archive changed/);
	expect(existsSync(f.record.fork.path)).toBe(true);
	writeFileSync(f.path, bytes);
	expect(removeWorkspace({ registryRoot: f.authority, name: 'task' }).state).toBe('removed');
	expect(existsSync(join(f.authority, 'workspace-runtime-bytes'))).toBe(true);
});
it('refuses future/foreign dependency records and does not infer ownership for neighbouring runtime data', () => {
	const f = fixture();
	for (const data of [
		{ ...f.data, codkitDepsHash: 2 },
		{ ...f.data, treeId: 'foreign' },
		{ ...f.data, extra: 'unowned' }
	]) {
		writeFileSync(f.path, JSON.stringify(data));
		expect(f.finish).toThrow(/malformed or foreign/);
	}
	writeFileSync(f.path, JSON.stringify(f.data));
	writeFileSync(join(f.record.patchset.path, '.codkit/human.txt'), 'keep this');
	expect(f.finish).toThrow(/uncommitted or untracked/);
	expect(readFileSync(join(f.record.patchset.path, '.codkit/human.txt'), 'utf8')).toBe('keep this');
});
it('refuses future runtime archive versions and arbitrary archive paths', () => {
	const f = fixture();
	const payload = {
		codkitWorkspaceClosedRuntime: 1,
		id: f.record.id,
		patchsetCommit: f.record.patchset.baseCommit,
		forkCommit: f.record.fork.baseCommit,
		files: [{ path: '.codkit/human.txt', sha256: 'a'.repeat(64), bytes: 1 }]
	};
	expect(workspaceClosedRuntimeSchema.safeParse(payload).success).toBe(false);
	expect(workspaceClosedRuntimeSchema.safeParse({ ...payload, codkitWorkspaceClosedRuntime: 2, files: [] }).success).toBe(false);
});
