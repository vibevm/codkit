// unit: the licensing check of verify (PROP-019 ##VERIFY-LICENSING).
//
// A real fixture triple, because the surfaces read the pin's bytes out of the
// fork tree's git objects, and a trusted store in a temporary home, because the
// profile is the machine's and never the patch set's. The check is called in
// process with the store's root, so each case breaks exactly one thing and reads
// exactly the finding it should produce. The untouched fixture declares the
// profile and carries nothing that answers it, which makes the first full run
// the map of every finding kind.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFilePatchText } from '../../src/lib/addFilePatch.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { productHeader } from '../../src/lib/genTemplates.ts';
import { ownLayerPaths } from '../../src/lib/licensingProfile.ts';
import { addFileArtifactOf } from '../../src/lib/licensingSurfaces.ts';
import type { Finding } from '../../src/lib/verifyEngine.ts';
import { checkLicensing } from '../../src/lib/verifyLicensing.ts';
import { LICENCE_GUARD_PATH, projectType } from '../fixtures/stubType.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import {
	FIXTURE_HOLDER,
	FIXTURE_LICENSE_ID,
	FIXTURE_LICENSE_TEXT,
	FIXTURE_LICENSE_TITLE,
	FIXTURE_YEAR,
	installLicensingProfile
} from '../support/licensingFixture.ts';
import type { LicensingFixture } from '../support/licensingFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DECLARATION = 'codkit.licensing.json';
const MANIFEST_OVERLAY = 'delta/overlays/manifest.json.overlay.json';
const PACKAGE_OVERLAY = 'delta/overlays/package.json.overlay.json';
const LICENCE_FILE_ARTIFACT = addFileArtifactOf('LICENSE.md');
const HELLO = 'delta/own/hello.ts';
const OWN_TEST = 'delta/own/test/fixture.test.ts';

let fixture: CliFixture;
let lic: LicensingFixture;
let config: CodkitConfig;

beforeAll(() => {
	fixture = makeCliFixture('verify-licensing-unit');
	lic = installLicensingProfile('verify-licensing-unit', fixture.patchesDir);
	const loaded = loadConfig(fixture.patchesDir);
	if (loaded === null) {
		throw new Error('the fixture patch set carries codkit.json');
	}
	config = loaded;
});

afterAll(cleanupTempRoots);

function check(): readonly Finding[] {
	const findings: Finding[] = [];
	checkLicensing({
		patchesDir: fixture.patchesDir,
		type: projectType,
		config,
		treeDir: fixture.treeDir,
		toolRoot,
		findings,
		trustedRoot: join(lic.home, '.codkit')
	});
	return findings;
}

function ofCode(findings: readonly Finding[], code: string): readonly Finding[] {
	return findings.filter((item) => item.code === code);
}

/** Add a patch-set file, run the body, and remove the file again. */
function withFile<T>(relative: string, content: string, body: () => T): T {
	const path = fixture.patchesPath(relative);
	mkdirSync(dirname(path), { recursive: true });
	try {
		writeFileSync(path, content, 'utf8');
		return body();
	} finally {
		rmSync(path, { force: true });
	}
}

/** Edit a patch-set file, run the body, and put the file back whatever happens. */
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

/** Remove a patch-set file, run the body, and restore it. */
function withoutFile<T>(relative: string, body: () => T): T {
	const path = fixture.patchesPath(relative);
	const saved = readFileSync(path);
	try {
		rmSync(path);
		return body();
	} finally {
		writeFileSync(path, saved);
	}
}

/** The header the engine lays out from the fixture profile, in the stub's block style (##HEADER-FROM-PROFILE). */
function conformingHeader(): string {
	return productHeader({
		form: 'fields',
		holder: FIXTURE_HOLDER,
		license: FIXTURE_LICENSE_ID,
		year: FIXTURE_YEAR,
		style: 'block',
		title: FIXTURE_LICENSE_TITLE,
		file: 'LICENSE.md'
	});
}

/** An add-file patch of the fixture's shape for a file of the licensing subsystem. */
function addFilePatch(treePath: string, content: string): string {
	const header = [
		'# codkit-patch: 2',
		'# id: CK-product-903',
		'# type: extend',
		'# category: follow',
		'# owner: product',
		'# reason: fixture licence file, written by hand for the check',
		'# link: none',
		'# cause: none',
		`# pin: ${config.pin.tag}@${config.pin.sha}`,
		'# contract-tests: none',
		''
	].join('\n');
	return addFilePatchText(header, treePath, content);
}

describe('checkLicensing', () => {
	it('says nothing for a patch set without a declaration', () => {
		expect(withoutFile(DECLARATION, check)).toEqual([]);
	});

	it('reports the profile this machine does not carry, and nothing else', () => {
		lic.removeStore();
		try {
			const findings = check();
			expect(findings.map((item) => item.code)).toEqual(['LICENSE-PROFILE']);
			expect(findings[0]?.file).toBe(DECLARATION);
			expect(findings[0]?.message).toContain('selects the profile "fixture", which this machine does not carry: ');
			expect(findings[0]?.hint).toContain('the CI machine included; the patch set cannot supply one');
		} finally {
			lic.setLicenseText(FIXTURE_LICENSE_TEXT);
		}
	});

	it('names every own file without a carrier, once', () => {
		const own = ownLayerPaths(fixture.patchesDir, projectType);
		expect(own).toEqual([HELLO, OWN_TEST]);

		const headers = ofCode(check(), 'LICENSE-HEADER');

		expect(headers.map((item) => item.file)).toEqual([...own]);
		expect(headers.every((item) => item.message.startsWith('no licence carrier'))).toBe(true);
		expect(headers.every((item) => item.hint.includes('codkit license annotate --own'))).toBe(true);
	});

	it('names every surface the patch set does not carry, in surface order', () => {
		const surfaces = ofCode(check(), 'LICENSE-SURFACE');

		expect(surfaces.map((item) => [item.message, item.file])).toEqual([
			[`the licence field manifest.json:licenseName is not set to "${FIXTURE_LICENSE_ID}" by an overlay of the target`, MANIFEST_OVERLAY],
			['the licence field manifest.json:licenseFileName is not set to "LICENSE.md" by an overlay of the target', MANIFEST_OVERLAY],
			[`the licence field package.json:license is not set to "${FIXTURE_LICENSE_ID}" by an overlay of the target`, PACKAGE_OVERLAY],
			['the licence file LICENSE.md has no add-file patch', LICENCE_FILE_ARTIFACT],
			[
				'the component licence licenses/LICENSE-upstream.txt of upstream has no add-file patch',
				addFileArtifactOf('licenses/LICENSE-upstream.txt')
			],
			['the rendering LICENSE.rtf has no add-file patch', addFileArtifactOf('LICENSE.rtf')],
			[`the licence guard ${LICENCE_GUARD_PATH} is not written`, LICENCE_GUARD_PATH]
		]);
		expect(surfaces[0]?.hint).toBe('run codkit gen licensing (or --update) to write the surfaces from the profile');
		expect(surfaces[3]?.hint).toBe('run codkit gen licensing --update');
		expect(surfaces[6]?.hint).toBe('run codkit gen licensing');
	});

	it('is satisfied by an overlay operation with the same op, path and value, and by nothing less', () => {
		const findings = withEdit(
			MANIFEST_OVERLAY,
			(text) => {
				const overlay = JSON.parse(text) as { operations: unknown[] };
				overlay.operations.push(
					{ op: 'set', path: ['licenseName'], value: FIXTURE_LICENSE_ID, expectUpstream: { $absent: true } },
					{ op: 'set', path: ['licenseFileName'], value: 'LICENCE.txt', expectUpstream: { $absent: true } }
				);
				return `${JSON.stringify(overlay, null, 2)}\n`;
			},
			check
		);

		const fields = ofCode(findings, 'LICENSE-SURFACE').filter((item) => item.message.includes(' manifest.json:'));
		expect(fields.map((item) => item.message)).toEqual([
			'the licence field manifest.json:licenseFileName is not set to "LICENSE.md" by an overlay of the target'
		]);
	});

	it('drops the carrier finding of a file that gained a conforming header', () => {
		const findings = withEdit(HELLO, (text) => `${conformingHeader()}${text}`, check);

		const files = ofCode(findings, 'LICENSE-HEADER').map((item) => item.file);
		expect(files).toEqual([OWN_TEST]);
	});

	it('reports a licence file patch that carries another text', () => {
		const findings = withFile(LICENCE_FILE_ARTIFACT, addFilePatch('LICENSE.md', 'Another text, not the canonical one.\n'), check);

		const about = ofCode(findings, 'LICENSE-SURFACE').filter((item) => item.file === LICENCE_FILE_ARTIFACT);
		expect(about.map((item) => item.message)).toEqual([
			`the add-file patch of LICENSE.md does not carry the canonical text of ${FIXTURE_LICENSE_ID}`
		]);
		expect(about[0]?.hint).toBe('run codkit gen licensing --update');
	});

	it('accepts a licence file patch that carries the canonical text', () => {
		const findings = withFile(LICENCE_FILE_ARTIFACT, addFilePatch('LICENSE.md', FIXTURE_LICENSE_TEXT), check);

		expect(ofCode(findings, 'LICENSE-SURFACE').some((item) => item.file === LICENCE_FILE_ARTIFACT)).toBe(false);
	});
});
