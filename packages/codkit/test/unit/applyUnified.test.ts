// unit: in-memory patch application with exact context (PROP-006 sec. 5,
// PROP-013 ##UT-APPLY-UNIFIED).
//
// The module is deliberately unforgiving: it exists to compute "the pin plus
// this patch" for the checks, so anything it cannot reproduce exactly has to
// come out as CK-E-ARTIFACT-BROKEN rather than as a plausible guess.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyUnified } from '../../src/lib/applyUnified.ts';
import { decodeUtf8Strict, encodeUtf8 } from '../../src/lib/bytes.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { formatPatchHeader, parseCkpatch } from '../../src/lib/patchFormat.ts';
import type { ParsedPatch } from '../../src/lib/patchFormat.ts';
import { EXAMPLE_AREA_ANCHOR, EXAMPLE_PART_PATH, makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { makePatchSet, PATCH_FILE_NAME, PATCH_ID } from '../fixtures/makePatchSet.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const TEST_PATCH_FILE = 'delta/patches/test.ckpatch';

/**
 * A patch with a valid header and the given diff body. `target` writes the two
 * file headers; null leaves them to the caller, for the add-file shape.
 */
function patchOf(target: string | null, bodyLines: readonly string[], id = 'CK-shell-001'): ParsedPatch {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'a synthetic patch built by the applyUnified unit test',
		link: 'none',
		cause: 'none',
		pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
		contractTests: []
	});
	const headers = target === null ? [] : [`--- a/${target}`, `+++ b/${target}`];
	return parseCkpatch(encodeUtf8(`${header}${[...headers, ...bodyLines].join('\n')}\n`), conventions(), TEST_PATCH_FILE);
}

function apply(base: string, patch: ParsedPatch): string {
	const result = decodeUtf8Strict(applyUnified(encodeUtf8(base), patch));
	if (result === null) {
		throw new Error('applyUnified produced bytes that are not UTF-8');
	}
	return result;
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return isCkError(error) ? error.code : `not a CkError: ${String(error)}`;
	}
	return 'no error';
}

describe('applyUnified on the fixture patch', () => {
	let upstream: UpstreamFixture;
	let patch: ParsedPatch;

	beforeAll(() => {
		upstream = makeUpstream(makeTempRoot('apply-upstream'));
		const patchset = makeTempRoot('apply-patchset');
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

	function atPin(path: string): string {
		return runGit({ args: ['show', `${upstream.t1.sha}:${path}`], cwd: upstream.dir }).stdout;
	}

	it('turns the file at the pin into the file with the hook block', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		// The expectation is built here, independently of how the fixture built
		// the patch: the anchor line plus the three marker lines under it.
		const anchor = `${EXAMPLE_AREA_ANCHOR}\n`;
		const expected = pin.replace(
			anchor,
			`${anchor}\t\t// codkit:begin ${PATCH_ID}\n\t\t// (hook body lives in own/ code; this block only delegates)\n\t\t// codkit:end ${PATCH_ID}\n`
		);

		expect(apply(pin, patch)).toBe(expected);
		expect(expected).not.toBe(pin);
	});

	it('refuses the same patch against a later state of the file', () => {
		// c4 of the fixture history edits the constructor, so the context of the
		// hunk no longer matches even though the hook line itself survives.
		const later = runGit({ args: ['show', `${upstream.t2.sha}:${EXAMPLE_PART_PATH}`], cwd: upstream.dir }).stdout;

		expect(codeOf(() => applyUnified(encodeUtf8(later), patch))).toBe('ARTIFACT-BROKEN');
	});
});

describe('applyUnified exactness', () => {
	const BASE = 'one\ntwo\nthree\nfour\nfive\n';

	it('applies an addition inside the file', () => {
		const patch = patchOf('source/a.ts', ['@@ -1,5 +1,6 @@', ' one', ' two', '+inserted', ' three', ' four', ' five']);

		expect(apply(BASE, patch)).toBe('one\ntwo\ninserted\nthree\nfour\nfive\n');
	});

	it('applies several hunks in order', () => {
		const base = `${'a\n'.repeat(3)}x\n${'b\n'.repeat(8)}y\n${'c\n'.repeat(3)}`;
		const patch = patchOf('source/a.ts', [
			'@@ -1,7 +1,8 @@',
			' a',
			' a',
			' a',
			'-x',
			'+X',
			'+added',
			' b',
			' b',
			' b',
			'@@ -10,7 +11,7 @@',
			' b',
			' b',
			' b',
			'-y',
			'+Y',
			' c',
			' c',
			' c'
		]);

		expect(apply(base, patch)).toBe(`${'a\n'.repeat(3)}X\nadded\n${'b\n'.repeat(8)}Y\n${'c\n'.repeat(3)}`);
	});

	it('reports ARTIFACT-BROKEN when a context line does not match', () => {
		const patch = patchOf('source/a.ts', ['@@ -1,5 +1,6 @@', ' one', ' TWO', '+inserted', ' three', ' four', ' five']);

		expect(codeOf(() => applyUnified(encodeUtf8(BASE), patch))).toBe('ARTIFACT-BROKEN');
		try {
			applyUnified(encodeUtf8(BASE), patch);
		} catch (error) {
			expect(isCkError(error) ? error.message : '').toContain('context mismatch at source/a.ts:2');
		}
	});

	it('reports ARTIFACT-BROKEN when a removed line does not match', () => {
		const patch = patchOf('source/a.ts', ['@@ -1,5 +1,4 @@', ' one', '-TWO', ' three', ' four', ' five']);

		expect(codeOf(() => applyUnified(encodeUtf8(BASE), patch))).toBe('ARTIFACT-BROKEN');
	});

	it('reports ARTIFACT-BROKEN when the hunk runs past the end of the file', () => {
		const patch = patchOf('source/a.ts', ['@@ -5,3 +5,3 @@', ' five', ' six', '-seven', '+SEVEN']);

		expect(codeOf(() => applyUnified(encodeUtf8(BASE), patch))).toBe('ARTIFACT-BROKEN');
	});
});

describe('applyUnified on an add-file patch', () => {
	it('produces the file from an empty base', () => {
		const patch = patchOf(null, [
			'--- /dev/null',
			'+++ b/source/app/browser/parts/example/exampleHost.ts',
			'@@ -0,0 +1,3 @@',
			'+// codkit:begin CK-shell-001',
			'+export const exampleHost = 1;',
			'+// codkit:end CK-shell-001'
		]);

		expect(apply('', patch)).toBe('// codkit:begin CK-shell-001\nexport const exampleHost = 1;\n// codkit:end CK-shell-001\n');
	});

	it('refuses an add-file patch when the pin already has the file', () => {
		const patch = patchOf(null, ['--- /dev/null', '+++ b/source/a.ts', '@@ -0,0 +1,1 @@', '+const a = 1;']);

		expect(codeOf(() => applyUnified(encodeUtf8('something\n'), patch))).toBe('ARTIFACT-BROKEN');
	});
});

describe('applyUnified and the missing final newline', () => {
	it('keeps a file that has no newline at the end of the file', () => {
		const patch = patchOf('source/a.ts', [
			'@@ -1,3 +1,3 @@',
			' one',
			' two',
			'-three',
			'\\ No newline at end of file',
			'+three-changed',
			'\\ No newline at end of file'
		]);

		expect(apply('one\ntwo\nthree', patch)).toBe('one\ntwo\nthree-changed');
	});

	it('adds the terminator when the patch stops marking it', () => {
		const patch = patchOf('source/a.ts', ['@@ -1,3 +1,4 @@', ' one', ' two', '-three', '\\ No newline at end of file', '+three', '+four']);

		expect(apply('one\ntwo\nthree', patch)).toBe('one\ntwo\nthree\nfour\n');
	});

	it('removes the terminator when the patch marks the added last line', () => {
		const patch = patchOf('source/a.ts', ['@@ -1,3 +1,3 @@', ' one', ' two', '-three', '+three-changed', '\\ No newline at end of file']);

		expect(apply('one\ntwo\nthree\n', patch)).toBe('one\ntwo\nthree-changed');
	});

	it('refuses a patch that claims a missing terminator the pin does not have', () => {
		const patch = patchOf('source/a.ts', [
			'@@ -1,3 +1,3 @@',
			' one',
			' two',
			'-three',
			'\\ No newline at end of file',
			'+three-changed',
			'\\ No newline at end of file'
		]);

		expect(codeOf(() => applyUnified(encodeUtf8('one\ntwo\nthree\n'), patch))).toBe('ARTIFACT-BROKEN');
	});

	it('refuses a patch that consumes an unterminated last line without saying so', () => {
		const patch = patchOf('source/a.ts', ['@@ -1,3 +1,3 @@', ' one', ' two', '-three', '+three-changed']);

		expect(codeOf(() => applyUnified(encodeUtf8('one\ntwo\nthree'), patch))).toBe('ARTIFACT-BROKEN');
	});
});
