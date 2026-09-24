// unit: the bytes of the files the delta writes, in a fork tree whose checkout
// writes CRLF (PROP-008 ##WORKTREE-DELTA-BYTES, PROP-002 ##GIT-ENV-EOL).
//
// The reported tree: upstream declares its text files `text=auto`, the
// platform's checkout writes CRLF for them, and the package built from the
// working copy carried the CRLF - the Linux templates included. After a load
// every file the delta writes holds the patch set's bytes, whatever the
// platform or the tree's attributes say; a tree an older checkout wrote heals on
// its next load, fast path included; a real edit is never taken for a
// conversion; and what `package` puts back is the tip's bytes.

import { spawnSync } from 'node:child_process';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { restoreToTip } from '../../src/lib/syncEngine.ts';
import { restoreDeltaBytes } from '../../src/lib/workTreeBytes.ts';
import { DELTA_FILES, LAUNCHER, LINUX_INPUTS, MANIFEST, PATCHED, convertLikeAnOldCheckout, makeEolFixture } from '../support/eolFixture.ts';
import type { EolFixture } from '../support/eolFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const CR = 0x0d;

afterAll(() => {
	cleanupTempRoots();
});

function mtimeOf(fixture: EolFixture, path: string): number {
	return statSync(fixture.treePath(path)).mtimeMs;
}

function expectPatchSetBytes(fixture: EolFixture): void {
	for (const path of [...LINUX_INPUTS, LAUNCHER]) {
		expect(fixture.tipBytes(path).equals(fixture.resourceBytes(path)), `${path} at the tip`).toBe(true);
		expect(fixture.treeBytes(path).equals(fixture.resourceBytes(path)), `${path} in the tree`).toBe(true);
	}
	for (const path of [PATCHED, MANIFEST]) {
		expect(fixture.treeBytes(path).equals(fixture.tipBytes(path)), `${path} in the tree`).toBe(true);
		expect(fixture.treeBytes(path).includes(CR), `${path} in the tree`).toBe(false);
	}
}

describe('load in a fork tree whose checkout writes CRLF', () => {
	it('is a tree where git itself writes CRLF for a text file: the control', () => {
		const fixture = makeEolFixture('eol-control');
		const path = 'source/base/common/fixture.ts';
		rmSync(fixture.treePath(path));

		// The user's own git, machine configuration out of the way: no wrapper flags.
		const plain = spawnSync('git', ['-c', 'core.autocrlf=false', 'checkout', 'HEAD', '--', path], {
			cwd: fixture.treeDir,
			env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
			encoding: 'utf8'
		});

		expect(plain.status).toBe(0);
		expect(fixture.treeBytes(path).includes(CR)).toBe(true);
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
	}, 60_000);

	it('writes every file the delta writes with the patch set bytes', () => {
		const fixture = makeEolFixture('eol-first-load');

		const result = fixture.sync();

		expect(result.status).toBe('applied');
		expectPatchSetBytes(fixture);
		// The checkout of the move wrote the text files with their blob's LF. What
		// was left is the launcher, which upstream's own `eol=crlf` converts on
		// every OS, and the manifest the tree was checked out with.
		expect([...result.restoredBytes]).toEqual([MANIFEST, LAUNCHER].sort());
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
	}, 60_000);

	it('heals a tree an older checkout left with CRLF on its next load, fast path included', () => {
		const fixture = makeEolFixture('eol-heal');
		expect(fixture.sync().status).toBe('applied');
		convertLikeAnOldCheckout(fixture, DELTA_FILES);
		for (const path of DELTA_FILES) {
			expect(fixture.treeBytes(path).includes(CR), `${path} before`).toBe(true);
		}
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
		const upstreamFile = mtimeOf(fixture, 'source/base/common/fixture.ts');

		const healed = fixture.sync();

		expect(healed.status).toBe('up-to-date');
		expect([...healed.restoredBytes]).toEqual([...DELTA_FILES]);
		expectPatchSetBytes(fixture);
		expect(fixture.messages).toContain(`restored the bytes of ${DELTA_FILES.length} file(s) the delta writes: ${DELTA_FILES.join(', ')}`);
		expect(mtimeOf(fixture, 'source/base/common/fixture.ts')).toBe(upstreamFile);
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');

		// Nothing is left to restore, and nothing is written again (##MTIME-DISCIPLINE).
		const mtimes = DELTA_FILES.map((path) => mtimeOf(fixture, path));
		const again = fixture.sync();
		expect(again.status).toBe('up-to-date');
		expect(again.restoredBytes).toEqual([]);
		expect(DELTA_FILES.map((path) => mtimeOf(fixture, path))).toEqual(mtimes);
	}, 60_000);

	it('leaves a real edit alone: no conversion explains it, and the guard owns it', () => {
		const fixture = makeEolFixture('eol-edit');
		expect(fixture.sync().status).toBe('applied');
		const path = LINUX_INPUTS[0] ?? '';
		const edited = Buffer.from(
			fixture.treeBytes(path).toString('utf8').replace('Name=Fixture Product', 'Name=By Hand').replace(/\n/gu, '\r\n'),
			'utf8'
		);
		writeFileSync(fixture.treePath(path), edited);

		expect(restoreDeltaBytes(fixture.treeDir, DELTA_FILES)).toEqual([]);
		expect(fixture.treeBytes(path).equals(edited)).toBe(true);
		expect(fixture.sync().status).toBe('dirty');
		expect(fixture.treeBytes(path).equals(edited)).toBe(true);
	}, 60_000);

	it('puts back an overlay target and a scratch path with the tip bytes, as package does', () => {
		const fixture = makeEolFixture('eol-restore');
		expect(fixture.sync().status).toBe('applied');
		// What `overlay apply` leaves in the target, and what a packager rewrites in passing.
		writeFileSync(fixture.treePath(MANIFEST), '{\n\t"displayName": "Fixture PatchSet"\n}\n', 'utf8');
		writeFileSync(fixture.treePath('package.json'), '{\n\t"name": "fixture-app",\n\t"version": "1.0.0-package"\n}\n', 'utf8');

		restoreToTip(fixture.treeDir, [MANIFEST, 'package.json']);

		expect(fixture.treeBytes(MANIFEST).equals(fixture.tipBytes(MANIFEST))).toBe(true);
		expect(fixture.treeBytes('package.json').equals(fixture.tipBytes('package.json'))).toBe(true);
	}, 60_000);
});
