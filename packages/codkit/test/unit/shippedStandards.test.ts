// PROP-013 ##UT-SHIPPED-STANDARDS: the packages codkit ships, checked on their
// real bytes.
//
// The synthetic fixture proves the algorithm; this proves the artifact. It is
// the CI of the package repository (PROP-014 ##LIC-CHECK-CALLSITES step 1): if
// anyone edits a licence header, a licence text or a pilot asset, `npm run
// floor` goes red before the package can reach anybody.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLicenseCarriers } from '../../src/lib/licenseCheck.ts';
import { loadLicensePolicy } from '../../src/lib/licensePolicy.ts';
import { UPL_1_0_TEXT, normalizeLicenseText, upl10BodyWithoutPlaceholder } from '../../src/lib/licenseTexts.ts';
import { loadSpdxLicenseIds } from '../../src/lib/spdxIds.ts';
import { STANDARDS_PACKAGE_PARENT, shippedPackages, shippedStandardsPackage } from '../../src/lib/standardsPackage.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shipped = shippedStandardsPackage(toolRoot);
const skills = shippedPackages(toolRoot, []).find((entry) => entry.name === 'agent-skills');
/** ##STD-PACKAGES-OF-THE-TYPE: the package the `vscode` type names, delivered only to that type. */
const seams = shippedPackages(toolRoot, ['seams-vscode']).find((entry) => entry.name === 'seams-vscode');
/** The same for the second real type: one catalogue per family, and no other. */
const theiaSeams = shippedPackages(toolRoot, ['seams-theia']).find((entry) => entry.name === 'seams-theia');

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

/** ##STD-SKILLS-ROSTER-1-0-0 */
const SKILL_NAMES = ['ck-orient', 'ck-intervene', 'ck-review-intervention', 'ck-resolve'];

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
		expect(result.checked).toHaveLength(11);
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
		expectNoProductName(shipped.directory);
	});
});

/**
 * The tool repository carries no downstream product name anywhere (PROP-003
 * ##CURRENT-TREE-ZERO-RETIRED-NAME). The needles are written as concatenations
 * so that this test does not itself put one in the tree.
 */
function expectNoProductName(directory: string): void {
	const forbidden = ['v' + 'code', 'V' + 'Code'];
	const walk = (from: string, prefix: string): readonly string[] =>
		readdirSync(from, { withFileTypes: true }).flatMap((entry) => {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			return entry.isDirectory() ? walk(join(from, entry.name), relative) : [relative];
		});

	for (const relative of walk(directory, '')) {
		const bytes = readFileSync(join(directory, ...relative.split('/')));
		const text = bytes.includes(0) ? '' : bytes.toString('utf8');
		for (const needle of forbidden) {
			expect(text.includes(needle), `${relative} names ${needle}`).toBe(false);
		}
	}
}

/**
 * ##STD-SKILLS-PACKAGE-IDENTITY and ##STD-SKILLS-ROSTER-1-0-0: the second
 * package codkit ships, on the same terms as the first - every file carries its
 * own licence banner, and the bodies name no product.
 */
describe('the shipped agent-skills package', () => {
	it('is one version directory whose manifest declares the roster', () => {
		expect(skills?.version).toBe('1.0.0');
		expect(skills?.declaresSkills).toBe(true);
		expect(skills?.kind).toBe('agent-skills');

		const manifest = readFileSync(join(skills?.directory ?? '', 'vibe.toml'), 'utf8');
		for (const name of SKILL_NAMES) {
			expect(manifest, name).toContain(`name = "${name}"`);
			// The projection resolves the path against the package root, so it is
			// written out in full rather than through an alias.
			expect(manifest, name).toContain(`path = "vibevm/vibespecs/skills/${name}"`);
		}
	});

	it('passes the licence check with no problems at all', () => {
		const result = checkLicenseCarriers(skills?.directory ?? '', loadLicensePolicy(), loadSpdxLicenseIds());

		expect(result.problems).toEqual([]);
		expect(result.licences.own).toEqual(['UPL-1.0']);
		expect(result.licences.thirdParty).toEqual([]);
		expect(result.checked.filter((file) => file.carrier !== 'header')).toEqual([]);
	});

	it('states the licence in both languages in every carrier, after the frontmatter', () => {
		const result = checkLicenseCarriers(skills?.directory ?? '', loadLicensePolicy(), loadSpdxLicenseIds());
		for (const file of result.checked) {
			const text = readFileSync(join(skills?.directory ?? '', ...file.path.split('/')), 'utf8');
			expect(text, file.path).toContain(ENGLISH_REFERENCE);
			expect(text, file.path).toContain(RUSSIAN_REFERENCE);
		}
		// A harness reads the frontmatter from the first bytes, so the licence
		// comment of a skill body comes after it, never before.
		for (const name of SKILL_NAMES) {
			const body = readFileSync(join(skills?.directory ?? '', 'vibevm', 'vibespecs', 'skills', name, 'SKILL.md'), 'utf8');
			expect(body.startsWith(`---\nname: ${name}\n`), name).toBe(true);
		}
	});

	it('names no product', () => {
		expectNoProductName(skills?.directory ?? '');
	});

	/**
	 * ##STD-SKILLS-ARE-TYPE-NEUTRAL: a skill is delivered to every patch set, so
	 * it states no seam of one family - it routes to the catalogue of the type
	 * the patch set declares.
	 */
	it("routes to the type's seam catalogue and states no seam of its own", () => {
		const bodies = SKILL_NAMES.map((name) => ({
			name,
			text: readFileSync(join(skills?.directory ?? '', 'vibevm', 'vibespecs', 'skills', name, 'SKILL.md'), 'utf8')
		}));
		for (const { name, text } of bodies) {
			for (const needle of ['manifest.json', 'registerService', 'shell', 'addons/', 'nls.ts']) {
				expect(text.includes(needle), `${name} names ${needle}`).toBe(false);
			}
		}
		const intervene = bodies.find((body) => body.name === 'ck-intervene')?.text ?? '';
		expect(intervene).toContain('vibevm/vibepacks/org.vibevm.codkit/seams-<type>/v*');
		expect(intervene).toContain('codkit --json where');
		expect(bodies.find((body) => body.name === 'ck-review-intervention')?.text).toContain(
			'vibevm/vibepacks/org.vibevm.codkit/seams-<type>/v*'
		);
	});
});

/**
 * ##STD-PACKAGES-OF-THE-TYPE: the package of the `vscode` project type, on the
 * same terms as the universal two - one version directory, every file with its
 * own bilingual banner, and no product name anywhere.
 */
/**
 * ##STD-PACKAGES-OF-THE-TYPE: the package of the `theia` project type, on the
 * same terms as every other - one version directory, every file with its own
 * bilingual banner, no product name anywhere, and a catalogue of the seams of
 * its own family only.
 */
describe('the shipped seams-theia package', () => {
	it('is one version directory of a type package, declaring no skills', () => {
		expect(theiaSeams?.version).toBe('1.0.0');
		expect(theiaSeams?.kind).toBe('type');
		expect(theiaSeams?.declaresSkills).toBe(false);

		const manifest = readFileSync(join(theiaSeams?.directory ?? '', 'vibe.toml'), 'utf8');
		expect(manifest).toContain('name = "seams-theia"');
		expect(manifest).toContain('source = "vibevm/vibespecs/boot/77-flow-codkit-seams-theia.xml"');
	});

	it('catalogues the seams of its own family and of no other', () => {
		const catalogue = readFileSync(
			join(theiaSeams?.directory ?? '', 'vibevm', 'vibespecs', 'flows', 'standards', 'seam-catalogue.xml'),
			'utf8'
		);
		expect(catalogue).toContain('SEAM-CATALOGUE-IS-A-MENU-NOT-AN-INSTANCE');
		// The two seams that make this family what it is.
		expect(catalogue).toContain('SEAM-THEIA-EXTENSION');
		expect(catalogue).toContain('SEAM-REBIND');
		// And none of the other family's own vocabulary: a catalogue copied from
		// the neighbouring type would carry these, and this one names them
		// nowhere - the one mention of a manifest that does not exist here is
		// the sentence saying so.
		for (const foreign of ['registerService', 'shell.common.main', 'source/', 'product.overrides']) {
			expect(catalogue, foreign).not.toContain(foreign);
		}
	});

	it('passes the licence check with no problems at all', () => {
		const result = checkLicenseCarriers(theiaSeams?.directory ?? '', loadLicensePolicy(), loadSpdxLicenseIds());

		expect(result.problems).toEqual([]);
		expect(result.licences.own).toEqual(['UPL-1.0']);
		expect(result.licences.thirdParty).toEqual([]);
		expect(result.checked.filter((file) => file.carrier !== 'header')).toEqual([]);
	});

	it('states the licence in both languages in every carrier', () => {
		const result = checkLicenseCarriers(theiaSeams?.directory ?? '', loadLicensePolicy(), loadSpdxLicenseIds());
		for (const file of result.checked) {
			const text = readFileSync(join(theiaSeams?.directory ?? '', ...file.path.split('/')), 'utf8');
			expect(text, file.path).toContain(ENGLISH_REFERENCE);
			expect(text, file.path).toContain(RUSSIAN_REFERENCE);
		}
	});

	it('names no product', () => {
		expectNoProductName(theiaSeams?.directory ?? '');
	});
});

describe('the shipped seams-vscode package', () => {
	it('is one version directory of a type package, declaring no skills', () => {
		expect(seams?.version).toBe('1.0.0');
		expect(seams?.kind).toBe('type');
		expect(seams?.declaresSkills).toBe(false);

		const manifest = readFileSync(join(seams?.directory ?? '', 'vibe.toml'), 'utf8');
		expect(manifest).toContain('name = "seams-vscode"');
		expect(manifest).toContain('source = "vibevm/vibespecs/boot/77-flow-codkit-seams-vscode.xml"');
	});

	it('carries the seam catalogue, and the standards package no longer does', () => {
		const catalogue = join(seams?.directory ?? '', 'vibevm', 'vibespecs', 'flows', 'standards', 'seam-catalogue.xml');
		expect(readFileSync(catalogue, 'utf8')).toContain('SEAM-CATALOGUE-IS-A-MENU-NOT-AN-INSTANCE');
		expect(existsSync(join(shipped.directory, 'vibevm', 'vibespecs', 'flows', 'standards', 'seam-catalogue.xml'))).toBe(false);
	});

	it('passes the licence check with no problems at all', () => {
		const result = checkLicenseCarriers(seams?.directory ?? '', loadLicensePolicy(), loadSpdxLicenseIds());

		expect(result.problems).toEqual([]);
		expect(result.licences.own).toEqual(['UPL-1.0']);
		expect(result.licences.thirdParty).toEqual([]);
		expect(result.checked.filter((file) => file.carrier !== 'header')).toEqual([]);
	});

	it('states the licence in both languages in every carrier', () => {
		const result = checkLicenseCarriers(seams?.directory ?? '', loadLicensePolicy(), loadSpdxLicenseIds());
		for (const file of result.checked) {
			const text = readFileSync(join(seams?.directory ?? '', ...file.path.split('/')), 'utf8');
			expect(text, file.path).toContain(ENGLISH_REFERENCE);
			expect(text, file.path).toContain(RUSSIAN_REFERENCE);
		}
	});

	it('names no product', () => {
		expectNoProductName(seams?.directory ?? '');
	});
});
