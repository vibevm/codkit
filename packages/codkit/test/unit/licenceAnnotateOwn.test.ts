// PROP-019 ##ANNOTATE-OWN in process: the own files of a fixture patch set get
// their carriers from the fixture profile - the block of PROP-015
// ##GEN-HEADER-IS-THE-PRODUCTS for the sources of a `headerStyle: block` type,
// the comment of the extension otherwise (PROP-014 ##LIC-COMMENT-STYLES), a
// sidecar for what cannot carry a comment (##LIC-CARRIER-SIDECAR) - and the
// walk, the narrowing, the registries, the retired posture and the dry run
// behave as the fact says.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProjectType } from '@codkit/type-api';
import { annotateOwn } from '../../src/lib/licenceAnnotateOwn.ts';
import type { OwnAnnotateOptions, OwnAnnotateResult } from '../../src/lib/licenceAnnotateOwn.ts';
import { readLicensingProfile } from '../../src/lib/licensingProfile.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { projectType } from '../fixtures/stubType.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import {
	FIXTURE_HOLDER,
	FIXTURE_LICENSE_ID,
	FIXTURE_LICENSE_TITLE,
	FIXTURE_RETIRED_NOTICE,
	FIXTURE_YEAR,
	FOREIGN_HOLDER,
	fixtureBlockHeaderLines,
	installLicensingProfile
} from '../support/licensingFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const SAMPLE = 'delta/own/sample';
const RULE_OPEN = `/*${'-'.repeat(93)}`;
const RULE_CLOSE = ` *${'-'.repeat(92)}*/`;

/** The product's pre-campaign block: a holder the parser reads as foreign, and the retired posture. */
const RETIRED_BLOCK = [
	RULE_OPEN,
	` *  Copyright (c) 2025 ${FOREIGN_HOLDER}. All rights reserved.`,
	` *  Licensed under the ${FIXTURE_RETIRED_NOTICE} terms of the previous edition.`,
	' *  SPDX-License-Identifier: LicenseRef-Previous',
	RULE_CLOSE,
	'',
	'export const old = 1;',
	''
].join('\n');

/** Somebody else's notice without a retired phrase: a third party's, whatever the flag says. */
const THEIRS = [`// Copyright (c) 2024 ${FOREIGN_HOLDER}`, '// SPDX-License-Identifier: MIT', '', 'export const theirs = 1;', ''].join(
	'\n'
);

/** The four statements of the line form, as the engine wraps them in a non-slash comment. */
const LINE_STATEMENTS = [
	`Copyright (c) ${FIXTURE_YEAR} ${FIXTURE_HOLDER}`,
	`Licensed under the ${FIXTURE_LICENSE_TITLE}.`,
	'The full text is LICENSE.md of this repository.',
	`SPDX-License-Identifier: ${FIXTURE_LICENSE_ID}`
];

const SIDECAR = `Copyright (c) ${FIXTURE_YEAR} ${FIXTURE_HOLDER}\nSPDX-License-Identifier: ${FIXTURE_LICENSE_ID}\n`;

const BLOCK_HEADED = (code: string): string => [...fixtureBlockHeaderLines(), '', code, ''].join('\n');

function ownFixture(label: string, product?: Record<string, unknown>) {
	const fixture = makeCliFixture(label);
	const lic = installLicensingProfile(label, fixture.patchesDir, product === undefined ? {} : { product });
	const profile = readLicensingProfile(fixture.patchesDir, join(lic.home, '.codkit'));
	if (profile === null) throw new Error('the fixture declaration was not read');
	const write = (relative: string, content: string | Uint8Array): void => {
		const absolute = fixture.patchesPath(relative);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	};
	const read = (relative: string): string => readFileSync(fixture.patchesPath(relative), 'utf8');
	const has = (relative: string): boolean => existsSync(fixture.patchesPath(relative));
	const run = (options: Partial<OwnAnnotateOptions> = {}): OwnAnnotateResult =>
		annotateOwn({
			patchesDir: fixture.patchesDir,
			type: projectType,
			profile,
			paths: [],
			replaceRetired: false,
			dryRun: false,
			...options
		});
	return { fixture, profile, write, read, has, run };
}

function actionOf(result: OwnAnnotateResult, path: string): string | undefined {
	return result.files.find((file) => file.path === path)?.action;
}

/** The registry value of the error a run throws, or null when it does not throw. */
function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return isCkError(error) ? error.code : 'not a CkError';
	}
}

function registry(annotation: Record<string, string>): string {
	return [
		'version = 1',
		'SPDX-PackageName = "fixture-own-layer"',
		'',
		'[[annotations]]',
		...Object.entries(annotation).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
		''
	].join('\n');
}

describe('annotateOwn', () => {
	it('gives every headerless own file its carrier from the profile and walks only the own layers', () => {
		const own = ownFixture('annotate-own-unit');
		own.write(`${SAMPLE}/a.ts`, 'export const a = 1;\n');
		own.write(`${SAMPLE}/data.json`, '{"a":1}\n');
		own.write(`${SAMPLE}/notes.md`, '# Notes\n\ntext\n');
		own.write(`${SAMPLE}/blob.bin`, new Uint8Array([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]));
		own.write(`${SAMPLE}/old.ts`, RETIRED_BLOCK);
		own.write(`${SAMPLE}/theirs.ts`, THEIRS);
		own.write('delta/own/codkit/x.ts', 'export const delivered = 1;\n');
		own.write('delta/own-extensions/sample-ext/package.json', '{"name":"sample-ext"}\n');

		const result = own.run();

		const paths = result.files.map((file) => file.path);
		expect(paths).toEqual([...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
		expect(actionOf(result, `${SAMPLE}/a.ts`)).toBe('header');
		expect(actionOf(result, `${SAMPLE}/notes.md`)).toBe('header');
		expect(actionOf(result, `${SAMPLE}/data.json`)).toBe('sidecar');
		expect(actionOf(result, `${SAMPLE}/blob.bin`)).toBe('sidecar');
		expect(actionOf(result, `${SAMPLE}/old.ts`)).toBe('foreign-holder');
		expect(actionOf(result, `${SAMPLE}/theirs.ts`)).toBe('foreign-holder');
		expect(actionOf(result, 'delta/own-extensions/sample-ext/package.json')).toBe('sidecar');
		// The fixture's own files are the product's too; its manifest, the tool's
		// delivered directory and the resource layer are not walked.
		expect(actionOf(result, 'delta/own/hello.ts')).toBe('header');
		expect(paths.some((path) => path.startsWith('delta/own/codkit/'))).toBe(false);
		expect(paths.some((path) => path.startsWith('delta/resources/'))).toBe(false);
		expect(paths).not.toContain('delta/own/patchset.delta.json');
		expect(paths.some((path) => path.endsWith('.license'))).toBe(false);

		expect(own.read(`${SAMPLE}/a.ts`)).toBe(BLOCK_HEADED('export const a = 1;'));
		expect(own.read(`${SAMPLE}/notes.md`)).toBe(['<!--', ...LINE_STATEMENTS, '-->', '', '# Notes', '', 'text', ''].join('\n'));
		expect(own.read(`${SAMPLE}/data.json`)).toBe('{"a":1}\n');
		expect(own.read(`${SAMPLE}/data.json.license`)).toBe(SIDECAR);
		expect(own.read(`${SAMPLE}/blob.bin.license`)).toBe(SIDECAR);
		expect(own.read('delta/own-extensions/sample-ext/package.json.license')).toBe(SIDECAR);
		expect(own.read(`${SAMPLE}/old.ts`)).toBe(RETIRED_BLOCK);
		expect(own.read(`${SAMPLE}/theirs.ts`)).toBe(THEIRS);
		expect(own.read('delta/own/codkit/x.ts')).toBe('export const delivered = 1;\n');
		expect(own.has('delta/own/codkit/x.ts.license')).toBe(false);
	});

	it('is idempotent: the second run leaves every carried file unchanged', () => {
		const own = ownFixture('annotate-own-twice');
		own.write(`${SAMPLE}/a.ts`, 'export const a = 1;\n');
		own.write(`${SAMPLE}/data.json`, '{"a":1}\n');
		own.write(`${SAMPLE}/notes.md`, '# Notes\n');
		own.run();
		const after = [`${SAMPLE}/a.ts`, `${SAMPLE}/data.json`, `${SAMPLE}/data.json.license`, `${SAMPLE}/notes.md`].map((path) =>
			own.read(path)
		);

		const second = own.run();

		expect(second.files.every((file) => file.action === 'unchanged')).toBe(true);
		expect(
			[`${SAMPLE}/a.ts`, `${SAMPLE}/data.json`, `${SAMPLE}/data.json.license`, `${SAMPLE}/notes.md`].map((path) => own.read(path))
		).toEqual(after);
	});

	it('follows the prelude and the comment style of the extension, and the line form for a type without the area', () => {
		const own = ownFixture('annotate-own-styles');
		own.write(`${SAMPLE}/run.sh`, '#!/bin/sh\necho hi\n');
		own.write(`${SAMPLE}/style.css`, 'body {}\n');
		own.write(`${SAMPLE}/doc.xml`, '<?xml version="1.0"?>\n<spec/>\n');
		own.write(`${SAMPLE}/line.ts`, 'export const line = 1;\n');
		const { licensing: _area, ...withoutArea } = projectType;
		const lineType: ProjectType = withoutArea;

		own.run({ paths: [`${SAMPLE}/run.sh`, `${SAMPLE}/style.css`, `${SAMPLE}/doc.xml`] });
		own.run({ type: lineType, paths: [`${SAMPLE}/line.ts`] });

		expect(own.read(`${SAMPLE}/run.sh`)).toBe(['#!/bin/sh', ...LINE_STATEMENTS.map((line) => `# ${line}`), '', 'echo hi', ''].join('\n'));
		expect(own.read(`${SAMPLE}/style.css`)).toBe(BLOCK_HEADED('body {}'));
		expect(own.read(`${SAMPLE}/doc.xml`)).toBe(['<?xml version="1.0"?>', '<!--', ...LINE_STATEMENTS, '-->', '', '<spec/>', ''].join('\n'));
		expect(own.read(`${SAMPLE}/line.ts`)).toBe(
			[...LINE_STATEMENTS.map((line) => `// ${line}`), '', 'export const line = 1;', ''].join('\n')
		);
	});

	it('replaces the retired posture under --replace-retired and nothing else', () => {
		const own = ownFixture('annotate-own-replace');
		const retiredRun = [
			'#!/bin/sh',
			`# Copyright (c) 2025 ${FOREIGN_HOLDER}. All rights reserved.`,
			`# The ${FIXTURE_RETIRED_NOTICE} edition.`,
			'# SPDX-License-Identifier: LicenseRef-Previous',
			'# prints a greeting',
			'echo hi',
			''
		].join('\n');
		const deeper = [
			'// The module.',
			'',
			`// Copyright (c) 2025 ${FOREIGN_HOLDER} (${FIXTURE_RETIRED_NOTICE})`,
			'export const deep = 1;',
			''
		].join('\n');
		const retiredSidecar = `Copyright (c) 2025 ${FOREIGN_HOLDER}\nLicensed under the ${FIXTURE_RETIRED_NOTICE} terms.\nSPDX-License-Identifier: LicenseRef-Previous\n`;
		own.write(`${SAMPLE}/old.ts`, RETIRED_BLOCK);
		own.write(`${SAMPLE}/theirs.ts`, THEIRS);
		own.write(`${SAMPLE}/old.sh`, retiredRun);
		own.write(`${SAMPLE}/deep.ts`, deeper);
		own.write(`${SAMPLE}/retired.json`, '{}\n');
		own.write(`${SAMPLE}/retired.json.license`, retiredSidecar);

		const reported = own.run({ paths: [SAMPLE] });
		expect(reported.files.map((file) => file.action)).toEqual([
			'foreign-holder',
			'foreign-holder',
			'foreign-holder',
			'foreign-holder',
			'foreign-holder'
		]);
		expect(own.read(`${SAMPLE}/old.ts`)).toBe(RETIRED_BLOCK);

		const replaced = own.run({ paths: [SAMPLE], replaceRetired: true });
		expect(actionOf(replaced, `${SAMPLE}/old.ts`)).toBe('replaced');
		expect(actionOf(replaced, `${SAMPLE}/old.sh`)).toBe('replaced');
		expect(actionOf(replaced, `${SAMPLE}/retired.json`)).toBe('replaced');
		// Somebody else's notice has no retired phrase; a carrier below the
		// leading comment is not the leading comment. Both stay as they are.
		expect(actionOf(replaced, `${SAMPLE}/theirs.ts`)).toBe('foreign-holder');
		expect(actionOf(replaced, `${SAMPLE}/deep.ts`)).toBe('foreign-holder');
		expect(own.read(`${SAMPLE}/old.ts`)).toBe(BLOCK_HEADED('export const old = 1;'));
		// The run of line comments ends at its SPDX line: the comment that follows is the file's own.
		expect(own.read(`${SAMPLE}/old.sh`)).toBe(
			['#!/bin/sh', ...LINE_STATEMENTS.map((line) => `# ${line}`), '', '# prints a greeting', 'echo hi', ''].join('\n')
		);
		expect(own.read(`${SAMPLE}/retired.json.license`)).toBe(SIDECAR);
		expect(own.read(`${SAMPLE}/retired.json`)).toBe('{}\n');
		expect(own.read(`${SAMPLE}/theirs.ts`)).toBe(THEIRS);
		expect(own.read(`${SAMPLE}/deep.ts`)).toBe(deeper);

		const again = own.run({ paths: [SAMPLE], replaceRetired: true });
		expect(actionOf(again, `${SAMPLE}/old.ts`)).toBe('unchanged');
		expect(actionOf(again, `${SAMPLE}/old.sh`)).toBe('unchanged');
		expect(actionOf(again, `${SAMPLE}/retired.json`)).toBe('unchanged');
		expect(actionOf(again, `${SAMPLE}/theirs.ts`)).toBe('foreign-holder');
	});

	it('replaces the pre-campaign block, which closes without an SPDX line, under --replace-retired', () => {
		const own = ownFixture('annotate-own-pre-campaign');
		// The exact shape the campaign retires: the copyright line ends in "All rights
		// reserved.", one statement names the retired posture, and no SPDX line closes
		// the block - the carrier is found by its copyright line alone.
		const preCampaign = [
			RULE_OPEN,
			` *  Copyright (c) 2026 ${FOREIGN_HOLDER}. All rights reserved.`,
			` *  Licensed under the Product ${FIXTURE_RETIRED_NOTICE} licence. See LICENSE.md in the patch set.`,
			RULE_CLOSE,
			'',
			'export const pre = 1;',
			''
		].join('\n');
		own.write(`${SAMPLE}/pre.ts`, preCampaign);

		expect(actionOf(own.run({ paths: [SAMPLE] }), `${SAMPLE}/pre.ts`)).toBe('foreign-holder');
		expect(own.read(`${SAMPLE}/pre.ts`)).toBe(preCampaign);
		expect(actionOf(own.run({ paths: [SAMPLE], replaceRetired: true }), `${SAMPLE}/pre.ts`)).toBe('replaced');
		expect(own.read(`${SAMPLE}/pre.ts`)).toBe(BLOCK_HEADED('export const pre = 1;'));
		expect(actionOf(own.run({ paths: [SAMPLE], replaceRetired: true }), `${SAMPLE}/pre.ts`)).toBe('unchanged');
	});

	it('replaces nothing when the product block declares no retired notices', () => {
		const own = ownFixture('annotate-own-no-retired', { retiredNotices: [] });
		own.write(`${SAMPLE}/old.ts`, RETIRED_BLOCK);

		const result = own.run({ paths: [SAMPLE], replaceRetired: true });

		expect(result.files).toEqual([{ path: `${SAMPLE}/old.ts`, action: 'foreign-holder' }]);
		expect(own.read(`${SAMPLE}/old.ts`)).toBe(RETIRED_BLOCK);
	});

	it('honours the registries the way the consumer check does', () => {
		const own = ownFixture('annotate-own-registry');
		own.write(
			'delta/own/data/REUSE.toml',
			registry({
				path: '*.json',
				'SPDX-FileCopyrightText': `${FIXTURE_YEAR} ${FIXTURE_HOLDER}`,
				'SPDX-License-Identifier': FIXTURE_LICENSE_ID
			})
		);
		own.write('delta/own/data/one.json', '{"one":1}\n');
		own.write('delta/own/data/two.json', '{"two":2}\n');
		own.write(
			'delta/own/vendor/REUSE.toml',
			registry({
				path: '*',
				'SPDX-FileCopyrightText': `2020 ${FOREIGN_HOLDER}`,
				'SPDX-License-Identifier': 'MIT',
				'SPDX-FileComment': 'third-party; a fixture pack the product derives from'
			})
		);
		own.write('delta/own/vendor/pack.ts', 'export const pack = 1;\n');
		own.write('delta/own/vendor/pack.json', '{"pack":1}\n');
		own.write('delta/own/vendor/pack.txt', `Copyright (c) 2020 ${FOREIGN_HOLDER}\n${FIXTURE_RETIRED_NOTICE}\n`);
		own.write(
			'delta/own/mixed/REUSE.toml',
			registry({ path: '*.json', 'SPDX-FileCopyrightText': `2020 ${FOREIGN_HOLDER}`, 'SPDX-License-Identifier': 'MIT' })
		);
		own.write('delta/own/mixed/m.json', '{"m":1}\n');

		const result = own.run({ replaceRetired: true });

		// An own annotation covers a directory of data files without a sidecar per file.
		expect(actionOf(result, 'delta/own/data/one.json')).toBe('unchanged');
		expect(actionOf(result, 'delta/own/data/two.json')).toBe('unchanged');
		expect(own.has('delta/own/data/one.json.license')).toBe(false);
		// A declared third party is never touched, with or without a carrier of its own, flag or no flag.
		expect(actionOf(result, 'delta/own/vendor/pack.ts')).toBe('unchanged');
		expect(actionOf(result, 'delta/own/vendor/pack.json')).toBe('unchanged');
		expect(actionOf(result, 'delta/own/vendor/pack.txt')).toBe('unchanged');
		expect(own.read('delta/own/vendor/pack.ts')).toBe('export const pack = 1;\n');
		expect(own.has('delta/own/vendor/pack.json.license')).toBe(false);
		expect(own.has('delta/own/vendor/pack.txt.license')).toBe(false);
		// An own annotation naming a foreign holder is fixed in its registry, not in the files.
		expect(actionOf(result, 'delta/own/mixed/m.json')).toBe('foreign-holder');
		expect(own.has('delta/own/mixed/m.json.license')).toBe(false);
		// The registries are metadata, not files to annotate.
		expect(result.files.some((file) => file.path.endsWith('REUSE.toml'))).toBe(false);
	});

	it('refuses a registry that does not read, before writing anything', () => {
		const own = ownFixture('annotate-own-broken-registry');
		own.write(`${SAMPLE}/a.ts`, 'export const a = 1;\n');
		own.write(`${SAMPLE}/REUSE.toml`, 'version = "one"\n');

		expect(codeOf(() => own.run())).toBe('CONFIG');
		expect(own.read(`${SAMPLE}/a.ts`)).toBe('export const a = 1;\n');
	});

	it('writes nothing under dryRun and still reports every action', () => {
		const own = ownFixture('annotate-own-dry');
		own.write(`${SAMPLE}/a.ts`, 'export const a = 1;\n');
		own.write(`${SAMPLE}/data.json`, '{"a":1}\n');
		own.write(`${SAMPLE}/old.ts`, RETIRED_BLOCK);

		const result = own.run({ paths: [SAMPLE], dryRun: true, replaceRetired: true });

		expect(result.files).toEqual([
			{ path: `${SAMPLE}/a.ts`, action: 'header' },
			{ path: `${SAMPLE}/data.json`, action: 'sidecar' },
			{ path: `${SAMPLE}/old.ts`, action: 'replaced' }
		]);
		expect(own.read(`${SAMPLE}/a.ts`)).toBe('export const a = 1;\n');
		expect(own.has(`${SAMPLE}/data.json.license`)).toBe(false);
		expect(own.read(`${SAMPLE}/old.ts`)).toBe(RETIRED_BLOCK);
	});

	it('narrows the walk to the given paths and refuses one that names no own-layer file', () => {
		const own = ownFixture('annotate-own-narrow');
		own.write(`${SAMPLE}/a.ts`, 'export const a = 1;\n');
		own.write(`${SAMPLE}/data.json`, '{"a":1}\n');
		own.write('delta/own/other/b.ts', 'export const b = 1;\n');
		own.write('delta/own/codkit/x.ts', 'export const delivered = 1;\n');

		const one = own.run({ paths: [`${SAMPLE}/data.json`] });
		expect(one.files).toEqual([{ path: `${SAMPLE}/data.json`, action: 'sidecar' }]);
		expect(own.read(`${SAMPLE}/a.ts`)).toBe('export const a = 1;\n');

		// The order is the walk's byte order, not the order the paths were given in.
		const directory = own.run({ paths: [`${SAMPLE}/`, 'delta/own/other/b.ts'] });
		expect(directory.files).toEqual([
			{ path: 'delta/own/other/b.ts', action: 'header' },
			{ path: `${SAMPLE}/a.ts`, action: 'header' },
			{ path: `${SAMPLE}/data.json`, action: 'unchanged' }
		]);
		expect(own.read('delta/own/hello.ts')).not.toContain('SPDX-License-Identifier');

		expect(codeOf(() => own.run({ paths: ['delta/own/nowhere'] }))).toBe('CONFIG');
		expect(codeOf(() => own.run({ paths: ['delta/own/codkit/x.ts'] }))).toBe('CONFIG');
		expect(codeOf(() => own.run({ paths: ['delta/resources/files/app-icon.bin'] }))).toBe('CONFIG');
		expect(codeOf(() => own.run({ paths: ['../elsewhere/a.ts'] }))).toBe('CONFIG');
		expect(own.read('delta/own/codkit/x.ts')).toBe('export const delivered = 1;\n');
	});

	it('refuses a file with CR line endings before writing anything', () => {
		const own = ownFixture('annotate-own-crlf');
		own.write(`${SAMPLE}/a.ts`, 'export const a = 1;\n');
		own.write(`${SAMPLE}/crlf.ts`, 'export const crlf = 1;\r\n');

		expect(codeOf(() => own.run({ paths: [SAMPLE] }))).toBe('CRLF');
		expect(own.read(`${SAMPLE}/a.ts`)).toBe('export const a = 1;\n');
		expect(own.read(`${SAMPLE}/crlf.ts`)).toBe('export const crlf = 1;\r\n');
	});
});
