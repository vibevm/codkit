// unit: the .ckpatch format of PROP-004 sec. 4 (PROP-013 sec. 3, patchFormat row).
//
// The reference input is the valid sample of the spec itself, transcribed line
// by line so that no editor can quietly change its whitespace: the sample has a
// context line whose single leading space the spec text lost, and one that kept
// it, and the parser has to accept and reproduce both.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesEqual, encodeUtf8 } from '../../src/lib/bytes.ts';
import { isCkError } from '../../src/lib/messages.ts';
import {
	decodePatchName,
	encodePatchName,
	extractHeaderText,
	formatPatchHeader,
	parseCkpatch,
	serializeCkpatch
} from '../../src/lib/patchFormat.ts';
import type { ParsedPatch } from '../../src/lib/patchFormat.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { makePatchSet, PATCH_FILE_NAME, PATCH_ID } from '../fixtures/makePatchSet.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

/** The valid sample of PROP-004 sec. 4, one array element per line. */
const SPEC_SAMPLE_LINES = [
	'# codkit-patch: 2',
	'# id: CK-shell-001',
	'# type: hook',
	'# category: follow',
	'# owner: shell-core',
	'# reason: mount point for patchset center-area host initialization',
	'# link: none',
	'# cause: none',
	'# pin: 1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
	'# contract-tests: none',
	'--- a/source/app/browser/parts/example/examplePart.ts',
	'+++ b/source/app/browser/parts/example/examplePart.ts',
	'@@ -110,6 +110,9 @@',
	' \t}',
	// The spec text lost the single space of this context line; a real generator
	// writes " ". Both shapes are accepted, and both are written back unchanged.
	'',
	' \tprotected createExampleArea(parent: HTMLElement): void {',
	'+\t\t// codkit:begin CK-shell-001',
	'+\t\t// (hook body lives in own/ code; this block only delegates)',
	'+\t\t// codkit:end CK-shell-001',
	' \t\tthis.doCreateExampleArea(parent);',
	' \t}',
	' '
];

const SPEC_SAMPLE = `${SPEC_SAMPLE_LINES.join('\n')}\n`;
const SAMPLE_FILE = 'delta/patches/source__app__browser__parts__example__examplePart.ts.ckpatch';

function parse(text: string, file = SAMPLE_FILE): ParsedPatch {
	return parseCkpatch(encodeUtf8(text), conventions(), file);
}

/** Replace one line of the sample, keeping everything else byte for byte. */
function sampleWith(index: number, line: string): string {
	const lines = [...SPEC_SAMPLE_LINES];
	lines[index] = line;
	return `${lines.join('\n')}\n`;
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return isCkError(error) ? error.code : `not a CkError: ${String(error)}`;
	}
	return 'no error';
}

function hintOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return isCkError(error) ? (error.hint ?? 'no hint') : `not a CkError: ${String(error)}`;
	}
	return 'no error';
}

describe('patch file names', () => {
	it('encodes the upstream path with __ and the .ckpatch suffix', () => {
		expect(encodePatchName('source/app/browser/parts/titlebar/titlebarPart.ts')).toBe(
			'source__app__browser__parts__titlebar__titlebarPart.ts.ckpatch'
		);
		expect(encodePatchName('manifest.json')).toBe('manifest.json.ckpatch');
	});

	it('decodes back to the upstream path', () => {
		const path = 'source/app/browser/parts/titlebar/titlebarPart.ts';
		expect(decodePatchName(encodePatchName(path))).toBe(path);
	});

	it('refuses a path that already contains __', () => {
		expect(codeOf(() => encodePatchName('source/some__module/file.ts'))).toBe('INTERNAL');
		expect(() => encodePatchName('source/some__module/file.ts')).toThrow(/cannot encode patch name/);
	});

	it('refuses a file name that is not a .ckpatch', () => {
		expect(codeOf(() => decodePatchName('source__a.ts.patch'))).toBe('ARTIFACT-BROKEN');
	});
});

describe('parseCkpatch on the sample of the spec', () => {
	it('reads the header fields in the fixed order', () => {
		const patch = parse(SPEC_SAMPLE);

		expect(patch.header.schema).toBe(2);
		expect(patch.header.id).toBe('CK-shell-001');
		expect(patch.header.type).toBe('hook');
		expect(patch.header.category).toBe('follow');
		expect(patch.header.owner).toBe('shell-core');
		expect(patch.header.reason).toBe('mount point for patchset center-area host initialization');
		expect(patch.header.link).toBe('none');
		expect(patch.header.cause).toBe('none');
		expect(patch.header.pin).toBe('1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5');
		expect(patch.header.contractTests).toEqual([]);
	});

	it('reads the body as one file and one hunk', () => {
		const patch = parse(SPEC_SAMPLE);

		expect(patch.targetPath).toBe('source/app/browser/parts/example/examplePart.ts');
		expect(patch.isAddFile).toBe(false);
		expect(patch.hunks.length).toBe(1);

		const hunk = patch.hunks[0];
		expect(hunk?.startOld).toBe(110);
		expect(hunk?.countOld).toBe(6);
		expect(hunk?.startNew).toBe(110);
		expect(hunk?.countNew).toBe(9);
		expect(hunk?.lines.filter((line) => line.kind === '+').length).toBe(3);
		// Six context lines: the two blank ones count like any other.
		expect(hunk?.lines.filter((line) => line.kind === ' ').length).toBe(6);
		expect(hunk?.lines.filter((line) => line.bare).length).toBe(1);
	});

	it('serializes back to the very same bytes', () => {
		const original = encodeUtf8(SPEC_SAMPLE);
		const round = serializeCkpatch(parseCkpatch(original, conventions(), SAMPLE_FILE));

		expect(bytesEqual(round, original)).toBe(true);
	});

	it('hands the header back byte for byte', () => {
		expect(extractHeaderText(parse(SPEC_SAMPLE))).toBe(`${SPEC_SAMPLE_LINES.slice(0, 10).join('\n')}\n`);
	});
});

describe('parseCkpatch header validation', () => {
	it('refuses a schema version newer than the tool', () => {
		expect(codeOf(() => parse(sampleWith(0, '# codkit-patch: 3')))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(sampleWith(0, '# codkit-patch: 3'))).toThrow(/newer than the tool, update codkit/);
	});

	it('refuses the pre-user v1 format instead of creating a hybrid header', () => {
		expect(codeOf(() => parse(sampleWith(0, '# codkit-patch: 1')))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(sampleWith(0, '# codkit-patch: 1'))).toThrow(/pre-user hard break supports only 2/);
	});

	it('refuses a header whose fields are out of order', () => {
		const lines = [...SPEC_SAMPLE_LINES];
		const id = lines[1] ?? '';
		const type = lines[2] ?? '';
		lines[1] = type;
		lines[2] = id;

		expect(codeOf(() => parse(`${lines.join('\n')}\n`))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(`${lines.join('\n')}\n`)).toThrow(/out of order/);
	});

	it('refuses a header with a field missing', () => {
		// Dropping a field in the middle makes the next one arrive out of order;
		// dropping the last one leaves the header short.
		const withoutLink = SPEC_SAMPLE_LINES.filter((line) => !line.startsWith('# link:'));
		expect(() => parse(`${withoutLink.join('\n')}\n`)).toThrow(/field 7 must be "link"/);

		const withoutTests = SPEC_SAMPLE_LINES.filter((line) => !line.startsWith('# contract-tests:'));
		expect(() => parse(`${withoutTests.join('\n')}\n`)).toThrow(/"contract-tests" is missing/);
	});

	it('refuses an id, type or category outside the conventions', () => {
		expect(codeOf(() => parse(sampleWith(1, '# id: CK-nosuch-001')))).toBe('ARTIFACT-BROKEN');
		expect(codeOf(() => parse(sampleWith(2, '# type: rewrite')))).toBe('ARTIFACT-BROKEN');
		expect(codeOf(() => parse(sampleWith(3, '# category: whatever')))).toBe('ARTIFACT-BROKEN');
	});

	it('refuses a pin that is not <tag>@<sha>', () => {
		expect(codeOf(() => parse(sampleWith(8, '# pin: 1.135.0')))).toBe('ARTIFACT-BROKEN');
	});

	it('reads a comma-separated contract-tests list', () => {
		const patch = parse(sampleWith(9, '# contract-tests: a.guard.one,a.guard.two'));
		expect(patch.header.contractTests).toEqual(['a.guard.one', 'a.guard.two']);
	});
});

describe('parseCkpatch body validation', () => {
	it('refuses a generator header line', () => {
		const lines = [...SPEC_SAMPLE_LINES];
		lines.splice(10, 0, 'diff --git a/x b/x', 'index 1234567..89abcde 100644');

		expect(codeOf(() => parse(`${lines.join('\n')}\n`))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(`${lines.join('\n')}\n`)).toThrow(/generator header line/);
	});

	it('refuses two headers that name different files', () => {
		expect(codeOf(() => parse(sampleWith(11, '+++ b/source/app/browser/parts/example/other.ts')))).toBe('ARTIFACT-BROKEN');
	});

	it('refuses a hunk whose counts disagree with its body', () => {
		expect(codeOf(() => parse(sampleWith(12, '@@ -110,6 +110,8 @@')))).toBe('ARTIFACT-BROKEN');
	});

	it('refuses a patch that does not end with a line feed', () => {
		expect(codeOf(() => parse(SPEC_SAMPLE_LINES.join('\n')))).toBe('ARTIFACT-BROKEN');
	});

	it('refuses a second file in the same patch', () => {
		const doubled = `${SPEC_SAMPLE}--- a/source/other.ts\n+++ b/source/other.ts\n@@ -1 +1 @@\n-a\n+b\n`;

		expect(codeOf(() => parse(doubled))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(doubled)).toThrow(/second file/);
	});
});

describe('add-file and delete-file patches', () => {
	const ADD_FILE = [
		'# codkit-patch: 2',
		'# id: CK-shell-001',
		'# type: extend',
		'# category: own',
		'# owner: shell-core',
		'# reason: a new file in the upstream zone, allowed only as an exception',
		'# link: none',
		'# cause: none',
		'# pin: 1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
		'# contract-tests: none',
		'--- /dev/null',
		'+++ b/source/app/browser/parts/example/exampleHost.ts',
		'@@ -0,0 +1,3 @@',
		'+// codkit:begin CK-shell-001',
		'+export const exampleHost = 1;',
		'+// codkit:end CK-shell-001',
		''
	].join('\n');

	it('reads an add-file patch', () => {
		const patch = parse(ADD_FILE);

		expect(patch.isAddFile).toBe(true);
		expect(patch.targetPath).toBe('source/app/browser/parts/example/exampleHost.ts');
		expect(patch.hunks[0]?.startOld).toBe(0);
		expect(patch.hunks[0]?.countOld).toBe(0);
		expect(patch.hunks[0]?.countNew).toBe(3);
	});

	it('round-trips an add-file patch byte for byte', () => {
		const original = encodeUtf8(ADD_FILE);
		expect(bytesEqual(serializeCkpatch(parseCkpatch(original, conventions(), SAMPLE_FILE)), original)).toBe(true);
	});

	it('refuses a patch that deletes an upstream file', () => {
		const deleteFile = [
			...SPEC_SAMPLE_LINES.slice(0, 10),
			'--- a/source/app/browser/parts/example/examplePart.ts',
			'+++ /dev/null',
			'@@ -1,2 +0,0 @@',
			'-const a = 1;',
			'-const b = 2;',
			''
		].join('\n');

		expect(codeOf(() => parse(deleteFile))).toBe('DELETES-UPSTREAM-FILE');
		expect(hintOf(() => parse(deleteFile))).toContain('delta/removed.json');
	});
});

describe('formatPatchHeader', () => {
	it('writes the ten fields in the order the spec fixes', () => {
		const header = formatPatchHeader({
			id: 'CK-shell-001',
			type: 'hook',
			category: 'follow',
			owner: 'shell-core',
			reason: 'mount point for patchset center-area host initialization',
			link: 'none',
			cause: 'none',
			pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
			contractTests: []
		});

		expect(header).toBe(`${SPEC_SAMPLE_LINES.slice(0, 10).join('\n')}\n`);
	});

	it('writes no layer line for a plain patch, and one for an entry module', () => {
		const fields = {
			id: 'CK-build-001',
			type: 'extend' as const,
			category: 'own',
			owner: 'shell-core',
			reason: 'graft point of the patchset contribution',
			link: 'none',
			cause: 'none',
			pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
			contractTests: []
		};

		expect(formatPatchHeader({ ...fields, layer: 'patch' })).not.toContain('# layer:');
		expect(formatPatchHeader({ ...fields, layer: 'entry-module' }).split('\n')[2]).toBe('# layer: entry-module');
	});
});

// PROP-004 ##PH-LAYER: the field was added after patches already existed, so
// both shapes of the header are legal and both have to survive the round trip
// byte for byte - a header rewritten with a line it did not have would make
// every regeneration look like a change.
describe('the optional # layer: field', () => {
	/** The spec sample with `# layer: <value>` inserted after `# id:`. */
	function sampleWithLayer(value: string): string {
		const lines = [...SPEC_SAMPLE_LINES];
		lines.splice(2, 0, `# layer: ${value}`);
		return `${lines.join('\n')}\n`;
	}

	it('defaults to patch when the header does not carry it', () => {
		const patch = parse(SPEC_SAMPLE);

		expect(patch.header.layer).toBe('patch');
		expect(patch.header.layerExplicit).toBe(false);
	});

	it('reads an explicit patch and an explicit entry-module', () => {
		expect(parse(sampleWithLayer('patch')).header.layer).toBe('patch');
		expect(parse(sampleWithLayer('patch')).header.layerExplicit).toBe(true);

		const entry = parse(sampleWithLayer('entry-module'));
		expect(entry.header.layer).toBe('entry-module');
		expect(entry.header.layerExplicit).toBe(true);
		// Everything after the inserted line is still read as the same header.
		expect(entry.header.id).toBe('CK-shell-001');
		expect(entry.header.contractTests).toEqual([]);
	});

	it('serializes both shapes back to the very same bytes', () => {
		for (const text of [SPEC_SAMPLE, sampleWithLayer('entry-module')]) {
			const original = encodeUtf8(text);
			expect(bytesEqual(serializeCkpatch(parseCkpatch(original, conventions(), SAMPLE_FILE)), original)).toBe(true);
		}
	});

	it('hands the header back byte for byte, layer line included', () => {
		const text = sampleWithLayer('entry-module');
		expect(extractHeaderText(parse(text))).toBe(`${text.split('\n').slice(0, 11).join('\n')}\n`);
	});

	it('reads the rewrite-rule layer of a generated patch', () => {
		// PROP-004 ##PH-LAYER: a patch a rule engine produced is an ordinary
		// patch file that the inventory attributes to the rewrite-rule layer.
		expect(parse(sampleWithLayer('rewrite-rule')).header.layer).toBe('rewrite-rule');
	});

	it('refuses a layer that is not one of the patch layers', () => {
		expect(codeOf(() => parse(sampleWithLayer('config-overlay')))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(sampleWithLayer('config-overlay'))).toThrow(/header layer "config-overlay" is not one of the patch layers/);
		expect(hintOf(() => parse(sampleWithLayer('config-overlay')))).toContain('patch, entry-module, rewrite-rule');
	});

	it('refuses the layer line anywhere but after the id', () => {
		const lines = [...SPEC_SAMPLE_LINES];
		lines.splice(4, 0, '# layer: entry-module');

		expect(codeOf(() => parse(`${lines.join('\n')}\n`))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(`${lines.join('\n')}\n`)).toThrow(/out of order/);
	});

	it('still refuses a header that is missing a mandatory field', () => {
		const lines = [...SPEC_SAMPLE_LINES];
		lines.splice(9, 1); // drop `# contract-tests:`

		expect(codeOf(() => parse(`${lines.join('\n')}\n`))).toBe('ARTIFACT-BROKEN');
		expect(() => parse(`${lines.join('\n')}\n`)).toThrow(/header field "contract-tests" is missing/);
		// A field out of place is still named by the field that should be there.
		const swapped = [...SPEC_SAMPLE_LINES];
		swapped.splice(2, 1);
		expect(() => parse(`${swapped.join('\n')}\n`)).toThrow(/field 3 must be "type"/);
	});
});

describe('the patch of the patchset fixture', () => {
	let patchBytes: Uint8Array;

	beforeAll(() => {
		const upstream = makeUpstream(makeTempRoot('patchformat-upstream'));
		const patchset = makeTempRoot('patchformat-patchset');
		makePatchSet(patchset, upstream);
		patchBytes = readFileSync(join(patchset, 'delta', 'patches', PATCH_FILE_NAME));
	});

	afterAll(() => {
		cleanupTempRoots();
	});

	it('parses as a one-file, one-hunk patch of the fixture target', () => {
		const patch = parseCkpatch(patchBytes, conventions(), `delta/patches/${PATCH_FILE_NAME}`);

		expect(patch.header.id).toBe(PATCH_ID);
		expect(patch.targetPath).toBe(decodePatchName(PATCH_FILE_NAME));
		expect(patch.isAddFile).toBe(false);
		expect(patch.hunks.length).toBe(1);
		// git puts the enclosing declaration after the second @@; it is content of
		// the header line and is carried through untouched.
		expect(patch.hunks[0]?.header).toContain('@@ export class ExamplePart');
	});

	it('serializes back to the very same bytes', () => {
		const round = serializeCkpatch(parseCkpatch(patchBytes, conventions(), `delta/patches/${PATCH_FILE_NAME}`));

		expect(bytesEqual(round, patchBytes)).toBe(true);
	});
});
