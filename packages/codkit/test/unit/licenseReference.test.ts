// PROP-014 ##LIC-REFERENCE-IMPLEMENTATION: the TypeScript check must give the
// same verdict as the Python reference on the same fixtures.
//
// The reference is `tools/license-reference.py` and it is not part of codkit -
// it exists so that "what is red and what is green" has a second, independent
// statement. A disagreement is a defect in one of the two, and this test is
// what finds it.
//
// The comparison is over the SET of (code, path) pairs, not their order: the
// reference walks with `os.walk` (root files before subdirectories) while the
// spec requires lexicographic paths (##LIC-CHECK-ALGORITHM step 2), so the two
// legitimately report the same findings in a different sequence.
//
// Without python3 >= 3.11 (tomllib) the test skips with its reason printed, and
// a skip is never a pass (##LIC-REFERENCE-IMPLEMENTATION).

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLicenseCarriers } from '../../src/lib/licenseCheck.ts';
import { loadLicensePolicy } from '../../src/lib/licensePolicy.ts';
import { loadSpdxLicenseIds } from '../../src/lib/spdxIds.ts';
import { FIXTURE_SPEC_PATH, FIXTURE_THIRD_PARTY_PATH, makeLicensePackage } from '../fixtures/makeLicensePackage.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const REFERENCE = 'tools/license-reference.py';
const POLICY_FILE = 'packages/codkit/config/license-policy.json';
const SPDX_FILE = 'packages/codkit/config/spdx-license-ids.json';

/** The interpreter, or null with the reason the comparison cannot run. */
function python(): { readonly command: string } | { readonly reason: string } {
	const probe = spawnSync('python3', ['-c', 'import sys, tomllib; print(sys.version_info[:2])'], { encoding: 'utf8' });
	if (probe.status !== 0) {
		return { reason: `python3 with tomllib (>= 3.11) is not available: ${(probe.stderr || probe.error?.message) ?? 'not found'}` };
	}
	return { command: 'python3' };
}

const interpreter = python();
const available = 'command' in interpreter;

/** The (code, path) pairs the reference reports for a package directory. */
function referenceFindings(dir: string): readonly string[] {
	if (!('command' in interpreter)) return [];
	const run = spawnSync(interpreter.command, [REFERENCE, dir, POLICY_FILE, SPDX_FILE], { encoding: 'utf8' });
	return [...(run.stdout ?? '').matchAll(/^error CK-E-([A-Z-]+): ([^:]+):/gmu)].map((match) => `${match[1]} ${match[2]}`).sort();
}

/** The same pairs from the TypeScript implementation. */
function typescriptFindings(dir: string): readonly string[] {
	const result = checkLicenseCarriers(dir, loadLicensePolicy(), loadSpdxLicenseIds());
	return result.problems.map((problem) => `${problem.code} ${problem.file}`).sort();
}

function edit(root: string, relative: string, change: (text: string) => string): void {
	const path = join(root, ...relative.split('/'));
	writeFileSync(path, change(readFileSync(path, 'utf8')), 'utf8');
}

/** The fixture mutations of FEAT-002 ##S29, one defect each. */
const CASES: readonly (readonly [string, ((root: string) => void) | null])[] = [
	['clean package', null],
	['a spec without a header', (root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace(/<!--[\s\S]*?-->\n/u, ''))],
	[
		'a header below line 20',
		(root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('<!--', `<!-- x -->\n${'filler line\n'.repeat(20)}<!--`))
	],
	[
		'a GPL identifier on an own file',
		(root) =>
			edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('SPDX-License-Identifier: UPL-1.0', 'SPDX-License-Identifier: GPL-3.0-only'))
	],
	[
		'UPL without its version',
		(root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('SPDX-License-Identifier: UPL-1.0', 'SPDX-License-Identifier: UPL'))
	],
	['a raster without its sidecar', (root) => rmSync(join(root, 'assets', 'codkit.png.license'))],
	['a JSON file without a sidecar', (root) => writeFileSync(join(root, 'data.json'), '{"a":1}\n', 'utf8')],
	['a holder typo', (root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('Oleg Chirukhin', 'Oleg Chiruhin'))],
	[
		'an orphan sidecar',
		(root) =>
			writeFileSync(join(root, 'ghost.txt.license'), 'Copyright (c) 2026 Oleg Chirukhin\nSPDX-License-Identifier: UPL-1.0\n', 'utf8')
	],
	['LICENSE with a changed word', (root) => edit(root, 'LICENSE', (text) => text.replace('without restriction', 'with restriction'))],
	['a manifest licence of MIT', (root) => edit(root, 'vibe.toml', (text) => text.replace('license = "UPL-1.0"', 'license = "MIT"'))],
	['a licence text nobody uses', (root) => writeFileSync(join(root, 'LICENSES', 'BSD-2-Clause.txt'), 'text\n', 'utf8')],
	['a symlink inside', (root) => symlinkSync('README.md', join(root, 'link.md'))],
	[
		'an own copyright without a year',
		(root) => edit(root, FIXTURE_SPEC_PATH, (text) => text.replace('Copyright (c) 2026 Oleg Chirukhin', 'Copyright (c) Oleg Chirukhin'))
	],
	['a third-party file without an annotation', (root) => edit(root, 'REUSE.toml', (text) => text.split('[[annotations]]')[0] ?? '')],
	[
		'a third-party licence outside the allowlist',
		(root) => {
			edit(root, 'REUSE.toml', (text) => text.replace('"MIT"', '"GPL-3.0-only"'));
			edit(root, `${FIXTURE_THIRD_PARTY_PATH}.license`, (text) => text.replace('MIT', 'GPL-3.0-only'));
		}
	],
	[
		'a carrier and an annotation that disagree',
		(root) =>
			edit(root, `${FIXTURE_THIRD_PARTY_PATH}.license`, (text) =>
				text.replace('SPDX-License-Identifier: MIT', 'SPDX-License-Identifier: ISC')
			)
	],
	['stale notices', (root) => edit(root, 'THIRD-PARTY-NOTICES.md', (text) => text.replace('v4.29.1', 'v4.29.0'))],
	['a missing MIT text', (root) => rmSync(join(root, 'LICENSES', 'MIT.txt'))],
	['a table row below the SPDX line', (root) => edit(root, 'README.md', (text) => `${text}\n| Path | Copyright | License |\n`)],
	// Edition 3 (FEAT-002 ##S52): annotation carriers, nested registries, own annotations.
	[
		'(t) an image carried by an own annotation alone',
		(root) => {
			writeFileSync(join(root, 'assets', 'x.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
			edit(root, 'REUSE.toml', (text) => text + ownAnnotation('assets/x.png'));
		}
	],
	[
		'(u) a source file under an annotation still needs a header',
		(root) => {
			mkdirSync(join(root, 'src'), { recursive: true });
			writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
			edit(root, 'REUSE.toml', (text) => text + ownAnnotation('src/**'));
		}
	],
	[
		'(v) a nested registry covers its directory',
		(root) => {
			mkdirSync(join(root, 'sub'), { recursive: true });
			writeFileSync(join(root, 'sub', 'data.csv'), 'a,b\n1,2\n', 'utf8');
			writeFileSync(join(root, 'sub', 'REUSE.toml'), `version = 1\n${ownAnnotation('data.csv')}`, 'utf8');
		}
	],
	[
		'(w) the deepest registry wins',
		(root) => {
			mkdirSync(join(root, 'sub'), { recursive: true });
			writeFileSync(join(root, 'sub', 'data.csv'), 'a,b\n', 'utf8');
			edit(root, 'REUSE.toml', (text) => text + wrongLicenceAnnotation('sub/**'));
			writeFileSync(join(root, 'sub', 'REUSE.toml'), `version = 1\n${ownAnnotation('data.csv')}`, 'utf8');
		}
	],
	[
		'(x) an own annotation naming a foreign holder',
		(root) => {
			writeFileSync(join(root, 'assets', 'x.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
			edit(root, 'REUSE.toml', (text) => text + foreignOwnShapedAnnotation('assets/x.png'));
		}
	]
];

function ownAnnotation(path: string): string {
	return `\n[[annotations]]\npath = "${path}"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2026 Oleg Chirukhin"\nSPDX-License-Identifier = "UPL-1.0"\n`;
}

function wrongLicenceAnnotation(path: string): string {
	return `\n[[annotations]]\npath = "${path}"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2026 Oleg Chirukhin"\nSPDX-License-Identifier = "MIT"\n`;
}

function foreignOwnShapedAnnotation(path: string): string {
	return `\n[[annotations]]\npath = "${path}"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2020 Somebody Else"\nSPDX-License-Identifier = "MIT"\n`;
}

describe.skipIf(!available)('the TypeScript check agrees with the Python reference', () => {
	if (!available && 'reason' in interpreter) {
		// Vitest prints the suite as skipped; the reason has to be visible, or a
		// green run would silently mean "not compared".
		console.warn(`licenseReference: SKIPPED - ${interpreter.reason}`);
	}

	let compared = 0;

	for (const [label, mutate] of CASES) {
		it(`agrees on ${label}`, () => {
			const source = makeLicensePackage(makeTempRoot('lic-ref-src'), { thirdParty: true });
			const root = makeTempRoot('lic-ref');
			cpSync(source, root, { recursive: true });
			mutate?.(root);

			expect(typescriptFindings(root)).toEqual(referenceFindings(root));
			compared += 1;
		});
	}

	it('compared every fixture, and a skip is never a pass', () => {
		expect(available).toBe(true);
		expect(compared).toBe(CASES.length);
	});
});
