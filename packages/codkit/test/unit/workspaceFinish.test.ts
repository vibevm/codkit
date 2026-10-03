import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createWorkspace } from '../../src/lib/workspaceCreate.ts';
import { finishWorkspace } from '../../src/lib/workspaceFinish.ts';
import { removeWorkspace } from '../../src/lib/workspaceRemove.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { readWorkspaceRegistry } from '../../src/lib/workspaceRegistry.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { projectType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const source = makeSyncFixture('workspace-finish-source');
	const registryRoot = makeTempRoot('workspace-finish-registry');
	const record = createWorkspace({
		registryRoot,
		directory: makeTempRoot('workspace-finish-pairs'),
		name: 'task',
		patchesRepository: source.patchesDir,
		forkRepository: source.treeDir,
		owner: { id: 'fixture-owner', session: 'fixture-session' },
		registration: readTypeManifest('stub', STUB_TYPE_MODULE)
	});
	return { record, registryRoot, finish: () => finishWorkspace({ registryRoot, name: 'task', type: projectType }) };
}
it('finishes an untouched pair with preserved immutable heads and leaves both checkouts present', () => {
	const f = fixture();
	const result = f.finish();
	expect(result.state).toBe('finished');
	expect(result.finished).toMatchObject({
		patchsetCommit: f.record.patchset.baseCommit,
		forkCommit: f.record.fork.baseCommit,
		deltaFingerprint: null
	});
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.finished).toEqual(result.finished);
	expect(readFileSync(join(f.record.patchset.path, '.codkit/workspace.json'))).toBeDefined();
});
it('refuses dirty task work and an unextracted detached fork commit without discarding either', () => {
	const f = fixture();
	writeFileSync(join(f.record.patchset.path, 'human-work.txt'), 'preserve task work\n');
	expect(f.finish).toThrow(/uncommitted or untracked/);
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.state).toBe('active');
	const other = fixture();
	writeFileSync(join(other.record.fork.path, 'new-work.txt'), 'preserve detached commit\n');
	fixtureCommit(other.record.fork.path, 'human fork work', '2026-10-03T00:00:00Z');
	expect(other.finish).toThrow(/unextracted fork commits/);
	expect(readFileSync(join(other.record.fork.path, 'new-work.txt'), 'utf8')).toBe('preserve detached commit\n');
});
it('refuses live writers, foreign receipts and unresolved daemon records', () => {
	const f = fixture();
	const writer = acquireLock(f.record.patchset.path, 'another-tree', 'fixture writer');
	try {
		expect(f.finish).toThrow(/already working/);
	} finally {
		writer.release();
	}
	writeFileSync(join(f.record.patchset.path, '.codkit/workspace.json'), '{}\n');
	expect(f.finish).toThrow(/receipt.*foreign/);
	const other = fixture();
	mkdirSync(join(other.record.patchset.path, '.codkit/build'));
	writeFileSync(join(other.record.patchset.path, '.codkit/build/watch.json'), '{}\n');
	expect(other.finish).toThrow(/unresolved build daemon/);
});

it('removes only a finished pair and retains both immutable heads in repository refs', () => {
	const f = fixture();
	const remove = () => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' });
	expect(remove).toThrow(/must finish/);
	const finished = f.finish();
	expect(remove().state).toBe('removed');
	for (const role of ['patchset', 'fork'] as const) {
		expect(existsSync(f.record[role].path)).toBe(false);
		const ref = runGit({ cwd: f.record[role].repository, args: ['rev-parse', `refs/codkit/workspace/${f.record.id}/finished/${role}`] });
		expect(ref.status).toBe(0);
		expect(ref.stdout.trim()).toBe(role === 'patchset' ? finished.finished?.patchsetCommit : finished.finished?.forkCommit);
	}
	expect(remove().state).toBe('removed');
});

it('preserves ignored files and empty unowned directories during removal', () => {
	const f = fixture();
	writeFileSync(join(f.record.patchset.path, '.gitignore'), 'private-work/\n');
	fixtureCommit(f.record.patchset.path, 'ignore private work', '2026-10-04T00:00:00Z');
	f.finish();
	mkdirSync(join(f.record.patchset.path, 'private-work'));
	writeFileSync(join(f.record.patchset.path, 'private-work/notes.txt'), 'keep me');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/unowned data/);
	expect(readFileSync(join(f.record.patchset.path, 'private-work/notes.txt'), 'utf8')).toBe('keep me');
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.state).toBe('finished');
	const empty = fixture();
	empty.finish();
	mkdirSync(join(empty.record.fork.path, 'human-empty-directory'));
	expect(() => removeWorkspace({ registryRoot: empty.registryRoot, name: 'task' })).toThrow(/unowned data/);
	expect(existsSync(empty.record.patchset.path)).toBe(true);
});

it('resumes a journaled partial removal without discarding finish proof', () => {
	const f = fixture();
	const finished = f.finish();
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
	expect(existsSync(f.record.fork.path)).toBe(true);
	expect(readWorkspaceRegistry(f.registryRoot).workspaces[0]?.state).toBe('removing');
	const result = removeWorkspace({ registryRoot: f.registryRoot, name: 'task' });
	expect(result.state).toBe('removed');
	expect(result.finished).toEqual(finished.finished);
});

it('refuses a moved finished HEAD and a writer that still owns either checkout', () => {
	const f = fixture();
	f.finish();
	const lock = acquireLock(f.record.fork.path, 'other-writer', 'fixture');
	try {
		expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/already working/);
	} finally {
		lock.release();
	}
	writeFileSync(join(f.record.patchset.path, 'new-task.txt'), 'new committed work');
	fixtureCommit(f.record.patchset.path, 'new task after finish', '2026-10-04T00:00:00Z');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/HEAD changed/);
	expect(existsSync(f.record.fork.path)).toBe(true);
});

it('rechecks unowned data after journaling and refuses a foreign retained ref on retry', () => {
	const f = fixture();
	f.finish();
	expect(() =>
		removeWorkspace({
			registryRoot: f.registryRoot,
			name: 'task',
			checkpoint: (stage) => {
				if (stage === 'journaled') mkdirSync(join(f.record.fork.path, 'late-human-directory'));
			}
		})
	).toThrow(/unowned data/);
	expect(existsSync(f.record.fork.path)).toBe(true);
	const other = fixture();
	other.finish();
	expect(() =>
		removeWorkspace({
			registryRoot: other.registryRoot,
			name: 'task',
			checkpoint: (stage) => {
				if (stage === 'patchset-removed') throw new Error('fixture interruption');
			}
		})
	).toThrow(/fixture interruption/);
	const ref = `refs/codkit/workspace/${other.record.id}/finished/patchset`;
	expect(runGit({ cwd: other.record.patchset.repository, args: ['update-ref', '-d', ref] }).status).toBe(0);
	expect(() => removeWorkspace({ registryRoot: other.registryRoot, name: 'task' })).toThrow(/removal refused/);
	expect(existsSync(other.record.fork.path)).toBe(true);
});
