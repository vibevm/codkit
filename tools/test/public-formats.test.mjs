import { deepStrictEqual, equal, match } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CATALOG, ROOT, checkCatalog, discoverFormats } from '../check-public-formats.mjs';

const catalog = JSON.parse(readFileSync(join(ROOT, CATALOG), 'utf8'));
const discovered = discoverFormats();

test('current public schemas have policies and source/test evidence', () => {
	deepStrictEqual(checkCatalog(catalog, discovered), []);
	equal(
		discovered.some((row) => row.field === 'codkitSupplyKit'),
		true
	);
	equal(
		discovered.some((row) => row.field === 'codkitTreeMark'),
		true
	);
});

test('removing a format policy makes the gate red', () => {
	const candidate = structuredClone(catalog);
	candidate.formats = candidate.formats.filter((row) => row.field !== 'codkitOverlay');
	match(checkCatalog(candidate, discovered).join('\n'), /codkitOverlay: public format has no version\/migration policy/);
});

test('an unregistered schema refuses even when it has no numeric version', () => {
	match(
		checkCatalog(catalog, [...discovered, { field: 'codkitForeign', versions: [], sources: ['packages/codkit/src/lib/foreign.ts'] }]).join(
			'\n'
		),
		/codkitForeign: public format has no/
	);
});

test('version drift and a newly admitted legacy version both make the gate red', () => {
	for (const versions of [[3], [1, 2]]) {
		const candidate = discovered.map((row) => (row.field === 'codkitOverlay' ? { ...row, versions } : row));
		match(checkCatalog(catalog, candidate).join('\n'), /overlay: observed versions/);
	}
});

test('a public seam cannot silently become unversioned', () => {
	const candidate = structuredClone(catalog);
	const row = candidate.formats.find((entry) => entry.id === 'text-patch');
	row.version = null;
	match(checkCatalog(candidate, discovered).join('\n'), /text-patch: unversioned format needs an explicit versionGap/);
});

test('empty migration and missing test evidence refuse', () => {
	const candidate = structuredClone(catalog);
	candidate.formats[0].migration = ' ';
	candidate.formats[0].tests = ['tools/test/missing.mjs'];
	const errors = checkCatalog(candidate, discovered).join('\n');
	match(errors, /missing migration/);
	match(errors, /missing or unsafe conformance test/);
});

test('duplicate ids and fields refuse', () => {
	const candidate = structuredClone(catalog);
	candidate.formats.push(candidate.formats.find((row) => row.field === 'codkitOverlay'));
	const errors = checkCatalog(candidate, discovered).join('\n');
	match(errors, /duplicate format id/);
	match(errors, /duplicate version field/);
});

test('contract references and file evidence must resolve', () => {
	const candidate = structuredClone(catalog);
	candidate.formats[0].contract = 'spec://codkit/modules/codkit/PROP-999#root';
	candidate.formats[0].source = 'tools';
	const errors = checkCatalog(candidate, discovered).join('\n');
	match(errors, /contract does not resolve/);
	match(errors, /missing or unsafe source/);
});

test('source constants for non-JSON formats are also frozen', () => {
	const candidate = structuredClone(catalog);
	candidate.formats.find((row) => row.id === 'text-patch').version = 3;
	match(checkCatalog(candidate, discovered).join('\n'), /PATCH_SCHEMA_VERSION is 2, catalog says 3/);
});

test('discovery scans declarations and writers across packages without running them', () => {
	const root = mkdtempSync(join(tmpdir(), 'codkit-format-probe-'));
	try {
		mkdirSync(join(root, 'packages', 'external-type', 'src'), { recursive: true });
		mkdirSync(join(root, 'tools'));
		writeFileSync(
			join(root, 'packages', 'external-type', 'src', 'schema.ts'),
			[
				'throw new Error("must never execute");',
				'const PROBE_VERSION = 7;',
				'const schema = { "codkitProbe": z.literal(PROBE_VERSION) };',
				'type Old = { readonly codkitProbe: 6 };',
				'const missing = { codkitNoVersion: z.number() };',
				'// codkitComment: 900',
				'const text = "codkitString: 901";',
				'const regex = /^# codkitRegex: 902/;',
				'const template = `# codkitTemplate: 903 ${`nested ${1}`} tail`;',
				'const following = { codkitAfterTemplate: 8 };'
			].join('\n')
		);
		writeFileSync(join(root, 'tools', 'writer.mjs'), 'const manifest = { codkitKitProbe: 4 };');
		deepStrictEqual(
			discoverFormats(root).map(({ field, versions }) => ({ field, versions })),
			[
				{ field: 'codkitAfterTemplate', versions: [8] },
				{ field: 'codkitKitProbe', versions: [4] },
				{ field: 'codkitNoVersion', versions: [] },
				{ field: 'codkitProbe', versions: [6, 7] }
			]
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
