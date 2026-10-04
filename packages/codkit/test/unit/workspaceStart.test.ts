// Deterministic lifecycle/start interleavings against actual registered Git pairs.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createWorkspace } from '../../src/lib/workspaceCreate.ts';
import { finishWorkspace } from '../../src/lib/workspaceFinish.ts';
import { removeWorkspace } from '../../src/lib/workspaceRemove.ts';
import { updateWorkspaceRegistry, readWorkspaceRegistry, findWorkspace, workspaceIdSchema } from '../../src/lib/workspaceRegistry.ts';
import { upChannel, downChannel } from '../../src/lib/buildWrap.ts';
import { recordPath, readRecordState } from '../../src/lib/buildRuntime.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { projectType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
const channel = {
	name: 'transpile',
	script: 'watch-transpile',
	passStart: [/start/],
	passEnd: [/done/],
	errorLine: [/error/],
	errorCountLine: [],
	falseEndGuards: []
};
function fixture() {
	const source = makeSyncFixture('workspace-start-source');
	const registryRoot = makeTempRoot('workspace-start-control');
	const record = createWorkspace({
		registryRoot,
		directory: makeTempRoot('workspace-start-pairs'),
		name: 'task',
		patchesRepository: source.patchesDir,
		forkRepository: source.treeDir,
		owner: { id: 'fixture', session: 'fixture' },
		registration: readTypeManifest('stub', STUB_TYPE_MODULE)
	});
	const ctx = {
		patchesDir: record.patchset.path,
		treeDir: record.fork.path,
		treeId: treeId(record.fork.path),
		workspaceId: record.id,
		workspaceRegistryRoot: registryRoot
	};
	return { record, ctx, registryRoot, finish: () => finishWorkspace({ registryRoot, name: 'task', type: projectType }) };
}
it('holds the shared registry guard before channel writes and through final PID publication', () => {
	const f = fixture();
	const revision = readWorkspaceRegistry(f.registryRoot).revision;
	let barriers = 0;
	const barrier = () => {
		barriers++;
		expect(f.finish).toThrow(/already working/);
	};
	const result = upChannel(f.ctx, channel, {
		afterLock: barrier,
		afterReservation: barrier,
		beforeFinalize: barrier,
		spawn: () => ({ pid: 4_194_305, terminate: () => undefined })
	});
	expect(result).toMatchObject({ ok: true, action: 'started' });
	expect(barriers).toBe(3);
	expect(readWorkspaceRegistry(f.registryRoot)).toMatchObject({ revision, workspaces: [{ state: 'active' }] });
	expect(readRecordState(f.record.patchset.path, channel.name)).toMatchObject({
		state: 'valid',
		record: { workspaceId: f.record.id, pid: 4_194_305 }
	});
});
it('rejects a stale start after finish and after removal without recreating either checkout', () => {
	const f = fixture();
	f.finish();
	let spawns = 0;
	const start = () =>
		upChannel(f.ctx, channel, {
			spawn: () => {
				spawns++;
				return { pid: 4_194_305, terminate: () => undefined };
			}
		});
	expect(start()).toMatchObject({ ok: false, reason: 'daemon start requires an active workspace' });
	expect(existsSync(recordPath(f.record.patchset.path, channel.name))).toBe(false);
	removeWorkspace({ registryRoot: f.registryRoot, name: 'task' });
	expect(start()).toMatchObject({ ok: false });
	expect(spawns).toBe(0);
	expect(existsSync(f.record.patchset.path)).toBe(false);
	expect(existsSync(f.record.fork.path)).toBe(false);
});
it('refuses a start while lifecycle authority is locked and refuses unbound paired-checkout starts', () => {
	const f = fixture();
	let spawns = 0;
	const runtime = {
		spawn: () => {
			spawns++;
			return { pid: 4_194_305, terminate: () => undefined };
		}
	};
	updateWorkspaceRegistry(f.registryRoot, () => expect(upChannel(f.ctx, channel, runtime)).toMatchObject({ ok: false }));
	const { workspaceId: _, ...unbound } = f.ctx;
	expect(upChannel(unbound, channel, runtime)).toMatchObject({ ok: false });
	expect(spawns).toBe(0);
	expect(existsSync(join(f.record.patchset.path, '.codkit/build'))).toBe(false);
});

it('does not let UUID-shaped names replace the identity or active state used by a start', () => {
	const f = fixture();
	f.finish();
	const unknown = workspaceIdSchema.parse('44444444-4444-4444-8444-444444444444');
	for (const name of [f.record.id, unknown]) {
		createWorkspace({
			registryRoot: f.registryRoot,
			directory: makeTempRoot('workspace-start-shadow-pairs'),
			name,
			patchesRepository: f.record.patchset.repository,
			forkRepository: f.record.fork.repository,
			owner: { id: 'fixture', session: 'fixture' },
			registration: readTypeManifest('stub', STUB_TYPE_MODULE)
		});
	}
	expect(findWorkspace(readWorkspaceRegistry(f.registryRoot), f.record.id).id).toBe(f.record.id);
	let spawns = 0;
	const runtime = {
		spawn: () => {
			spawns++;
			return { pid: 4_194_305, terminate: () => undefined };
		}
	};
	for (const workspaceId of [f.record.id, unknown])
		expect(upChannel({ ...f.ctx, workspaceId }, channel, runtime)).toMatchObject({ ok: false });
	expect(spawns).toBe(0);
	expect(existsSync(join(f.record.patchset.path, '.codkit/build'))).toBe(false);
});

it('retires a no-child failed reservation and prunes only its empty build directory', () => {
	const f = fixture();
	expect(() =>
		upChannel(f.ctx, channel, {
			afterReservation: () => {
				throw new Error('fixture before spawn');
			}
		})
	).toThrow(/fixture before spawn/);
	expect(readRecordState(f.record.patchset.path, channel.name).state).toBe('absent');
	expect(existsSync(join(f.record.patchset.path, '.codkit/build'))).toBe(false);
	f.finish();
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
});
it('archives a failed no-child generation log while retaining unrelated build data', () => {
	const f = fixture();
	const log = join(f.record.patchset.path, '.codkit/build/transpile.log');
	const human = join(f.record.patchset.path, '.codkit/build/human.txt');
	expect(() =>
		upChannel(f.ctx, channel, {
			spawn: () => {
				writeFileSync(log, 'owned starter failure\n');
				writeFileSync(human, 'preserve unrelated build work');
				throw new Error('fixture start failed');
			}
		})
	).toThrow(/fixture start failed/);
	expect(readRecordState(f.record.patchset.path, channel.name).state).toBe('absent');
	expect(readFileSync(human, 'utf8')).toBe('preserve unrelated build work');
	expect(f.finish).toThrow(/uncommitted or untracked/);
	unlinkSync(human);
	f.finish();
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
});
it('preserves the actual spawned PID if failure termination throws', () => {
	const f = fixture();
	expect(() =>
		upChannel(f.ctx, channel, {
			spawn: () => ({
				pid: 4_194_305,
				terminate: () => {
					throw new Error('fixture teardown failed');
				}
			}),
			beforeFinalize: () => {
				throw new Error('fixture finalization failed');
			}
		})
	).toThrow(/could not be stopped/);
	expect(readRecordState(f.record.patchset.path, channel.name)).toMatchObject({
		state: 'valid',
		record: { pid: 4_194_305, workspaceId: f.record.id }
	});
	expect(f.finish).toThrow(/unresolved build daemon/);
});
it('retires a proven dead POSIX generation with no log and removes its empty runtime directory', async () => {
	const f = fixture();
	upChannel(f.ctx, channel, { spawn: () => ({ pid: 4_194_305, terminate: () => undefined }) });
	const stopped = await downChannel(f.record.patchset.path, channel.name, {
		platform: 'linux',
		expectedWorkspaceId: f.record.id,
		workspaceRegistryRoot: f.registryRoot,
		expectedTreeId: f.ctx.treeId,
		expectedTreePath: f.record.fork.path
	});
	expect(stopped.action).toBe('not-running');
	expect(existsSync(join(f.record.patchset.path, '.codkit/build'))).toBe(false);
	f.finish();
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
});
