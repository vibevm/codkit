// PROP-013 ##E2E-GEN-SURFACE: `codkit gen` through the real launcher.
// FEAT-002 ##S49-##S50, ##S61.
//
// The fixture is a patch-set root with `delta/own/` and a configuration: the
// generator writes into the delta and needs no fork tree, but it does need the
// project type whose skeleton it writes (##GEN-NAMESPACE).

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Envelope } from '../support/cliFixture.ts';
import { runCli } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const COMMON = 'delta/own/contrib/sample/common/sample.ts';
const CONTRIBUTION = 'delta/own/contrib/sample/browser/sample.contribution.ts';
// ##GEN-TEST-LIVES-WITH-THE-FEATURE: inside the feature, not in a shared
// directory that belongs to no unit of the own manifest.
const TEST = 'delta/own/contrib/sample/test/browser/sample.test.ts';
const BRAND = 'delta/own/common/brand.ts';
const HEADER_FILE = 'delta/own/HEADER.txt';

function makePatchSet(label: string): string {
	const root = makeTempRoot(`gen-${label}`);
	mkdirSync(join(root, 'delta', 'own'), { recursive: true });
	writeFileSync(
		join(root, 'codkit.json'),
		`${JSON.stringify(
			{
				codkitConfig: 2,
				pin: { tag: '1.0.0', sha: 'f'.repeat(40), date: '2026-01-01' },
				upstreamAnchorCommit: 'f'.repeat(40),
				type: 'vscode',
				typeConfig: { ownRoot: 'src/vs/patchset' },
				generatedBranchPrefix: 'codkit/applied/',
				cycleBranchPrefix: 'codkit/cycle/',
				releaseRefPrefix: 'codkit/release/',
				publishRemoteUrl: null,
				buildWatchFile: null,
				conventionsExtensionFile: null
			},
			null,
			'\t'
		)}\n`,
		'utf8'
	);
	return root;
}

function run(patchesDir: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
	return runCli(patchesDir, ['--patches-dir', patchesDir, ...args]);
}

function json(patchesDir: string, args: readonly string[]): { status: number; envelope: Envelope } {
	const outcome = run(patchesDir, ['--json', ...args]);
	return { status: outcome.status, envelope: JSON.parse(outcome.stdout) as Envelope };
}

function read(patchesDir: string, relative: string): string {
	return readFileSync(join(patchesDir, ...relative.split('/')), 'utf8');
}

function walk(root: string, prefix = ''): readonly string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		return entry.isDirectory() ? walk(join(root, entry.name), relative) : [relative];
	});
}

// The block form, pinned to the character: the width is what makes an own file
// sit flush with the upstream file beside it.
const BLOCK_LINES: readonly string[] = [
	'/*---------------------------------------------------------------------------------------------',
	' *  Copyright (c) 2026 Acme. All rights reserved.',
	' *  Licensed under the MIT licence. The full licence text is the licence file of this repository.',
	' *  SPDX-License-Identifier: MIT',
	' *--------------------------------------------------------------------------------------------*/'
];

function snapshot(root: string): string {
	return [...walk(root)]
		.sort()
		.map(
			(relative) =>
				`${relative} ${createHash('sha256')
					.update(readFileSync(join(root, ...relative.split('/'))))
					.digest('hex')}`
		)
		.join('\n');
}

describe('S49 - gen feature writes the skeleton with the product header', () => {
	it('creates three files, each headed by the product, and offers the import line', () => {
		const patchesDir = makePatchSet('s49');
		const outcome = json(patchesDir, [
			'gen',
			'feature',
			'acme.sample',
			'--title',
			'Sample',
			'--setting',
			'--holder',
			'Acme',
			'--license',
			'MIT',
			'--year',
			'2026'
		]);

		expect(outcome.status).toBe(0);
		const data = outcome.envelope.data as { files: string[]; importLine: string; headerWritten: boolean; headerStyle: string };
		expect(data.files).toEqual([COMMON, CONTRIBUTION, TEST]);
		expect(data.headerWritten).toBe(true);
		expect(data.headerStyle).toBe('line');
		expect(data.importLine).toBe("import '../contrib/sample/browser/sample.contribution.js';");

		for (const relative of data.files) {
			const lines = read(patchesDir, relative).split('\n');
			expect(lines).toHaveLength(lines.length);
			expect(lines[0]).toBe('// Copyright (c) 2026 Acme');
			expect(lines[3]).toBe('// SPDX-License-Identifier: MIT');
		}
		expect(read(patchesDir, CONTRIBUTION)).toContain('registerFeature(');
		expect(read(patchesDir, CONTRIBUTION)).toContain('hotToggle: true,');
	});

	it('refuses the second run with CK-E-GEN-EXISTS and touches nothing', () => {
		const patchesDir = makePatchSet('s49-again');
		expect(run(patchesDir, ['gen', 'feature', 'acme.sample', '--title', 'Sample']).status).toBe(0);
		const before = snapshot(join(patchesDir, 'delta', 'own'));

		const again = json(patchesDir, ['gen', 'feature', 'acme.sample', '--title', 'Other']);
		expect(again.status).toBe(1);
		expect(again.envelope.errors[0]?.code).toBe('CK-E-GEN-EXISTS');
		expect(snapshot(join(patchesDir, 'delta', 'own'))).toBe(before);
	});

	it('refuses an id that is not of the descriptor form', () => {
		const patchesDir = makePatchSet('s49-id');
		const outcome = json(patchesDir, ['gen', 'feature', 'Sample', '--title', 'x']);

		expect(outcome.status).toBe(2);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-GEN-ID');
		expect(existsSync(join(patchesDir, 'delta', 'own', 'contrib'))).toBe(false);
	});

	it('writes no header and says so when the product supplied none', () => {
		const patchesDir = makePatchSet('s49-bare');
		const outcome = run(patchesDir, ['gen', 'feature', 'acme.sample', '--title', 'Sample']);

		expect(outcome.status).toBe(0);
		expect(outcome.stderr).toContain('no header written; pass --holder and --license, or --header-file');
		expect(read(patchesDir, COMMON).startsWith('// Identifiers of the Sample feature.')).toBe(true);
		expect(read(patchesDir, COMMON)).not.toContain('SPDX-License-Identifier');
	});
});

describe('S61 - gen feature writes the header form of the product and keeps the test with it', () => {
	it('writes the block form into all three files of the feature directory', () => {
		const patchesDir = makePatchSet('s61-block');
		const outcome = json(patchesDir, [
			'gen',
			'feature',
			'acme.sample',
			'--title',
			'Sample',
			'--holder',
			'Acme',
			'--license',
			'MIT',
			'--year',
			'2026',
			'--header-style',
			'block'
		]);

		expect(outcome.status).toBe(0);
		const data = outcome.envelope.data as { files: string[]; headerStyle: string; reminders: string[] };
		expect(data.files).toEqual([COMMON, CONTRIBUTION, TEST]);
		expect(data.headerStyle).toBe('block');
		for (const relative of data.files) {
			expect(read(patchesDir, relative).split('\n').slice(0, 5)).toEqual(BLOCK_LINES);
		}
		// One unit covers the code and the test alike, so the reminder names one.
		expect(data.reminders).toEqual([
			'declare a unit for delta/own/contrib/sample in delta/own/patchset.delta.json, or verify reports CK-E-OWN-UNCOVERED'
		]);
	});

	it('copies the header file of another product byte for byte', () => {
		const patchesDir = makePatchSet('s61-file');
		const house = `${['/* the house header of this product', ' * kept exactly as the product wrote it', ' */'].join('\n')}\n`;
		writeFileSync(join(patchesDir, 'delta', 'own', 'HEADER.txt'), house, 'utf8');

		const outcome = json(patchesDir, ['gen', 'feature', 'acme.sample', '--title', 'Sample', '--header-file', HEADER_FILE]);

		expect(outcome.status).toBe(0);
		const data = outcome.envelope.data as { files: string[]; headerStyle: string };
		expect(data.headerStyle).toBe('file');
		for (const relative of data.files) {
			expect(read(patchesDir, relative).startsWith(`${house}\n`)).toBe(true);
		}
	});

	it('refuses --header-file together with a field of the header, writing nothing', () => {
		const patchesDir = makePatchSet('s61-both');
		writeFileSync(join(patchesDir, 'delta', 'own', 'HEADER.txt'), '// house\n', 'utf8');
		const before = snapshot(join(patchesDir, 'delta', 'own'));

		const outcome = json(patchesDir, [
			'gen',
			'feature',
			'acme.sample',
			'--title',
			'Sample',
			'--header-file',
			HEADER_FILE,
			'--holder',
			'Acme'
		]);

		expect(outcome.status).toBe(2);
		expect(snapshot(join(patchesDir, 'delta', 'own'))).toBe(before);
		expect(existsSync(join(patchesDir, 'delta', 'own', 'contrib'))).toBe(false);
	});

	it('refuses a header style with no holder and licence to shape, writing nothing', () => {
		const patchesDir = makePatchSet('s61-style-alone');
		const outcome = json(patchesDir, ['gen', 'feature', 'acme.sample', '--title', 'Sample', '--header-style', 'block']);

		expect(outcome.status).toBe(2);
		expect(existsSync(join(patchesDir, 'delta', 'own', 'contrib'))).toBe(false);
	});

	it('refuses a header file it cannot read and names the path', () => {
		const patchesDir = makePatchSet('s61-missing');
		const outcome = json(patchesDir, ['gen', 'feature', 'acme.sample', '--title', 'Sample', '--header-file', HEADER_FILE]);

		expect(outcome.status).toBe(2);
		expect(outcome.envelope.errors[0]?.file).toBe(HEADER_FILE);
		expect(existsSync(join(patchesDir, 'delta', 'own', 'contrib'))).toBe(false);
	});

	it('refuses a header style that is neither line nor block', () => {
		const patchesDir = makePatchSet('s61-style-unknown');
		const outcome = json(patchesDir, [
			'gen',
			'feature',
			'acme.sample',
			'--title',
			'Sample',
			'--holder',
			'Acme',
			'--license',
			'MIT',
			'--header-style',
			'banner'
		]);

		expect(outcome.status).toBe(2);
		expect(existsSync(join(patchesDir, 'delta', 'own', 'contrib'))).toBe(false);
	});
});

describe('S50 - gen brand writes the table and prints the graft', () => {
	it('exports brandMessage and hands over the hook text with both reminders', () => {
		const patchesDir = makePatchSet('s50');
		const outcome = json(patchesDir, ['gen', 'brand', '--holder', 'Acme', '--license', 'MIT']);

		expect(outcome.status).toBe(0);
		const data = outcome.envelope.data as { file: string; hookText: string; reminders: string[] };
		expect(data.file).toBe(BRAND);
		expect(read(patchesDir, BRAND)).toContain('createBrandTransform');
		expect(read(patchesDir, BRAND)).toContain('export const brandMessage = createBrandTransform(RULES);');
		expect(data.hookText).toContain('brandMessage(');
		expect(data.reminders.some((line) => line.includes('type = hook'))).toBe(true);
		expect(data.reminders.some((line) => line.includes('nls.ts') && line.includes('code-import-patterns'))).toBe(true);
	});
});

describe('the gen namespace', () => {
	it('does nothing by itself and says which subcommands there are', () => {
		const patchesDir = makePatchSet('namespace');
		const outcome = run(patchesDir, ['gen']);

		expect(outcome.status).toBe(2);
		expect(outcome.stderr).toContain('gen feature, gen brand');
	});
});
