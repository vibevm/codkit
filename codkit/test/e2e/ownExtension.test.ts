// e2e: the own-extension layer through the real CLI (FEAT-002 S54, S55, S62).
//
// S54 is the round trip the layer exists for: `load` materializes
// `delta/own-extensions/<name>/**` into `extensions/<name>/**` of the fork tree,
// an edit made in the tree comes back into the delta with `save`, and the
// inventory carries one record of category `own-extension` for it.
//
// S55 is the pair of refusals: a directory without the `package.json` the
// upstream build looks for is CK-E-OWN-EXTENSION-MANIFEST, and a tree that
// stopped matching the delta is CK-E-OWN-EXTENSION-DRIFT with the path.
//
// S62 is the state after the record goes away: the directory stays in the tree
// until `load --fresh` sweeps it, and `status` says so instead of leaving it to
// be discovered (modules/vscode/PROP-002 ##OWN-EXTENSION-STRANDED).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const EXTENSION_ID = 'CK-product-905';
const EXTENSION_NAME = 'acme-pack';

const PACKAGE_JSON = `{
	"name": "acme-pack",
	"version": "0.0.1",
	"contributes": {}
}
`;
const NLS_JSON = `{
	"acme.hello": "hello"
}
`;
const NLS_EDITED = `{
	"acme.hello": "hello, world"
}
`;

type Finding = { code: string; file: string | null; message: string; hint: string };
type VerifyData = { findings: Finding[]; counts: Record<string, number> };
type InventoryEntry = { id: string; layer: string; category: string; owner: string; files: string[] };
type InventoryData = { inventory: { entries: InventoryEntry[] } };

let fixture: CliFixture;

beforeAll(() => {
	fixture = makeCliFixture('own-extension');
	writeDelta(`${EXTENSION_NAME}/package.json`, PACKAGE_JSON);
	writeDelta(`${EXTENSION_NAME}/package.nls.json`, NLS_JSON);
	declareExtension();
	commitPatchSet('fixture patchset: one own extension');
	expect(fixture.run(['load']).status).toBe(0);
});

afterAll(cleanupTempRoots);

function writeDelta(relative: string, text: string): void {
	const absolute = fixture.patchesPath(`delta/own-extensions/${relative}`);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, text, 'utf8');
}

function deltaPath(relative: string): string {
	return fixture.patchesPath(`delta/own-extensions/${relative}`);
}

/** Put the `extensions` section into the fixture's own manifest. */
function declareExtension(): void {
	const path = fixture.patchesPath('delta/own/patchset.delta.json');
	const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	manifest['extensions'] = [
		{
			id: EXTENSION_ID,
			name: EXTENSION_NAME,
			owner: 'product',
			reason: 'fixture own extension: the language pack of the own strings',
			pin: `${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
			contractTests: []
		}
	];
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function commitPatchSet(subject: string): void {
	fixtureCommit(fixture.patchesDir, subject, '2026-01-02T00:02:00Z');
}

function verify(): { status: number; data: VerifyData } {
	const outcome = fixture.json(['verify']);
	return { status: outcome.run.status, data: outcome.envelope.data as unknown as VerifyData };
}

function findingsOf(code: string): Finding[] {
	return verify().data.findings.filter((entry) => entry.code === `CK-E-${code}`);
}

describe('S54 - load materializes an own extension, save brings the edit back', () => {
	it('writes the whole extension directory into the fork tree', () => {
		expect(readFileSync(fixture.treePath(`extensions/${EXTENSION_NAME}/package.json`), 'utf8')).toBe(PACKAGE_JSON);
		expect(readFileSync(fixture.treePath(`extensions/${EXTENSION_NAME}/package.nls.json`), 'utf8')).toBe(NLS_JSON);
	});

	it('leaves a delta and a tree that verify agrees on', () => {
		expect(verify().status).toBe(0);
	});

	it('stays quiet on a second load: nothing in the tree is unextracted work', () => {
		const outcome = fixture.run(['load']);

		expect(outcome.status).toBe(0);
		expect(outcome.stderr).not.toContain('CK-E-DIRTY-TREE');
		expect(outcome.stdout).toContain('own extensions: 2 file(s), 0 copied, 0 removed');
	});

	it('is own code to status: the materialized directory is neither upstream dirt nor unextracted work', () => {
		const outcome = fixture.json(['status']);
		const data = outcome.envelope.data as { upstream: { changed: number; files: { path: string }[] }; ownExtensions?: unknown };

		expect(outcome.run.status).toBe(0);
		expect(data.upstream.changed).toBe(0);
		expect(data.upstream.files.some((file) => file.path.startsWith('extensions/'))).toBe(false);
		expect(outcome.run.stdout).toContain('own extensions: 1 declared, 0 path(s) differ');
		expect(outcome.run.stdout).not.toContain('run codkit save');
	});

	it('carries an inventory record of category own-extension in the own layer', () => {
		const outcome = fixture.json(['inventory']);
		const entries = (outcome.envelope.data as unknown as InventoryData).inventory.entries;
		const entry = entries.find((candidate) => candidate.id === EXTENSION_ID);

		expect(outcome.run.status).toBe(0);
		expect(entry?.layer).toBe('own');
		expect(entry?.category).toBe('own-extension');
		expect(entry?.owner).toBe('product');
		expect(entry?.files).toEqual([`${EXTENSION_NAME}/package.json`, `${EXTENSION_NAME}/package.nls.json`]);
	});

	it('brings an edit made in the tree back into the delta', () => {
		writeFileSync(fixture.treePath(`extensions/${EXTENSION_NAME}/package.nls.json`), NLS_EDITED, 'utf8');

		const outcome = fixture.run(['save']);

		expect(outcome.status).toBe(0);
		expect(readFileSync(deltaPath(`${EXTENSION_NAME}/package.nls.json`), 'utf8')).toBe(NLS_EDITED);
		expect(verify().status).toBe(0);
	});

	it('does not offer the materialized extension as a new file in the upstream zone', () => {
		const outcome = fixture.run(['save']);

		expect(outcome.status).toBe(0);
		expect(outcome.stderr).not.toContain('CK-E-NEW-FILE-IN-UPSTREAM-ZONE');
	});
});

describe('S55 - verify is red on a broken manifest and on drift', () => {
	it('reports CK-E-OWN-EXTENSION-MANIFEST when the package.json is missing', () => {
		const path = deltaPath(`${EXTENSION_NAME}/package.json`);
		const saved = readFileSync(path, 'utf8');
		try {
			rmSync(path);
			const findings = findingsOf('OWN-EXTENSION-MANIFEST');

			expect(findings).toHaveLength(1);
			expect(findings[0]?.message).toContain(`delta/own-extensions/${EXTENSION_NAME}/package.json is missing`);
			expect(verify().status).toBe(1);
		} finally {
			writeFileSync(path, saved, 'utf8');
		}
	});

	it('reports CK-E-OWN-EXTENSION-MANIFEST for a directory no record declares', () => {
		const path = deltaPath('orphan-pack/package.json');
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, PACKAGE_JSON, 'utf8');
			const findings = findingsOf('OWN-EXTENSION-MANIFEST');

			expect(findings).toHaveLength(1);
			expect(findings[0]?.message).toContain('delta/own-extensions/orphan-pack/ is declared by no record');
		} finally {
			rmSync(dirname(path), { recursive: true, force: true });
		}
	});

	it('reports CK-E-OWN-EXTENSION-DRIFT with the path when the tree differs', () => {
		const path = fixture.treePath(`extensions/${EXTENSION_NAME}/package.nls.json`);
		const saved = readFileSync(path, 'utf8');
		try {
			writeFileSync(path, '{\n\t"acme.hello": "a hand edit nobody extracted"\n}\n', 'utf8');
			const findings = findingsOf('OWN-EXTENSION-DRIFT');

			expect(findings).toHaveLength(1);
			expect(findings[0]?.message).toContain(`extensions/${EXTENSION_NAME}/package.nls.json differs from`);
			expect(findings[0]?.file).toBe(`delta/own-extensions/${EXTENSION_NAME}/package.nls.json`);
		} finally {
			writeFileSync(path, saved, 'utf8');
		}
	});

	it('reports CK-E-OWN-EXTENSION-DRIFT for a file only the tree carries', () => {
		const path = fixture.treePath(`extensions/${EXTENSION_NAME}/themes/dark.json`);
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, '{}\n', 'utf8');
			const findings = findingsOf('OWN-EXTENSION-DRIFT');

			expect(findings).toHaveLength(1);
			expect(findings[0]?.message).toContain(`extensions/${EXTENSION_NAME}/themes/dark.json is not in`);
		} finally {
			rmSync(dirname(path), { recursive: true, force: true });
		}
	});

	it('is green again once the tree matches the delta', () => {
		expect(existsSync(join(fixture.treeDir, 'extensions', EXTENSION_NAME))).toBe(true);
		expect(verify().status).toBe(0);
	});
});

describe('S55 - a name the pin already ships is refused in the words the spec fixes', () => {
	it('reports CK-E-OWN-EXTENSION-MANIFEST naming the upstream collision', () => {
		// A pin that ships `extensions/acme-pack` of its own: the fork tree gets
		// one commit adding it, and the delta is pinned to that commit. This is
		// the only case the layer cannot answer from patchset alone.
		const colliding = makeCliFixture('own-extension-collision');
		const upstreamExtension = join(colliding.treeDir, 'extensions', EXTENSION_NAME, 'package.json');
		mkdirSync(dirname(upstreamExtension), { recursive: true });
		writeFileSync(upstreamExtension, '{\n\t"name": "acme-pack"\n}\n', 'utf8');
		const pinSha = fixtureCommit(colliding.treeDir, 'upstream ships a built-in extension of this name', '2026-01-02T00:03:00Z');
		const configPath = colliding.patchesPath('codkit.json');
		writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(colliding.upstream.t1.sha, pinSha), 'utf8');

		const deltaFile = colliding.patchesPath(`delta/own-extensions/${EXTENSION_NAME}/package.json`);
		mkdirSync(dirname(deltaFile), { recursive: true });
		writeFileSync(deltaFile, PACKAGE_JSON, 'utf8');
		const manifestPath = colliding.patchesPath('delta/own/patchset.delta.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
		manifest['extensions'] = [
			{
				id: EXTENSION_ID,
				name: EXTENSION_NAME,
				owner: 'product',
				reason: 'fixture own extension over a name upstream already uses',
				pin: `${colliding.upstream.t1.tag}@${pinSha}`,
				contractTests: []
			}
		];
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
		fixtureCommit(colliding.patchesDir, 'fixture patchset: an own extension that collides', '2026-01-02T00:04:00Z');

		const outcome = colliding.json(['verify']);
		const findings = (outcome.envelope.data as unknown as VerifyData).findings.filter(
			(entry) => entry.code === 'CK-E-OWN-EXTENSION-MANIFEST'
		);

		expect(outcome.run.status).toBe(1);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain('name collides with an upstream extension');
	});
});

describe('S62 - a stranded own extension: load passes over it, status names it', () => {
	const STRANDED_NAME = 'sample';
	let stray: CliFixture;

	beforeAll(() => {
		// A fixture of its own: the one above is edited by S54 and S55, and this
		// scenario needs a delta whose extension record is taken away again.
		stray = makeStrandedFixture('own-extension-stranded');
	});

	/**
	 * A patch set that declared one own extension, loaded it into the tree and
	 * then withdrew the record: `extensions/<name>/` stands in the tree,
	 * untracked, and nothing in the delta claims it any more.
	 */
	function makeStrandedFixture(label: string): CliFixture {
		const fixture = makeCliFixture(label);
		writeExtensionDelta(fixture, `${STRANDED_NAME}/package.json`, PACKAGE_JSON);
		declareExtensions(fixture, [
			{
				id: EXTENSION_ID,
				name: STRANDED_NAME,
				owner: 'product',
				reason: 'fixture own extension whose record is taken away again',
				pin: `${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
				contractTests: []
			}
		]);
		fixtureCommit(fixture.patchesDir, 'fixture patchset: one own extension', '2026-01-02T00:05:00Z');
		expect(fixture.run(['load']).status).toBe(0);
		expect(existsSync(fixture.treePath(`extensions/${STRANDED_NAME}/package.json`))).toBe(true);

		declareExtensions(fixture, []);
		rmSync(fixture.patchesPath(`delta/own-extensions/${STRANDED_NAME}`), { recursive: true, force: true });
		fixtureCommit(fixture.patchesDir, 'fixture patchset: the extension record is withdrawn', '2026-01-02T00:06:00Z');
		return fixture;
	}

	function writeExtensionDelta(fixture: CliFixture, relative: string, text: string): void {
		const absolute = fixture.patchesPath(`delta/own-extensions/${relative}`);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, text, 'utf8');
	}

	function declareExtensions(fixture: CliFixture, records: readonly Record<string, unknown>[]): void {
		const path = fixture.patchesPath('delta/own/patchset.delta.json');
		const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		manifest['extensions'] = records;
		writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
	}

	function strandedOf(fixture: CliFixture): { status: number; stdout: string; stranded: string[] } {
		const outcome = fixture.json(['status']);
		const data = outcome.envelope.data['ownExtensions'] as { stranded: string[] };
		return { status: outcome.run.status, stdout: outcome.run.stdout, stranded: data.stranded };
	}

	it('lets a plain load through and does not touch the directory', () => {
		const outcome = stray.run(['load']);

		expect(outcome.status, outcome.stderr).toBe(0);
		expect(outcome.stderr).not.toContain('CK-E-DIRTY-TREE');
		expect(readFileSync(stray.treePath(`extensions/${STRANDED_NAME}/package.json`), 'utf8')).toBe(PACKAGE_JSON);
	});

	it('counts it, names it with the recipe that removes it, and exits 1', () => {
		const outcome = stray.run(['status']);

		expect(outcome.status).toBe(1);
		expect(outcome.stdout).toContain(
			'own extensions: 0 declared, 0 path(s) differ between tree and patchset, 1 stranded materialization(s)'
		);
		expect(outcome.stdout).toContain(`  extensions/${STRANDED_NAME}/ - codkit load --fresh removes it`);
		expect(strandedOf(stray).stranded).toEqual([`extensions/${STRANDED_NAME}/`]);
	});

	it('names an untracked directory without a package.json too, in the order git reports', () => {
		const note = stray.treePath('extensions/local-experiment/note.txt');
		try {
			mkdirSync(dirname(note), { recursive: true });
			writeFileSync(note, 'a local experiment nobody declared\n', 'utf8');

			expect(strandedOf(stray).stranded).toEqual(['extensions/local-experiment/', `extensions/${STRANDED_NAME}/`]);
		} finally {
			rmSync(dirname(note), { recursive: true, force: true });
		}
	});

	it('is still unextracted work for a guarded command that gets no exception', () => {
		// The exception belongs to a plain `load` alone. `cycle` is the witness
		// here because it reaches the tree with the untracked rule armed; `ci`
		// and `publish` get there through a fresh apply, where no untracked path
		// is dirt for any command, so neither could show the difference.
		const guarded = makeStrandedFixture('own-extension-stranded-guarded');
		// A real patch set excludes codkit runtime state; the fixture has no
		// tracked .gitignore, and `cycle start` refuses over a dirty patch set
		// before it ever looks at the tree.
		writeFileSync(guarded.patchesPath('.git/info/exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');

		const outcome = guarded.json(['cycle', 'start', guarded.upstream.t2.tag]);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-DIRTY-TREE');
		expect(outcome.envelope.errors[0]?.message).toContain(`extensions/${STRANDED_NAME}`);
	}, 60_000);

	it('is still a new file in the upstream zone for the two-way sync', () => {
		const guarded = makeStrandedFixture('own-extension-stranded-sync');

		const outcome = guarded.json(['sync']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-NEW-FILE-IN-UPSTREAM-ZONE']);
		expect(outcome.envelope.errors[0]?.file).toContain('extensions/');
		expect(existsSync(guarded.treePath(`extensions/${STRANDED_NAME}/package.json`))).toBe(true);
	});

	it('is gone after load --fresh, and status is quiet and green again', () => {
		expect(stray.run(['load', '--fresh']).status).toBe(0);
		const outcome = strandedOf(stray);

		expect(existsSync(stray.treePath(`extensions/${STRANDED_NAME}`))).toBe(false);
		expect(outcome.stranded).toEqual([]);
		expect(outcome.stdout).toContain(
			'own extensions: 0 declared, 0 path(s) differ between tree and patchset, 0 stranded materialization(s)'
		);
		expect(outcome.status).toBe(0);
	});

	it('never calls an extension of the pin stranded, whatever is untracked inside it', () => {
		// A pin that ships `extensions/<name>` of its own, as in the collision
		// case above: an untracked file inside it is litter, never a stranded
		// materialization, because the rule asks the pin and not the tree.
		const shipped = makeCliFixture('own-extension-stranded-upstream');
		const upstreamExtension = shipped.treePath('extensions/builtin-thing/package.json');
		mkdirSync(dirname(upstreamExtension), { recursive: true });
		writeFileSync(upstreamExtension, '{\n\t"name": "builtin-thing"\n}\n', 'utf8');
		const pinSha = fixtureCommit(shipped.treeDir, 'upstream ships a built-in extension', '2026-01-02T00:07:00Z');
		const configPath = shipped.patchesPath('codkit.json');
		writeFileSync(configPath, readFileSync(configPath, 'utf8').replace(shipped.upstream.t1.sha, pinSha), 'utf8');
		writeFileSync(shipped.treePath('extensions/builtin-thing/scratch.json'), '{}\n', 'utf8');

		const outcome = shipped.json(['status']);
		const data = outcome.envelope.data as { upstream: { files: { path: string }[] }; ownExtensions: { stranded: string[] } };

		// The untracked file does reach the report, so the empty verdict is the
		// pin's answer and not an entry nobody ever classified.
		expect(data.upstream.files.some((file) => file.path === 'extensions/builtin-thing/scratch.json')).toBe(true);
		expect(data.ownExtensions.stranded).toEqual([]);
	});
});
