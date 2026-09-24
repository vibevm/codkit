// unit: deterministic patch generation (PROP-004 sec. 5, PROP-013 sec. 3, generation row).
//
// Two things are checked here that no other test can check: that the byte
// predicates refuse a target before any diff is taken, and that the same inputs
// produce the same bytes twice in a row (##DOUBLE-REGEN-INVARIANT). The generated
// patch is also handed to real git, so "it applies at the pin" is a fact rather
// than a belief about the format.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyUnified } from '../../src/lib/applyUnified.ts';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from '../../src/lib/bytes.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { extractHeaderText, formatPatchHeader, parseCkpatch } from '../../src/lib/patchFormat.ts';
import { regeneratePatch } from '../../src/lib/patchGenerate.ts';
import type { RegenerateResult } from '../../src/lib/patchGenerate.ts';
import { EXAMPLE_AREA_ANCHOR, EXAMPLE_PART_PATH, makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const PATCH_ID = 'CK-shell-001';

let upstream: UpstreamFixture;
let scratch: string;
let tmpDir: string;

beforeAll(() => {
	upstream = makeUpstream(makeTempRoot('gen-upstream'));
	scratch = makeTempRoot('gen-scratch');
	tmpDir = join(scratch, '.codkit', 'tmp');
});

afterAll(() => {
	cleanupTempRoots();
});

function header(pin = `${upstream.t1.tag}@${upstream.t1.sha}`): string {
	return formatPatchHeader({
		id: PATCH_ID,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'mount point for the example area host',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: []
	});
}

function generate(
	pinText: string,
	curText: string,
	options?: { readonly targetPath?: string; readonly existingBytes?: Uint8Array; readonly header?: string; readonly pinExists?: boolean }
): RegenerateResult {
	return regeneratePatch({
		targetPath: options?.targetPath ?? EXAMPLE_PART_PATH,
		pinBytes: encodeUtf8(pinText),
		...(options?.pinExists === undefined ? {} : { pinExists: options.pinExists }),
		curBytes: encodeUtf8(curText),
		header: options?.header ?? header(),
		existingBytes: options?.existingBytes ?? null,
		tmpDir
	});
}

function bytesOf(result: RegenerateResult): Uint8Array {
	if (result.unchanged) {
		throw new Error('expected a regenerated patch, got "unchanged"');
	}
	return result.bytes;
}

function textOf(result: RegenerateResult): string {
	const text = decodeUtf8Strict(bytesOf(result));
	if (text === null) {
		throw new Error('the generated patch is not UTF-8');
	}
	return text;
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return isCkError(error) ? error.code : `not a CkError: ${String(error)}`;
	}
	return 'no error';
}

/** The file as of t1, read from git objects. */
function atPin(path: string): string {
	return runGit({ args: ['show', `${upstream.t1.sha}:${path}`], cwd: upstream.dir }).stdout;
}

/** The same edit the fixture makes: a marker block at the top of the create* body. */
function withHookBlock(source: string): string {
	const anchor = `${EXAMPLE_AREA_ANCHOR}\n`;
	return source.replace(
		anchor,
		`${anchor}\t\t// codkit:begin ${PATCH_ID}\n\t\t// (hook body lives in own/ code; this block only delegates)\n\t\t// codkit:end ${PATCH_ID}\n`
	);
}

/**
 * `git apply --cached --check` against a temporary index holding the pin's tree,
 * so the fixture work tree (which sits at t2) is not involved.
 */
function appliesAtPin(patchBytes: Uint8Array, label: string): boolean {
	mkdirSync(scratch, { recursive: true });
	const patchFile = join(scratch, `${label}.ckpatch`);
	writeFileSync(patchFile, patchBytes);
	const env = { GIT_INDEX_FILE: join(scratch, `${label}-index`) };
	const read = runGit({ args: ['read-tree', upstream.t1.sha], cwd: upstream.dir, env });
	if (read.status !== 0) {
		throw new Error(`cannot read the pin tree into a temporary index: ${read.stderr}`);
	}
	return runGit({ args: ['apply', '--cached', '--check', patchFile], cwd: upstream.dir, env }).status === 0;
}

describe('regeneratePatch on the fixture target', () => {
	it('produces a patch that git applies at the pin and that reproduces the file', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		const cur = withHookBlock(pin);
		expect(cur).not.toBe(pin);

		const result = generate(pin, cur);
		const bytes = bytesOf(result);

		expect(appliesAtPin(bytes, 'generated')).toBe(true);

		const parsed = parseCkpatch(bytes, conventions(), 'delta/patches/generated.ckpatch');
		expect(parsed.targetPath).toBe(EXAMPLE_PART_PATH);
		expect(parsed.header.id).toBe(PATCH_ID);
		expect(decodeUtf8Strict(applyUnified(encodeUtf8(pin), parsed))).toBe(cur);
	});

	it('carries no volatile generator headers', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		const text = textOf(generate(pin, withHookBlock(pin)));

		expect(text).not.toContain('diff --git');
		expect(text).not.toContain('\nindex ');
		expect(text).toContain(`--- a/${EXAMPLE_PART_PATH}\n`);
		expect(text).toContain(`+++ b/${EXAMPLE_PART_PATH}\n`);
		expect(text.endsWith('\n')).toBe(true);
	});

	it('produces identical bytes on two consecutive runs', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		const cur = withHookBlock(pin);

		const first = bytesOf(generate(pin, cur));
		const second = bytesOf(generate(pin, cur));

		expect(bytesEqual(first, second)).toBe(true);
	});
});

describe('regeneratePatch verdicts', () => {
	it('reports an empty diff when the target is back at the pin', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		const result = generate(pin, pin);

		expect(result.unchanged).toBe(true);
		expect(result.empty).toBe(true);
	});

	it('reports unchanged when the bytes match the patch on disk', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		const cur = withHookBlock(pin);
		const existing = bytesOf(generate(pin, cur));

		const again = generate(pin, cur, { existingBytes: existing });

		expect(again.unchanged).toBe(true);
		expect(again.empty).toBe(false);
	});

	it('regenerates when the patch on disk differs', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		const cur = withHookBlock(pin);
		const stale = encodeUtf8(`${header()}--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n`);

		expect(generate(pin, cur, { existingBytes: stale }).unchanged).toBe(false);
	});

	it('keeps the header of the existing patch byte for byte', () => {
		const pin = atPin(EXAMPLE_PART_PATH);
		const cur = withHookBlock(pin);
		const existingHeader = extractHeaderText(parseCkpatch(bytesOf(generate(pin, cur)), conventions(), 'delta/patches/generated.ckpatch'));

		// The same header, on a body regenerated from a different edit.
		const edited = withHookBlock(pin).replace('this.doCreateExampleArea(parent);', 'this.doCreateExampleArea(parent); // note');
		const text = textOf(generate(pin, edited, { header: existingHeader }));

		expect(text.startsWith(existingHeader)).toBe(true);
		expect(parseCkpatch(encodeUtf8(text), conventions(), 'x.ckpatch').header.pin).toBe(`${upstream.t1.tag}@${upstream.t1.sha}`);
	});
});

describe('regeneratePatch byte predicates', () => {
	const PIN = 'const one = 1;\nconst two = 2;\n';

	it('keeps trailing whitespace on a changed line', () => {
		const text = textOf(generate(PIN, 'const one = 1;   \nconst two = 2;\n', { targetPath: 'source/a.ts' }));

		expect(text).toContain('+const one = 1;   \n');
		expect(text).toContain('-const one = 1;\n');
	});

	it('refuses a target with CRLF line endings', () => {
		expect(codeOf(() => generate(PIN, 'const one = 1;\r\nconst two = 2;\r\n', { targetPath: 'source/a.ts' }))).toBe('CRLF');
	});

	it('names both settings a checkout on Windows needs to write LF again', () => {
		// ##GIT-ENV-EOL: core.autocrlf=false alone leaves core.eol at native, which is CRLF there.
		let hint = '';
		try {
			generate(PIN, 'const one = 1;\r\nconst two = 2;\r\n', { targetPath: 'source/a.ts' });
		} catch (error) {
			hint = isCkError(error) ? (error.hint ?? '') : '';
		}

		expect(hint).toContain('core.autocrlf=false');
		expect(hint).toContain('core.eol=lf');
	});

	it('refuses a target that lost the newline it has at the pin', () => {
		expect(codeOf(() => generate(PIN, 'const one = 1;\nconst two = 2;', { targetPath: 'source/a.ts' }))).toBe('EOF-NEWLINE');
	});

	it('refuses a binary target', () => {
		const code = codeOf(() =>
			regeneratePatch({
				targetPath: 'resources/app-icon.bin',
				pinBytes: new Uint8Array([0x01, 0x02, 0x03]),
				curBytes: new Uint8Array([0x01, 0x00, 0x03]),
				header: header(),
				existingBytes: null,
				tmpDir
			})
		);

		expect(code).toBe('FORBIDDEN-TARGET');
	});

	it('refuses a target that is not valid UTF-8', () => {
		const code = codeOf(() =>
			regeneratePatch({
				targetPath: 'source/a.ts',
				pinBytes: encodeUtf8(PIN),
				curBytes: new Uint8Array([0x63, 0x6f, 0x6e, 0xff, 0x0a]),
				header: header(),
				existingBytes: null,
				tmpDir
			})
		);

		expect(code).toBe('ENCODING');
	});

	it('accepts a target that never had a final newline at the pin', () => {
		const result = generate('const one = 1;', 'const one = 1;\nconst two = 2;', { targetPath: 'source/a.ts' });

		expect(textOf(result)).toContain('\\ No newline at end of file');
	});
});

describe('regeneratePatch on a new file', () => {
	it('does not confuse an existing empty pin file with an absent add-file target', () => {
		const text = textOf(generate('', 'export const host = 1;\n', { targetPath: 'source/empty.ts', pinExists: true }));

		expect(text).toContain('--- a/source/empty.ts\n');
		expect(text).not.toContain('--- /dev/null\n');
		expect(parseCkpatch(encodeUtf8(text), conventions(), 'x.ckpatch').isAddFile).toBe(false);
	});

	it('writes an add-file patch when the pin has no such file', () => {
		const text = textOf(generate('', 'export const host = 1;\n', { targetPath: 'source/ownHost.ts' }));

		expect(text).toContain('--- /dev/null\n');
		expect(text).toContain('+++ b/source/ownHost.ts\n');
		expect(parseCkpatch(encodeUtf8(text), conventions(), 'x.ckpatch').isAddFile).toBe(true);
	});
});
