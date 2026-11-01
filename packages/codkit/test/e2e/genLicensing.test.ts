// PROP-013 ##E2E-GEN-SURFACE: `codkit gen licensing` and the profile-derived
// header of `codkit gen feature` through the real launcher. FEAT-002 ##S91,
// ##S92 (the generator's half: the refusal and the rewrite under `--update`;
// the findings of `verify` are proved in its own suite), ##S95.
//
// The fixture is the full triple: the surfaces take the pin's bytes from the
// fork tree, and the trusted store lives in a temporary home directory that
// every run is pointed at (PROP-019 ##ORGANIZATION-POLICY-TRUST).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { addFileBodyOf } from '../../src/lib/addFilePatch.ts';
import { loadConventions } from '../../src/lib/conventionsFile.ts';
import { unitReminder } from '../../src/lib/genFeature.ts';
import { parseCkpatch } from '../../src/lib/patchFormat.ts';
import type { ParsedPatch } from '../../src/lib/patchFormat.ts';
import { OVERLAY_ID } from '../fixtures/makePatchSet.ts';
import { LICENCE_GUARD_PATH, projectType } from '../fixtures/stubType.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import {
	FIXTURE_LICENSE_ID,
	FIXTURE_LICENSE_TEXT,
	FOREIGN_HOLDER,
	fixtureBlockHeaderLines,
	installLicensingProfile
} from '../support/licensingFixture.ts';
import type { LicensingFixture } from '../support/licensingFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const MANIFEST_OVERLAY = 'delta/overlays/manifest.json.overlay.json';
const PACKAGE_OVERLAY = 'delta/overlays/package.json.overlay.json';
const LICENCE_PATCH = 'delta/patches/LICENSE.md.ckpatch';
const COMPONENT_PATCH = 'delta/patches/licenses__LICENSE-upstream.txt.ckpatch';
const RENDERING_PATCH = 'delta/patches/LICENSE.rtf.ckpatch';
const SECOND_EDITION = '# Fixture Private Licence\n\nFixture private terms, second edition, not a commercial legal approval.\n';

type FileAction = { path: string; action: string };
type OverlaySummary = { artifact: string; target: string; operations: number };
type LicensingData = { files: FileAction[]; overlays: OverlaySummary[]; reminders: string[]; owner: string };
type Operation = { op: string; path: string[]; value?: unknown; expectUpstream?: unknown };
type OverlayDocument = { id: string; contractTests: string[]; operations: Operation[] };

function walk(root: string, prefix = ''): readonly string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		return entry.isDirectory() ? walk(join(root, entry.name), relative) : [relative];
	});
}

function digestOf(root: string, relative: string): string {
	return createHash('sha256')
		.update(readFileSync(join(root, ...relative.split('/'))))
		.digest('hex');
}

/** Every file under `root` with its digest, so that a run can be shown to have moved nothing, or only what it names. */
function digests(root: string): ReadonlyMap<string, string> {
	return new Map([...walk(root)].sort().map((relative) => [relative, digestOf(root, relative)]));
}

function snapshot(root: string): string {
	return [...digests(root)].map(([relative, digest]) => `${relative} ${digest}`).join('\n');
}

function readOverlay(fixture: CliFixture, relative: string): OverlayDocument {
	return JSON.parse(readFileSync(fixture.patchesPath(relative), 'utf8')) as OverlayDocument;
}

function readPatch(fixture: CliFixture, relative: string): ParsedPatch {
	return parseCkpatch(readFileSync(fixture.patchesPath(relative)), loadConventions(projectType, fixture.patchesDir), relative);
}

describe('S91/S92 - gen licensing writes the surfaces of the profile, refuses a second run and rewrites under --update', () => {
	let fixture: CliFixture;
	let lic: LicensingFixture;

	beforeAll(() => {
		fixture = makeCliFixture('gen-licensing');
		lic = installLicensingProfile('gen-licensing', fixture.patchesDir);
	});

	it('prints the plan and writes nothing under --dry-run', () => {
		const before = snapshot(fixture.patchesPath('delta'));
		const outcome = fixture.json(['gen', 'licensing', '--owner', 'product', '--dry-run'], lic.env);

		expect(outcome.run.status).toBe(0);
		const data = outcome.envelope.data as unknown as LicensingData;
		expect(data.files.map((file) => file.action)).toEqual(['planned', 'planned', 'planned', 'planned', 'planned', 'planned']);
		expect(data.files.map((file) => file.path)).toEqual([
			MANIFEST_OVERLAY,
			PACKAGE_OVERLAY,
			LICENCE_PATCH,
			COMPONENT_PATCH,
			RENDERING_PATCH,
			LICENCE_GUARD_PATH
		]);
		expect(snapshot(fixture.patchesPath('delta'))).toBe(before);
	});

	it('S91: writes the overlays, the patches and the guard from the profile and ends with the three reminders', () => {
		const outcome = fixture.json(['gen', 'licensing', '--owner', 'product'], lic.env);

		expect(outcome.run.status).toBe(0);
		const data = outcome.envelope.data as unknown as LicensingData;
		expect(data.owner).toBe('product');
		expect(data.files).toEqual([
			{ path: MANIFEST_OVERLAY, action: 'updated' },
			{ path: PACKAGE_OVERLAY, action: 'created' },
			{ path: LICENCE_PATCH, action: 'created' },
			{ path: COMPONENT_PATCH, action: 'created' },
			{ path: RENDERING_PATCH, action: 'created' },
			{ path: LICENCE_GUARD_PATH, action: 'created' }
		]);
		expect(data.overlays).toEqual([
			{ artifact: MANIFEST_OVERLAY, target: 'manifest.json', operations: 2 },
			{ artifact: PACKAGE_OVERLAY, target: 'package.json', operations: 1 }
		]);
		expect(data.reminders).toEqual([
			unitReminder('delta/own/test'),
			'run codkit license annotate --own to give the own files their carriers',
			'run codkit verify'
		]);
		expect(outcome.envelope.messages.some((message) => message.text === `merged ${MANIFEST_OVERLAY} (2 operation(s))`)).toBe(true);

		// The manifest overlay: one operation per field, expectUpstream from the pin
		// - which carries none of the keys - and the fixture's own operations kept.
		const manifest = readOverlay(fixture, MANIFEST_OVERLAY);
		expect(manifest.id).toBe(OVERLAY_ID);
		expect(manifest.contractTests).toContain('licence-leftovers');
		expect(manifest.operations.map((operation) => operation.path)).toEqual([
			['displayName'],
			['patchsetUpstreamPin'],
			['licenseName'],
			['licenseFileName']
		]);
		expect(manifest.operations[2]).toEqual({
			op: 'set',
			path: ['licenseName'],
			value: FIXTURE_LICENSE_ID,
			expectUpstream: { $absent: true }
		});
		expect(manifest.operations[3]).toEqual({
			op: 'set',
			path: ['licenseFileName'],
			value: 'LICENSE.md',
			expectUpstream: { $absent: true }
		});
		const manifestPackage = readOverlay(fixture, PACKAGE_OVERLAY);
		expect(manifestPackage.id).toBe('CK-product-001');
		expect(manifestPackage.operations).toEqual([
			{ op: 'set', path: ['license'], value: FIXTURE_LICENSE_ID, expectUpstream: { $absent: true } }
		]);

		// The licence file: an add-file patch whose body is the canonical text.
		const licence = readPatch(fixture, LICENCE_PATCH);
		expect(licence.isAddFile).toBe(true);
		expect(licence.targetPath).toBe('LICENSE.md');
		expect(licence.header.id).toBe('CK-product-002');
		expect(licence.header.contractTests).toEqual(['licence-leftovers']);
		expect(addFileBodyOf(licence)).toBe(FIXTURE_LICENSE_TEXT);
		expect(readPatch(fixture, COMPONENT_PATCH).targetPath).toBe('licenses/LICENSE-upstream.txt');
		expect(readPatch(fixture, RENDERING_PATCH).targetPath).toBe('LICENSE.rtf');

		// The guard: at the type's path, headed from the profile, under its suite id.
		const guard = readFileSync(fixture.patchesPath(LICENCE_GUARD_PATH), 'utf8');
		expect(guard.split('\n').slice(0, 5)).toEqual(fixtureBlockHeaderLines());
		expect(guard).toContain("describe('licence-leftovers', () => {");
	});

	it('S92: refuses the second run with CK-E-GEN-EXISTS and changes nothing', () => {
		const before = snapshot(fixture.patchesPath('delta'));
		const again = fixture.json(['gen', 'licensing', '--owner', 'product'], lic.env);

		expect(again.run.status).toBe(1);
		expect(again.envelope.errors[0]?.code).toBe('CK-E-GEN-EXISTS');
		expect(again.envelope.errors[0]?.message).toContain(LICENCE_PATCH);
		expect(again.envelope.errors[0]?.message).not.toContain(MANIFEST_OVERLAY);
		expect(snapshot(fixture.patchesPath('delta'))).toBe(before);
	});

	it('S92: rewrites exactly its own artifacts under --update after a new edition of the text, keeping their ids', () => {
		lic.setLicenseText(SECOND_EDITION);
		const before = digests(fixture.patchesPath('delta'));
		const update = fixture.json(['gen', 'licensing', '--owner', 'product', '--update'], lic.env);

		expect(update.run.status).toBe(0);
		const data = update.envelope.data as unknown as LicensingData;
		expect(data.files.map((file) => file.action)).toEqual(['updated', 'updated', 'updated', 'updated', 'updated', 'updated']);
		const licence = readPatch(fixture, LICENCE_PATCH);
		expect(addFileBodyOf(licence)).toBe(SECOND_EDITION);
		expect(licence.header.id).toBe('CK-product-002');
		expect(readPatch(fixture, COMPONENT_PATCH).header.id).toBe('CK-product-003');
		expect(readPatch(fixture, RENDERING_PATCH).header.id).toBe('CK-product-004');
		expect(readOverlay(fixture, PACKAGE_OVERLAY).id).toBe('CK-product-001');
		// The rendering follows the text, the guard bakes the new digest; nothing
		// outside the artifacts of the command moved.
		expect(addFileBodyOf(readPatch(fixture, RENDERING_PATCH))).toContain('second edition');
		expect(readFileSync(fixture.patchesPath(LICENCE_GUARD_PATH), 'utf8')).toContain(
			createHash('sha256').update(SECOND_EDITION).digest('hex')
		);
		const touched = data.files.map((file) => file.path);
		const after = digests(fixture.patchesPath('delta'));
		expect([...after.keys()]).toEqual([...before.keys()]);
		for (const [relative, digest] of before) {
			if (!touched.includes(`delta/${relative}`)) expect(after.get(relative)).toBe(digest);
		}
		expect(after.get('patches/LICENSE.md.ckpatch')).not.toBe(before.get('patches/LICENSE.md.ckpatch'));
	});

	it('S95: gen feature heads every file from the profile in the style of the type', () => {
		const outcome = fixture.json(['gen', 'feature', 'acme.sample', '--title', 'Sample'], lic.env);

		expect(outcome.run.status).toBe(0);
		const data = outcome.envelope.data as { files: string[]; headerWritten: boolean; headerStyle: string };
		expect(data.headerWritten).toBe(true);
		expect(data.headerStyle).toBe('block');
		expect(data.files).toHaveLength(3);
		for (const relative of data.files) {
			expect(readFileSync(fixture.patchesPath(relative), 'utf8').split('\n').slice(0, 5)).toEqual(fixtureBlockHeaderLines());
		}
		expect(outcome.envelope.messages.some((message) => message.text.includes('no header written'))).toBe(false);
	});

	it('S95: a header flag that disagrees with the profile is CK-E-CONFIG with nothing written; one that agrees takes effect', () => {
		const holder = fixture.json(['gen', 'feature', 'acme.other', '--title', 'Other', '--holder', FOREIGN_HOLDER], lic.env);
		expect(holder.run.status).toBe(2);
		expect(holder.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(existsSync(fixture.patchesPath('delta/own/contrib/other'))).toBe(false);

		const licence = fixture.json(['gen', 'feature', 'acme.other', '--title', 'Other', '--license', 'MIT'], lic.env);
		expect(licence.run.status).toBe(2);
		expect(licence.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(existsSync(fixture.patchesPath('delta/own/contrib/other'))).toBe(false);

		const year = fixture.json(['gen', 'feature', 'acme.other', '--title', 'Other', '--year', '2031', '--header-style', 'line'], lic.env);
		expect(year.run.status).toBe(0);
		const lines = readFileSync(fixture.patchesPath('delta/own/contrib/other/common/other.ts'), 'utf8').split('\n');
		expect(lines[0]).toBe('// Copyright (c) 2031 Fixture Org');
		expect(lines[3]).toBe(`// SPDX-License-Identifier: ${FIXTURE_LICENSE_ID}`);
	});
});

describe('gen licensing without a declaration', () => {
	it('is CK-E-CONFIG, exit 2, before anything is written', () => {
		const fixture = makeCliFixture('gen-licensing-bare');
		const outcome = fixture.json(['gen', 'licensing', '--owner', 'product']);

		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(outcome.envelope.errors[0]?.message).toContain('codkit.licensing.json');
		expect(existsSync(fixture.patchesPath(LICENCE_PATCH))).toBe(false);
	});
});
