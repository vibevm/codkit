// PROP-014 ##LIC-THIRD-PARTY-REGISTRY: reading REUSE.toml, and the third-party
// half of the classification it feeds (FEAT-002 ##S29 cases n-r).

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLicenseCarriers } from '../../src/lib/licenseCheck.ts';
import type { LicensePolicy } from '../../src/lib/licensePolicy.ts';
import {
	REUSE_REGISTRY_NAME,
	emptyRegistryText,
	readReuseRegistry,
	renderAnnotation,
	thirdPartyAnnotations
} from '../../src/lib/reuseRegistry.ts';
import { loadSpdxLicenseIds } from '../../src/lib/spdxIds.ts';
import { FIXTURE_THIRD_PARTY_PATH, makeLicensePackage } from '../fixtures/makeLicensePackage.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const POLICY: LicensePolicy = {
	holders: ['Oleg Chirukhin'],
	ownLicense: 'UPL-1.0',
	allowedThirdParty: ['UPL-1.0', 'MIT', 'ISC'],
	allowedExceptions: []
};

const spdx = loadSpdxLicenseIds();

function pkg(label: string): string {
	return makeLicensePackage(makeTempRoot(`reg-${label}`), { thirdParty: true });
}

function edit(root: string, relative: string, change: (text: string) => string): void {
	const path = join(root, ...relative.split('/'));
	writeFileSync(path, change(readFileSync(path, 'utf8')), 'utf8');
}

function codesFor(root: string, file: string): readonly string[] {
	return checkLicenseCarriers(root, POLICY, spdx)
		.problems.filter((problem) => problem.file === file)
		.map((problem) => problem.code);
}

describe('readReuseRegistry', () => {
	it('reads the annotations of a well-formed registry', () => {
		const root = pkg('read');
		const registry = readReuseRegistry(root, true);

		expect(registry.problems).toEqual([]);
		expect(registry.annotations).toHaveLength(1);
		expect(registry.annotations[0]?.paths).toEqual(['assets/third-party/feather/**']);
		expect(registry.annotations[0]?.precedence).toBe('closest');
		expect(registry.annotations[0]?.license).toBe('MIT');
		expect(registry.annotations[0]?.comment).toContain('third-party;');
	});

	it('is empty and silent when the package has no registry', () => {
		expect(readReuseRegistry(makeTempRoot('reg-none'), false)).toEqual({ annotations: [], problems: [] });
	});

	it('reports a version other than 1 and an unknown key as package problems', () => {
		const version = pkg('version');
		edit(version, REUSE_REGISTRY_NAME, (text) => text.replace('version = 1', 'version = 2'));
		expect(readReuseRegistry(version, true).problems[0]?.code).toBe('LICENSE-PACKAGE');

		const unknown = pkg('unknown');
		edit(unknown, REUSE_REGISTRY_NAME, (text) => `${text}\nSPDX-Nonsense = "x"\n`);
		expect(readReuseRegistry(unknown, true).problems[0]?.message).toContain('Unrecognized key');
	});

	it('reports a file that does not parse instead of throwing', () => {
		const root = pkg('broken');
		writeFileSync(join(root, REUSE_REGISTRY_NAME), 'version = = 1\n', 'utf8');
		const registry = readReuseRegistry(root, true);

		expect(registry.annotations).toEqual([]);
		expect(registry.problems[0]?.message).toContain('cannot parse');
	});

	it('separates our own annotations from third-party ones', () => {
		const registry = readReuseRegistry(pkg('rows'), true);

		expect(thirdPartyAnnotations(registry, POLICY.holders)).toHaveLength(1);
		expect(thirdPartyAnnotations(registry, ['Cole Bemis'])).toHaveLength(0);
	});

	it('renders an annotation as a table element appended at the end', () => {
		const rendered = renderAnnotation({ path: 'a/b.svg', copyright: '2013 Someone', license: 'MIT', source: 'https://example.test v1' });

		expect(rendered).toContain('[[annotations]]');
		expect(rendered).toContain('path = "a/b.svg"');
		expect(rendered).toContain('SPDX-FileComment = "third-party; https://example.test v1"');
		expect(emptyRegistryText('p', 'Oleg Chirukhin')).toContain('version = 1');
	});
});

describe('third-party classification (S29 n-r)', () => {
	it('(n) an undeclared third-party file', () => {
		const root = pkg('n');
		edit(root, REUSE_REGISTRY_NAME, (text) => text.split('[[annotations]]')[0] ?? '');
		expect(codesFor(root, FIXTURE_THIRD_PARTY_PATH)).toEqual(['LICENSE-THIRD-PARTY']);
	});

	it('(o) a third-party licence outside the allowlist', () => {
		const root = pkg('o');
		edit(root, REUSE_REGISTRY_NAME, (text) => text.replace('"MIT"', '"GPL-3.0-only"'));
		edit(root, `${FIXTURE_THIRD_PARTY_PATH}.license`, (text) => text.replace('MIT', 'GPL-3.0-only'));
		const problems = checkLicenseCarriers(root, POLICY, spdx).problems;

		expect(codesFor(root, FIXTURE_THIRD_PARTY_PATH)).toEqual(['LICENSE-THIRD-PARTY']);
		expect(problems.find((problem) => problem.file === FIXTURE_THIRD_PARTY_PATH)?.message).toContain('outside the allowlist');
	});

	it('(p) a carrier and an annotation that disagree', () => {
		const root = pkg('p');
		edit(root, `${FIXTURE_THIRD_PARTY_PATH}.license`, (text) =>
			text.replace('SPDX-License-Identifier: MIT', 'SPDX-License-Identifier: ISC')
		);
		const problems = checkLicenseCarriers(root, POLICY, spdx).problems;

		expect(problems.find((problem) => problem.file === FIXTURE_THIRD_PARTY_PATH)?.message).toContain('the REUSE.toml annotation says');
	});

	it('(q) notices that no longer match the registry', () => {
		const root = pkg('q');
		edit(root, 'THIRD-PARTY-NOTICES.md', (text) => text.replace('v4.29.1', 'v4.29.0'));
		expect(codesFor(root, 'THIRD-PARTY-NOTICES.md')).toEqual(['LICENSE-THIRD-PARTY']);
	});

	it('(r) a licence in use with no text under LICENSES/', () => {
		const root = pkg('r');
		rmSync(join(root, 'LICENSES', 'MIT.txt'));
		expect(codesFor(root, 'LICENSES/MIT.txt')).toEqual(['LICENSE-PACKAGE']);
	});

	it('a clean package with a third-party file passes and names its licence', () => {
		const result = checkLicenseCarriers(pkg('clean'), POLICY, spdx);

		expect(result.problems).toEqual([]);
		expect(result.licences.thirdParty).toEqual(['MIT']);
		expect(result.checked.find((file) => file.path === FIXTURE_THIRD_PARTY_PATH)?.kind).toBe('third-party');
	});

	it('refuses LicenseRef and NOASSERTION even with a matching annotation', () => {
		for (const identifier of ['LicenseRef-Private', 'NOASSERTION']) {
			const root = pkg(`ref-${identifier}`);
			edit(root, REUSE_REGISTRY_NAME, (text) => text.replace('"MIT"', `"${identifier}"`));
			edit(root, `${FIXTURE_THIRD_PARTY_PATH}.license`, (text) =>
				text.replace('SPDX-License-Identifier: MIT', `SPDX-License-Identifier: ${identifier}`)
			);
			const problems = checkLicenseCarriers(root, POLICY, spdx).problems;
			const message = problems.find((problem) => problem.file === FIXTURE_THIRD_PARTY_PATH)?.message ?? '';

			expect(message.length, identifier).toBeGreaterThan(0);
		}
	});
});
