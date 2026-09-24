// e2e: `codkit overlay check` on a development tree (PROP-007
// ##CMD-OVERLAY-CHECK-TREE).
//
// The reported case: a loaded tree whose manifest is the pin's file, written by
// a Windows checkout of a `text=auto` file - CRLF over the pin's LF blob, which
// git calls unchanged. The check used to take the raw bytes for a
// materialization, compare the pin with the operations and fail with
// CK-E-OVERLAY-DRIFT. It now says the target is not materialized, in its own
// words and its own status, and exits 0; a real edit, a materialization and a
// missing file each keep their own answer.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const TARGET = 'manifest.json';

afterAll(() => {
	cleanupTempRoots();
});

/** The pin's manifest as git on Windows checks it out: `core.eol=crlf` is what `native` means there. */
function checkOutConverted(fixture: CliFixture): void {
	rmSync(fixture.treePath(TARGET), { force: true });
	expect(fixture.git(['-c', 'core.eol=crlf', 'checkout', 'HEAD', '--', TARGET]).status).toBe(0);
}

describe('codkit overlay check on a development tree', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('overlay-check-tree');
		expect(fixture.run(['load']).status).toBe(0);
		// Upstream VS Code declares every file `text=auto`; the tree's own
		// attributes say the same here without touching the pin.
		writeFileSync(fixture.treePath('.git/info/attributes'), '* text=auto\n', 'utf8');
		checkOutConverted(fixture);
	}, 120_000);

	it('says the target is not materialized and passes, over the pin file a checkout converted', () => {
		// The precondition of the report: other bytes than the blob's, no change for git.
		expect(readFileSync(fixture.treePath(TARGET), 'utf8')).toContain('\r\n');
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');

		const { run, envelope } = fixture.json(['overlay', 'check', TARGET]);

		expect(run.status).toBe(0);
		expect(envelope.errors).toEqual([]);
		expect(envelope.data['inTree']).toBe('pin');
		expect(envelope.data['materialized']).toBe(false);
		expect(envelope.data['matchesOperations']).toBeNull();
		expect(
			envelope.messages.some((message) =>
				message.text.includes(`${TARGET}: 1 overlay(s) agree with the pin; the target is not materialized`)
			)
		).toBe(true);
	}, 60_000);

	it('still reports the drift of a hand edit made on top of that file', () => {
		const path = fixture.treePath(TARGET);
		const converted = readFileSync(path, 'utf8');
		writeFileSync(path, converted.replace('"applicationName": "fixture-app"', '"applicationName": "by-hand"'), 'utf8');
		try {
			const { run, envelope } = fixture.json(['overlay', 'check', TARGET]);

			expect(run.status).toBe(1);
			expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-OVERLAY-DRIFT']);
			expect(envelope.errors[0]?.message).toContain('is not the pin plus the operations');
			expect(envelope.data['inTree']).toBe('materialized');
			expect(envelope.data['matchesOperations']).toBe(false);
		} finally {
			checkOutConverted(fixture);
		}
	}, 60_000);

	it('agrees with a materialization, and says it is one', () => {
		expect(fixture.run(['overlay', 'apply', TARGET]).status).toBe(0);
		try {
			const { run, envelope } = fixture.json(['overlay', 'check', TARGET]);

			expect(run.status).toBe(0);
			expect(envelope.data['inTree']).toBe('materialized');
			expect(envelope.data['materialized']).toBe(true);
			expect(envelope.data['matchesOperations']).toBe(true);
			expect(envelope.messages.some((message) => message.text.includes('the target is materialized in the fork tree'))).toBe(true);
		} finally {
			checkOutConverted(fixture);
		}
	}, 60_000);
});

describe('codkit overlay check of a target the tree does not carry', () => {
	// The manifest is a fingerprint of the type, so a tree without it is not a
	// tree of this family at all; a JSON file that is no fingerprint can be gone.
	const LOCK = '.config/generated/build-lock.json';

	it('says the tree has no such file, and passes', () => {
		const fixture = makeCliFixture('overlay-check-absent');
		writeFileSync(fixture.patchesPath('delta/overlays/build-lock.json.overlay.json'), lockOverlay(LOCK), 'utf8');
		rmSync(fixture.treePath(LOCK));

		const { run, envelope } = fixture.json(['overlay', 'check', LOCK]);

		expect(run.status).toBe(0);
		expect(envelope.errors).toEqual([]);
		expect(envelope.data['inTree']).toBe('absent');
		expect(envelope.data['materialized']).toBe(false);
		expect(envelope.data['matchesOperations']).toBeNull();
		expect(envelope.messages.some((message) => message.text.includes(`the target is not materialized: the fork tree has no ${LOCK}`))).toBe(
			true
		);
	}, 120_000);
});

/** An overlay on a JSON file of the pin that is no fingerprint, in the canonical key order. */
function lockOverlay(target: string): string {
	return `${JSON.stringify(
		{
			codkitOverlay: 2,
			id: 'CK-product-906',
			target,
			type: 'extend',
			category: 'own',
			owner: 'product',
			reason: 'fixture: an overlay target the tree may lack',
			link: 'none',
			cause: 'none',
			pin: 't1@0000000000000000000000000000000000000000',
			contractTests: ['fixture.guard.product'],
			operations: [{ op: 'set', path: ['scripts', 'fixture'], value: 'echo fixture' }]
		},
		null,
		2
	)}\n`;
}
