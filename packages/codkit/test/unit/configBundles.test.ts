// unit: the declaration of the bundles in codkit.json and codkit.local.json
// (PROP-003 ##CFG-BUNDLES, ##CFG-BUNDLE-NAME, ##CFG-BUNDLE-FILE,
// ##LOCAL-CONFIG-RULE): the schema, the one field the local file may replace
// or null, the merge, and the canonical serialization that carries nothing
// local.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	bundleFileProblem,
	declaredBundleFile,
	localBundleContentField,
	locateBundles,
	resolveBundleFile,
	unmatchedLocalBundles
} from '../../src/lib/bundlesDeclaration.ts';
import { CONFIG_FILE_NAME, LOCAL_CONFIG_FILE_NAME, loadConfig, parseBaseConfig, serializeBaseConfig } from '../../src/lib/configFile.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const SAMPLE = {
	codkitConfig: 2,
	pin: { tag: '1.135.0', sha: '08d4889f9ec4a1685d257b9b95de036c8e1ce1e5', date: '2026-08-25' },
	upstreamAnchorCommit: '0000000000000000000000000000000000000000',
	type: 'stub',
	typeConfig: { ownRoot: 'source/own' },
	generatedBranchPrefix: 'codkit/applied/',
	cycleBranchPrefix: 'codkit/cycle/',
	releaseRefPrefix: 'codkit/release/',
	publishRemoteUrl: null
};

const ABSOLUTE = process.platform === 'win32' ? 'D:/bundles/acme-pack.vsix' : '/bundles/acme-pack.vsix';

function message(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) return `${error.message} ${error.hint ?? ''}`;
		throw error;
	}
	throw new Error('expected a refusal');
}

function writeJson(dir: string, name: string, body: unknown): void {
	writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

describe('bundles in codkit.json', () => {
	it('reads the list, each entry name and file, and writes it back canonically', () => {
		const parsed = parseBaseConfig(
			{
				...SAMPLE,
				bundles: [
					{ name: 'acme.pack', file: '../bundles/acme-pack.vsix' },
					{ name: 'acme.other', file: ABSOLUTE }
				]
			},
			CONFIG_FILE_NAME
		);
		expect(parsed.bundles).toEqual([
			{ name: 'acme.pack', file: '../bundles/acme-pack.vsix' },
			{ name: 'acme.other', file: ABSOLUTE }
		]);
		const written = JSON.parse(
			serializeBaseConfig({ ...parsed, bundles: [{ name: 'acme.pack', file: '../bundles/acme-pack.vsix', off: true }] })
		) as Record<string, unknown>;
		expect(written['bundles']).toEqual([{ name: 'acme.pack', file: '../bundles/acme-pack.vsix' }]);
		expect(parseBaseConfig(SAMPLE, CONFIG_FILE_NAME).bundles).toBeUndefined();
	});

	it('refuses a duplicate name, a name that is not one portable token, and a file with backslashes or a trailing slash', () => {
		expect(
			message(() =>
				parseBaseConfig(
					{
						...SAMPLE,
						bundles: [
							{ name: 'acme.pack', file: 'a.vsix' },
							{ name: 'acme.pack', file: 'b.vsix' }
						]
					},
					CONFIG_FILE_NAME
				)
			)
		).toContain('bundles');
		expect(message(() => parseBaseConfig({ ...SAMPLE, bundles: [{ name: 'acme pack', file: 'a.vsix' }] }, CONFIG_FILE_NAME))).toContain(
			'bundles.name'
		);
		expect(message(() => parseBaseConfig({ ...SAMPLE, bundles: [{ name: 'acme.pack', file: 'a\\b.vsix' }] }, CONFIG_FILE_NAME))).toContain(
			'bundles.file'
		);
		expect(message(() => parseBaseConfig({ ...SAMPLE, bundles: [{ name: 'acme.pack', file: 'bundles/' }] }, CONFIG_FILE_NAME))).toContain(
			'bundles.file'
		);
		expect(message(() => parseBaseConfig({ ...SAMPLE, bundles: [{ name: 'acme.pack' }] }, CONFIG_FILE_NAME))).toContain('bundles.file');
		expect(bundleFileProblem('../bundles/a.vsix')).toBeNull();
		expect(bundleFileProblem('')).toBe('must not be empty');
	});
});

describe('bundles in codkit.local.json', () => {
	function configured(local: unknown): ReturnType<typeof loadConfig> {
		const dir = makeTempRoot('config-bundles-local');
		writeJson(dir, CONFIG_FILE_NAME, { ...SAMPLE, bundles: [{ name: 'acme.pack', file: '../bundles/acme-pack.vsix' }] });
		if (local !== undefined) writeJson(dir, LOCAL_CONFIG_FILE_NAME, local);
		return loadConfig(dir);
	}

	it('replaces the archive of a bundle on this machine, and null switches it off here', () => {
		expect(configured({ bundles: [{ name: 'acme.pack', file: ABSOLUTE }] })?.bundles).toEqual([{ name: 'acme.pack', file: ABSOLUTE }]);
		expect(configured({ bundles: [{ name: 'acme.pack', file: null }] })?.bundles).toEqual([
			{ name: 'acme.pack', file: '../bundles/acme-pack.vsix', off: true }
		]);
		expect(configured(undefined)?.bundles).toEqual([{ name: 'acme.pack', file: '../bundles/acme-pack.vsix' }]);
	});

	it('leaves a declaration alone that the local file does not name, and names the local entries codkit.json does not declare', () => {
		expect(configured({ bundles: [{ name: 'acme.other', file: ABSOLUTE }] })?.bundles).toEqual([
			{ name: 'acme.pack', file: '../bundles/acme-pack.vsix' }
		]);
		expect(unmatchedLocalBundles([{ name: 'acme.pack' }], [{ name: 'acme.other' }, { name: 'acme.pack' }])).toEqual(['acme.other']);
		expect(unmatchedLocalBundles([{ name: 'acme.pack' }], undefined)).toEqual([]);
	});

	it('refuses content that is not the archive: the local file locates, it never declares', () => {
		expect(message(() => configured({ bundles: [{ name: 'acme.pack', file: ABSOLUTE, version: '1.0.0' }] }))).toContain('version');
		expect(localBundleContentField([{ name: 'a', file: null }])).toBeNull();
		expect(localBundleContentField([{ name: 'a', file: null, sha256: 'x' }])).toBe('sha256');
		expect(message(() => configured({ bundles: [{ name: 'acme.pack', file: 'a\\b.vsix' }] }))).toContain('bundles.file');
		expect(
			message(() =>
				configured({
					bundles: [
						{ name: 'acme.pack', file: null },
						{ name: 'acme.pack', file: null }
					]
				})
			)
		).toContain('bundles');
	});

	it('merges by name', () => {
		const base = [
			{ name: 'a', file: 'a.vsix' },
			{ name: 'b', file: 'b.vsix' }
		];
		expect(locateBundles(base, [{ name: 'b', file: null }])).toEqual([
			{ name: 'a', file: 'a.vsix' },
			{ name: 'b', file: 'b.vsix', off: true }
		]);
		expect(locateBundles(base, undefined)).toBe(base);
	});
});

describe('the path of an archive', () => {
	const patchesDir = process.platform === 'win32' ? 'D:\\work\\patchset' : '/work/patchset';

	it('resolves against the patch-set root unless absolute', () => {
		expect(resolveBundleFile(patchesDir, '../bundles/acme-pack.vsix')).toBe(join(patchesDir, '..', 'bundles', 'acme-pack.vsix'));
		expect(resolveBundleFile(patchesDir, ABSOLUTE)).toBe(join(ABSOLUTE));
	});

	it('is declared as given when absolute, else relative to the patch-set root with forward slashes', () => {
		expect(declaredBundleFile(patchesDir, join(ABSOLUTE), ABSOLUTE)).toBe(ABSOLUTE);
		if (process.platform === 'win32') {
			expect(declaredBundleFile(patchesDir, 'D:\\bundles\\acme-pack.vsix', 'D:\\bundles\\acme-pack.vsix')).toBe(
				'D:/bundles/acme-pack.vsix'
			);
		}
		expect(declaredBundleFile(patchesDir, join(patchesDir, '..', 'bundles', 'acme-pack.vsix'), '../bundles/acme-pack.vsix')).toBe(
			'../bundles/acme-pack.vsix'
		);
		expect(declaredBundleFile(patchesDir, join(patchesDir, 'bundles', 'acme-pack.vsix'), 'bundles/acme-pack.vsix')).toBe(
			'bundles/acme-pack.vsix'
		);
	});
});
