// unit: the provisioning of the bundles (PROP-008 ##BUNDLES-LOAD, PROP-006
// ##BUNDLES-STAMP, PROP-007 ##CMD-LOAD-BUNDLES, ##CMD-STATUS-BUNDLES,
// ##CMD-PACKAGE-BUNDLES) over the stub type: the tree is the fixture upstream,
// the patch set is a directory with the overlay record, the archives are made
// in the test. Nothing here runs the CLI; the e2e suite does.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { bundleStatusLine, declaredBundles, inspectBundles, provisionBundles } from '../../src/lib/bundles.ts';
import type { BundleReport, ProvisionOptions } from '../../src/lib/bundles.ts';
import type { BundleConfig } from '../../src/lib/bundlesDeclaration.ts';
import { BUNDLES_STAMP_RELATIVE_PATH, readBundleStore } from '../../src/lib/bundlesStore.ts';
import { CONFIG_FILE_NAME, parseBaseConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { serializeOverlay } from '../../src/lib/layers/overlay.ts';
import type { OverlayVarContext } from '../../src/lib/layers/overlay.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { gitDirOf } from '../../src/lib/treeCache.ts';
import { hashFile } from '../../src/lib/zipArchive.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { ADDONS_CACHE_DIR, projectType as stub, stubType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const NAME = 'acme.pack';
/** One mtime for every entry, so that two archives of the same content are the same bytes. */
const ARCHIVE_TIME = new Date('2026-01-01T00:00:00Z');
const RECORD = `delta/overlays/manifest.json.bundle-${NAME}.overlay.json`;

type Unit = { readonly name: string; readonly version: string; readonly sha256: string };

type Harness = {
	readonly tree: string;
	readonly patchesDir: string;
	readonly archives: string;
	readonly context: OverlayVarContext;
	/** An add-on archive at `<archives>/<file>`, as the layer reads it; the absolute path with forward slashes. */
	archive(file: string, unit: { readonly name: string; readonly version: string }, files?: Readonly<Record<string, string>>): string;
	/** The overlay record that appends the unit to the manifest. */
	record(unit: Unit | null): void;
	config(bundles: readonly BundleConfig[] | undefined): CodkitConfig;
	run(options: Partial<ProvisionOptions> & { readonly config: CodkitConfig }): {
		readonly reports: readonly BundleReport[];
		readonly lines: readonly string[];
	};
	cache(name?: string): string;
};

function captured(): { readonly out: Output; readonly lines: () => readonly string[] } {
	const texts: string[] = [];
	const out = new Output({
		command: 'load',
		version: 'test',
		jsonMode: false,
		streams: {
			writeOut(text: string) {
				texts.push(text);
			},
			writeErr(text: string) {
				texts.push(text);
			}
		}
	});
	return {
		out,
		lines: () =>
			texts
				.join('')
				.split('\n')
				.filter((line) => line !== '')
	};
}

function harness(label: string): Harness {
	const fixture = makeUpstream(makeTempRoot(`${label}-tree`));
	const patchesDir = makeTempRoot(`${label}-patchset`);
	const archives = makeTempRoot(`${label}-archives`);
	mkdirSync(join(patchesDir, 'delta', 'overlays'), { recursive: true });
	const context: OverlayVarContext = {
		pinTag: fixture.t1.tag,
		pinSha: fixture.t1.sha,
		pinDate: '2026-01-01',
		patchSetCommit: 'a'.repeat(40),
		buildDate: '2026-01-01'
	};
	const self: Harness = {
		tree: fixture.dir,
		patchesDir,
		archives,
		context,
		archive(file, unit, files = {}) {
			const data: Record<string, Uint8Array> = {
				'addon/addon.json': strToU8(`${JSON.stringify({ name: unit.name, version: unit.version })}\n`),
				'addon/main.js': strToU8(`module.exports = '${unit.version}';\n`),
				'README.md': strToU8('outside the root\n')
			};
			for (const [path, text] of Object.entries(files)) data[path] = strToU8(text);
			const absolute = join(archives, file);
			writeFileSync(absolute, zipSync(data, { level: 6, mtime: ARCHIVE_TIME }));
			return absolute.split('\\').join('/');
		},
		record(unit) {
			const path = join(patchesDir, ...RECORD.split('/'));
			if (unit === null) {
				rmSync(path, { force: true });
				return;
			}
			writeFileSync(
				path,
				serializeOverlay({
					codkitOverlay: 2,
					id: 'CK-product-903',
					target: 'manifest.json',
					type: 'extend',
					category: 'own',
					owner: 'product',
					reason: 'fixture: the product bundles one add-on',
					link: 'none',
					cause: 'none',
					pin: `${fixture.t1.tag}@${fixture.t1.sha}`,
					contractTests: ['CK-product-903'],
					operations: [{ op: 'append', path: ['builtInAddons'], value: { ...unit } }]
				}),
				'utf8'
			);
		},
		config(bundles) {
			const base = parseBaseConfig(
				{
					codkitConfig: 2,
					pin: { tag: fixture.t1.tag, sha: fixture.t1.sha, date: '2026-01-01' },
					upstreamAnchorCommit: '0'.repeat(40),
					type: 'stub',
					typeConfig: { ownRoot: 'source/own' },
					generatedBranchPrefix: 'codkit/applied/',
					cycleBranchPrefix: 'codkit/cycle/',
					releaseRefPrefix: 'codkit/release/',
					publishRemoteUrl: null
				},
				CONFIG_FILE_NAME
			);
			return bundles === undefined ? base : { ...base, bundles };
		},
		run(options) {
			const output = captured();
			const reports = provisionBundles({
				type: stub,
				patchesDir,
				treeDir: fixture.dir,
				context,
				out: output.out,
				mode: 'load',
				...options
			});
			return { reports, lines: output.lines() };
		},
		cache: (name = NAME) => join(fixture.dir, ...`${ADDONS_CACHE_DIR}/${name}`.split('/'))
	};
	return self;
}

function refusal(action: () => unknown): { readonly code: string; readonly message: string; readonly hint: string } {
	try {
		action();
	} catch (error) {
		if (isCkError(error)) return { code: error.code, message: error.message, hint: error.hint ?? '' };
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('the declaration joined with the composed manifest', () => {
	const h = harness('bundles-declared');

	it('names the entry of the overlay, the archive on this machine and the cache of the layer', () => {
		const file = h.archive('acme-pack.zip', { name: NAME, version: '1.0.0' });
		const sha256 = hashFile(file).sha256;
		h.record({ name: NAME, version: '1.0.0', sha256 });
		const declared = declaredBundles(stub, h.config([{ name: NAME, file }]), h.patchesDir, h.tree, h.context);
		expect(declared).toHaveLength(1);
		expect(declared[0]?.unit).toEqual({ name: NAME, version: '1.0.0', sha256 });
		expect(declared[0]?.file).toBe(join(file));
		expect(declared[0]?.cachePath).toBe(`${ADDONS_CACHE_DIR}/${NAME}`);
		expect(declaredBundles(stub, h.config(undefined), h.patchesDir, h.tree, h.context)).toEqual([]);
	});

	it('is refused under a type without the layer, and when the manifest does not carry the unit', () => {
		const file = h.archive('acme-pack.zip', { name: NAME, version: '1.0.0' });
		const without = stubType({ layers: { ...stub.layers, bundles: null } });
		expect(refusal(() => declaredBundles(without, h.config([{ name: NAME, file }]), h.patchesDir, h.tree, h.context)).code).toBe(
			'TYPE-CAPABILITY'
		);
		h.record(null);
		const refused = refusal(() => h.run({ config: h.config([{ name: NAME, file }]) }));
		expect(refused.code).toBe('CONFIG');
		expect(refused.message).toContain(`bundle ${NAME}: manifest.json composed over the pin declares no such unit in builtInAddons`);
		expect(refused.hint).toContain('codkit bundles add');
	});
});

describe('load provisions, keeps, warns and withdraws', () => {
	const h = harness('bundles-load');
	const file = h.archive('acme-pack.zip', { name: NAME, version: '1.0.0' });
	const sha256 = hashFile(file).sha256;
	h.record({ name: NAME, version: '1.0.0', sha256 });
	const config = h.config([{ name: NAME, file }]);

	it('unpacks the unit under the archive root into the cache and writes the stamp', () => {
		const { reports, lines } = h.run({ config });
		expect(reports.map((report) => report.state)).toEqual(['provisioned']);
		expect(reports[0]).toMatchObject({ name: NAME, version: '1.0.0', sha256, file: join(file), cachePath: `${ADDONS_CACHE_DIR}/${NAME}` });
		expect(
			lines.some((line) => line.startsWith(`bundle ${NAME}@1.0.0: provisioned from ${join(file)} into ${ADDONS_CACHE_DIR}/${NAME}`))
		).toBe(true);
		expect(readFileSync(join(h.cache(), 'main.js'), 'utf8')).toBe("module.exports = '1.0.0';\n");
		expect(existsSync(join(h.cache(), 'addon.json'))).toBe(true);
		expect(existsSync(join(h.cache(), 'README.md'))).toBe(false);
		expect(existsSync(`${h.cache()}.codkit-tmp`)).toBe(false);
		const stored = readBundleStore(h.tree, () => {});
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ name: NAME, version: '1.0.0', sha256, cachePath: `${ADDONS_CACHE_DIR}/${NAME}` });
		expect(existsSync(join(gitDirOf(h.tree), ...BUNDLES_STAMP_RELATIVE_PATH.split('/')))).toBe(true);
	});

	it('leaves an unchanged archive alone: nothing is hashed or unpacked twice', () => {
		writeFileSync(join(h.cache(), 'marker.txt'), 'kept\n', 'utf8');
		const { reports } = h.run({ config });
		expect(reports.map((report) => report.state)).toEqual(['unchanged']);
		expect(existsSync(join(h.cache(), 'marker.txt'))).toBe(true);
	});

	it('keeps a provisioned unit when the archive is gone, and says so', () => {
		rmSync(join(file), { force: true });
		const { reports, lines } = h.run({ config });
		expect(reports.map((report) => report.state)).toEqual(['unchanged']);
		expect(lines.some((line) => line.includes('is not there'))).toBe(true);
		expect(existsSync(join(h.cache(), 'main.js'))).toBe(true);
	});

	it('reports a missing archive as one line and no failure when nothing was provisioned', () => {
		rmSync(h.cache(), { recursive: true, force: true });
		const { reports, lines } = h.run({ config });
		expect(reports.map((report) => report.state)).toEqual(['missing']);
		expect(lines).toContain(`bundle ${NAME}@1.0.0: not provisioned (${join(file)} is not there)`);
		expect(readBundleStore(h.tree, () => {})).toEqual([]);
	});

	it('warns about an archive whose hash differs from the record, and does not unpack it', () => {
		h.archive('acme-pack.zip', { name: NAME, version: '1.1.0' });
		const { reports, lines } = h.run({ config });
		expect(reports.map((report) => report.state)).toEqual(['mismatch']);
		expect(lines.some((line) => line.includes(`codkit bundles update ${NAME}`))).toBe(true);
		expect(existsSync(h.cache())).toBe(false);
	});

	it('withdraws a bundle switched off on this machine, and reports one that was never provisioned as off', () => {
		h.archive('acme-pack.zip', { name: NAME, version: '1.0.0' });
		expect(h.run({ config }).reports.map((report) => report.state)).toEqual(['provisioned']);
		const off = h.config([{ name: NAME, file, off: true }]);
		const withdrawn = h.run({ config: off });
		expect(withdrawn.reports.map((report) => report.state)).toEqual(['withdrawn']);
		expect(withdrawn.lines).toContain(
			`bundle ${NAME}@1.0.0: switched off in codkit.local.json; withdrawn from ${ADDONS_CACHE_DIR}/${NAME}`
		);
		expect(existsSync(h.cache())).toBe(false);
		expect(readBundleStore(h.tree, () => {})).toEqual([]);
		expect(h.run({ config: off }).reports.map((report) => report.state)).toEqual(['off']);
	});

	it('withdraws a bundle declared no more, and only the directory it wrote', () => {
		expect(h.run({ config }).reports.map((report) => report.state)).toEqual(['provisioned']);
		const foreign = h.cache('vendor.tool');
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(foreign, 'package.json'), '{}\n', 'utf8');
		const { reports } = h.run({ config: h.config(undefined) });
		expect(reports.map((report) => report.state)).toEqual(['withdrawn']);
		expect(reports[0]?.name).toBe(NAME);
		expect(existsSync(h.cache())).toBe(false);
		expect(existsSync(join(foreign, 'package.json'))).toBe(true);
		expect(readBundleStore(h.tree, () => {})).toEqual([]);
	});

	it('replaces the cache when the record and the archive move to a new version', () => {
		expect(h.run({ config }).reports.map((report) => report.state)).toEqual(['provisioned']);
		const moved = h.archive('acme-pack.zip', { name: NAME, version: '2.0.0' });
		h.record({ name: NAME, version: '2.0.0', sha256: hashFile(moved).sha256 });
		const { reports } = h.run({ config });
		expect(reports.map((report) => report.state)).toEqual(['provisioned']);
		expect(readFileSync(join(h.cache(), 'main.js'), 'utf8')).toBe("module.exports = '2.0.0';\n");
		expect(readBundleStore(h.tree, () => {})[0]?.version).toBe('2.0.0');
	});

	it('treats a stamp that does not read as absent, with a warning', () => {
		writeFileSync(join(gitDirOf(h.tree), ...BUNDLES_STAMP_RELATIVE_PATH.split('/')), '{ not json', 'utf8');
		const { reports, lines } = h.run({ config });
		expect(reports.map((report) => report.state)).toEqual(['provisioned']);
		expect(lines.some((line) => line.includes('malformed'))).toBe(true);
	});
});

describe('status inspects without writing', () => {
	const h = harness('bundles-inspect');
	const file = h.archive('acme-pack.zip', { name: NAME, version: '1.0.0' });
	h.record({ name: NAME, version: '1.0.0', sha256: hashFile(file).sha256 });
	const config = h.config([{ name: NAME, file }]);

	it('says what load would do and leaves the tree and the stamp as they are', () => {
		const output = captured();
		const reports = inspectBundles({
			type: stub,
			config,
			patchesDir: h.patchesDir,
			treeDir: h.tree,
			context: h.context,
			out: output.out,
			print: false
		});
		expect(reports.map((report) => report.state)).toEqual(['provisioned']);
		expect(output.lines()).toEqual([]);
		expect(existsSync(h.cache())).toBe(false);
		expect(readBundleStore(h.tree, () => {})).toEqual([]);
		expect(bundleStatusLine(reports[0] as BundleReport, true)).toBe(
			`${NAME}@1.0.0 -> ${ADDONS_CACHE_DIR}/${NAME}: not provisioned (codkit load unpacks ${join(file)})`
		);
	});

	it('phrases every state the way status prints it', () => {
		const base: BundleReport = {
			name: NAME,
			version: '1.0.0',
			sha256: 'f'.repeat(64),
			file: '/x/acme-pack.zip',
			cachePath: 'cache/acme',
			state: 'unchanged',
			line: ''
		};
		expect(bundleStatusLine(base, true)).toBe(`${NAME}@1.0.0 -> cache/acme: provisioned (sha256 ffffffffffff)`);
		expect(bundleStatusLine({ ...base, state: 'missing' }, true)).toBe(
			`${NAME}@1.0.0 -> cache/acme: not provisioned (/x/acme-pack.zip is not there)`
		);
		expect(bundleStatusLine({ ...base, state: 'mismatch' }, true)).toBe(
			`${NAME}@1.0.0 -> cache/acme: archive differs from the record (codkit bundles update ${NAME})`
		);
		expect(bundleStatusLine({ ...base, state: 'off', file: null }, true)).toBe(
			`${NAME}@1.0.0 -> cache/acme: switched off in codkit.local.json`
		);
		expect(bundleStatusLine({ ...base, state: 'withdrawn', file: null }, true)).toContain(
			'switched off in codkit.local.json (codkit load withdraws it)'
		);
		expect(bundleStatusLine({ ...base, state: 'withdrawn', file: null }, false)).toContain('declared no more (codkit load withdraws it)');
	});
});

describe('package refuses before its first write, and takes the kit first', () => {
	const h = harness('bundles-package');
	const file = h.archive('acme-pack.zip', { name: NAME, version: '1.0.0' });
	const sha256 = hashFile(file).sha256;
	h.record({ name: NAME, version: '1.0.0', sha256 });
	const config = h.config([{ name: NAME, file }]);

	it('refuses a missing archive with the places it looked, as a network refusal under --ci', () => {
		rmSync(join(file), { force: true });
		const refused = refusal(() => h.run({ config, mode: 'package', inspect: true }));
		expect(refused.code).toBe('CONFIG');
		expect(refused.message).toContain(`bundle ${NAME}@1.0.0: no archive to provision it from (looked for ${join(file)})`);
		expect(refused.hint).toContain('--inputs <dir>');
		expect(refusal(() => h.run({ config, mode: 'package', inspect: true, offline: true })).code).toBe('NET-FORBIDDEN');
		expect(existsSync(h.cache())).toBe(false);
	});

	it('refuses an archive whose hash differs from the entry, naming both', () => {
		h.archive('acme-pack.zip', { name: NAME, version: '1.0.0' }, { 'addon/extra.js': 'changed\n' });
		const refused = refusal(() => h.run({ config, mode: 'package', inspect: true }));
		expect(refused.code).toBe('CONFIG');
		expect(refused.message).toContain('hashes to');
		expect(refused.message).toContain(`the manifest entry expects ${sha256.slice(0, 12)}`);
		expect(refused.hint).toContain(`codkit bundles update ${NAME}`);
	});

	it('takes the archive from the bundles directory of the kit before the declared path, and ignores the local switch', () => {
		const kit = makeTempRoot('bundles-kit');
		mkdirSync(join(kit, 'bundles'), { recursive: true });
		writeFileSync(join(kit, 'bundles', 'acme-pack.zip'), readFileSync(h.archive('elsewhere.zip', { name: NAME, version: '1.0.0' })));
		const off = h.config([{ name: NAME, file, off: true }]);
		const inspected = h.run({ config: off, mode: 'package', inspect: true, kitDir: kit });
		expect(inspected.reports.map((report) => report.state)).toEqual(['provisioned']);
		expect(inspected.lines.some((line) => line.includes('from the kit'))).toBe(true);
		expect(existsSync(h.cache())).toBe(false);
		const provisioned = h.run({ config: off, mode: 'package', kitDir: kit });
		expect(provisioned.reports.map((report) => report.state)).toEqual(['provisioned']);
		expect(provisioned.reports[0]?.file).toBe(join(kit, 'bundles', 'acme-pack.zip'));
		expect(readFileSync(join(h.cache(), 'main.js'), 'utf8')).toBe("module.exports = '1.0.0';\n");
		expect(h.run({ config: off, mode: 'package', kitDir: kit }).reports.map((report) => report.state)).toEqual(['unchanged']);
	});
});
