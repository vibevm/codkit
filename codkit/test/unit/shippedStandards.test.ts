// PROP-013 ##UT-SHIPPED-STANDARDS: the package codkit ships, checked on its
// real bytes.
//
// The synthetic fixture proves the algorithm; this proves the artifact. It is
// the CI of the package repository (PROP-014 ##LIC-CHECK-CALLSITES step 1): if
// anyone edits a licence header, a licence text or a pilot asset, `npm run
// floor` goes red before the package can reach anybody.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLicenseCarriers } from '../../src/lib/licenseCheck.ts';
import { loadLicensePolicy } from '../../src/lib/licensePolicy.ts';
import { UPL_1_0_TEXT, normalizeLicenseText, upl10BodyWithoutPlaceholder } from '../../src/lib/licenseTexts.ts';
import { loadSpdxLicenseIds } from '../../src/lib/spdxIds.ts';
import { STANDARDS_PACKAGE_PARENT, shippedStandardsPackage } from '../../src/lib/standardsPackage.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shipped = shippedStandardsPackage(toolRoot);

/** ##STD-PACKAGE-PILOT-ASSETS: the bytes of the logo and the third-party icon. */
const ASSET_HASHES: ReadonlyMap<string, string> = new Map([
	['assets/codkit.svg', '80e1120ffe4d0748bf9c440a67c48ed31c7d22665e0b062404502e1268545d49'],
	['assets/codkit-mark.svg', 'd2118a56a9ad1d23ec2658b2edb7a759ca6a23aa4ed440253de1b2490eecbd2b'],
	['assets/codkit.png', '8990e15afc5ca5ae353f365be17138c7d7560ac5c08fc3d97d442fdb6878cae4'],
	['assets/codkit-128.png', '668bef6c28ce92342cff922372d5185ff2165b9efb35036f086e6d762fd2fb4d'],
	['assets/third-party/feather/package.svg', 'd6fef5e22b890eb614ebbe336491012f726f34e78ca3a90a436c238d1ac104e0'],
	['LICENSES/MIT.txt', 'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5']
]);

/** ##LIC-NOTICE-BILINGUAL: both references, and the English one governs. */
const ENGLISH_REFERENCE = 'Licensed under the Universal Permissive License v 1.0';
const RUSSIAN_REFERENCE = 'Лицензировано на условиях Universal Permissive License версии 1.0';

function read(relative: string): string {
	return readFileSync(join(shipped.directory, ...relative.split('/')), 'utf8');
}

function sha256(relative: string): string {
	return createHash('sha256')
		.update(readFileSync(join(shipped.directory, ...relative.split('/'))))
		.digest('hex');
}

describe('the shipped standards package', () => {
	it('sits at exactly one version directory whose name is its manifest version', () => {
		const parent = join(toolRoot, ...STANDARDS_PACKAGE_PARENT.split('/'));
		const versions = readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('v'));

		expect(versions).toHaveLength(1);
		expect(versions[0]?.name).toBe(`v${shipped.version}`);
	});

	it('passes the licence check with no problems at all', () => {
		const result = checkLicenseCarriers(shipped.directory, loadLicensePolicy(), loadSpdxLicenseIds());

		expect(result.problems).toEqual([]);
		expect(result.checked).toHaveLength(12);
		expect(result.licences.own).toEqual(['UPL-1.0']);
		expect(result.licences.thirdParty).toEqual(['MIT']);
		expect(result.licences.notices).toBe('THIRD-PARTY-NOTICES.md');
	});

	it('resolves every scanned file by a header or a sidecar, never by an annotation', () => {
		// The mandate is that every file carries its own licence information, so
		// the registry exists for provenance and never as a file's only carrier
		// (##LIC-THIRD-PARTY-REGISTRY).
		const result = checkLicenseCarriers(shipped.directory, loadLicensePolicy(), loadSpdxLicenseIds());

		expect(result.checked.filter((file) => file.carrier === 'annotation')).toEqual([]);
		expect(result.checked.filter((file) => file.carrier === 'sidecar').map((file) => file.path)).toEqual([
			'assets/codkit-128.png',
			'assets/codkit.png',
			'assets/third-party/feather/package.svg'
		]);
	});

	it('carries the canonical UPL text and a LICENSE whose body equals it', () => {
		expect(read('LICENSES/UPL-1.0.txt')).toBe(UPL_1_0_TEXT);

		const lines = read('LICENSE').split('\n');
		const blank = lines.indexOf('');
		expect(blank).toBeGreaterThanOrEqual(2);
		expect(normalizeLicenseText(lines.slice(blank + 1).join('\n'))).toBe(normalizeLicenseText(upl10BodyWithoutPlaceholder()));
	});

	it('states the licence in both languages in LICENSE and in every own carrier', () => {
		const license = read('LICENSE');
		expect(license).toContain(ENGLISH_REFERENCE);
		expect(license).toContain(RUSSIAN_REFERENCE);

		const result = checkLicenseCarriers(shipped.directory, loadLicensePolicy(), loadSpdxLicenseIds());
		for (const file of result.checked.filter((entry) => entry.kind === 'own')) {
			const carrier = file.carrier === 'sidecar' ? read(`${file.path}.license`) : read(file.path);
			expect(carrier, file.path).toContain(ENGLISH_REFERENCE);
			expect(carrier, file.path).toContain(RUSSIAN_REFERENCE);
		}
	});

	it('carries the pilot assets byte for byte', () => {
		for (const [relative, digest] of ASSET_HASHES) {
			expect(sha256(relative), relative).toBe(digest);
		}
	});

	it('is reproduced byte for byte by the script that drew it', () => {
		// ##DECISION-STD-PILOT-ASSETS: the logo is committed bytes and the script
		// is how it is redrawn. If the two ever part, the committed asset stops
		// being explainable - so the run is the proof, not the comment.
		const probe = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
		if (probe.status !== 0) {
			console.warn('shippedStandards: logo reproduction SKIPPED - python3 with Pillow is not available');
			expect(probe.status).not.toBe(0);
			return;
		}
		const out = mkdtempSync(join(tmpdir(), 'ck-logo-'));
		try {
			const run = spawnSync('python3', ['tools/make-logo.py', out], { encoding: 'utf8' });
			expect(run.status, run.stderr).toBe(0);
			for (const relative of ['assets/codkit.svg', 'assets/codkit-mark.svg', 'assets/codkit.png', 'assets/codkit-128.png']) {
				const name = relative.slice('assets/'.length);
				expect(
					createHash('sha256')
						.update(readFileSync(join(out, name)))
						.digest('hex'),
					relative
				).toBe(sha256(relative));
			}
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	});

	it('names no product', () => {
		// The tool repository carries no downstream product name anywhere
		// (PROP-003 ##CURRENT-TREE-ZERO-RETIRED-NAME). The needles are written as
		// concatenations so that this test does not itself put one in the tree.
		const forbidden = ['v' + 'code', 'V' + 'Code'];
		const walk = (directory: string, prefix: string): readonly string[] =>
			readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
				const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
				return entry.isDirectory() ? walk(join(directory, entry.name), relative) : [relative];
			});

		for (const relative of walk(shipped.directory, '')) {
			const bytes = readFileSync(join(shipped.directory, ...relative.split('/')));
			const text = bytes.includes(0) ? '' : bytes.toString('utf8');
			for (const needle of forbidden) {
				expect(text.includes(needle), `${relative} names ${needle}`).toBe(false);
			}
		}
	});
});
