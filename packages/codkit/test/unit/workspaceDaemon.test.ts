import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createReservation, daemonRecordBytes, finalizeReservation, readRecordState, recordPath } from '../../src/lib/buildRuntime.ts';
import type { DaemonRecord } from '../../src/lib/buildRuntime.ts';
import { downChannel, readFinishedPass, statusOf, upChannel } from '../../src/lib/buildWrap.ts';
import { acquireDaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';
import { workspaceIdSchema, workspaceRecordSchema, workspaceTaskBranch, updateWorkspaceRegistry } from '../../src/lib/workspaceRegistry.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
const owner = workspaceIdSchema.parse('11111111-1111-4111-8111-111111111111');
const foreign = workspaceIdSchema.parse('22222222-2222-4222-8222-222222222222');
const channel = {
	name: 'transpile',
	script: 'watch-transpile',
	passStart: [/start/],
	passEnd: [/done/],
	errorLine: [/error/],
	errorCountLine: [],
	falseEndGuards: []
};
function record(): DaemonRecord {
	return {
		codkitBuildDaemon: 2,
		workspaceId: owner,
		channel: 'transpile',
		script: 'watch-transpile',
		pid: 0,
		cmdline: 'watch-transpile',
		startedAt: '2026-10-04T00:00:00.000Z',
		treeId: 'fixture-tree',
		treePath: '/fixture/tree',
		nonce: '33333333-3333-4333-8333-333333333333'
	};
}
it('publishes and finalizes a workspace generation without changing the ordinary v1 wire', () => {
	const root = makeTempRoot('workspace-daemon-reservation');
	const next = record();
	const lock = acquireDaemonChannelLock(root, next.channel, 'fixture');
	try {
		expect(createReservation(root, next, lock)).toBe(true);
		expect(finalizeReservation(root, next, 4242, lock)).toBe(true);
	} finally {
		lock.release();
	}
	expect(readRecordState(root, next.channel)).toMatchObject({
		state: 'valid',
		record: { codkitBuildDaemon: 2, workspaceId: owner, pid: 4242 }
	});
	const { workspaceId: _, ...legacy } = next;
	const old = { ...legacy, codkitBuildDaemon: 1 };
	expect(Buffer.from(daemonRecordBytes(old)).toString('utf8')).toBe(`${JSON.stringify(old, null, 2)}\n`);
	expect(() => daemonRecordBytes({ ...next, codkitBuildDaemon: 1 })).toThrow();
});
it('refuses missing/future/foreign-format identity without upgrading persisted records', () => {
	const root = makeTempRoot('workspace-daemon-schema');
	const path = recordPath(root, 'transpile');
	mkdirSync(dirname(path), { recursive: true });
	const { workspaceId: _, ...missing } = record();
	for (const value of [missing, { ...record(), codkitBuildDaemon: 1 }, { ...record(), codkitBuildDaemon: 3 }]) {
		const bytes = `${JSON.stringify(value)}\n`;
		writeFileSync(path, bytes);
		expect(readRecordState(root, 'transpile').state).toBe('invalid');
		expect(readFileSync(path, 'utf8')).toBe(bytes);
	}
});

it('starts a v2 reservation for an explicit workspace and refuses duplicate start under another identity', () => {
	const patchesDir = makeTempRoot('workspace-daemon-start');
	const treeDir = makeTempRoot('workspace-daemon-tree');
	const registryRoot = makeTempRoot('workspace-daemon-control');
	const registered = (id: typeof owner, name: string, patches: string, tree: string) =>
		workspaceRecordSchema.parse({
			id,
			name,
			state: 'active',
			patchset: {
				repository: patches,
				commonDirectory: join(patches, '.git'),
				path: patches,
				branch: workspaceTaskBranch(id),
				baseCommit: 'a'.repeat(40)
			},
			fork: { repository: tree, commonDirectory: join(tree, '.git'), path: tree, branch: null, baseCommit: 'a'.repeat(40) },
			pin: { tag: 'v1', sha: 'a'.repeat(40), date: '2026-10-04' },
			type: { id: 'stub', contractVersion: 1, manifestSha256: '0'.repeat(64) },
			owner: { id: 'fixture', session: 'fixture' },
			createdAt: '2026-10-04T00:00:00.000Z',
			updatedAt: '2026-10-04T00:00:00.000Z'
		});
	updateWorkspaceRegistry(registryRoot, (_, save) =>
		save([
			registered(owner, 'Owner', patchesDir, treeDir),
			registered(foreign, 'Other', makeTempRoot('daemon-other-patches'), makeTempRoot('daemon-other-tree'))
		])
	);
	writeFileSync(join(treeDir, 'package.json'), JSON.stringify({ scripts: { 'watch-transpile': 'fixture' } }));
	let spawns = 0;
	const runtime = {
		spawn: () => {
			spawns++;
			return { pid: 4_194_305, terminate: () => undefined };
		}
	};
	expect(
		upChannel({ patchesDir, treeDir, treeId: 'fixture-tree', workspaceId: owner, workspaceRegistryRoot: registryRoot }, channel, runtime)
	).toMatchObject({
		ok: true,
		action: 'started'
	});
	expect(readRecordState(patchesDir, channel.name)).toMatchObject({ state: 'valid', record: { codkitBuildDaemon: 2, workspaceId: owner } });
	const before = readFileSync(recordPath(patchesDir, channel.name));
	expect(
		upChannel({ patchesDir, treeDir, treeId: 'fixture-tree', workspaceId: foreign, workspaceRegistryRoot: registryRoot }, channel, runtime)
	).toMatchObject({ ok: false });
	expect(spawns).toBe(1);
	expect(readFileSync(recordPath(patchesDir, channel.name))).toEqual(before);
});
it('refuses foreign or unbound workspace teardown before probing or signalling a process', async () => {
	const root = makeTempRoot('workspace-daemon-foreign');
	const next = record();
	const path = recordPath(root, next.channel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, daemonRecordBytes(next));
	const bytes = readFileSync(path);
	const tree = { expectedTreeId: next.treeId, expectedTreePath: next.treePath };
	expect(statusOf(root, next.channel, { ...tree, expectedWorkspaceId: owner }).state).toBe('starting');
	for (const probe of [tree, { ...tree, expectedWorkspaceId: foreign }]) {
		expect(statusOf(root, next.channel, probe)).toMatchObject({ state: 'unknown', treeMatches: false });
		let signals = 0;
		await expect(
			downChannel(root, next.channel, {
				...probe,
				signal: () => {
					signals++;
				}
			})
		).rejects.toThrow(/workspace/);
		expect(signals).toBe(0);
		expect(readFileSync(path)).toEqual(bytes);
	}
	expect(() =>
		readFinishedPass(
			root,
			{
				name: 'transpile',
				script: next.script,
				passStart: [/start/],
				passEnd: [/done/],
				errorLine: [/error/],
				errorCountLine: [],
				falseEndGuards: []
			},
			{ probe: { ...tree, expectedWorkspaceId: foreign } }
		)
	).toThrow(/workspace/);
});
