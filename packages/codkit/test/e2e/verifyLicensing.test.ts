// e2e: the licensing findings of codkit verify (PROP-019 ##VERIFY-LICENSING,
// FEAT-002 S94).
//
// The real CLI on the fixture triple, with the trusted store in a temporary home
// handed to the run through its environment. The untouched patch set declares
// the profile and carries neither carriers nor surfaces, so it is red with the
// two finding kinds about the product; a machine without the store is red with
// exactly the profile finding, and a copy of the store inside the patch set does
// not change that verdict (##ORGANIZATION-POLICY-TRUST); a patch set without a
// declaration verifies as it always did.
// Once `license annotate --own` has written the carriers, the carrier findings
// are gone and the surfaces remain (the closing clause of S93).
// Once `gen licensing` has written the surfaces, `verify` is clean; a new edition of
// the text is one surface finding until `--update` (the closing clause of S92).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { FIXTURE_LICENSE_TEXT, installLicensingProfile, storeText } from '../support/licensingFixture.ts';
import type { LicensingFixture } from '../support/licensingFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

type VerifyData = {
	findings: { code: string; file: string | null; message: string; hint: string }[];
	counts: Record<string, number>;
};

/** The keys of `counts` are the bare codes; the findings carry the public `CK-E-` form. */
const LICENSING_CODES = ['LICENSE-HEADER', 'LICENSE-PROFILE', 'LICENSE-SURFACE'];

/** A later edition of the fixture licence: the same text with one more paragraph, so the canonical text changes. */
const SECOND_EDITION = `${FIXTURE_LICENSE_TEXT.trimEnd()}\n\nEdition 2 of the fixture licence: one paragraph more.\n`;

let fixture: CliFixture;
let lic: LicensingFixture;

beforeAll(() => {
	fixture = makeCliFixture('verify-licensing');
	lic = installLicensingProfile('verify-licensing', fixture.patchesDir);
});

afterAll(cleanupTempRoots);

function verify(env: Readonly<Record<string, string>>): { status: number; data: VerifyData; codes: string[] } {
	const outcome = fixture.json(['verify'], env);
	const data = outcome.envelope.data as unknown as VerifyData;
	return { status: outcome.run.status, data, codes: data.findings.map((item) => item.code) };
}

function licensingCounts(data: VerifyData): Record<string, number> {
	return Object.fromEntries(Object.entries(data.counts).filter(([code]) => LICENSING_CODES.includes(code)));
}

describe('codkit verify with a licensing declaration', () => {
	it('reports the carriers and the surfaces the patch set does not carry', () => {
		const outcome = verify(lic.env);

		expect(outcome.status).toBe(1);
		expect(Object.keys(licensingCounts(outcome.data)).sort()).toEqual(['LICENSE-HEADER', 'LICENSE-SURFACE']);
		expect(outcome.codes).toContain('CK-E-LICENSE-HEADER');
		expect(outcome.codes).toContain('CK-E-LICENSE-SURFACE');
		expect(outcome.codes).not.toContain('CK-E-LICENSE-PROFILE');
		expect(outcome.data.findings.find((item) => item.code === 'CK-E-LICENSE-HEADER')?.file).toBe('delta/own/hello.ts');
		expect(outcome.data.findings.find((item) => item.code === 'CK-E-LICENSE-SURFACE')?.message).toContain('manifest.json:licenseName');
	});

	it('S93: after license annotate --own the carriers are no longer a finding', () => {
		const annotated = fixture.json(['license', 'annotate', '--own'], lic.env);
		expect(annotated.run.status).toBe(0);

		const outcome = verify(lic.env);

		expect(outcome.codes).not.toContain('CK-E-LICENSE-HEADER');
		expect(Object.keys(licensingCounts(outcome.data))).toEqual(['LICENSE-SURFACE']);
	});

	it('S92: after gen licensing no surface is a finding; a new edition of the text is one finding until --update', () => {
		const written = fixture.json(['gen', 'licensing', '--owner', 'product'], lic.env);
		expect(written.run.status).toBe(0);

		const clean = verify(lic.env);
		expect(licensingCounts(clean.data)).toEqual({});
		expect(clean.data.findings.map((item) => `${item.code} ${item.file ?? ''}: ${item.message}`)).toEqual([]);
		expect(clean.status).toBe(0);

		// The store now carries a later edition: the add-file patch of the licence
		// file no longer carries the canonical text, and nothing else has moved.
		lic.setLicenseText(SECOND_EDITION);
		const stale = verify(lic.env);
		expect(licensingCounts(stale.data)).toEqual({ 'LICENSE-SURFACE': 1 });
		expect(stale.data.findings.find((item) => item.code === 'CK-E-LICENSE-SURFACE')?.message).toContain('canonical text');

		const updated = fixture.json(['gen', 'licensing', '--owner', 'product', '--update'], lic.env);
		expect(updated.run.status).toBe(0);
		expect(licensingCounts(verify(lic.env).data)).toEqual({});
	});

	it('S94: reports exactly one profile finding on a machine without the store', () => {
		lic.removeStore();

		const outcome = verify(lic.env);

		expect(outcome.status).toBe(1);
		expect(licensingCounts(outcome.data)).toEqual({ 'LICENSE-PROFILE': 1 });
		const profile = outcome.data.findings.filter((item) => item.code === 'CK-E-LICENSE-PROFILE');
		expect(profile).toHaveLength(1);
		expect(profile[0]?.file).toBe('codkit.licensing.json');
		expect(profile[0]?.hint).toContain('the patch set cannot supply one');
	});

	it('S94: a copy of the store inside the patch set does not change the verdict', () => {
		const shadow = join(fixture.patchesDir, '.codkit');
		mkdirSync(shadow, { recursive: true });
		writeFileSync(join(shadow, 'organization-policies.json'), storeText(), 'utf8');
		try {
			const outcome = verify({ HOME: fixture.patchesDir, USERPROFILE: fixture.patchesDir });

			expect(outcome.status).toBe(1);
			expect(licensingCounts(outcome.data)).toEqual({ 'LICENSE-PROFILE': 1 });
		} finally {
			rmSync(shadow, { recursive: true, force: true });
		}
	});

	it('leaves a patch set without a declaration exactly as before', () => {
		const plain = makeCliFixture('verify-licensing-plain');

		const outcome = plain.json(['verify'], lic.env);

		expect(outcome.run.status).toBe(0);
		const data = outcome.envelope.data as unknown as VerifyData;
		expect(Object.keys(data.counts).some((code) => LICENSING_CODES.includes(code))).toBe(false);
		expect(data.findings).toEqual([]);
	});
});
