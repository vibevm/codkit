// e2e: the own-extension layer through the real CLI (FEAT-002 S54, S55).
//
// S54 is the round trip the layer exists for: `load` materializes
// `delta/own-extensions/<name>/**` into `extensions/<name>/**` of the fork tree,
// an edit made in the tree comes back into the delta with `save`, and the
// inventory carries one record of category `own-extension` for it.
//
// S55 is the pair of refusals: a directory without the `package.json` the
// upstream build looks for is CK-E-OWN-EXTENSION-MANIFEST, and a tree that
// stopped matching the delta is CK-E-OWN-EXTENSION-DRIFT with the path.

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
