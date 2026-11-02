// e2e: the bundles of a patch set through the real CLI over the stub type
// (PROP-007 ##CMD-BUNDLES-ADD, ##CMD-BUNDLES-UPDATE, ##CMD-LOAD-BUNDLES,
// ##CMD-STATUS-BUNDLES, ##CMD-PACKAGE-BUNDLES; PROP-008 ##BUNDLES-LOAD;
// PROP-006 ##BUNDLES-STAMP). The archive is an add-on of the stub layout made
// in the test; the engine reads it through the type's bundles layer and never
// learns what an add-on is.

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashFile } from '../../src/lib/zipArchive.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import { fixtureBlockHeaderLines, installLicensingProfile } from '../support/licensingFixture.ts';
import type { LicensingFixture } from '../support/licensingFixture.ts';
import type { CliFixture, Envelope, Run } from '../support/cliFixture.ts';
import { ADDON_TARGETS } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const NAME = 'acme.pack';
/** One mtime for every entry, so that two archives of the same content are the same bytes. */
const ARCHIVE_TIME = new Date('2026-01-01T00:00:00Z');
const ID = 'CK-product-910';
const RECORD = `delta/overlays/manifest.json.bundle-${NAME}.overlay.json`;
const GUARD = `delta/own/test/node/bundles/${NAME}.test.ts`;
const CACHE = `.build/addons/${NAME}`;

type Entry = Record<string, unknown>;

function text(run: Run): string {
	return `${run.stdout}\n${run.stderr}`;
}

function bundlesOf(envelope: Envelope): readonly Entry[] {
	return (envelope.data['bundles'] as Entry[] | undefined) ?? [];
}

function writeArchive(path: string, name: string, version: string, target?: string, body = version): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		zipSync(
			{
				'addon/addon.json': strToU8(`${JSON.stringify({ name, version, ...(target === undefined ? {} : { target }) })}\n`),
				'addon/main.js': strToU8(`module.exports = '${body}';\n`),
				'README.md': strToU8('outside the root\n')
			},
			{ level: 6, mtime: ARCHIVE_TIME }
		)
	);
}

function readJson(path: string): Entry {
	return JSON.parse(readFileSync(path, 'utf8')) as Entry;
}

describe('codkit bundles over the stub type', () => {
	let fixture: CliFixture;
	let archives: string;
	let archive: string;
	const declared = (): string => archive.split('\\').join('/');

	beforeAll(() => {
		fixture = makeCliFixture('bundles');
		archives = makeTempRoot('bundles-archives');
		archive = join(archives, 'acme-pack.zip');
		writeArchive(archive, NAME, '1.0.0');
		const loaded = fixture.run(['load']);
		expect(loaded.status, text(loaded)).toBe(0);
	});

	it('bundles is a namespace; add needs the archive, an id, and an archive that is there', () => {
		expect(fixture.run(['bundles']).status).toBe(2);
		expect(fixture.run(['bundles', 'add']).status).toBe(2);
		expect(fixture.run(['bundles', 'add', archive]).status).toBe(2);
		const missing = fixture.run(['bundles', 'add', join(archives, 'missing.zip'), '--id', ID, '--owner', 'product']);
		expect(missing.status).toBe(2);
		expect(missing.stderr).toContain('is not there');
		const notZip = join(archives, 'text.zip');
		writeFileSync(notZip, 'not an archive\n', 'utf8');
		expect(text(fixture.run(['bundles', 'add', notZip, '--id', ID, '--owner', 'product']))).toContain('is not a zip archive');
	}, 600000);

	it('add declares the bundle: codkit.json, the overlay record with one append, and the guard test', () => {
		const { run, envelope } = fixture.json(['bundles', 'add', archive, '--id', ID, '--owner', 'product']);
		expect(run.status, text(run)).toBe(0);
		const sha256 = hashFile(archive).sha256;
		expect(envelope.data).toMatchObject({ name: NAME, version: '1.0.0', sha256, file: declared() });
		expect(envelope.data['artifacts']).toEqual(['codkit.json', RECORD, GUARD]);
		// No licensing profile is selected here: the guard has no header, and the run says so.
		expect(envelope.data['headerWritten']).toBe(false);
		expect(run.stderr).toContain('no licence header');
		expect(run.stderr).toContain(`bundle ${NAME}@1.0.0: ${declared()} (sha256 ${sha256.slice(0, 12)})`);
		expect(run.stderr).toContain("commit them together with the archive's new content");

		expect(readJson(fixture.patchesPath('codkit.json'))['bundles']).toEqual([{ name: NAME, file: declared() }]);
		const record = readJson(fixture.patchesPath(RECORD));
		expect(record).toMatchObject({
			id: ID,
			target: 'manifest.json',
			type: 'extend',
			category: 'own',
			owner: 'product',
			contractTests: [ID]
		});
		expect(record['operations']).toEqual([{ op: 'append', path: ['builtInAddons'], value: { name: NAME, version: '1.0.0', sha256 } }]);
		const guard = readFileSync(fixture.patchesPath(GUARD), 'utf8');
		expect(guard).toContain(`describe('${ID}'`);
		expect(guard).toContain('1.0.0');

		// Declared twice is refused, and so is an id another record holds.
		expect(fixture.run(['bundles', 'add', archive, '--id', 'CK-product-911', '--owner', 'product']).status).toBe(2);
		const other = join(archives, 'other.zip');
		writeArchive(other, 'acme.other', '0.1.0');
		const duplicate = fixture.run(['bundles', 'add', other, '--id', ID, '--owner', 'product']);
		expect(duplicate.status).toBe(1);
		expect(duplicate.stderr).toContain('CK-E-MARKER-DUP-ID');
		expect(readJson(fixture.patchesPath('codkit.json'))['bundles']).toHaveLength(1);
	}, 600000);

	it('load provisions the unit into the cache, the dev channel carries the entry, and a second load keeps it', () => {
		const first = fixture.json(['load']);
		expect(first.run.status, text(first.run)).toBe(0);
		expect(bundlesOf(first.envelope)[0]).toMatchObject({ name: NAME, version: '1.0.0', state: 'provisioned', cachePath: CACHE });
		expect(readFileSync(fixture.treePath(`${CACHE}/main.js`), 'utf8')).toBe("module.exports = '1.0.0';\n");
		expect(existsSync(fixture.treePath(`${CACHE}/README.md`))).toBe(false);
		const channel = readJson(fixture.treePath('manifest.overrides.json'));
		expect(channel['builtInAddons']).toEqual([{ name: NAME, version: '1.0.0', sha256: hashFile(archive).sha256 }]);
		expect(existsSync(fixture.treePath('.git/codkit/bundles.json'))).toBe(true);

		const second = fixture.json(['load']);
		expect(second.run.status, text(second.run)).toBe(0);
		expect(bundlesOf(second.envelope)[0]?.['state']).toBe('unchanged');
		// The cache is nobody's work: status is clean and exits 0.
		expect(fixture.run(['status']).status).toBe(0);
	}, 600000);

	it('status counts the bundles and prints one line per bundle', () => {
		const status = fixture.json(['status']);
		expect(status.run.status, text(status.run)).toBe(0);
		expect(bundlesOf(status.envelope)[0]).toMatchObject({ name: NAME, state: 'unchanged', file: join(archive) });
		expect(status.run.stderr).toContain('bundles: 1 declared, 1 provisioned, 0 not provisioned');
		expect(status.run.stderr).toContain(`${NAME}@1.0.0 -> ${CACHE}: provisioned (sha256 `);
	}, 600000);

	it('codkit.local.json switches the bundle off on this machine: load withdraws it, then reports it off', () => {
		writeFileSync(fixture.patchesPath('codkit.local.json'), `${JSON.stringify({ bundles: [{ name: NAME, file: null }] })}\n`, 'utf8');
		const withdrawn = fixture.json(['load']);
		expect(withdrawn.run.status, text(withdrawn.run)).toBe(0);
		expect(bundlesOf(withdrawn.envelope)[0]?.['state']).toBe('withdrawn');
		expect(existsSync(fixture.treePath(CACHE))).toBe(false);
		expect(bundlesOf(fixture.json(['load']).envelope)[0]?.['state']).toBe('off');
		const status = fixture.json(['status']);
		expect(status.run.stderr).toContain('bundles: 1 declared, 0 provisioned, 1 not provisioned');
		expect(status.run.stderr).toContain('switched off in codkit.local.json');
		unlinkSync(fixture.patchesPath('codkit.local.json'));
		expect(bundlesOf(fixture.json(['load']).envelope)[0]?.['state']).toBe('provisioned');
	}, 600000);

	it('update rewrites the record and the guard from a changed archive, after load warned about it', () => {
		writeArchive(archive, NAME, '1.1.0');
		const warned = fixture.json(['load']);
		expect(warned.run.status, text(warned.run)).toBe(0);
		expect(bundlesOf(warned.envelope)[0]?.['state']).toBe('mismatch');
		expect(warned.run.stderr).toContain(`codkit bundles update ${NAME}`);
		expect(readFileSync(fixture.treePath(`${CACHE}/main.js`), 'utf8')).toBe("module.exports = '1.0.0';\n");

		expect(fixture.run(['bundles', 'update']).status).toBe(2);
		expect(fixture.run(['bundles', 'update', 'nope']).status).toBe(2);
		expect(fixture.run(['bundles', 'update', NAME, '--all']).status).toBe(2);

		const updated = fixture.json(['bundles', 'update', NAME]);
		expect(updated.run.status, text(updated.run)).toBe(0);
		const sha256 = hashFile(archive).sha256;
		expect(updated.run.stderr).toContain(`bundle ${NAME}: 1.0.0 (`);
		expect(updated.run.stderr).toContain(`) -> 1.1.0 (${sha256.slice(0, 12)})`);
		const record = readJson(fixture.patchesPath(RECORD));
		expect((record['operations'] as Entry[])[0]?.['value']).toEqual({ name: NAME, version: '1.1.0', sha256 });
		expect(record['id']).toBe(ID);
		expect(readFileSync(fixture.patchesPath(GUARD), 'utf8')).toContain('1.1.0');

		const current = fixture.json(['bundles', 'update', '--all']);
		expect(current.run.status, text(current.run)).toBe(0);
		expect(current.run.stderr).toContain(`bundle ${NAME}: already current`);
		const reloaded = fixture.json(['load']);
		expect(bundlesOf(reloaded.envelope)[0]?.['state']).toBe('provisioned');
		expect(readFileSync(fixture.treePath(`${CACHE}/main.js`), 'utf8')).toBe("module.exports = '1.1.0';\n");
	}, 600000);

	it('package provisions after the overlay and before the stamps, refuses without an archive, and takes the kit first', () => {
		const packaged = fixture.json(['package']);
		expect(packaged.run.status, text(packaged.run)).toBe(0);
		const steps = (packaged.envelope.data['steps'] as { name: string }[]).map((step) => step.name);
		expect(steps.slice(0, 4)).toEqual(['drift guard', 'overlay apply', 'bundles', 'stamps']);
		expect(bundlesOf(packaged.envelope)[0]?.['state']).toBe('unchanged');

		unlinkSync(archive);
		rmSync(fixture.treePath(CACHE), { recursive: true, force: true });
		const refused = fixture.run(['package']);
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain('CK-E-CONFIG');
		expect(refused.stderr).toContain(`bundle ${NAME}@1.1.0: no archive to provision it from`);
		const offline = fixture.run(['--ci', 'package']);
		expect(offline.status).toBe(2);
		expect(offline.stderr).toContain('CK-E-NET-FORBIDDEN');
		// Nothing was written: the tree is the dev tree it was.
		expect(existsSync(fixture.treePath('manifest.overrides.json'))).toBe(true);
		expect(fixture.run(['status']).status).toBe(0);

		const kit = makeTempRoot('bundles-kit');
		writeArchive(join(kit, 'bundles', 'acme-pack.zip'), NAME, '1.1.0');
		const fromKit = fixture.json(['package', '--inputs', kit]);
		expect(fromKit.run.status, text(fromKit.run)).toBe(0);
		expect(bundlesOf(fromKit.envelope)[0]?.['state']).toBe('provisioned');
		expect(fromKit.run.stderr).toContain('from the kit');
		expect(readFileSync(fixture.treePath(`${CACHE}/main.js`), 'utf8')).toBe("module.exports = '1.1.0';\n");
	}, 900000);
});

describe('the guard of a bundle record under a licensing profile', () => {
	let fixture: CliFixture;
	let lic: LicensingFixture;
	let archive: string;

	beforeAll(() => {
		fixture = makeCliFixture('bundles-header');
		lic = installLicensingProfile('bundles-header', fixture.patchesDir);
		archive = join(makeTempRoot('bundles-header-archives'), 'acme-pack.zip');
		writeArchive(archive, NAME, '1.0.0');
	});

	it('carries the header of the profile, and keeps it when update rewrites the guard', () => {
		const added = fixture.json(['bundles', 'add', archive, '--id', ID, '--owner', 'product'], lic.env);
		expect(added.run.status, text(added.run)).toBe(0);
		expect(added.envelope.data['headerWritten']).toBe(true);
		const header = fixtureBlockHeaderLines().join('\n');
		expect(readFileSync(fixture.patchesPath(GUARD), 'utf8').startsWith(`${header}\n\n// generated by codkit bundles add`)).toBe(true);

		writeArchive(archive, NAME, '1.1.0');
		const updated = fixture.json(['bundles', 'update', '--all'], lic.env);
		expect(updated.run.status, text(updated.run)).toBe(0);
		const guard = readFileSync(fixture.patchesPath(GUARD), 'utf8');
		expect(guard.startsWith(`${header}\n\n// generated by codkit bundles add`)).toBe(true);
		expect(guard).toContain('1.1.0');
		expect(updated.run.stderr).not.toContain('no licence header');
	}, 600000);
});

describe('a bundle built per target', () => {
	const TARGET_ID = 'CK-product-912';
	const host = `${process.platform}-${process.arch}`;
	let fixture: CliFixture;
	let archives: string;
	const archiveOf = (target: string): string => join(archives, `pack-${target}.zip`);

	beforeAll(() => {
		fixture = makeCliFixture('bundles-targets');
		archives = makeTempRoot('bundles-targets-archives');
		for (const target of ADDON_TARGETS) writeArchive(archiveOf(target), NAME, '1.0.0', target, target);
		const loaded = fixture.run(['load']);
		expect(loaded.status, text(loaded)).toBe(0);
	});

	it('add takes one archive per target, and the record carries the hash of each', () => {
		const added = fixture.json(['bundles', 'add', ...ADDON_TARGETS.map(archiveOf), '--id', TARGET_ID, '--owner', 'product']);
		expect(added.run.status, text(added.run)).toBe(0);
		const files = Object.fromEntries(ADDON_TARGETS.map((target) => [target, archiveOf(target).split('\\').join('/')]));
		expect(readJson(fixture.patchesPath('codkit.json'))['bundles']).toEqual([{ name: NAME, files }]);
		const targets = Object.fromEntries(ADDON_TARGETS.map((target) => [target, hashFile(archiveOf(target)).sha256]));
		expect(added.envelope.data['targets']).toEqual(targets);
		const record = readJson(fixture.patchesPath(RECORD));
		expect(record['operations']).toEqual([{ op: 'append', path: ['builtInAddons'], value: { name: NAME, version: '1.0.0', targets } }]);
		for (const target of ADDON_TARGETS) expect(added.run.stderr).toContain(`bundle ${NAME}@1.0.0 for ${target}: `);
		// One archive of the targets twice, or one without a target among them, is refused.
		const twice = fixture.run([
			'bundles',
			'add',
			archiveOf('win32-x64'),
			archiveOf('win32-x64'),
			'--id',
			'CK-product-913',
			'--owner',
			'product'
		]);
		expect(twice.status).toBe(2);
	}, 600000);

	it.runIf(ADDON_TARGETS.includes(host))(
		'load provisions the archive of the host target',
		() => {
			const loaded = fixture.json(['load']);
			expect(loaded.run.status, text(loaded.run)).toBe(0);
			expect(bundlesOf(loaded.envelope)[0]).toMatchObject({ name: NAME, target: host, state: 'provisioned' });
			expect(readFileSync(fixture.treePath(`${CACHE}/main.js`), 'utf8')).toBe(`module.exports = '${host}';\n`);
			const status = fixture.json(['status']);
			expect(status.run.stderr).toContain(`${NAME}@1.0.0 for ${host} -> ${CACHE}: provisioned (sha256 `);
		},
		600000
	);

	it('update rewrites the hash of the target whose archive changed and keeps the others', () => {
		const before = (readJson(fixture.patchesPath(RECORD))['operations'] as Entry[])[0]?.['value'] as Entry;
		writeArchive(archiveOf('linux-x64'), NAME, '1.0.0', 'linux-x64', 'linux-x64 rebuilt');
		const updated = fixture.json(['bundles', 'update', NAME]);
		expect(updated.run.status, text(updated.run)).toBe(0);
		const after = (readJson(fixture.patchesPath(RECORD))['operations'] as Entry[])[0]?.['value'] as Entry;
		const was = before['targets'] as Record<string, string>;
		const now = after['targets'] as Record<string, string>;
		expect(now['linux-x64']).toBe(hashFile(archiveOf('linux-x64')).sha256);
		expect(now['linux-x64']).not.toBe(was['linux-x64']);
		expect(now['win32-x64']).toBe(was['win32-x64']);
		expect(updated.run.stderr).toContain('linux-x64');
		// An archive declared for one target and built for another is refused.
		const config = readJson(fixture.patchesPath('codkit.json'));
		const bundles = config['bundles'] as { name: string; files: Record<string, string> }[];
		const crossed = {
			...config,
			bundles: [{ name: NAME, files: { ...bundles[0]?.files, 'linux-x64': archiveOf('win32-x64').split('\\').join('/') } }]
		};
		writeFileSync(fixture.patchesPath('codkit.json'), `${JSON.stringify(crossed, null, 2)}\n`, 'utf8');
		const refused = fixture.run(['bundles', 'update', NAME]);
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain('is declared as the archive of linux-x64');
	}, 600000);
});
