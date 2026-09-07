// unit: the own-extension layer (PROP-005 sec. 13, ##OWN-EXTENSION-UNIT).
//
// The layer is the own layer applied to a second pair of roots, so the three
// things worth proving separately are the three it does not share with own
// code: what the `extensions` section has to satisfy before anything is
// materialized, which files a declared extension consists of, and that the
// mirror is content-addressed in both directions - the delta is the source of
// truth on `load`, the tree is what `save` extracts.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
	OWN_EXTENSIONS_DIR,
	checkOwnExtensions,
	compareOwnExtensions,
	listExtensionFiles,
	mirrorOwnExtensionsBack,
	ownExtensionFiles,
	ownExtensionSourceRoot,
	ownExtensionTargetRoot,
	ownExtensionTreePrefixes,
	syncOwnExtensions
} from '../../src/lib/layers/ownExtensions.ts';
import { parseOwnManifest } from '../../src/lib/layers/ownManifest.ts';
import type { OwnExtension } from '../../src/lib/layers/ownManifest.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const PIN = '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5';

const PACK: OwnExtension = {
	id: 'CK-product-905',
	name: 'acme-pack',
	owner: 'product',
	reason: 'fixture own extension: the language pack of the own strings',
	pin: PIN,
	contractTests: []
};

const PACKAGE_JSON = '{\n\t"name": "acme-pack"\n}\n';
const NLS_JSON = '{\n\t"acme.hello": "hello"\n}\n';

let patchesDir: string;
let treeDir: string;

beforeEach(() => {
	patchesDir = makeTempRoot('ownext-patchset');
	treeDir = makeTempRoot('ownext-tree');
});

afterAll(() => {
	cleanupTempRoots();
});

function writeDelta(relative: string, text: string): void {
	const absolute = join(patchesDir, ...`${OWN_EXTENSIONS_DIR}/${relative}`.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, text, 'utf8');
}

function writeTree(relative: string, text: string): void {
	const absolute = join(treeDir, ...relative.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, text, 'utf8');
}

/** The complete sample extension: the manifest the build looks for, and a string file. */
function writeSampleExtension(): void {
	writeDelta('acme-pack/package.json', PACKAGE_JSON);
	writeDelta('acme-pack/package.nls.json', NLS_JSON);
}

const noUpstream = (): boolean => false;

describe('the extensions section of the own manifest (##OWN-EXTENSION-UNIT)', () => {
	it('is optional: a manifest without it parses into no extensions', () => {
		const parsed = parseOwnManifest({ codkitOwnManifest: 2, units: [], serviceOverrides: [] });

		expect(parsed.extensions).toEqual([]);
	});

	it('accepts a record and keeps every field', () => {
		const parsed = parseOwnManifest({ codkitOwnManifest: 2, units: [], serviceOverrides: [], extensions: [PACK] });

		expect(parsed.extensions).toEqual([PACK]);
	});
});

describe('checkOwnExtensions (##OWN-EXTENSION-UNIT)', () => {
	it('accepts a directory that carries its package.json', () => {
		writeSampleExtension();

		expect(checkOwnExtensions(patchesDir, [PACK], noUpstream)).toEqual([]);
	});

	it('refuses a name that is not of the declared form', () => {
		writeDelta('Acme_Pack/package.json', PACKAGE_JSON);
		const problems = checkOwnExtensions(patchesDir, [{ ...PACK, name: 'Acme_Pack' }], noUpstream);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.message).toContain('is not of the form');
	});

	it('refuses a second record claiming a name the first already has', () => {
		writeSampleExtension();
		const problems = checkOwnExtensions(patchesDir, [PACK, { ...PACK, id: 'CK-product-906' }], noUpstream);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.message).toContain('is already declared by CK-product-905');
	});

	it('refuses a directory without the package.json the build looks for', () => {
		writeDelta('acme-pack/package.nls.json', NLS_JSON);
		const problems = checkOwnExtensions(patchesDir, [PACK], noUpstream);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.message).toContain(`${OWN_EXTENSIONS_DIR}/acme-pack/package.json is missing`);
		expect(problems[0]?.file).toBe(`${OWN_EXTENSIONS_DIR}/acme-pack/package.json`);
	});

	it('refuses a name the pin already ships, in the words the spec fixes', () => {
		writeSampleExtension();
		const problems = checkOwnExtensions(patchesDir, [PACK], (name) => name === 'acme-pack');

		expect(problems).toHaveLength(1);
		expect(problems[0]?.message).toContain('name collides with an upstream extension');
	});

	it('refuses a directory no record declares: it would never be materialized', () => {
		writeSampleExtension();
		writeDelta('orphan-pack/package.json', PACKAGE_JSON);
		const problems = checkOwnExtensions(patchesDir, [PACK], noUpstream);

		expect(problems).toHaveLength(1);
		expect(problems[0]?.message).toContain(`${OWN_EXTENSIONS_DIR}/orphan-pack/ is declared by no record`);
	});

	it('says nothing about a patchset that does not use the layer at all', () => {
		expect(checkOwnExtensions(patchesDir, [], noUpstream)).toEqual([]);
	});
});

describe('the files of a declared extension', () => {
	it('lists them byte-sorted, with their delta and tree paths', () => {
		writeSampleExtension();
		writeDelta('acme-pack/themes/dark.json', '{}\n');

		expect(ownExtensionFiles(patchesDir, [PACK]).map((file) => [file.relative, file.target])).toEqual([
			['acme-pack/package.json', 'extensions/acme-pack/package.json'],
			['acme-pack/package.nls.json', 'extensions/acme-pack/package.nls.json'],
			['acme-pack/themes/dark.json', 'extensions/acme-pack/themes/dark.json']
		]);
	});

	it('names the tree prefix the upstream-change selectors have to skip', () => {
		expect(ownExtensionTreePrefixes([PACK])).toEqual(['extensions/acme-pack/']);
	});

	it('contributes nothing for a name that cannot be a path', () => {
		expect(ownExtensionFiles(patchesDir, [{ ...PACK, name: '../escape' }])).toEqual([]);
		expect(ownExtensionTreePrefixes([{ ...PACK, name: '../escape' }])).toEqual([]);
	});
});

describe('syncOwnExtensions: patchset -> tree, the direction load uses', () => {
	it('writes the whole directory into extensions/<name>/', () => {
		writeSampleExtension();
		const report = syncOwnExtensions(patchesDir, treeDir, [PACK]);

		expect(report).toEqual({ copied: 2, removed: 0, total: 2 });
		expect(readFileSync(join(treeDir, 'extensions', 'acme-pack', 'package.nls.json'), 'utf8')).toBe(NLS_JSON);
	});

	it('does not rewrite a file whose bytes already match, so its mtime stays put', () => {
		writeSampleExtension();
		syncOwnExtensions(patchesDir, treeDir, [PACK]);
		const target = join(treeDir, 'extensions', 'acme-pack', 'package.json');
		const past = new Date(Date.now() - 60_000);
		utimesSync(target, past, past);
		const before = statSync(target).mtimeMs;

		const report = syncOwnExtensions(patchesDir, treeDir, [PACK]);

		expect(report.copied).toBe(0);
		expect(statSync(target).mtimeMs).toBe(before);
	});

	it('removes a tree file the delta no longer has, and prunes the directory it emptied', () => {
		writeSampleExtension();
		writeDelta('acme-pack/themes/dark.json', '{}\n');
		syncOwnExtensions(patchesDir, treeDir, [PACK]);
		expect(existsSync(join(treeDir, 'extensions', 'acme-pack', 'themes', 'dark.json'))).toBe(true);

		// The delta drops the theme; the next load has to take it out of the tree.
		rmSync(join(ownExtensionSourceRoot(patchesDir, 'acme-pack'), 'themes', 'dark.json'), { force: true });
		const report = syncOwnExtensions(patchesDir, treeDir, [PACK]);

		expect(report.removed).toBe(1);
		expect(existsSync(join(treeDir, 'extensions', 'acme-pack', 'themes'))).toBe(false);
	});

	it('skips a record whose name cannot be a path', () => {
		expect(syncOwnExtensions(patchesDir, treeDir, [{ ...PACK, name: '../escape' }])).toEqual({ copied: 0, removed: 0, total: 0 });
	});
});

describe('mirrorOwnExtensionsBack: tree -> patchset, the direction save uses', () => {
	it('brings a tree-side edit into the delta', () => {
		writeSampleExtension();
		syncOwnExtensions(patchesDir, treeDir, [PACK]);
		writeTree('extensions/acme-pack/package.nls.json', '{\n\t"acme.hello": "hi"\n}\n');

		const report = mirrorOwnExtensionsBack(patchesDir, treeDir, [PACK]);

		expect(report.copied).toBe(1);
		expect(readFileSync(join(ownExtensionSourceRoot(patchesDir, 'acme-pack'), 'package.nls.json'), 'utf8')).toBe(
			'{\n\t"acme.hello": "hi"\n}\n'
		);
	});

	it('brings a file the tree added into the delta', () => {
		writeSampleExtension();
		syncOwnExtensions(patchesDir, treeDir, [PACK]);
		writeTree('extensions/acme-pack/themes/dark.json', '{}\n');

		mirrorOwnExtensionsBack(patchesDir, treeDir, [PACK]);

		expect(listExtensionFiles(ownExtensionSourceRoot(patchesDir, 'acme-pack'))).toEqual([
			'package.json',
			'package.nls.json',
			'themes/dark.json'
		]);
	});

	it('leaves the delta alone when the tree never materialized the extension', () => {
		writeSampleExtension();

		const report = mirrorOwnExtensionsBack(patchesDir, treeDir, [PACK]);

		expect(report).toEqual({ copied: 0, removed: 0, total: 2 });
		expect(listExtensionFiles(ownExtensionSourceRoot(patchesDir, 'acme-pack'))).toEqual(['package.json', 'package.nls.json']);
	});
});

describe('compareOwnExtensions: what the drift guard and verify read', () => {
	it('reports nothing while the two sides are identical', () => {
		writeSampleExtension();
		syncOwnExtensions(patchesDir, treeDir, [PACK]);

		expect(compareOwnExtensions(patchesDir, treeDir, [PACK])).toEqual([]);
	});

	it('reports an edited file as `both`, with the path inside the layer', () => {
		writeSampleExtension();
		syncOwnExtensions(patchesDir, treeDir, [PACK]);
		writeTree('extensions/acme-pack/package.nls.json', '{}\n');

		expect(compareOwnExtensions(patchesDir, treeDir, [PACK])).toEqual([{ relative: 'acme-pack/package.nls.json', kind: 'both' }]);
	});

	it('reports a file only the tree has as `tree-only`', () => {
		writeSampleExtension();
		syncOwnExtensions(patchesDir, treeDir, [PACK]);
		writeTree('extensions/acme-pack/themes/dark.json', '{}\n');

		expect(compareOwnExtensions(patchesDir, treeDir, [PACK])).toEqual([{ relative: 'acme-pack/themes/dark.json', kind: 'tree-only' }]);
	});

	it('says nothing about an extension the tree has never materialized', () => {
		writeSampleExtension();

		expect(compareOwnExtensions(patchesDir, treeDir, [PACK])).toEqual([]);
		expect(existsSync(ownExtensionTargetRoot(treeDir, 'acme-pack'))).toBe(false);
	});
});
