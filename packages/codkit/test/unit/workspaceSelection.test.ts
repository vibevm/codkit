import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createWorkspace } from '../../src/lib/workspaceCreate.ts';
import { finishWorkspace } from '../../src/lib/workspaceFinish.ts';
import { selectWorkspace } from '../../src/lib/workspaceSelection.ts';
import { workspaceConfig, inheritWorkspaceConfig } from '../../src/lib/workspaceConfig.ts';
import { loadBaseConfig, serializeBaseConfig, parseBaseConfig } from '../../src/lib/configFile.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { projectType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const source = makeSyncFixture('workspace-selection-source');
	const registryRoot = makeTempRoot('workspace-selection-registry');
	const record = createWorkspace({
		registryRoot,
		directory: makeTempRoot('workspace-selection-pairs'),
		name: 'Task',
		patchesRepository: source.patchesDir,
		forkRepository: source.treeDir,
		owner: { id: 'fixture', session: 'session' },
		registration: readTypeManifest('stub', STUB_TYPE_MODULE)
	});
	const select = (name = 'task') => selectWorkspace(name, { patchesDir: null, forkDir: null }, registryRoot);
	return { record, registryRoot, select };
}
it('selects the same verified active pair by name and UUID', () => {
	const f = fixture();
	const selected = f.select();
	expect(selected.record).toEqual(f.record);
	expect(f.select(f.record.id)).toEqual(selected);
	expect(selected.locations).toMatchObject({
		patchesDir: { path: f.record.patchset.path, source: 'flag', exists: true },
		forkDir: { path: f.record.fork.path, source: 'flag', exists: true }
	});
	expect(() => selectWorkspace('task', { patchesDir: f.record.patchset.path, forkDir: null }, f.registryRoot)).toThrow(
		/external root flags/
	);
});
it('refuses missing names, foreign role receipts and finished lifecycle states', () => {
	const f = fixture();
	expect(() => f.select('absent')).toThrow(/not registered/);
	writeFileSync(join(f.record.fork.path, '.codkit/workspace.json'), '{}\n');
	expect(f.select).toThrow(/receipt.*foreign/);
	const other = fixture();
	finishWorkspace({ registryRoot: other.registryRoot, name: 'task', type: projectType });
	expect(other.select).toThrow(/requires an active workspace/);
});

it('keeps declaration serialization unchanged while inheriting execution namespaces across snapshots', () => {
	const f = fixture();
	const declared = loadBaseConfig(f.record.patchset.path);
	if (declared === null) throw new Error('missing fixture config');
	const executed = workspaceConfig(declared, f.record);
	expect(executed.generatedBranchPrefix).toBe(`codkit/workspace/${f.record.id}/applied/`);
	expect(serializeBaseConfig(executed)).toBe(serializeBaseConfig(declared));
	const snapshot = { ...declared, releaseRefPrefix: 'snapshot/release/' };
	const inherited = inheritWorkspaceConfig(snapshot, executed);
	expect(inherited.releaseRefPrefix).toBe(`codkit/workspace/${f.record.id}/release/`);
	expect(serializeBaseConfig(inherited)).toBe(serializeBaseConfig(snapshot));
	expect(() => parseBaseConfig(executed, 'not a persisted configuration')).toThrow(/workspace/);
});
