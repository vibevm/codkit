// A synthetic standards package with the layout of the shipped one.
//
// PROP-013 ##UT-LICENSE-CHECK: the licence check is exercised against a package
// built by code, not against committed bytes - one defect is applied to a fresh
// copy per case, which is how the acceptance oracle
// (`tools/license-fixtures.py`) works too. The layout matches the shipped
// package exactly, so the same oracle runs on either.
//
// Nothing here is committed as a binary: the raster stands in as a few bytes
// with a NUL in them, which is all the binary heuristic looks at.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { UPL_1_0_TEXT } from '../../src/lib/licenseTexts.ts';

const HOLDER = 'Oleg Chirukhin';
const YEAR = '2026';

const NOTICE = [
	`Copyright (c) ${YEAR} ${HOLDER}`,
	'Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/',
	'Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/',
	'SPDX-License-Identifier: UPL-1.0'
] as const;

/** The four notice lines wrapped in a comment of the given style. */
function header(style: 'hash' | 'xml'): string {
	if (style === 'hash') return `${NOTICE.map((line) => `# ${line}`).join('\n')}\n`;
	return `<!--\n${NOTICE.join('\n')}\n-->\n`;
}

/** The sidecar body: the same lines with no comment markers. */
function sidecar(): string {
	return `${NOTICE.join('\n')}\n`;
}

/** ##LIC-LICENSE-FILE-SHAPE: notice header, blank line, then the licence body. */
function licenseFile(): string {
	const body = UPL_1_0_TEXT.split('\n').slice(2).join('\n');
	return `${NOTICE.slice(0, 3).join('\n')}\n\n${body}`;
}

const MIT_TEXT = `MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

/** The path of the specification file every case mutates. */
export const FIXTURE_SPEC_PATH = 'vibevm/vibespecs/flows/standards/minimal-intervention.xml';

/** The third-party asset and its sidecar, when the package carries one. */
export const FIXTURE_THIRD_PARTY_PATH = 'assets/third-party/feather/package.svg';

export type LicensePackageOptions = {
	/**
	 * Include the third-party asset, its REUSE.toml annotation, `LICENSES/MIT.txt`
	 * and the generated notices. A package without one is equally valid: the
	 * registry, the notices file and the MIT text all exist only because a
	 * third-party file does (##LIC-NOTICES-FILE).
	 */
	readonly thirdParty?: boolean;
};

/** The body `codkit license notices` generates for the fixture's registry. */
export const FIXTURE_NOTICES = `<!--
${NOTICE.join('\n')}
-->
# Third-party notices

This package includes the following third-party components. Each keeps its
own copyright notice and license; the license texts are in \`LICENSES/\`.

| Path | Copyright | License | Source |
|---|---|---|---|
| \`assets/third-party/feather/**\` | 2013-2023 Cole Bemis | MIT | https://github.com/feathericons/feather tag v4.29.1 |
`;

function write(root: string, relative: string, contents: string | Uint8Array): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

/** Build a package that passes `codkit license check` with no problems. */
export function makeLicensePackage(root: string, options: LicensePackageOptions = {}): string {
	const thirdParty = options.thirdParty ?? false;

	write(root, 'vibe.toml', `${header('hash')}\n[package]\nname = "standards"\nversion = "0.1.0"\nlicense = "UPL-1.0"\nkind = "flow"\n`);
	write(root, 'README.md', `${header('xml')}\n# Standards\n\nA fixture package.\n`);
	write(root, 'LICENSE', licenseFile());
	write(root, 'LICENSES/UPL-1.0.txt', UPL_1_0_TEXT);
	write(
		root,
		FIXTURE_SPEC_PATH,
		`<?xml version="1.0" encoding="UTF-8"?>\n${header('xml')}<spec xmlns="https://vibevm.org/spec/1">\n  <title id="root">Minimal intervention</title>\n</spec>\n`
	);

	// A raster is binary by the only test that matters here - a NUL byte in the
	// first 8 KiB - so it needs the sidecar rather than a header.
	write(root, 'assets/codkit.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]));
	write(root, 'assets/codkit.png.license', sidecar());

	if (!thirdParty) return root;

	write(root, 'LICENSES/MIT.txt', MIT_TEXT);
	write(
		root,
		'REUSE.toml',
		`version = 1\nSPDX-PackageName = "org.vibevm.codkit/standards"\nSPDX-PackageSupplier = "Person: ${HOLDER}"\n\n[[annotations]]\npath = "assets/third-party/feather/**"\nprecedence = "closest"\nSPDX-FileCopyrightText = "2013-2023 Cole Bemis"\nSPDX-License-Identifier = "MIT"\nSPDX-FileComment = "third-party; https://github.com/feathericons/feather tag v4.29.1"\n`
	);
	write(root, FIXTURE_THIRD_PARTY_PATH, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>\n');
	write(
		root,
		`${FIXTURE_THIRD_PARTY_PATH}.license`,
		'Copyright (c) 2013-2023 Cole Bemis\nSPDX-License-Identifier: MIT\nSource: https://github.com/feathericons/feather, tag v4.29.1, icons/package.svg\n'
	);
	write(root, 'THIRD-PARTY-NOTICES.md', FIXTURE_NOTICES);
	return root;
}
