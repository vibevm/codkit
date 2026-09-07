// PROP-013 ##UT-SHIPPED-RUNTIME: the runtime library codkit ships, checked on
// its real bytes (PROP-015 ##RT-SHIPPED-RUNTIME-TEST).
//
// The library typechecks against upstream on a harness outside this
// repository; what this repository can prove is the shape of the artifact:
// one version, the literal, only TypeScript and Markdown, the banner on every
// file, a clean licence check, the narrow upstream surface, no product name.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLicenseCarriers } from '../../src/lib/licenseCheck.ts';
import { loadLicensePolicy } from '../../src/lib/licensePolicy.ts';
import { RUNTIME_PACKAGE_PARENT, shippedRuntime } from '../../src/lib/runtimePackage.ts';
import { loadSpdxLicenseIds } from '../../src/lib/spdxIds.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const shipped = shippedRuntime(toolRoot);

const BANNER_TS = [
	'// Copyright (c) 2026 Oleg Chirukhin',
	'// Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/',
	'// allow-any-unicode-next-line',
	'// Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/',
	'// SPDX-License-Identifier: UPL-1.0'
];
const BANNER_MD = [
	'<!--',
	'Copyright (c) 2026 Oleg Chirukhin',
	'Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/',
	'Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/',
	'SPDX-License-Identifier: UPL-1.0',
	'-->'
];

/** ##RT-NARROW-UPSTREAM-SURFACE, as regular expressions over import specifiers (resolved to `vs/...`). */
const ALLOWED = {
	common: [/^vs\/base\/common\//u, /^vs\/platform\/[^/]+\/common\//u],
	browser: [
		/^vs\/base\/common\//u,
		/^vs\/platform\/[^/]+\/common\//u,
		/^vs\/workbench\/common\/contributions\.js$/u,
		/^vs\/workbench\/services\/host\/browser\/host\.js$/u,
		/^vs\/workbench\/services\/lifecycle\/common\/lifecycle\.js$/u,
		/^vs\/nls\.js$/u
	],
	test: [
		/^vs\/base\/common\//u,
		/^vs\/platform\/[^/]+\/common\//u,
		/^vs\/base\/test\/common\//u,
		/^vs\/platform\/[^/]+\/test\/common\//u,
		/^assert$/u
	]
};

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(path));
		} else {
			out.push(path);
		}
	}
	return out.sort();
}

const files = walk(shipped.directory).map((path) => relative(shipped.directory, path).split('\\').join('/'));

/** Resolves a relative import of a library file to the upstream `vs/...` path or to the library's own `codkit/...` path. */
function resolveSpecifier(file: string, specifier: string): string {
	if (!specifier.startsWith('.')) {
		return specifier;
	}
	// The library lives at src/vs/<own>/codkit/; `<own>` is one segment under vs/.
	const fromParts = ['vs', 'own', 'codkit', ...file.split('/').slice(0, -1)];
	const parts = [...fromParts];
	for (const segment of specifier.split('/')) {
		if (segment === '..') {
			parts.pop();
		} else if (segment !== '.') {
			parts.push(segment);
		}
	}
	return parts.join('/');
}

describe('the shipped runtime library', () => {
	it('sits at exactly one version directory whose name is the version literal', () => {
		const parent = join(toolRoot, ...RUNTIME_PACKAGE_PARENT.split('/'));
		const versions = readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('v'));

		expect(versions).toHaveLength(1);
		expect(versions[0]?.name).toBe(`v${shipped.version}`);
		expect(shipped.verifiedUpstream.length).toBeGreaterThan(0);
	});

	it('consists of TypeScript and Markdown only, with no empty directories', () => {
		for (const file of files) {
			expect(file, file).toMatch(/\.(ts|md)$/u);
			expect(statSync(join(shipped.directory, file)).size, file).toBeGreaterThan(0);
		}
		expect(files.some((file) => file.startsWith('common/features/'))).toBe(true);
		expect(files.some((file) => file.startsWith('browser/adapters/'))).toBe(true);
		expect(files.some((file) => file.startsWith('test/'))).toBe(true);
	});

	it('carries the licence banner at the top of every file', () => {
		for (const file of files) {
			const lines = readFileSync(join(shipped.directory, file), 'utf8').split('\n');
			const banner = file.endsWith('.md') ? BANNER_MD : BANNER_TS;
			expect(lines.slice(0, banner.length), file).toEqual(banner);
		}
	});

	it('passes the licence check with no problems and only header carriers', () => {
		const result = checkLicenseCarriers(shipped.directory, loadLicensePolicy(), loadSpdxLicenseIds(), { packageShape: false });

		expect(result.problems).toEqual([]);
		expect(result.checked.filter((file) => file.carrier !== 'header')).toEqual([]);
		expect(result.licences.own).toEqual(['UPL-1.0']);
		expect(result.licences.thirdParty).toEqual([]);
	});

	it('imports upstream only through the narrow surface and never a contrib', () => {
		for (const file of files.filter((name) => name.endsWith('.ts'))) {
			const layer = file.startsWith('common/') ? 'common' : file.startsWith('browser/') ? 'browser' : 'test';
			const text = readFileSync(join(shipped.directory, file), 'utf8');
			for (const match of text.matchAll(/^import[^'"]*['"]([^'"]+)['"];$/gmu)) {
				const resolved = resolveSpecifier(file, match[1]!);
				if (resolved.startsWith('vs/own/codkit/')) {
					const target = resolved.slice('vs/own/codkit/'.length);
					const targetLayer = target.startsWith('common/') ? 'common' : target.startsWith('browser/') ? 'browser' : 'test';
					const allowedInternal = layer === 'test' || layer === targetLayer || (layer === 'browser' && targetLayer === 'common');
					expect(allowedInternal, `${file} imports ${target}`).toBe(true);
					continue;
				}
				expect(resolved, `${file} imports ${resolved}`).not.toMatch(/^vs\/workbench\/contrib\//u);
				expect(
					ALLOWED[layer].some((pattern) => pattern.test(resolved)),
					`${file} imports ${resolved}`
				).toBe(true);
			}
		}
	});

	it('names no product and keeps non-ASCII to the banner comments', () => {
		const productToken = ['v', 'code'].join('');
		for (const file of files) {
			const text = readFileSync(join(shipped.directory, file), 'utf8');
			expect(text.toLowerCase().includes(productToken), file).toBe(false);
			if (file.endsWith('.ts')) {
				const body = text.split('\n').slice(BANNER_TS.length).join('\n');
				expect(/[^\x00-\x7f]/u.test(body), `${file} carries non-ASCII outside the banner`).toBe(false);
			}
		}
	});
});
