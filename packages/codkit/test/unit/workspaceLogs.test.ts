import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { archiveWorkspaceLog, workspaceLogPaths, workspaceDaemonLogSchema } from '../../src/lib/workspaceLogs.ts';
import { createWorkspace } from '../../src/lib/workspaceCreate.ts';
import { finishWorkspace } from '../../src/lib/workspaceFinish.ts';
import { removeWorkspace } from '../../src/lib/workspaceRemove.ts';
import type { DaemonRecord } from '../../src/lib/buildRuntime.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import { readTypeManifest } from '../../src/types/manifest.ts';
import { projectType, STUB_TYPE_MODULE } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
function fixture() {
	const source = makeSyncFixture('workspace-log-source');
	const registryRoot = makeTempRoot('workspace-log-authority');
	const record = createWorkspace({
		registryRoot,
		directory: makeTempRoot('workspace-log-pairs'),
		name: 'task',
		patchesRepository: source.patchesDir,
		forkRepository: source.treeDir,
		owner: { id: 'fixture', session: 'fixture' },
		registration: readTypeManifest('stub', STUB_TYPE_MODULE)
	});
	const daemon: DaemonRecord = {
		codkitBuildDaemon: 2,
		workspaceId: record.id,
		channel: 'transpile',
		script: 'watch-transpile',
		pid: 4_194_305,
		cmdline: 'watch-transpile',
		startedAt: '2026-10-04T00:00:00.000Z',
		treeId: treeId(record.fork.path),
		treePath: record.fork.path,
		nonce: '11111111-1111-4111-8111-111111111111'
	};
	const path = join(record.patchset.path, '.codkit/build/transpile.log');
	mkdirSync(join(record.patchset.path, '.codkit/build'), { recursive: true });
	writeFileSync(path, 'completed fixture log\n');
	return { record, registryRoot, daemon, path, finish: () => finishWorkspace({ registryRoot, name: 'task', type: projectType }) };
}
it('retains exact log bytes after checkout removal and accepts an unchanged rotated generation', () => {
	const f = fixture();
	archiveWorkspaceLog(f.record.patchset.path, f.daemon, f.registryRoot);
	archiveWorkspaceLog(f.record.patchset.path, f.daemon, f.registryRoot);
	const bytes = readFileSync(f.path);
	writeFileSync(`${f.path}.1`, bytes);
	expect(workspaceLogPaths(f.registryRoot, f.record)).toHaveLength(2);
	const finished = f.finish();
	expect(finished.state).toBe('finished');
	expect(removeWorkspace({ registryRoot: f.registryRoot, name: 'task' }).state).toBe('removed');
	const names = readdirSync(join(f.registryRoot, 'workspace-log-bytes'));
	expect(names).toHaveLength(1);
	expect(readFileSync(join(f.registryRoot, 'workspace-log-bytes', names[0] ?? 'missing'))).toEqual(bytes);
});
it('refuses edited or unowned logs and refuses loss of retained backing bytes', () => {
	const f = fixture();
	archiveWorkspaceLog(f.record.patchset.path, f.daemon, f.registryRoot);
	writeFileSync(f.path, 'new human log edits');
	expect(f.finish).toThrow(/changed or is unowned/);
	writeFileSync(f.path, 'completed fixture log\n');
	writeFileSync(`${f.path}.1`, 'unowned earlier log');
	expect(f.finish).toThrow(/changed or is unowned/);
	writeFileSync(`${f.path}.1`, 'completed fixture log\n');
	const finished = f.finish();
	const blob = readdirSync(join(f.registryRoot, 'workspace-log-bytes'))[0];
	if (blob === undefined) throw new Error('no archive');
	writeFileSync(join(f.registryRoot, 'workspace-log-bytes', blob), 'corrupt archive');
	expect(() => removeWorkspace({ registryRoot: f.registryRoot, name: 'task' })).toThrow(/missing or changed/);
	expect(finished.state).toBe('finished');
});
it('refuses future log receipt versions', () => {
	const f = fixture();
	archiveWorkspaceLog(f.record.patchset.path, f.daemon, f.registryRoot);
	const name = readdirSync(join(f.registryRoot, 'workspace-logs', f.record.id))[0];
	if (name === undefined) throw new Error('no receipt');
	const path = join(f.registryRoot, 'workspace-logs', f.record.id, name);
	const receipt = workspaceDaemonLogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	writeFileSync(path, JSON.stringify({ ...receipt, codkitWorkspaceDaemonLog: 2 }));
	expect(f.finish).toThrow(/invalid or foreign/);
});
