// e2e: codkit verify (PROP-007 sec. 11).
//
// The real CLI on the fixture triple: green on a healthy delta, red with a
// coded line per violation on a damaged one, and green again on a dirty tree -
// everything it compares against comes out of git objects, so an unfinished
// edit in the working files changes nothing about the verdict.

import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATCH_FILE_NAME, PATCH_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

let fixture: CliFixture;

const PATCH_ARTIFACT = `delta/patches/${PATCH_FILE_NAME}`;

type VerifyData = {
	findings: { code: string; file: string | null; line: number | null; message: string; hint: string }[];
	counts: Record<string, number>;
	checked: number;
	warnings: string[];
};

beforeAll(() => {
	fixture = makeCliFixture('verify');
	expect(fixture.run(['load']).status).toBe(0);
});

afterAll(cleanupTempRoots);

/** Break one delta file, run verify, and put the file back whatever happens. */
function withEdit<T>(relative: string, edit: (text: string) => string, body: () => T): T {
	const path = fixture.patchesPath(relative);
	const saved = readFileSync(path, 'utf8');
	try {
		writeFileSync(path, edit(saved), 'utf8');
		return body();
	} finally {
		writeFileSync(path, saved, 'utf8');
	}
}

describe('codkit verify', () => {
	it('passes on a healthy delta and says what it checked', () => {
		const outcome = fixture.run(['verify']);

		expect(outcome.status).toBe(0);
		expect(outcome.stdout).toContain('5 intervention(s) checked, no violations');
		expect(outcome.stderr).not.toContain('warning');
	});

	it('reports an empty finding list in the envelope', () => {
		const outcome = fixture.json(['verify']);
		const data = outcome.envelope.data as unknown as VerifyData;

		expect(outcome.run.status).toBe(0);
		expect(data.findings).toEqual([]);
		expect(data.counts).toEqual({});
		expect(data.checked).toBe(5);
		expect(outcome.envelope.errors).toEqual([]);
	});

	it('gives the same verdict on a dirty tree', () => {
		const path = fixture.treePath('src/vs/workbench/browser/parts/example/examplePart.ts');
		const saved = readFileSync(path, 'utf8');
		try {
			writeFileSync(path, `${saved}\n// an unfinished edit nobody extracted yet\n`, 'utf8');
			expect(fixture.run(['verify']).status).toBe(0);
		} finally {
			writeFileSync(path, saved, 'utf8');
		}
	});

	it('prints one coded line with a hint per violation, and exits 1', () => {
		const outcome = withEdit(
			PATCH_ARTIFACT,
			(text) => text.replace('# owner: workbench-core', '# owner: nobody'),
			() => fixture.run(['verify'])
		);

		expect(outcome.status).toBe(1);
		expect(outcome.stderr).toContain(`error CK-E-OWNER-UNKNOWN: ${PATCH_ARTIFACT}: ${PATCH_ID}: owner "nobody"`);
		expect(outcome.stderr).toContain('hint: use one of:');
	});

	it('carries the findings and their counts in the envelope', () => {
		const outcome = withEdit(
			'delta/rules/example.ckrule.json',
			(text) => text.replace('"expectedMatches": 1', '"expectedMatches": 7'),
			() => fixture.json(['verify'])
		);
		const data = outcome.envelope.data as unknown as VerifyData;

		expect(outcome.run.status).toBe(1);
		expect(data.counts).toEqual({ 'RULE-DRIFT': 1 });
		expect(data.findings[0]?.code).toBe('CK-E-RULE-DRIFT');
		expect(outcome.envelope.errors[0]?.code).toBe(data.findings[0]?.code);
		expect(data.findings[0]?.file).toBe('delta/rules/example.ckrule.json');
		expect(data.findings[0]?.hint).toContain('expectedMatches');
	});

	it('reports several violations in one run', () => {
		const outcome = withEdit(
			PATCH_ARTIFACT,
			(text) => text.replace('# category: follow', '# category: hide'),
			() =>
				withEdit(
					'delta/overlays/product.json.overlay.json',
					(text) => text.replace('"Fixture - OSS"', '"Moved"'),
					() => fixture.json(['verify'])
				)
		);
		const data = outcome.envelope.data as unknown as VerifyData;

		expect(outcome.run.status).toBe(1);
		expect(Object.keys(data.counts).sort()).toEqual(['GUARD-MISSING', 'OVERLAY-DRIFT']);
	});

	it('warns instead of failing when the tree was never synced', () => {
		const other = makeCliFixture('verify-unsynced');
		const outcome = other.run(['verify']);

		expect(outcome.status).toBe(0);
		expect(outcome.stderr).toContain('run codkit load first');
	});

	it('refuses to run without a fork tree it can use', () => {
		const outcome = fixture.json(['--fork-dir', makeTempRoot('verify-not-a-tree'), 'verify']);

		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-NOT-A-REPO');
	});
});
