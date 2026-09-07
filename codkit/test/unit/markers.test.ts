// unit: the marker parser of PROP-004 sec. 3 (PROP-013 ##UT-MARKERS).
//
// Every case is a synthetic file: the parser reads bytes and an extension and
// answers with blocks and diagnostics, so no repository is needed. The forms
// come from the shipped conventions.json, not from a copy of it.

import { describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import { markerFormFor, parseMarkers } from '../../src/lib/markers.ts';
import type { MarkerParseResult } from '../../src/lib/markers.ts';
import type { ErrorCode } from '../../src/lib/messages.ts';
import { conventions } from '../support/conventions.ts';

function parse(text: string, ext: string): MarkerParseResult {
	return parseMarkers(encodeUtf8(text), ext, conventions(), `fixture${ext}`);
}

function codes(result: MarkerParseResult): ErrorCode[] {
	return result.errors.map((error) => error.code);
}

/** A file body with a marker block around one line, in the form of `ext`. */
function fileWithBlock(ext: string, id: string): string {
	const form = markerFormFor(ext, conventions());
	if (form === null) {
		throw new Error(`no marker form for ${ext}`);
	}
	return [
		'first line',
		`\t${form.open}begin ${id}${form.close}`,
		'\tthe body of the block',
		`\t${form.open}end ${id}${form.close}`,
		'last line',
		''
	].join('\n');
}

describe('marker forms', () => {
	it('finds the block in every comment form of PROP-004 sec. 1', () => {
		for (const ext of ['.ts', '.css', '.html', '.sh']) {
			const result = parse(fileWithBlock(ext, 'CK-workbench-001'), ext);

			expect(codes(result), ext).toEqual([]);
			expect(result.blocks, ext).toEqual([{ id: 'CK-workbench-001', beginLine: 2, endLine: 4 }]);
		}
	});

	it('accepts the js, md and yaml aliases of those forms', () => {
		for (const ext of ['.js', '.mjs', '.cjs', '.jsonc', '.md', '.svg', '.ps1', '.yml', '.yaml']) {
			const result = parse(fileWithBlock(ext, 'CK-build-042'), ext);

			expect(codes(result), ext).toEqual([]);
			expect(result.blocks.length, ext).toBe(1);
		}
	});

	it('refuses a file whose extension has no marker form', () => {
		const result = parse('{\n\t"a": 1\n}\n', '.json');

		expect(codes(result)).toEqual(['FORBIDDEN-TARGET']);
		expect(result.errors[0]?.hint).toContain('resource-file');
		expect(result.blocks).toEqual([]);
	});

	it('normalizes the extension it is given', () => {
		expect(markerFormFor('ts', conventions())).toEqual({ open: '// codkit:', close: '' });
		expect(markerFormFor('.TS', conventions())).toEqual({ open: '// codkit:', close: '' });
		expect(markerFormFor('.css', conventions())).toEqual({ open: '/* codkit:', close: ' */' });
	});

	it('ignores the documentation keys of markerComment', () => {
		expect(markerFormFor('_doc', conventions())).toBeNull();
	});
});

describe('marker rules', () => {
	it('reports MARKER-NESTED for a block inside a block', () => {
		const result = parse(
			[
				'// codkit:begin CK-workbench-001',
				'// codkit:begin CK-workbench-002',
				'// codkit:end CK-workbench-002',
				'// codkit:end CK-workbench-001',
				''
			].join('\n'),
			'.ts'
		);

		expect(codes(result)).toEqual(['MARKER-NESTED']);
		expect(result.errors[0]?.line).toBe(2);
	});

	it('reports MARKER-UNBALANCED for an end without a begin', () => {
		const result = parse('const a = 1;\n// codkit:end CK-workbench-001\n', '.ts');

		expect(codes(result)).toEqual(['MARKER-UNBALANCED']);
		expect(result.errors[0]?.line).toBe(2);
		expect(result.blocks).toEqual([]);
	});

	it('reports MARKER-UNBALANCED when the end closes another id', () => {
		const result = parse('// codkit:begin CK-workbench-001\n// codkit:end CK-workbench-002\n', '.ts');

		expect(codes(result)).toContain('MARKER-UNBALANCED');
	});

	it('reports MARKER-UNCLOSED for a block that never ends', () => {
		const result = parse('// codkit:begin CK-workbench-001\nconst a = 1;\n', '.ts');

		expect(codes(result)).toEqual(['MARKER-UNCLOSED']);
		// The diagnostic points at the begin marker, not at the end of the file.
		expect(result.errors[0]?.line).toBe(1);
	});

	it('lets one id open several blocks in a file: an import line and a call site are one graft', () => {
		const result = parse(
			[
				'// codkit:begin CK-workbench-001',
				"import { hook } from './patchset/hook.js';",
				'// codkit:end CK-workbench-001',
				'const between = 1;',
				'// codkit:begin CK-workbench-001',
				'hook(between);',
				'// codkit:end CK-workbench-001',
				''
			].join('\n'),
			'.ts'
		);

		expect(codes(result)).toEqual([]);
		expect(result.blocks.map((block) => [block.id, block.beginLine, block.endLine])).toEqual([
			['CK-workbench-001', 1, 3],
			['CK-workbench-001', 5, 7]
		]);
	});

	it('reports MARKER-BAD-ID for a well-formed marker with an unknown subsystem', () => {
		const result = parse('// codkit:begin CK-nosuch-001\n// codkit:end CK-nosuch-001\n', '.ts');

		expect(codes(result)).toEqual(['MARKER-BAD-ID', 'MARKER-BAD-ID']);
		expect(result.errors[0]?.message).toContain('CK-nosuch-001');
		// The block structure is still understood, so nothing cascades.
		expect(result.blocks).toEqual([{ id: 'CK-nosuch-001', beginLine: 1, endLine: 2 }]);
	});

	it('reports MARKER-MALFORMED for a line that mentions a marker but is not one', () => {
		const result = parse('\t// codkit:begin CK-Workbench-001 (mount point)\n', '.ts');

		expect(codes(result)).toEqual(['MARKER-MALFORMED']);
		expect(result.errors[0]?.line).toBe(1);
		expect(result.errors[0]?.hint).toContain('// codkit:begin');
	});

	it('reports MARKER-MALFORMED when the comment form belongs to another language', () => {
		const result = parse('/* codkit:begin CK-workbench-001 */\n', '.ts');

		expect(codes(result)).toEqual(['MARKER-MALFORMED']);
	});

	it('accepts leading indentation and nothing else on the line', () => {
		const ok = parse('\t\t\t// codkit:begin CK-editor-007\n\t\t\t// codkit:end CK-editor-007\n', '.ts');
		expect(codes(ok)).toEqual([]);

		const trailing = parse('// codkit:begin CK-editor-007 // and a note\n', '.ts');
		expect(codes(trailing)).toEqual(['MARKER-MALFORMED']);
	});
});

describe('marker parser byte rules', () => {
	it('reports CRLF and stops', () => {
		const result = parse('// codkit:begin CK-workbench-001\r\n// codkit:end CK-workbench-001\r\n', '.ts');

		expect(codes(result)).toEqual(['CRLF']);
		expect(result.errors[0]?.line).toBe(1);
		expect(result.errors[0]?.hint).toContain('core.autocrlf=false');
		expect(result.blocks).toEqual([]);
	});

	it('reports ENCODING for bytes that are not UTF-8', () => {
		// 0xff never appears in valid UTF-8.
		const result = parseMarkers(new Uint8Array([0x2f, 0x2f, 0x20, 0xff, 0x0a]), '.ts', conventions(), 'broken.ts');

		expect(result.errors.map((error) => error.code)).toEqual(['ENCODING']);
		expect(result.blocks).toEqual([]);
	});
});

describe('marker parser performance', () => {
	it('parses a 5000-line file in well under 50 ms', () => {
		const lines: string[] = [];
		for (let index = 0; index < 5000; index += 1) {
			if (index === 2000) {
				lines.push('\t// codkit:begin CK-workbench-001');
			} else if (index === 2002) {
				lines.push('\t// codkit:end CK-workbench-001');
			} else {
				lines.push(`\tconst value${index} = ${index}; // a line of an ordinary source file`);
			}
		}
		const bytes = encodeUtf8(`${lines.join('\n')}\n`);

		// One warm-up pass, so the measurement is not the regexp compiler's.
		parseMarkers(bytes, '.ts', conventions());
		const started = performance.now();
		const result = parseMarkers(bytes, '.ts', conventions());
		const elapsed = performance.now() - started;

		expect(result.blocks).toEqual([{ id: 'CK-workbench-001', beginLine: 2001, endLine: 2003 }]);
		expect(elapsed).toBeLessThan(50);
	});
});
