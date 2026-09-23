// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the
// targets and masters below are that family's.
// A patch set that declares nothing (PROP-007 ##IMAGESET-DECLARED-FRAMES,
// ##IMAGESET-DECLARED-SOURCES) gets exactly what it got before a declaration
// could exist: every file `gen` writes - the seeded masters, the regenerated
// artifacts and the resource map - is compared, byte for byte, with the sha256
// the generator produced on the same fixture at e7330ef, the last commit
// without the declaration.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { encodePng, rgba } from '@codkit/type-api';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { runImageset } from '../../src/lib/imagesetEngine.ts';
import { makeImagesetPatchSet, makeImagesetTree } from '../support/imagesetFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { writePng } from '../../../type-api/test/support/pngVariants.ts';

afterAll(cleanupTempRoots);

const letterpressFixture = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'type-vscode',
	'test',
	'fixtures',
	'imageset',
	'letterpress.svg'
);

const ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#167abf"/><circle cx="64" cy="64" r="28" fill="#ffffff"/></svg>';
const JSON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect x="4" y="4" width="56" height="56" rx="10" fill="#e8a33d"/><path d="M20 20 L44 44 M44 20 L20 44" stroke="#ffffff" stroke-width="6"/></svg>';

/** Every file under the given directories of a patch set, as path -> sha256. */
function producedFiles(patchsetDir: string, roots: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string, prefix: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const relative = `${prefix}/${name}`;
			if (statSync(path).isDirectory()) {
				walk(path, relative);
				continue;
			}
			out[relative] = createHash('sha256').update(readFileSync(path)).digest('hex');
		}
	};
	for (const root of roots) {
		const dir = join(patchsetDir, ...root.split('/'));
		if (existsSync(dir)) {
			walk(dir, root);
		}
	}
	return out;
}

function generate(label: string, extended: boolean, masters: Readonly<Record<string, Uint8Array | string>> | null) {
	const tree = makeImagesetTree(`${label}-tree`, { extended });
	const patchset = makeImagesetPatchSet(`${label}-patchset`, tree);
	const brandingDir = join(patchset.dir, 'branding');
	if (masters !== null) {
		for (const [file, bytes] of Object.entries(masters)) {
			const path = join(brandingDir, ...file.split('/'));
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, bytes);
		}
	}
	const outcome = runImageset({
		patchesDir: patchset.dir,
		type: vscodeType,
		treeDir: tree.dir,
		brandingDir,
		pin: tree.pin,
		dryRun: false,
		onInfo: () => {},
		onWarn: () => {}
	});
	// A seeded run writes the masters it seeds; otherwise they are the test's input.
	return { outcome, files: producedFiles(patchset.dir, masters === null ? ['branding', 'delta/resources'] : ['delta/resources']) };
}

describe('a patch set that declares nothing', () => {
	it('gets every file of a seeded run byte for byte as before', () => {
		const { outcome, files } = generate('undeclared-seeded', false, null);
		expect(outcome.exitCode).toBe(0);
		expect(files).toEqual(SEEDED);
	});

	it('gets every file of a run over vector, raster, per-size and 16-bit masters of the whole brand surface byte for byte as before', () => {
		const { outcome, files } = generate('undeclared-masters', true, {
			'icon.svg': ICON_SVG,
			'icon-16.png': encodePng(rgba(16, 16, [200, 40, 40, 255])),
			'installer-big.png': encodePng(rgba(40, 20, [22, 122, 191, 255])),
			'installer-small.png': writePng(12, 12, { colorType: 6, bitDepth: 16 }, (x) => [x * 5000, 32768, 65535 - x * 5000, 65535]),
			'filetype/json.svg': JSON_SVG,
			'filetype/yaml.png': encodePng(rgba(96, 96, [120, 60, 200, 255])),
			'letterpress/dark.svg': readFileSync(letterpressFixture)
		});
		expect(outcome.exitCode).toBe(0);
		expect(files).toEqual(MASTERS);
	});
});

/** What e7330ef writes on a seeded run: the seeded masters, the artifacts and the map. */
const SEEDED: Record<string, string> = {
	'branding/icon.png': 'f99e0576406ff517c30247045814eac596a77307e5ecff6ab5a316cc9a1a243a',
	'branding/installer-big.png': '54d7abd60dda567115ca55f7f1c139903871fd2beb5b6c0d5d044844934c84ea',
	'branding/installer-small.png': '1f8db9fefd0d22b9e3c83c905dae739dd55921d1f7b4f3d217be3faac5ec277e',
	'delta/resources/files/resources/darwin/code.icns': 'ca30d8490f5fafcb6839aa24a91952649a21b2cff331ed71935d5620cab54a37',
	'delta/resources/files/resources/linux/code.png': '69662b874542e9ad742802a9d97284ce9710bd0d7415782f15d96bd6069b87bc',
	'delta/resources/files/resources/linux/rpm/code.xpm': 'ee8201743d964aa357cc0b5687ddec7f64fa8a9554b0c73ad0b515a3b1b48225',
	'delta/resources/files/resources/win32/code.ico': '412bf49f76192ae60cc88819bf3a341d77f6ac9d00f1e47c9237436e173d7ed6',
	'delta/resources/files/resources/win32/code_70x70.png': '17533b2653ee4cd67471b0d5ef0bd34d6429e6324521abad77ed813bb66ebb7c',
	'delta/resources/files/resources/win32/inno-big-100.bmp': '9930b2f22a43cbd6e81bfc058183f206684b5987979780dd82d0201c0f0cea63',
	'delta/resources/files/resources/win32/inno-big-125.bmp': 'aa0d5f4334e3d01d18bb64b3efb9a1f4364b7239cb6f60956c74ddbc612a086a',
	'delta/resources/files/resources/win32/inno-small-100.bmp': '7ab89e9c16a3853e60e5182df5225f65b423ef45602dcc4daba4bf786e8532f7',
	'delta/resources/map.json': 'e1e983014c43aecfe7fa4a85513a49530f113447ce96de3331d217aceacbf183'
};
/** What e7330ef writes from the masters above: the artifacts and the map. */
const MASTERS: Record<string, string> = {
	'delta/resources/files/resources/darwin/code.icns': '3371807bcfc977dbdce77aa1273c21c937e16e49f1887bf73953dd7e8cf022b5',
	'delta/resources/files/resources/darwin/json.icns': '4f541142324fc2c5156095baf5175cef6a82c3d673176f8f1ce5eca192b6bdb7',
	'delta/resources/files/resources/darwin/yaml.icns': '0dc7460403d29dff9615f0c503758edd42c9d46c852a81c24526268caa8180d9',
	'delta/resources/files/resources/linux/code.png': 'b43c47cc2024f863eaf516dd8d5d56ee8c460c344537af69e89e848687b176b9',
	'delta/resources/files/resources/linux/rpm/code.xpm': '5882f9d8d43eab65d7f09399eeb87b778f26700ad444eb2f168fb44952e09c8f',
	'delta/resources/files/resources/server/code-192.png': 'b43c47cc2024f863eaf516dd8d5d56ee8c460c344537af69e89e848687b176b9',
	'delta/resources/files/resources/server/favicon.ico': '15ee2ade3415c1694367f3c9d862498d2d4843344aba1f0b8e91ea0399314a20',
	'delta/resources/files/resources/win32/code.ico': '15ee2ade3415c1694367f3c9d862498d2d4843344aba1f0b8e91ea0399314a20',
	'delta/resources/files/resources/win32/code_70x70.png': '75ff6afa680b3303d6de941292511766e0c414ce51391b536dccbd9ada18ada6',
	'delta/resources/files/resources/win32/inno-big-100.bmp': '7da5f283c375f24f6d77c594e30b4e42c0e46d8aa518f1be1644a48e65666b30',
	'delta/resources/files/resources/win32/inno-big-125.bmp': '702aa6a40702f9ff717e8edc9624fba46a19b2ec693993a53bcc2674b533baa6',
	'delta/resources/files/resources/win32/inno-small-100.bmp': '1df0c5aeda638a450e17d3e59d4d08eac1d18e27097315d34c72d00359e816bf',
	'delta/resources/files/resources/win32/json.ico': '7ebe50357cbf7ac3899402e37b87018cfab5b9fb593bef60f79aec514c5d4f3c',
	'delta/resources/files/src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg':
		'628f0dae83bd992878e849a82e75a885300a2f103b048283b13f30d19e53e7ef',
	'delta/resources/map.json': '54a889db964709a2c2c495eae5f35d636f954309a68530286535abbbf810f80d'
};
