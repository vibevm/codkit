// Fixture pair for the imageset tests: a miniature fork tree whose commits
// carry a "shipped icon set" of a distribution (the committed binaries of the
// type package, under its test/fixtures/imageset and produced by its
// generate.mjs), and a patchset that could not be smaller: config, owners, one
// own unit whose test file declares the guard suites new resource entries need.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureCommit, fixtureGit, writeFingerprintFiles } from '../fixtures/makeUpstream.ts';
import { makeTempRoot } from './tmp.ts';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'type-vscode', 'test', 'fixtures', 'imageset');

/** Tree-relative path -> fixture file name of every shipped icon. */
export const SHIPPED_ICONS: ReadonlyMap<string, string> = new Map([
	['resources/win32/code.ico', 'code.ico'],
	['resources/darwin/code.icns', 'code.icns'],
	['resources/linux/code.png', 'code.png'],
	['resources/win32/code_70x70.png', 'code_70x70.png'],
	['resources/linux/rpm/code.xpm', 'code.xpm'],
	['resources/win32/inno-big-100.bmp', 'inno-big-100.bmp'],
	['resources/win32/inno-big-125.bmp', 'inno-big-125.bmp'],
	['resources/win32/inno-small-100.bmp', 'inno-small-100.bmp']
]);

/**
 * The rest of the brand surface, added only when a test asks for it: a file
 * type present on both platforms, one present on macOS alone, the web
 * client's icons and a vector watermark. Kept out of the default tree so the
 * tests written against the small set keep their exact counts.
 */
export const EXTENDED_ICONS: ReadonlyMap<string, string> = new Map([
	['resources/win32/json.ico', 'code.ico'],
	['resources/darwin/json.icns', 'code.icns'],
	['resources/darwin/yaml.icns', 'code.icns'],
	['resources/server/favicon.ico', 'code.ico'],
	['resources/server/code-192.png', 'code.png'],
	['src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg', 'letterpress.svg']
]);

export type ImagesetTreeFixture = {
	readonly dir: string;
	readonly pin: { readonly tag: string; readonly sha: string; readonly date: string };
};

/** A git repository that plays the fork tree: the icon set committed at t1. */
export function makeImagesetTree(label: string, options: { readonly extended?: boolean } = {}): ImagesetTreeFixture {
	const dir = makeTempRoot(`${label}-tree`);
	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);
	writeFingerprintFiles(dir);
	writeFileSync(join(dir, 'product.json'), '{\n\t"nameShort": "Fixture - OSS"\n}\n', 'utf8');
	const shipped = options.extended === true ? new Map([...SHIPPED_ICONS, ...EXTENDED_ICONS]) : SHIPPED_ICONS;
	for (const [relative, name] of shipped) {
		const absolute = join(dir, ...relative.split('/'));
		mkdirSync(dirname(absolute), { recursive: true });
		copyFileSync(join(fixtureRoot, name), absolute);
	}
	const sha = fixtureCommit(dir, 'fixture: distribution tree with its icon set', '2026-09-06T00:00:00Z');
	fixtureGit(dir, ['tag', 't1']);
	return { dir, pin: { tag: 't1', sha, date: '2026-09-06' } };
}

export type ImagesetPatchSetFixture = {
	readonly dir: string;
	/** Remove the guard suites so a run must refuse to create entries. */
	readonly withoutGuards: () => void;
};

/** The smallest honest patchset for imageset: config, owners, own guard tests. */
export function makeImagesetPatchSet(label: string, tree: ImagesetTreeFixture): ImagesetPatchSetFixture {
	const dir = makeTempRoot(`${label}-patchset`);
	const owners = join(dir, 'delta', 'owners.json');
	mkdirSync(dirname(owners), { recursive: true });
	writeFileSync(
		join(dir, 'codkit.json'),
		`${JSON.stringify(
			{
				codkitConfig: 2,
				pin: { tag: tree.pin.tag, sha: tree.pin.sha, date: tree.pin.date },
				upstreamAnchorCommit: tree.pin.sha,
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
	writeFileSync(
		owners,
		`${JSON.stringify({ codkitOwners: 1, owners: { product: { contact: 'fixture', paths: ['resources/**', 'src/**'] } } }, null, '\t')}\n`,
		'utf8'
	);
	writeGuards(dir);
	const manifest = join(dir, 'delta', 'own', 'patchset.delta.json');
	mkdirSync(dirname(manifest), { recursive: true });
	writeFileSync(
		manifest,
		`${JSON.stringify(
			{
				codkitOwnManifest: 2,
				units: [
					{
						id: 'CK-brand-901',
						layer: 'own',
						type: 'extend',
						category: 'own',
						owner: 'product',
						reason: 'fixture own unit: declares the brand guard suites',
						link: 'none',
						cause: 'none',
						pin: `${tree.pin.tag}@${tree.pin.sha}`,
						contractTests: ['fixture.unit.brand'],
						roots: ['test/']
					}
				],
				serviceOverrides: []
			},
			null,
			'\t'
		)}\n`,
		'utf8'
	);
	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureCommit(dir, 'fixture patchset: config, owners, brand guards', '2026-09-06T00:01:00Z');
	return {
		dir,
		withoutGuards: () => {
			const guardFile = join(dir, 'delta', 'own', 'test', 'brand.test.ts');
			writeFileSync(guardFile, "suite('fixture.unit.brand', () => {});\n", 'utf8');
		}
	};
}

function writeGuards(dir: string): void {
	const guardFile = join(dir, 'delta', 'own', 'test', 'brand.test.ts');
	mkdirSync(dirname(guardFile), { recursive: true });
	writeFileSync(
		guardFile,
		[
			"suite('fixture.unit.brand', () => {});",
			"suite('guard.brand.icon', () => {});",
			"suite('guard.brand.installer-big', () => {});",
			"suite('guard.brand.installer-small', () => {});",
			"suite('guard.brand.filetype', () => {});",
			"suite('guard.brand.letterpress', () => {});",
			''
		].join('\n'),
		'utf8'
	);
}

/** Bytes of a shipped fixture icon, as committed in the repository. */
export function shippedIconBytes(name: string): Buffer {
	return readFileSync(join(fixtureRoot, name));
}
