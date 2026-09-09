// unit: "every hunk inside a marker" (PROP-006 sec. 5, PROP-013 ##UT-APPLY-UNIFIED).
//
// The cases are the ones the rule exists for: an addition that escaped its
// block, a deleted upstream line, the one deletion that is allowed because the
// line was commented out instead, a block that carries nothing, and a block
// whose id does not belong to the artifact.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { checkHunksInsideMarkers, checkMarkerArtifactConsistency } from '../../src/lib/hunksInMarkers.ts';
import type { HunksInMarkersResult } from '../../src/lib/hunksInMarkers.ts';
import type { ErrorCode } from '../../src/lib/messages.ts';
import { formatPatchHeader, parseCkpatch } from '../../src/lib/patchFormat.ts';
import type { ParsedPatch } from '../../src/lib/patchFormat.ts';
import { EXAMPLE_PART_PATH, makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { makePatchSet, PATCH_FILE_NAME } from '../fixtures/makePatchSet.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const PATCH_FILE = 'delta/patches/source__a.ts.ckpatch';
const TARGET = 'source/a.ts';

const PIN_TS = ['const one = 1;', 'const two = 2;', 'const three = 3;', 'const four = 4;', 'const five = 5;', 'const six = 6;', ''].join(
	'\n'
);

function patchOf(bodyLines: readonly string[], id = 'CK-shell-001', target = TARGET): ParsedPatch {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'a synthetic patch built by the hunks-in-markers unit test',
		link: 'none',
		cause: 'none',
		pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
		contractTests: []
	});
	const body = [`--- a/${target}`, `+++ b/${target}`, ...bodyLines].join('\n');
	return parseCkpatch(encodeUtf8(`${header}${body}\n`), conventions(), PATCH_FILE);
}

function check(pin: string, patch: ParsedPatch, ext = '.ts', allowIds?: readonly string[]): HunksInMarkersResult {
	const options = allowIds === undefined ? { patchFile: PATCH_FILE } : { patchFile: PATCH_FILE, allowIds };
	return checkHunksInsideMarkers(patch, encodeUtf8(pin), ext, conventions(), options);
}

function codes(result: HunksInMarkersResult): ErrorCode[] {
	return result.errors.map((error) => error.code);
}

describe('the patch of the patchset fixture', () => {
	let upstream: UpstreamFixture;
	let patch: ParsedPatch;

	beforeAll(() => {
		upstream = makeUpstream(makeTempRoot('hunks-upstream'));
		const patchset = makeTempRoot('hunks-patchset');
		makePatchSet(patchset, upstream);
		patch = parseCkpatch(
			readFileSync(join(patchset, 'delta', 'patches', PATCH_FILE_NAME)),
			conventions(),
			`delta/patches/${PATCH_FILE_NAME}`
		);
	});

	afterAll(() => {
		cleanupTempRoots();
	});

	it('passes with no errors and no warnings', () => {
		const pin = runGit({ args: ['show', `${upstream.t1.sha}:${EXAMPLE_PART_PATH}`], cwd: upstream.dir }).stdout;

		const result = checkHunksInsideMarkers(patch, encodeUtf8(pin), '.ts', conventions(), {
			patchFile: `delta/patches/${PATCH_FILE_NAME}`
		});

		expect(result.errors.map((error) => `${error.code}: ${error.message}`)).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.blocks.length).toBe(1);
	});
});

describe('additions outside a marker block', () => {
	it('reports HUNK-OUTSIDE-MARKER with the target line number', () => {
		const patch = patchOf([
			'@@ -1,4 +1,5 @@',
			' const one = 1;',
			' const two = 2;',
			'+const injected = 0;',
			' const three = 3;',
			' const four = 4;'
		]);

		const result = check(PIN_TS, patch);

		expect(codes(result)).toContain('HUNK-OUTSIDE-MARKER');
		const outside = result.errors.find((error) => error.code === 'HUNK-OUTSIDE-MARKER');
		expect(outside?.message).toContain('hunk at target line 3 adds lines outside any codkit marker block');
		expect(outside?.message).toContain('// codkit:begin CK-shell-001');
		expect(outside?.file).toBe(PATCH_FILE);
	});

	it('reports one diagnostic per run of adjacent lines', () => {
		const patch = patchOf([
			'@@ -1,4 +1,7 @@',
			' const one = 1;',
			' const two = 2;',
			'+const a = 0;',
			'+const b = 0;',
			'+const c = 0;',
			' const three = 3;',
			' const four = 4;'
		]);

		expect(codes(check(PIN_TS, patch)).filter((code) => code === 'HUNK-OUTSIDE-MARKER').length).toBe(1);
	});
});

describe('deleted upstream lines', () => {
	it('reports DELETES-UPSTREAM-LINE when the line simply disappears', () => {
		const patch = patchOf([
			'@@ -1,5 +1,6 @@',
			' const one = 1;',
			' const two = 2;',
			'-const three = 3;',
			'+// codkit:begin CK-shell-001',
			'+// codkit:end CK-shell-001',
			' const four = 4;',
			' const five = 5;'
		]);

		const result = check(PIN_TS, patch);

		expect(codes(result)).toContain('DELETES-UPSTREAM-LINE');
		const deleted = result.errors.find((error) => error.code === 'DELETES-UPSTREAM-LINE');
		expect(deleted?.message).toContain('upstream line 3');
		expect(deleted?.message).toContain('const three = 3;');
	});

	it('accepts a line that was neutralized by commenting it out', () => {
		const patch = patchOf([
			'@@ -1,5 +1,7 @@',
			' const one = 1;',
			' const two = 2;',
			'-const three = 3;',
			'+// codkit:begin CK-shell-001',
			'+// const three = 3;',
			'+// codkit:end CK-shell-001',
			' const four = 4;',
			' const five = 5;'
		]);

		const result = check(PIN_TS, patch);

		expect(result.errors.map((error) => `${error.code}: ${error.message}`)).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('accepts neutralization in a form with a closing comment', () => {
		const pinCss = ['.a {', '\tcolor: red;', '\tdisplay: block;', '}', ''].join('\n');
		const patch = patchOf(
			[
				'@@ -1,4 +1,6 @@',
				' .a {',
				'-\tcolor: red;',
				'+\t/* codkit:begin CK-shell-001 */',
				'+\t/* color: red; */',
				'+\t/* codkit:end CK-shell-001 */',
				' \tdisplay: block;',
				' }'
			],
			'CK-shell-001',
			'source/a.css'
		);

		const result = checkHunksInsideMarkers(patch, encodeUtf8(pinCss), '.css', conventions(), { patchFile: PATCH_FILE });

		expect(result.errors.map((error) => `${error.code}: ${error.message}`)).toEqual([]);
	});

	it('does not accept a commented copy that lands in another hunk', () => {
		// The commented copy is real, but it is added twenty lines away, in a
		// different hunk: the exception is deliberately narrow.
		const pin = `${'const filler = 0;\n'.repeat(20)}const three = 3;\n${'const tail = 0;\n'.repeat(20)}`;
		const patch = patchOf([
			'@@ -1,3 +1,6 @@',
			'+// codkit:begin CK-shell-001',
			'+// const three = 3;',
			'+// codkit:end CK-shell-001',
			' const filler = 0;',
			' const filler = 0;',
			' const filler = 0;',
			'@@ -18,7 +21,6 @@',
			' const filler = 0;',
			' const filler = 0;',
			' const filler = 0;',
			'-const three = 3;',
			' const tail = 0;',
			' const tail = 0;',
			' const tail = 0;'
		]);

		expect(codes(check(pin, patch))).toContain('DELETES-UPSTREAM-LINE');
	});
});

describe('marker blocks and the artifact that owns them', () => {
	it('warns CK-W-EMPTY-BLOCK for a block with nothing but its markers', () => {
		const patch = patchOf([
			'@@ -1,5 +1,7 @@',
			' const one = 1;',
			' const two = 2;',
			'+// codkit:begin CK-shell-001',
			'+// codkit:end CK-shell-001',
			' const three = 3;',
			' const four = 4;',
			' const five = 5;'
		]);

		const result = check(PIN_TS, patch);

		expect(result.errors.map((error) => error.code)).toEqual([]);
		expect(result.warnings.map((warning) => warning.code)).toEqual(['EMPTY-BLOCK']);
		expect(result.warnings[0]?.line).toBe(3);
	});

	it('reports MARKER-ARTIFACT-MISMATCH for a block that belongs to another id', () => {
		const patch = patchOf([
			'@@ -1,5 +1,8 @@',
			' const one = 1;',
			' const two = 2;',
			'+// codkit:begin CK-editor-002',
			'+const injected = 0;',
			'+// codkit:end CK-editor-002',
			' const three = 3;',
			' const four = 4;',
			' const five = 5;'
		]);

		const result = check(PIN_TS, patch);

		expect(codes(result)).toContain('MARKER-ARTIFACT-MISMATCH');
		expect(result.errors.some((error) => error.message.includes('not owned by this artifact'))).toBe(true);
		expect(result.errors.some((error) => error.message.includes('no marker block carries the artifact id'))).toBe(true);
	});

	it('reports MARKER-ARTIFACT-MISMATCH when the marker is already in the pin', () => {
		const pin = ['const one = 1;', '// codkit:begin CK-shell-001', '// codkit:end CK-shell-001', 'const four = 4;', ''].join('\n');
		const patch = patchOf([
			'@@ -1,4 +1,5 @@',
			' const one = 1;',
			' // codkit:begin CK-shell-001',
			'+const injected = 1;',
			' // codkit:end CK-shell-001',
			' const four = 4;'
		]);

		const result = check(pin, patch);

		expect(codes(result)).toEqual(['MARKER-ARTIFACT-MISMATCH', 'MARKER-ARTIFACT-MISMATCH']);
		expect(result.errors[0]?.message).toContain('is not added by this patch');
	});

	it('passes the marker errors of the target state through', () => {
		const patch = patchOf([
			'@@ -1,5 +1,7 @@',
			' const one = 1;',
			' const two = 2;',
			'+// codkit:begin CK-shell-001',
			'+// codkit:begin CK-shell-001',
			' const three = 3;',
			' const four = 4;',
			' const five = 5;'
		]);

		expect(codes(check(PIN_TS, patch))).toContain('MARKER-NESTED');
	});
});

describe('checkMarkerArtifactConsistency', () => {
	it('accepts blocks that carry the artifact id', () => {
		const blocks = [{ id: 'CK-shell-001', beginLine: 3, endLine: 5 }];

		expect(checkMarkerArtifactConsistency(blocks, 'CK-shell-001')).toEqual([]);
	});

	it('reports a block with a foreign id and a missing artifact id', () => {
		const blocks = [{ id: 'CK-editor-002', beginLine: 3, endLine: 5 }];

		expect(checkMarkerArtifactConsistency(blocks, 'CK-shell-001').map((error) => error.code)).toEqual([
			'MARKER-ARTIFACT-MISMATCH',
			'MARKER-ARTIFACT-MISMATCH'
		]);
	});

	it('accepts a foreign id that the entry-module layer allows', () => {
		const blocks = [
			{ id: 'CK-shell-001', beginLine: 3, endLine: 5 },
			{ id: 'CK-editor-002', beginLine: 7, endLine: 9 }
		];

		expect(checkMarkerArtifactConsistency(blocks, 'CK-shell-001', ['CK-editor-002'])).toEqual([]);
	});
});
