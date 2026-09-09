// The drift guard (PROP-008 ##DRIFT-GUARD-PREDICATE).
//
// The first two halves are tested separately, because they see different
// things: git sees the upstream files, and only a byte comparison sees own
// code, which is excluded from git locally. The third half - tree commits -
// has its own suite in treeCommits.test.ts; here it only has to stay silent
// over a tree whose line carries generated commits alone.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driftDirty, porcelainEntries, upstreamDirt } from '../../src/lib/driftGuard.ts';
import type { DriftOptions } from '../../src/lib/driftGuard.ts';
import { strandedExtensionClassifier, materializerOf } from '../../src/lib/layers/ownExtensions.ts';
import { loadOwnManifest } from '../../src/lib/layers/ownManifest.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

const OWN_IN_TREE = 'src/vs/patchset/hello.ts';
const OWN_IN_PATCHSET = 'delta/own/hello.ts';

let fixture: SyncFixture;

beforeAll(() => {
	fixture = makeSyncFixture('drift');
	expect(fixture.sync().exitCode).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

/** The third half's walk context: the fixture pin and its generated branch. */
function generated(): DriftOptions['generated'] {
	return { pinSha: fixture.config.pin.sha, branch: `${fixture.config.generatedBranchPrefix}${fixture.config.pin.tag}` };
}

function guard(): ReturnType<typeof driftDirty> {
	return driftDirty(materializerOf(vscodeType), fixture.treeDir, fixture.config.typeConfig.ownRoot, fixture.patchesDir, {
		generated: generated()
	});
}

/** Change something in the tree, look, put it back. */
function whileChanged<T>(relative: string, content: string, look: () => T): T {
	const absolute = join(fixture.treeDir, relative);
	let saved: Buffer | null = null;
	try {
		saved = readFileSync(absolute);
	} catch {
		saved = null;
	}
	writeFileSync(absolute, content, 'utf8');
	try {
		return look();
	} finally {
		if (saved === null) {
			rmSync(absolute, { force: true });
		} else {
			writeFileSync(absolute, saved);
		}
	}
}

describe('driftDirty', () => {
	it('is clean right after a load', () => {
		const result = guard();
		expect(result.dirty).toBe(false);
		expect(result.files).toEqual([]);
		// Own code exists on both sides and matches byte for byte.
		expect(result.own).toEqual([]);
	});

	it('reports an edit of an upstream file', () => {
		const result = whileChanged(EXAMPLE_PART_PATH, '// replaced by hand\n', guard);
		expect(result.dirty).toBe(true);
		expect(result.files).toContain(EXAMPLE_PART_PATH);
		expect(result.upstream).toContain(EXAMPLE_PART_PATH);
	});

	it('reports an edit of own code that git cannot see', () => {
		const result = whileChanged(OWN_IN_TREE, '// edited in the tree\n', guard);

		expect(result.dirty).toBe(true);
		// git says nothing about it: the own directory is excluded locally.
		expect(result.upstream).toEqual([]);
		expect(upstreamDirt(fixture.treeDir, fixture.config.typeConfig.ownRoot)).toEqual([]);
		expect(result.own).toContainEqual({ relative: 'hello.ts', kind: 'both' });
		expect(result.files.some((path) => path.startsWith(OWN_IN_TREE) && path.includes(OWN_IN_PATCHSET))).toBe(true);
	});

	it('reports an own file the tree has and patchset does not', () => {
		const result = whileChanged('src/vs/patchset/strayNote.ts', '// never extracted\n', guard);
		expect(result.dirty).toBe(true);
		expect(result.own).toContainEqual({ relative: 'strayNote.ts', kind: 'tree-only' });
	});

	it('does not call own code that is merely not materialized yet dirt', () => {
		const inTree = join(fixture.treeDir, OWN_IN_TREE);
		const saved = readFileSync(inTree);
		rmSync(inTree);
		try {
			const result = guard();
			expect(result.own).toContainEqual({ relative: 'hello.ts', kind: 'patchset-only' });
			expect(result.dirty).toBe(false);
		} finally {
			writeFileSync(inTree, saved);
		}
	});

	it('counts untracked paths, unless the caller is about to clean them', () => {
		const litter = join(fixture.treeDir, 'left-behind.txt');
		writeFileSync(litter, 'junk\n', 'utf8');
		try {
			expect(guard().files).toContain('left-behind.txt');
			const fresh = driftDirty(materializerOf(vscodeType), fixture.treeDir, fixture.config.typeConfig.ownRoot, fixture.patchesDir, {
				untrackedIsDirt: false,
				generated: generated()
			});
			expect(fresh.dirty).toBe(false);
		} finally {
			rmSync(litter, { force: true });
		}
	});
});

describe('driftDirty: the known-materialization refinement (##OVERLAY-KNOWN-MATERIALIZATION)', () => {
	// The guard stays generic: what a "known state" is belongs to the layer that
	// can prove it, so these tests only pin the contract of the predicate.

	it('drops a tracked path the caller certifies, and only that path', () => {
		const result = whileChanged(EXAMPLE_PART_PATH, '// replaced by hand\n', () =>
			whileChanged('product.json', '// materialized for packaging\n', () =>
				driftDirty(materializerOf(vscodeType), fixture.treeDir, fixture.config.typeConfig.ownRoot, fixture.patchesDir, {
					generated: generated(),
					isKnownMaterialization: (path) => path === 'product.json'
				})
			)
		);

		// The certified path is gone from half (a); the ordinary edit is not.
		expect(result.upstream).toEqual([EXAMPLE_PART_PATH]);
		expect(result.dirty).toBe(true);
	});

	it('keeps the path dirt when the predicate answers no', () => {
		const result = whileChanged('product.json', '// materialized for packaging\n', () =>
			driftDirty(materializerOf(vscodeType), fixture.treeDir, fixture.config.typeConfig.ownRoot, fixture.patchesDir, {
				generated: generated(),
				isKnownMaterialization: () => false
			})
		);

		expect(result.upstream).toEqual(['product.json']);
	});

	it('never asks the predicate about untracked paths', () => {
		// Untracked litter has no HEAD to differ from; it stays the business of
		// `untrackedIsDirt`, so a classifier cannot make it disappear.
		const asked: string[] = [];
		const litter = join(fixture.treeDir, 'left-behind.txt');
		writeFileSync(litter, 'junk\n', 'utf8');
		try {
			const result = whileChanged('product.json', '// materialized for packaging\n', () =>
				driftDirty(materializerOf(vscodeType), fixture.treeDir, fixture.config.typeConfig.ownRoot, fixture.patchesDir, {
					generated: generated(),
					isKnownMaterialization: (path) => {
						asked.push(path);
						return true;
					}
				})
			);

			expect(asked).toEqual(['product.json']);
			expect(result.dirty).toBe(true);
			expect(result.files).toContain('left-behind.txt');
		} finally {
			rmSync(litter, { force: true });
		}
	});
});

describe('driftDirty: the stranded-materialization exception (##DRIFT-GUARD-PREDICATE)', () => {
	// The exception belongs to one command, so the guard only carries the hook:
	// these tests pin what the hook may and may not remove from the dirt.
	const PACKAGE_JSON = '{\n\t"name": "acme-pack"\n}\n';

	/** The guard as a plain `load` arms it, recording every path the hook saw. */
	function guardPassingStranded(asked: string[]): ReturnType<typeof driftDirty> {
		const classify = strandedExtensionClassifier(
			materializerOf(vscodeType)!,
			fixture.treeDir,
			fixture.config.pin.sha,
			loadOwnManifest(fixture.patchesDir).extensions
		);
		return driftDirty(materializerOf(vscodeType), fixture.treeDir, fixture.config.typeConfig.ownRoot, fixture.patchesDir, {
			generated: generated(),
			isStrandedExtension: (entry) => {
				asked.push(entry.path);
				return classify(entry.path);
			}
		});
	}

	/** Put something untracked in the tree, look, take it away again. */
	function withTreePath<T>(relative: string, content: string, look: () => T): T {
		const absolute = join(fixture.treeDir, relative);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content, 'utf8');
		try {
			return look();
		} finally {
			rmSync(join(fixture.treeDir, 'extensions'), { recursive: true, force: true });
			rmSync(absolute, { force: true });
		}
	}

	it('passes over a directory no record declares and the pin does not ship', () => {
		const asked: string[] = [];
		const result = withTreePath('extensions/sample/package.json', PACKAGE_JSON, () => guardPassingStranded(asked));

		expect(result.dirty).toBe(false);
		expect(result.upstream).toEqual([]);
		// The collapsed `extensions/` entry was opened up, or the hook could
		// never have been asked about the directory inside it.
		expect(asked).toContain('extensions/sample/package.json');
	});

	it('leaves the same directory dirt for a command that arms no hook', () => {
		const result = withTreePath('extensions/sample/package.json', PACKAGE_JSON, guard);

		expect(result.dirty).toBe(true);
		expect(result.upstream.some((path) => path.startsWith('extensions/'))).toBe(true);
	});

	it('is never asked about a declared extension, which stays out of the dirt as before', () => {
		const manifestPath = join(fixture.patchesDir, 'delta', 'own', 'patchset.delta.json');
		const saved = readFileSync(manifestPath, 'utf8');
		const manifest = JSON.parse(saved) as Record<string, unknown>;
		manifest['extensions'] = [
			{
				id: 'CK-product-905',
				name: 'acme-pack',
				owner: 'product',
				reason: 'fixture own extension',
				pin: `${fixture.config.pin.tag}@${fixture.config.pin.sha}`,
				contractTests: []
			}
		];
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
		const delta = join(fixture.patchesDir, 'delta', 'own-extensions', 'acme-pack', 'package.json');
		mkdirSync(dirname(delta), { recursive: true });
		writeFileSync(delta, PACKAGE_JSON, 'utf8');
		const asked: string[] = [];
		try {
			// Both sides carry the same bytes: the extension is materialized, not drifted.
			const result = withTreePath('extensions/acme-pack/package.json', PACKAGE_JSON, () => guardPassingStranded(asked));

			expect(result.dirty).toBe(false);
			expect(asked.some((path) => path.startsWith('extensions/acme-pack/'))).toBe(false);
		} finally {
			writeFileSync(manifestPath, saved, 'utf8');
			rmSync(join(fixture.patchesDir, 'delta', 'own-extensions'), { recursive: true, force: true });
		}
	});

	it('keeps a new file outside extensions/ dirt, and a loose file straight under it', () => {
		const asked: string[] = [];
		const result = withTreePath('extensions/README.md', '# not a materialization\n', () =>
			whileChanged('left-behind.txt', 'junk\n', () => guardPassingStranded(asked))
		);

		expect(result.dirty).toBe(true);
		expect(result.upstream).toContain('left-behind.txt');
		expect(result.upstream).toContain('extensions/README.md');
	});
});

describe('.gitkeep in own code', () => {
	it('is not materialized in the tree and is not a divergence', () => {
		const keep = join(fixture.patchesDir, 'delta', 'own', 'modes', '.gitkeep');
		mkdirSync(dirname(keep), { recursive: true });
		writeFileSync(keep, '', 'utf8');

		// The fingerprint moved, so this is a full apply, own copy included.
		expect(fixture.sync().exitCode).toBe(0);

		expect(existsSync(join(fixture.treeDir, 'src', 'vs', 'patchset', 'modes', '.gitkeep'))).toBe(false);
		expect(guard().dirty).toBe(false);
	});
});

describe('porcelainEntries', () => {
	it('keeps the status and takes the new path of a rename', () => {
		expect(porcelainEntries(' M src/vs/a.ts\n?? litter.txt\nR  old.ts -> new.ts\n')).toEqual([
			{ status: ' M', path: 'src/vs/a.ts' },
			{ status: '??', path: 'litter.txt' },
			{ status: 'R ', path: 'new.ts' }
		]);
	});
});
