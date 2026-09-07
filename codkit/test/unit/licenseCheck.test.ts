// PROP-013 ##UT-LICENSE-CHECK: the licence check over a package built by code.
// Scenario FEAT-002 ##S29, cases (a)-(m) and (s) - the own-file and package
// halves. The third-party cases (n)-(r) need the REUSE.toml registry and live
// with it.

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLicenseCarriers } from '../../src/lib/licenseCheck.ts';
import type { LicenseProblem } from '../../src/lib/licenseCheck.ts';
import type { LicensePolicy } from '../../src/lib/licensePolicy.ts';
import { UPL_1_0_TEXT, normalizeLicenseText, upl10BodyWithoutPlaceholder } from '../../src/lib/licenseTexts.ts';
import { loadSpdxLicenseIds } from '../../src/lib/spdxIds.ts';
import { FIXTURE_SPEC_PATH, makeLicensePackage } from '../fixtures/makeLicensePackage.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const POLICY: LicensePolicy = {
	holders: ['Oleg Chirukhin'],
	ownLicense: 'UPL-1.0',
	allowedThirdParty: ['UPL-1.0', 'MIT', 'ISC'],
	allowedExceptions: []
};

const spdx = loadSpdxLicenseIds();

/** A fresh clean package, then one mutation applied to it. */
function withDefect(label: string, mutate?: (root: string) => void): readonly LicenseProblem[] {
	const root = makeLicensePackage(makeTempRoot(`lic-${label}`));
	mutate?.(root);
	return checkLicenseCarriers(root, POLICY, spdx).problems;
}

function edit(root: string, relative: string, change: (text: string) => string): void {
	const path = join(root, ...relative.split('/'));
	writeFileSync(path, change(readFileSync(path, 'utf8')), 'utf8');
}

function codesFor(problems: readonly LicenseProblem[], file: string): readonly string[] {
	return problems.filter((problem) => problem.file === file).map((problem) => problem.code);
}

describe('licenseCheck on a clean package', () => {
	it('reports no problems and names every carrier', () => {
		const root = makeLicensePackage(makeTempRoot('lic-clean'));
		const result = checkLicenseCarriers(root, POLICY, spdx);

		expect(result.problems).toEqual([]);
		expect(result.checked.map((file) => file.path)).toEqual(['README.md', 'assets/codkit.png', 'vibe.toml', FIXTURE_SPEC_PATH]);
		expect(result.checked.map((file) => file.carrier)).toEqual(['header', 'sidecar', 'header', 'header']);
		expect(result.checked.every((file) => file.kind === 'own')).toBe(true);
		expect(result.licences.own).toEqual(['UPL-1.0']);
		expect(result.licences.thirdParty).toEqual([]);
	});

	it('lists checked files in lexicographic path order', () => {
		const root = makeLicensePackage(makeTempRoot('lic-order'));
		const paths = checkLicenseCarriers(root, POLICY, spdx).checked.map((file) => file.path);

		expect(paths).toEqual([...paths].sort());
	});
});

describe('licenseCheck names one defect at a time (S29)', () => {
	it('(a) a specification without a header', () => {
		const problems = withDefect('a', (root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace(/<!--[\s\S]*?-->\n/u, '')));
		expect(codesFor(problems, FIXTURE_SPEC_PATH)).toEqual(['LICENSE-HEADER']);
		expect(problems[0]?.message).toContain('no licence carrier');
	});

	it('(b) a header below the twentieth non-empty line', () => {
		const filler = `${'filler line\n'.repeat(20)}`;
		const problems = withDefect('b', (root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('<!--', `<!-- x -->\n${filler}<!--`)));
		expect(codesFor(problems, FIXTURE_SPEC_PATH)).toContain('LICENSE-HEADER');
	});

	it('(c) a GPL identifier on an own file', () => {
		const problems = withDefect('c', (root) =>
			edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('SPDX-License-Identifier: UPL-1.0', 'SPDX-License-Identifier: GPL-3.0-only'))
		);
		expect(codesFor(problems, FIXTURE_SPEC_PATH)).toEqual(['LICENSE-HEADER']);
		expect(problems.find((problem) => problem.file === FIXTURE_SPEC_PATH)?.message).toContain('must be exactly UPL-1.0');
	});

	it('(d) UPL without its version, with the hint that names the only valid form', () => {
		const problems = withDefect('d', (root) =>
			edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('SPDX-License-Identifier: UPL-1.0', 'SPDX-License-Identifier: UPL'))
		);
		const message = problems.find((problem) => problem.file === FIXTURE_SPEC_PATH)?.message ?? '';
		expect(message).toContain('not an SPDX identifier: UPL');
		expect(message).toContain('the only valid form is UPL-1.0');
	});

	it('(e) a raster without its sidecar', () => {
		const problems = withDefect('e', (root) => rmSync(join(root, 'assets', 'codkit.png.license')));
		expect(codesFor(problems, 'assets/codkit.png')).toEqual(['LICENSE-HEADER']);
		expect(problems[0]?.message).toContain('binary file without a .license sidecar');
	});

	it('(f) a JSON file without a sidecar', () => {
		const problems = withDefect('f', (root) => writeFileSync(join(root, 'data.json'), '{"a":1}\n', 'utf8'));
		expect(codesFor(problems, 'data.json')).toEqual(['LICENSE-HEADER']);
	});

	it('(g) a holder typo becomes an undeclared third-party file', () => {
		const problems = withDefect('g', (root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('Oleg Chirukhin', 'Oleg Chiruhin')));
		expect(codesFor(problems, FIXTURE_SPEC_PATH)).toEqual(['LICENSE-THIRD-PARTY']);
		expect(problems.find((problem) => problem.file === FIXTURE_SPEC_PATH)?.message).toContain('holder not in policy');
	});

	it('(h) an orphan sidecar', () => {
		const problems = withDefect('h', (root) =>
			writeFileSync(join(root, 'ghost.txt.license'), 'Copyright (c) 2026 Oleg Chirukhin\nSPDX-License-Identifier: UPL-1.0\n', 'utf8')
		);
		expect(codesFor(problems, 'ghost.txt.license')).toEqual(['LICENSE-HEADER']);
		expect(problems[0]?.message).toContain('orphan sidecar');
	});

	it('(i) LICENSE with one word changed', () => {
		const problems = withDefect('i', (root) => edit(root, 'LICENSE', (text) => text.replace('without restriction', 'with restriction')));
		expect(codesFor(problems, 'LICENSE')).toEqual(['LICENSE-PACKAGE']);
	});

	it('(j) a manifest claiming another licence', () => {
		const problems = withDefect('j', (root) => edit(root, 'vibe.toml', (text) => text.replace('license = "UPL-1.0"', 'license = "MIT"')));
		expect(codesFor(problems, 'vibe.toml')).toEqual(['LICENSE-PACKAGE']);
	});

	it('(k) a licence text no file uses', () => {
		const problems = withDefect('k', (root) => writeFileSync(join(root, 'LICENSES', 'BSD-2-Clause.txt'), 'text\n', 'utf8'));
		expect(codesFor(problems, 'LICENSES/BSD-2-Clause.txt')).toEqual(['LICENSE-PACKAGE']);
	});

	it('(l) a symlink inside the package', () => {
		const problems = withDefect('l', (root) => symlinkSync('README.md', join(root, 'link.md')));
		expect(codesFor(problems, 'link.md')).toEqual(['LICENSE-PACKAGE']);
		expect(problems[0]?.message).toBe('symlink inside the package');
	});

	it('(m) an own copyright line without a year', () => {
		const problems = withDefect('m', (root) =>
			edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('Copyright (c) 2026 Oleg Chirukhin', 'Copyright (c) Oleg Chirukhin'))
		);
		expect(codesFor(problems, FIXTURE_SPEC_PATH)).toEqual(['LICENSE-HEADER']);
		expect(problems.find((problem) => problem.file === FIXTURE_SPEC_PATH)?.message).toContain('without a year');
	});

	it('(s) a copyright-looking line below the SPDX line is content', () => {
		const problems = withDefect('s', (root) => edit(root, 'README.md', (text) => `${text}\n| Path | Copyright | License |\n`));
		expect(problems).toEqual([]);
	});
});

describe('licenseCheck carrier rules', () => {
	it('does not scan a file that has a sidecar', () => {
		const root = makeLicensePackage(makeTempRoot('lic-sidecar'));
		// A text file whose own bytes say GPL, with a sidecar that says UPL: the
		// sidecar wins outright (##LIC-CARRIER-SIDECAR).
		writeFileSync(join(root, 'notes.txt'), 'Copyright (c) 2026 Someone Else\nSPDX-License-Identifier: GPL-3.0-only\n', 'utf8');
		writeFileSync(join(root, 'notes.txt.license'), 'Copyright (c) 2026 Oleg Chirukhin\nSPDX-License-Identifier: UPL-1.0\n', 'utf8');
		const result = checkLicenseCarriers(root, POLICY, spdx);

		expect(result.problems).toEqual([]);
		expect(result.checked.find((file) => file.path === 'notes.txt')?.carrier).toBe('sidecar');
	});

	it('refuses two SPDX lines in the window', () => {
		const root = makeLicensePackage(makeTempRoot('lic-two-spdx'));
		edit(root, FIXTURE_SPEC_PATH, (text) =>
			text.replace('SPDX-License-Identifier: UPL-1.0', 'SPDX-License-Identifier: UPL-1.0\nSPDX-License-Identifier: UPL-1.0')
		);
		const problems = checkLicenseCarriers(root, POLICY, spdx).problems;

		expect(codesFor(problems, FIXTURE_SPEC_PATH)).toEqual(['LICENSE-HEADER']);
		expect(problems[0]?.message).toContain('2 SPDX-License-Identifier lines');
	});

	it('ignores a Modifications Copyright line when deciding who owns a file', () => {
		const root = makeLicensePackage(makeTempRoot('lic-modifications'));
		edit(root, FIXTURE_SPEC_PATH, (text) =>
			text.replace('SPDX-License-Identifier: UPL-1.0', 'Modifications Copyright (c) 2026 Someone Else\nSPDX-License-Identifier: UPL-1.0')
		);
		expect(checkLicenseCarriers(root, POLICY, spdx).problems).toEqual([]);
	});
});

describe('licenseTexts', () => {
	it('embeds the canonical SPDX bytes of UPL-1.0', () => {
		// ##LIC-CANONICAL-TEXT-EMBEDDED: this hash is the only oracle for "the
		// licence text was not modified".
		expect(createHash('sha256').update(Buffer.from(UPL_1_0_TEXT, 'utf8')).digest('hex')).toBe(
			'2f81e75033a0c872ab9725b36081e363f0c9e6c45585c35930edb66043fdc576'
		);
		expect(Buffer.byteLength(UPL_1_0_TEXT, 'utf8')).toBe(1837);
	});

	it('drops the placeholder copyright line from the body', () => {
		expect(UPL_1_0_TEXT.split('\n')[0]).toBe('Copyright (c) [year] [copyright holders]');
		expect(upl10BodyWithoutPlaceholder().startsWith('The Universal Permissive License (UPL), Version 1.0')).toBe(true);
	});

	it('normalises typographic quotes and whitespace before comparing', () => {
		expect(normalizeLicenseText('a  “b”\n c')).toBe('a "b" c');
		expect(normalizeLicenseText(' ‘x’ \n\n y ')).toBe("'x' y");
		expect(normalizeLicenseText(UPL_1_0_TEXT)).toBe(normalizeLicenseText(UPL_1_0_TEXT.replace(/\n/gu, ' ')));
	});
});

// PROP-014 edition 3 (FEAT-002 ##S52): ##LIC-CARRIER-ANNOTATION, ##LIC-REGISTRY-NESTED, ##LIC-ANNOTATION-OWN.
describe('licenseCheck edition 3: annotations as carriers, nested registries, own annotations', () => {
	const ownAnnotation = (path: string): string =>
		`\n[[annotations]]\npath = "${path}"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2026 Oleg Chirukhin"\nSPDX-License-Identifier = "UPL-1.0"\n`;
	const registry = (root: string, body: string): void => writeFileSync(join(root, 'REUSE.toml'), `version = 1\n${body}`, 'utf8');

	it('an own annotation carries a file that cannot hold a comment, and the report names the registry', () => {
		const root = makeLicensePackage(makeTempRoot('lic-t'));
		writeFileSync(join(root, 'assets', 'x.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
		writeFileSync(join(root, 'data.csv'), 'a,b\n1,2\n', 'utf8');
		registry(root, ownAnnotation('assets/x.png') + ownAnnotation('data.csv'));

		const result = checkLicenseCarriers(root, POLICY, spdx);
		expect(result.problems).toEqual([]);
		const png = result.checked.find((file) => file.path === 'assets/x.png');
		expect(png).toMatchObject({ carrier: 'annotation', registry: 'REUSE.toml', kind: 'own', license: 'UPL-1.0' });
		expect(result.checked.find((file) => file.path === 'data.csv')?.carrier).toBe('annotation');
	});

	it('a source file under an annotation still needs its header', () => {
		const root = makeLicensePackage(makeTempRoot('lic-u'));
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
		registry(root, ownAnnotation('src/**'));

		const problems = checkLicenseCarriers(root, POLICY, spdx).problems;
		expect(codesFor(problems, 'src/a.ts')).toEqual(['LICENSE-HEADER']);
		expect(problems[0]?.message).toContain('does not replace the header');
	});

	it('a nested registry covers its own directory and the deepest registry wins', () => {
		const root = makeLicensePackage(makeTempRoot('lic-v'));
		mkdirSync(join(root, 'sub'), { recursive: true });
		writeFileSync(join(root, 'sub', 'data.csv'), 'a,b\n', 'utf8');
		registry(root, ownAnnotation('sub/**').replace('UPL-1.0', 'MIT'));
		writeFileSync(join(root, 'sub', 'REUSE.toml'), `version = 1\n${ownAnnotation('data.csv')}`, 'utf8');

		const result = checkLicenseCarriers(root, POLICY, spdx);
		expect(result.problems).toEqual([]);
		expect(result.checked.find((file) => file.path === 'sub/data.csv')).toMatchObject({
			carrier: 'annotation',
			registry: 'sub/REUSE.toml'
		});
	});

	it('an own-shaped annotation naming a foreign holder is an error on every file it covers', () => {
		const root = makeLicensePackage(makeTempRoot('lic-x'));
		writeFileSync(join(root, 'assets', 'x.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
		registry(root, ownAnnotation('assets/x.png').replace('2026 Oleg Chirukhin', '2020 Somebody Else').replace('UPL-1.0', 'MIT'));

		const problems = checkLicenseCarriers(root, POLICY, spdx).problems;
		expect(codesFor(problems, 'assets/x.png')).toEqual(['LICENSE-HEADER']);
		expect(problems.find((problem) => problem.file === 'assets/x.png')?.message).toContain(
			'own annotation names a foreign holder or licence'
		);
	});

	it('a header under an own annotation must agree with it', () => {
		const root = makeLicensePackage(makeTempRoot('lic-agree'));
		registry(root, ownAnnotation('README.md').replace('UPL-1.0', 'MIT'));

		const problems = checkLicenseCarriers(root, POLICY, spdx).problems;
		// MIT is not the own licence, so the annotation itself is the defect, reported once.
		expect(codesFor(problems, 'README.md')).toEqual(['LICENSE-HEADER']);
	});

	it('a registry that does not parse names its own path', () => {
		const root = makeLicensePackage(makeTempRoot('lic-nested-bad'));
		mkdirSync(join(root, 'sub'), { recursive: true });
		writeFileSync(join(root, 'sub', 'REUSE.toml'), 'version = [\n', 'utf8');

		const problems = checkLicenseCarriers(root, POLICY, spdx).problems;
		expect(problems.map((problem) => [problem.code, problem.file])).toEqual([['LICENSE-PACKAGE', 'sub/REUSE.toml']]);
	});
});
