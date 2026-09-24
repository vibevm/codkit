// e2e: `codkit load` in a fork tree whose checkout writes CRLF (PROP-008
// ##WORKTREE-DELTA-BYTES, PROP-002 ##GIT-ENV-EOL), through the real launcher.
//
// The Linux package of a product is built from the working copy of its fork
// tree, so the templates it is built from must carry the patch set's LF even
// where the tree was written by a checkout that converted them. The next load
// puts the bytes back, says which files it restored, and lists them in --json.

import { afterAll, describe, expect, it } from 'vitest';
import type { Envelope } from '../support/cliFixture.ts';
import { LINUX_INPUTS, convertLikeAnOldCheckout, makeEolFixture } from '../support/eolFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

describe('codkit load and the bytes of the Linux package inputs', () => {
	it('gives the templates their LF back, and names them in its own line and in --json', () => {
		const fixture = makeEolFixture('eol-cli');
		expect(fixture.cli(['load']).status).toBe(0);
		convertLikeAnOldCheckout(fixture, LINUX_INPUTS);

		const run = fixture.cli(['--json', 'load']);
		const envelope = JSON.parse(run.stdout) as Envelope;

		expect(run.status).toBe(0);
		expect(envelope.data['status']).toBe('up-to-date');
		expect(envelope.data['restoredBytes']).toEqual([...LINUX_INPUTS]);
		expect(
			envelope.messages.some((message) => message.text === `restored the bytes of 3 file(s) the delta writes: ${LINUX_INPUTS.join(', ')}`)
		).toBe(true);
		for (const path of LINUX_INPUTS) {
			expect(fixture.treeBytes(path).equals(fixture.resourceBytes(path)), path).toBe(true);
		}
		// A load with nothing to restore says nothing about it.
		const quiet = JSON.parse(fixture.cli(['--json', 'load']).stdout) as Envelope;
		expect(quiet.data['restoredBytes']).toBeUndefined();
	}, 120_000);
});
