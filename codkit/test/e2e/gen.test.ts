// PROP-013 ##E2E-GEN-SURFACE: `codkit gen` through the real launcher.
// FEAT-002 ##S49-##S50.
//
// The fixture is a patch-set root with `delta/own/` and nothing else: the
// generator writes into the delta and needs no fork tree (##GEN-NAMESPACE).

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Envelope } from '../support/cliFixture.ts';
import { runCli } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const COMMON = 'delta/own/contrib/sample/common/sample.ts';
const CONTRIBUTION = 'delta/own/contrib/sample/browser/sample.contribution.ts';
const TEST = 'delta/own/test/browser/sample.test.ts';
const BRAND = 'delta/own/common/brand.ts';

function makePatchSet(label: string): string {
	const root = makeTempRoot(`gen-${label}`);
	mkdirSync(join(root, 'delta', 'own'), { recursive: true });
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
		const data = outcome.envelope.data as { files: string[]; importLine: string; headerWritten: boolean };
		expect(data.files).toEqual([COMMON, CONTRIBUTION, TEST]);
		expect(data.headerWritten).toBe(true);
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
		expect(outcome.stderr).toContain('no header written; pass --holder and --license');
		expect(read(patchesDir, COMMON).startsWith('// Identifiers of the Sample feature.')).toBe(true);
		expect(read(patchesDir, COMMON)).not.toContain('SPDX-License-Identifier');
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
