// unit: an exact delivery of a declared own extension is a runtime copy of the
// delta, not dirt of the tree (modules/vscode/PROP-002 ##OWN-EXTENSION-UNIT).
// The upgrade cycle judges the tree three times - at materialization, in
// resolve and in stabilize - and every one of them reads a delivered extension
// through the same list, so the list itself is what is proved here: an exact
// copy is in it, an edited copy, an absent copy and a stray file are not.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { deliveredExtensionTargets, withoutDeliveredExtensionDirt } from '../../src/lib/cycleOwnedDirt.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

const PIN = '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5';
const PACKAGE_JSON = '{\n\t"name": "acme-pack"\n}\n';
const NLS_JSON = '{\n\t"acme.hello": "hello"\n}\n';
const EDITED_NLS_JSON = '{\n\t"acme.hello": "edited in the tree"\n}\n';

let patchesDir: string;
let treeDir: string;

beforeEach(() => {
	patchesDir = makeTempRoot('owned-dirt-patchset');
	treeDir = makeTempRoot('owned-dirt-tree');
	write(
		patchesDir,
		'delta/own/patchset.delta.json',
		`${JSON.stringify(
			{
				codkitOwnManifest: 2,
				units: [],
				serviceOverrides: [],
				extensions: [
					{
						id: 'CK-product-905',
						name: 'acme-pack',
						owner: 'product',
						reason: 'fixture own extension: the language pack of the own strings',
						pin: PIN,
						contractTests: []
					}
				]
			},
			null,
			2
		)}\n`
	);
	write(patchesDir, 'delta/own-extensions/acme-pack/package.json', PACKAGE_JSON);
	write(patchesDir, 'delta/own-extensions/acme-pack/package.nls.json', NLS_JSON);
});

afterAll(() => {
	cleanupTempRoots();
});

function write(root: string, relative: string, text: string): void {
	const absolute = join(root, ...relative.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, text, 'utf8');
}

describe('deliveredExtensionTargets (##OWN-EXTENSION-UNIT)', () => {
	it('names every declared file whose tree copy equals its delta source', () => {
		write(treeDir, 'addons/acme-pack/package.json', PACKAGE_JSON);
		write(treeDir, 'addons/acme-pack/package.nls.json', NLS_JSON);

		expect(deliveredExtensionTargets(patchesDir, treeDir, stubProjectType)).toEqual([
			'addons/acme-pack/package.json',
			'addons/acme-pack/package.nls.json'
		]);
	});

	it('leaves out a copy edited in the tree', () => {
		write(treeDir, 'addons/acme-pack/package.json', PACKAGE_JSON);
		write(treeDir, 'addons/acme-pack/package.nls.json', EDITED_NLS_JSON);

		expect(deliveredExtensionTargets(patchesDir, treeDir, stubProjectType)).toEqual(['addons/acme-pack/package.json']);
	});

	it('names nothing when the tree carries no delivery', () => {
		expect(deliveredExtensionTargets(patchesDir, treeDir, stubProjectType)).toEqual([]);
	});
});

describe('withoutDeliveredExtensionDirt (##OWN-EXTENSION-UNIT)', () => {
	it('drops only the untracked entries of exact deliveries', () => {
		write(treeDir, 'addons/acme-pack/package.json', PACKAGE_JSON);
		write(treeDir, 'addons/acme-pack/package.nls.json', EDITED_NLS_JSON);
		const entries = [
			{ status: '??', path: 'addons/acme-pack/package.json' },
			{ status: '??', path: 'addons/acme-pack/package.nls.json' },
			{ status: ' M', path: 'addons/acme-pack/package.json' },
			{ status: '??', path: 'addons/stray.txt' }
		];

		expect(withoutDeliveredExtensionDirt(entries, patchesDir, treeDir, stubProjectType)).toEqual([
			{ status: '??', path: 'addons/acme-pack/package.nls.json' },
			{ status: ' M', path: 'addons/acme-pack/package.json' },
			{ status: '??', path: 'addons/stray.txt' }
		]);
	});
});
