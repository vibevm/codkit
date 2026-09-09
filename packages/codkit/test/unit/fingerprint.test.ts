// deltaFingerprint and treeId (PROP-006 sec. 1, ##DELTA-FINGERPRINT, ##TREE-ID).
//
// The fingerprint is what makes "nothing changed" checkable, so the properties
// under test are the ones the fast path relies on: it depends on every byte of
// every artifact and on the pin, and on nothing else - not on the order the
// filesystem hands out entries, and not on when it is computed.

import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deltaArtifactMap, deltaFiles, deltaFingerprint, listDeltaFiles, treeId } from '../../src/lib/fingerprint.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const PIN = 'f85f15468eedbafce8927c031d45cd39587e5263';
const OTHER_PIN = '0000000000000000000000000000000000000001';

afterAll(() => {
	cleanupTempRoots();
});

type Files = readonly (readonly [string, string])[];

function makeDelta(label: string, files: Files): string {
	const root = makeTempRoot(label);
	for (const [relative, content] of files) {
		const absolute = join(root, relative);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content, 'utf8');
	}
	return root;
}

const SAMPLE: Files = [
	['delta/patches/source__a.ts.ckpatch', '# codkit-patch: 2\n'],
	['delta/own/hello.ts', 'export const hello = 1;\n'],
	['delta/own/modes/.gitkeep', ''],
	['delta/overlays/manifest.json.overlay.json', '{ "codkitOverlay": 1 }\n']
];

describe('deltaFingerprint', () => {
	it('is the same for two calls over the same delta', () => {
		const root = makeDelta('fp-stable', SAMPLE);
		expect(deltaFingerprint(root, PIN)).toBe(deltaFingerprint(root, PIN));
	});

	it('does not depend on the order the files were created', () => {
		const forward = makeDelta('fp-forward', SAMPLE);
		const backward = makeDelta('fp-backward', [...SAMPLE].reverse());
		expect(deltaFingerprint(backward, PIN)).toBe(deltaFingerprint(forward, PIN));
	});

	it('changes when one byte of one artifact changes', () => {
		const root = makeDelta('fp-byte', SAMPLE);
		const before = deltaFingerprint(root, PIN);
		writeFileSync(join(root, 'delta/own/hello.ts'), 'export const hello = 2;\n', 'utf8');
		expect(deltaFingerprint(root, PIN)).not.toBe(before);
	});

	it('changes when an artifact is renamed', () => {
		const root = makeDelta('fp-rename', SAMPLE);
		const before = deltaFingerprint(root, PIN);
		renameSync(join(root, 'delta/own/hello.ts'), join(root, 'delta/own/greeting.ts'));
		expect(deltaFingerprint(root, PIN)).not.toBe(before);
	});

	it('changes when the pin changes', () => {
		const root = makeDelta('fp-pin', SAMPLE);
		expect(deltaFingerprint(root, OTHER_PIN)).not.toBe(deltaFingerprint(root, PIN));
	});

	it('counts a .gitkeep like any other file', () => {
		const root = makeDelta('fp-gitkeep', SAMPLE);
		const before = deltaFingerprint(root, PIN);
		rmSync(join(root, 'delta/own/modes/.gitkeep'));
		expect(deltaFingerprint(root, PIN)).not.toBe(before);
	});

	it('hashes the pin alone when there is no delta directory', () => {
		const empty = makeTempRoot('fp-empty');
		expect(deltaFingerprint(empty, PIN)).toBe(deltaFingerprint(makeTempRoot('fp-empty-too'), PIN));
		expect(listDeltaFiles(empty)).toEqual([]);
	});

	it('lists paths POSIX-style, relative to the patchset root, sorted by bytes', () => {
		const root = makeDelta('fp-list', SAMPLE);
		expect(listDeltaFiles(root).map((file) => file.path)).toEqual([
			'delta/overlays/manifest.json.overlay.json',
			'delta/own/hello.ts',
			'delta/own/modes/.gitkeep',
			'delta/patches/source__a.ts.ckpatch'
		]);
	});
});

describe('deltaFiles', () => {
	it('carries the same fingerprint as deltaFingerprint, one traversal for both halves', () => {
		const root = makeDelta('fp-files', SAMPLE);
		const both = deltaFiles(root, PIN);
		expect(both.fingerprint).toBe(deltaFingerprint(root, PIN));
		expect(both.files).toEqual({
			'delta/overlays/manifest.json.overlay.json': listDeltaFiles(root).find(
				(file) => file.path === 'delta/overlays/manifest.json.overlay.json'
			)?.sha256,
			'delta/own/hello.ts': listDeltaFiles(root).find((file) => file.path === 'delta/own/hello.ts')?.sha256,
			'delta/own/modes/.gitkeep': listDeltaFiles(root).find((file) => file.path === 'delta/own/modes/.gitkeep')?.sha256,
			'delta/patches/source__a.ts.ckpatch': listDeltaFiles(root).find((file) => file.path === 'delta/patches/source__a.ts.ckpatch')?.sha256
		});
	});
});

describe('deltaArtifactMap', () => {
	it('drops the own subtree and keeps every other layer: the mark never double-covers a path', () => {
		const files: Record<string, string> = {
			'delta/own/hello.ts': 'aaa',
			'delta/own/modes/.gitkeep': 'bbb',
			'delta/patches/source__a.ts.ckpatch': 'ccc',
			'delta/overlays/manifest.json.overlay.json': 'ddd',
			'delta/resources/map.json': 'eee'
		};
		expect(deltaArtifactMap(files)).toEqual({
			'delta/patches/source__a.ts.ckpatch': 'ccc',
			'delta/overlays/manifest.json.overlay.json': 'ddd',
			'delta/resources/map.json': 'eee'
		});
	});
});

describe('treeId', () => {
	it('is 16 hex characters of the path hash', () => {
		const root = makeTempRoot('tid');
		expect(treeId(root)).toMatch(/^[0-9a-f]{16}$/);
		expect(treeId(root)).toBe(treeId(root));
	});

	it('separates two trees and follows a symlink to the same one', () => {
		const first = makeTempRoot('tid-a');
		const second = makeTempRoot('tid-b');
		expect(treeId(first)).not.toBe(treeId(second));

		const link = join(makeTempRoot('tid-link'), 'link-to-first');
		symlinkSync(first, link);
		// The identity is the realpath: one tree, one id, one lock, one cache.
		expect(treeId(link)).toBe(treeId(first));
	});
});
