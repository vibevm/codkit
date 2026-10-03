import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createWorkspace, verifyWorkspaceCheckout } from '../../src/lib/workspaceCreate.ts';
import { readWorkspaceRegistry, workspaceRefPrefixes, workspaceRegistrySchema } from '../../src/lib/workspaceRegistry.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function options(name = 'task-one') {
	const source = makeSyncFixture('workspace-source');
	return {
		registryRoot: makeTempRoot('workspace-registry'),
		directory: makeTempRoot('workspace-pairs'),
		name,
		patchesRepository: source.patchesDir,
		forkRepository: source.treeDir,
		owner: { id: 'fixture-owner', session: 'fixture-session' },
		registration: readTypeManifest('stub', STUB_TYPE_MODULE)
	};
}
it('creates two real worktrees with stable task identity and separate namespace without rewriting source config', () => {
	const input = options();
	const before = readFileSync(join(input.patchesRepository, 'codkit.json'));
	const first = createWorkspace(input);
	expect(first.state).toBe('active');
	verifyWorkspaceCheckout(first, 'patchset');
	verifyWorkspaceCheckout(first, 'fork');
	expect(readWorkspaceRegistry(input.registryRoot).workspaces).toEqual([first]);
	expect(readFileSync(join(input.patchesRepository, 'codkit.json'))).toEqual(before);
	expect(readFileSync(join(first.patchset.path, 'codkit.json'))).toEqual(before);
	const second = createWorkspace({ ...input, name: 'task-two' });
	expect(first.id).not.toBe(second.id);
	expect(workspaceRefPrefixes(first.id).generatedBranchPrefix).not.toBe(workspaceRefPrefixes(second.id).generatedBranchPrefix);
	expect(() => createWorkspace({ ...input, name: 'TASK-ONE' })).toThrow(/already reserved/);
});
it('resumes an interrupted pair after the first worktree without replacing its receipt', () => {
	const input = options();
	expect(() =>
		createWorkspace({
			...input,
			checkpoint: (stage) => {
				if (stage === 'patchset-created') throw new Error('fixture interruption');
			}
		})
	).toThrow(/fixture interruption/);
	const reserved = readWorkspaceRegistry(input.registryRoot).workspaces[0];
	if (reserved === undefined) throw new Error('fixture reservation absent');
	expect(reserved.state).toBe('creating');
	expect(existsSync(reserved.patchset.path)).toBe(true);
	expect(existsSync(reserved.fork.path)).toBe(false);
	const receipt = readFileSync(join(reserved.patchset.path, '.codkit/workspace.json'));
	const resumed = createWorkspace(input);
	expect(resumed.id).toBe(reserved.id);
	expect(resumed.state).toBe('active');
	expect(readFileSync(join(resumed.patchset.path, '.codkit/workspace.json'))).toEqual(receipt);
});
it('refuses foreign-session retry and changed partial checkout while preserving the work', () => {
	const input = options();
	expect(() =>
		createWorkspace({
			...input,
			checkpoint: (stage) => {
				if (stage === 'patchset-created') throw new Error('fixture interruption');
			}
		})
	).toThrow();
	const reserved = readWorkspaceRegistry(input.registryRoot).workspaces[0];
	if (reserved === undefined) throw new Error('fixture reservation absent');
	expect(() => createWorkspace({ ...input, owner: { id: 'fixture-owner', session: 'other' } })).toThrow(/creating owner/);
	writeFileSync(join(reserved.patchset.path, 'human-work.txt'), 'preserve this work\n');
	expect(() => createWorkspace(input)).toThrow(/refusing to overwrite/);
	expect(readFileSync(join(reserved.patchset.path, 'human-work.txt'), 'utf8')).toBe('preserve this work\n');
	expect(readWorkspaceRegistry(input.registryRoot).workspaces[0]?.state).toBe('creating');
});
it('refuses unsafe directory placement and future or duplicate registry identities', () => {
	const input = options();
	expect(() => createWorkspace({ ...input, directory: input.patchesRepository })).toThrow(/disjoint/);
	const first = createWorkspace(input);
	expect(workspaceRegistrySchema.safeParse({ codkitWorkspaceRegistry: 2, revision: 1, workspaces: [first] }).success).toBe(false);
	expect(
		workspaceRegistrySchema.safeParse({
			codkitWorkspaceRegistry: 1,
			revision: 1,
			workspaces: [first, { ...first, name: first.name.toUpperCase() }]
		}).success
	).toBe(false);
	expect(
		workspaceRegistrySchema.safeParse({
			codkitWorkspaceRegistry: 1,
			revision: 1,
			workspaces: [{ ...first, patchset: { ...first.patchset, branch: 'shared-task' } }]
		}).success
	).toBe(false);
});
