/** @scope spec://codkit/modules/codkit/PROP-007#root */
// `build down` and the absent daemon record (R10B): a channel with no record at
// all is simply not running - not a party to a conflict - while the LOCKED
// refusal stays reserved for a record that exists and either changed under the
// locked operation or could not be retired. The two states were collapsed into
// one refusal when the expected-generation argument of `removeRecord` became
// mandatory, which turned every `down` over a never-started channel (and every
// stabilization teardown after the CI compile sweep) into a red stop.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downChannel } from '../../src/lib/buildWrap.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

type Row = { channel: string; action?: string; pid?: number };

function rows(envelope: { data: Record<string, unknown> }): Row[] {
	return (envelope.data as unknown as { channels: Row[] }).channels;
}

const CHANNELS = ['transpile', 'typecheck', 'extensions', 'copilot'];
const TREE_ID = 'absent-record-test-tree';
const TREE_PATH = '/absent-record/recorded/tree';
const DEAD_PID = 424_242;

/** A schema-valid record of this tree whose daemon is provably gone. */
function deadRecord(nonce: string): Buffer {
	return Buffer.from(
		`${JSON.stringify(
			{
				codkitBuildDaemon: 1,
				channel: 'transpile',
				script: 'watch-client-transpile',
				pid: DEAD_PID,
				cmdline: 'watch-client-transpile',
				startedAt: '2026-09-01T00:00:00.000Z',
				treeId: TREE_ID,
				treePath: TREE_PATH,
				nonce
			},
			null,
			2
		)}\n`
	);
}

describe('codkit build down: absent record is a no-op, changed record is a conflict', () => {
	let fixture: CliFixture;
	let recordPath: string;

	beforeAll(() => {
		fixture = makeCliFixture('down-absent-record');
		recordPath = fixture.patchesPath('.codkit/build/transpile.json');
	});

	afterAll(() => {
		cleanupTempRoots();
	});

	it('reports not-running with exit 0 for every channel that has no record, and retires nothing', () => {
		const { run, envelope } = fixture.json(['build', 'down', '--channel', 'all']);

		expect(run.status).toBe(0);
		expect(rows(envelope).map((row) => [row.channel, row.action, row.pid])).toEqual(CHANNELS.map((channel) => [channel, 'not-running', 0]));
		// Nothing was created either: a no-op that left files behind would be a
		// different operation from the one the ruling describes.
		for (const channel of CHANNELS) {
			expect(existsSync(fixture.patchesPath(`.codkit/build/${channel}.json`))).toBe(false);
		}
	});

	it('refuses when a dead record changes under the locked operation, preserving the new generation', async () => {
		mkdirSync(dirname(recordPath), { recursive: true });
		writeFileSync(recordPath, deadRecord('11111111-1111-4111-8111-111111111111'));

		await expect(
			downChannel(fixture.patchesDir, 'transpile', {
				expectedTreeId: TREE_ID,
				expectedTreePath: TREE_PATH,
				afterRecordRead: () => writeFileSync(recordPath, deadRecord('22222222-2222-4222-8222-222222222222'))
			})
		).rejects.toMatchObject({ code: 'LOCKED' });

		// The replacement generation survives: the refusal refused the unverified
		// removal, it did not delete the evidence.
		expect(readFileSync(recordPath)).toEqual(deadRecord('22222222-2222-4222-8222-222222222222'));
	});

	it('still retires a dead record that did not change, reporting the recorded pid', async () => {
		mkdirSync(dirname(recordPath), { recursive: true });
		writeFileSync(recordPath, deadRecord('33333333-3333-4333-8333-333333333333'));
		const result = await downChannel(fixture.patchesDir, 'transpile', {
			expectedTreeId: TREE_ID,
			expectedTreePath: TREE_PATH
		});

		expect(result).toEqual({ channel: 'transpile', action: 'not-running', pid: DEAD_PID });
		expect(existsSync(recordPath)).toBe(false);
		rmSync(dirname(recordPath), { recursive: true, force: true });
	});
});
