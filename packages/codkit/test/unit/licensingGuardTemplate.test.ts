// PROP-019 ##LICENCE-GUARD: the leftover guard is one template rendered with the
// type's words and the profile's values. The suite proves two things about the
// rendering: that it is TypeScript a product build accepts (node's own type
// stripping refuses what does not parse), and that it does what the fact says
// when it runs - against a tree that honours the profile and against one that
// does not, under a runner that supplies the two words as globals, the way the
// product's own test run does.

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderLicenceRtf } from '../../src/lib/licenceRtf.ts';
import { licenceGuardText } from '../../src/lib/licensingGuardTemplate.ts';
import type { LicenceGuardInput } from '../../src/lib/licensingGuardTemplate.ts';
import {
	FIXTURE_HOLDER,
	FIXTURE_LICENSE_ID,
	FIXTURE_LICENSE_TEXT,
	FIXTURE_RETIRED_NOTICE,
	FOREIGN_HOLDER,
	fixtureBlockHeaderLines
} from '../support/licensingFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const OWN_ROOT = 'source/own';
const EXTENSION_ROOT = 'addons/sample';
const UPSTREAM_COMPONENT = 'licenses/LICENSE-upstream.txt';

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

function input(over: Partial<LicenceGuardInput> = {}): LicenceGuardInput {
	return {
		words: { suite: 'describe', test: 'it' },
		holders: [FIXTURE_HOLDER],
		scopes: [
			{ treeDirectory: OWN_ROOT, expression: FIXTURE_LICENSE_ID },
			{ treeDirectory: EXTENSION_ROOT, expression: FIXTURE_LICENSE_ID }
		],
		skipDirectory: `${OWN_ROOT}/codkit`,
		licenceFile: { treePath: 'LICENSE.md', sha256: sha256(FIXTURE_LICENSE_TEXT) },
		fields: [
			{ target: 'manifest.json', path: ['licenseName'], expected: FIXTURE_LICENSE_ID },
			{ target: 'manifest.json', path: ['licenseFileName'], expected: 'LICENSE.md' },
			{ target: 'manifest.json', path: ['licenseUrl'], expected: 'absent' },
			{ target: 'package.json', path: ['license'], expected: FIXTURE_LICENSE_ID }
		],
		components: [UPSTREAM_COMPONENT],
		renderings: ['LICENSE.rtf'],
		retiredNotices: [FIXTURE_RETIRED_NOTICE],
		...over
	};
}

/** A file headed the way the engine heads own files of a block-style family. */
function headed(body: string, holder: string = FIXTURE_HOLDER): string {
	return `${fixtureBlockHeaderLines().join('\n').replace(FIXTURE_HOLDER, holder)}\n\n${body}`;
}

type Files = Readonly<Record<string, string | Uint8Array>>;

/** The tree of a product that honours the profile: every kind of carrier the model knows, and the surfaces. */
function conformingTree(): Files {
	return {
		'LICENSE.md': FIXTURE_LICENSE_TEXT,
		'LICENSE.rtf': renderLicenceRtf(FIXTURE_LICENSE_TEXT),
		[UPSTREAM_COMPONENT]: 'Fixture upstream licence\n',
		'manifest.json': `${JSON.stringify({ displayName: 'Fixture', licenseName: FIXTURE_LICENSE_ID, licenseFileName: 'LICENSE.md' }, null, '\t')}\n`,
		'package.json': `${JSON.stringify({ name: 'fixture-product', license: FIXTURE_LICENSE_ID }, null, '\t')}\n`,
		// A header in the first twenty non-empty lines.
		[`${OWN_ROOT}/hello.ts`]: headed("export const hello = 'hello';\n"),
		// The delivered directory of the tool: never the product's to annotate.
		[`${OWN_ROOT}/codkit/runtime.ts`]: 'export const RUNTIME = true;\n',
		// A binary with its sidecar.
		[`${OWN_ROOT}/media/logo.bin`]: new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x00, 0x10]),
		[`${OWN_ROOT}/media/logo.bin.license`]: `Copyright (c) 2026 ${FIXTURE_HOLDER}\nSPDX-License-Identifier: ${FIXTURE_LICENSE_ID}\n`,
		// A declared third party, annotated by the nearest registry.
		[`${OWN_ROOT}/vendor/REUSE.toml`]: [
			'version = 1',
			'',
			'[[annotations]]',
			'path = ["tiny.js"]',
			'precedence = "closest"',
			`SPDX-FileCopyrightText = "2020 ${FOREIGN_HOLDER}"`,
			'SPDX-License-Identifier = "MIT"',
			'SPDX-FileComment = "third-party; a vendored helper"',
			''
		].join('\n'),
		[`${OWN_ROOT}/vendor/tiny.js`]: 'module.exports = () => 1;\n',
		// Own files that cannot carry a comment, annotated by the registry of the scope's root.
		[`${OWN_ROOT}/REUSE.toml`]: [
			'version = 1',
			'',
			'[[annotations]]',
			'path = "icons/**"',
			`SPDX-FileCopyrightText = ["2026 ${FIXTURE_HOLDER}"]`,
			`SPDX-License-Identifier = "${FIXTURE_LICENSE_ID}"`,
			'SPDX-FileComment = "the icons of the product"',
			''
		].join('\n'),
		[`${OWN_ROOT}/icons/deep/a.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
		[`${EXTENSION_ROOT}/index.ts`]: headed('export const sample = 1;\n')
	};
}

/** The same tree with one problem per check of the guard. */
function brokenTree(): Files {
	const tree = { ...conformingTree() };
	return {
		...tree,
		[`${OWN_ROOT}/hello.ts`]: headed("export const hello = 'hello';\n", FOREIGN_HOLDER),
		[`${OWN_ROOT}/plain.ts`]: 'export const plain = true;\n',
		[`${OWN_ROOT}/vendor/other.js`]: 'module.exports = () => 2;\n',
		[`${OWN_ROOT}/vendor/REUSE.toml`]: `${tree[`${OWN_ROOT}/vendor/REUSE.toml`] as string}[[annotations]]\npath = "other.js"\nSPDX-FileCopyrightText = "2026 ${FIXTURE_HOLDER}"\nSPDX-License-Identifier = "MIT"\nSPDX-FileComment = "our own"\n`,
		[`${OWN_ROOT}/notes.md`]: 'This build is Source-Available.\n',
		'LICENSE.md': `${FIXTURE_LICENSE_TEXT}An extra line.\n`,
		'manifest.json': `${JSON.stringify({ licenseName: 'MIT', licenseFileName: 'LICENSE.md', licenseUrl: 'https://example.invalid/licence' }, null, '\t')}\n`,
		'package.json': `${JSON.stringify({ name: 'fixture-product' }, null, '\t')}\n`
	};
}

function writeTree(root: string, files: Files, omit: readonly string[] = []): void {
	for (const [relative, content] of Object.entries(files)) {
		if (omit.includes(relative)) continue;
		const absolute = join(root, ...relative.split('/'));
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}
}

type RunnerEntry = { readonly suite?: string; readonly test?: string; readonly ok?: boolean; readonly message?: string };

/**
 * The runner of the product, reduced to its two words: `describe` and `it` as
 * globals, every test run and its assertion recorded. The guard is executed by
 * node with its types stripped, from the tree root, exactly as the fact places
 * it.
 */
const HARNESS = [
	'const results = [];',
	'globalThis.describe = (name, body) => { results.push({ suite: name }); body(); };',
	'globalThis.it = (name, body) => {',
	'\ttry { body(); results.push({ test: name, ok: true }); }',
	'\tcatch (error) { results.push({ test: name, ok: false, message: error instanceof Error ? error.message : String(error) }); }',
	'};',
	'await import(process.argv[2]);',
	'process.stdout.write(JSON.stringify(results));',
	''
].join('\n');

function runGuard(label: string, files: Files, omit: readonly string[] = []): readonly RunnerEntry[] {
	const tree = makeTempRoot(`guard-${label}-tree`);
	writeTree(tree, files, omit);
	const runner = makeTempRoot(`guard-${label}-runner`);
	const guard = join(runner, 'licence.leftovers.test.ts');
	writeFileSync(guard, licenceGuardText(input()), 'utf8');
	const harness = join(runner, 'harness.mjs');
	writeFileSync(harness, HARNESS, 'utf8');
	const result = spawnSync(process.execPath, ['--no-warnings', harness, pathToFileURL(guard).href], { cwd: tree, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`the guard did not run: ${result.stderr}`);
	return JSON.parse(result.stdout) as RunnerEntry[];
}

function testNamed(entries: readonly RunnerEntry[], fragment: string): RunnerEntry {
	const found = entries.find((entry) => entry.test?.includes(fragment));
	if (found === undefined) throw new Error(`no test about ${fragment} ran`);
	return found;
}

describe('licenceGuardText', () => {
	it('is TypeScript, names its suite licence-leftovers with the words of the type, and imports node alone', () => {
		const text = licenceGuardText(input({ words: { suite: 'suite', test: 'test' } }));

		expect(() => stripTypeScriptTypes(text)).not.toThrow();
		expect(text).toContain("suite('licence-leftovers', () => {");
		expect(text.match(/^\ttest\('/gmu)).toHaveLength(5);
		const imports = [...text.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1]);
		expect(imports).toEqual(['node:assert/strict', 'node:crypto', 'node:fs', 'node:path']);
		expect(text.endsWith('\n')).toBe(true);
	});

	it('bakes the values of the profile and the carrier model in, the retired phrases as escapes', () => {
		const text = licenceGuardText(input());

		expect(text).toContain(JSON.stringify([FIXTURE_HOLDER]));
		expect(text).toContain(`"directory":"${OWN_ROOT}","expression":"${FIXTURE_LICENSE_ID}"`);
		expect(text).toContain(`"directory":"${EXTENSION_ROOT}"`);
		expect(text).toContain(`const SKIP_DIRECTORY = "${OWN_ROOT}/codkit";`);
		expect(text).toContain(`const LICENCE_SHA256 = "${sha256(FIXTURE_LICENSE_TEXT)}";`);
		expect(text).toContain('"path":["licenseName"],"expected":"LicenseRef-FIXTURE-Private-1.0"');
		expect(text).toContain('"path":["licenseUrl"],"expected":null');
		expect(text).toContain(JSON.stringify([UPSTREAM_COMPONENT]));
		// The whole carrier model: a header, a sidecar, or an annotation of a
		// REUSE.toml inside the scope, with a declared third party accepted.
		expect(text).toContain("'/REUSE.toml'");
		expect(text).toContain("'.license'");
		expect(text).toContain("'third-party;'");
		expect(text).toContain("'SPDX-FileCopyrightText'");
		// The guard is an own file too, and must not carry what it forbids.
		expect(text.toLowerCase()).not.toContain(FIXTURE_RETIRED_NOTICE);
		expect(text).toContain('\\u0073\\u006f\\u0075\\u0072\\u0063\\u0065');
	});

	it('is deterministic', () => {
		expect(licenceGuardText(input())).toBe(licenceGuardText(input()));
	});

	it('passes over a tree that honours the profile, every carrier of the model included', () => {
		const entries = runGuard('green', conformingTree());

		expect(entries[0]).toEqual({ suite: 'licence-leftovers' });
		const tests = entries.filter((entry) => entry.test !== undefined);
		expect(tests).toHaveLength(5);
		expect(tests.filter((entry) => entry.ok !== true).map((entry) => `${entry.test ?? ''}: ${entry.message ?? ''}`)).toEqual([]);
	});

	it('names every offending path of a tree that does not', () => {
		const entries = runGuard('red', brokenTree(), ['LICENSE.rtf']);

		const carriers = testNamed(entries, 'every own file carries');
		expect(carriers.ok).toBe(false);
		expect(carriers.message).toContain(`${OWN_ROOT}/hello.ts: its header names the holder "${FOREIGN_HOLDER}"`);
		expect(carriers.message).toContain(`${OWN_ROOT}/plain.ts: has no licence carrier`);
		expect(carriers.message).toContain(`${OWN_ROOT}/vendor/other.js: its REUSE.toml annotation says MIT instead of ${FIXTURE_LICENSE_ID}`);
		expect(carriers.message).not.toContain('tiny.js');
		expect(carriers.message).not.toContain('codkit/runtime.ts');

		const retired = testNamed(entries, 'retired notice');
		expect(retired.ok).toBe(false);
		expect(retired.message).toBe(`${OWN_ROOT}/notes.md: carries the retired notice "${FIXTURE_RETIRED_NOTICE}"`);

		const licence = testNamed(entries, 'licence file');
		expect(licence.ok).toBe(false);
		expect(licence.message).toContain('LICENSE.md: not the canonical text of the profile');

		const fields = testNamed(entries, 'manifest field');
		expect(fields.ok).toBe(false);
		expect(fields.message).toContain(`manifest.json:licenseName: expected "${FIXTURE_LICENSE_ID}", found "MIT"`);
		expect(fields.message).toContain('manifest.json:licenseUrl: expected no such key');
		expect(fields.message).toContain(`package.json:license: expected "${FIXTURE_LICENSE_ID}", found undefined`);

		const present = testNamed(entries, 'component licence and rendering');
		expect(present.ok).toBe(false);
		expect(present.message).toBe('missing from the tree: LICENSE.rtf');
	});
});
