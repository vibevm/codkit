// PROP-019 ##GEN-LICENSING (4): the renderings of the canonical licence text
// an installer reads instead of the text. The RTF is a plain document that
// stays inside ASCII whatever the text carries, and both renderings are the
// same bytes on every run.

import { describe, expect, it } from 'vitest';
import { renderLicencePlainText, renderLicenceRtf } from '../../src/lib/licenceRtf.ts';

const TEXT = [
	'# Fixture Private Licence',
	'',
	'Fixture **private** terms with `code` and a {brace} \\ backslash.',
	'## Section',
	'Второй абзац.',
	''
].join('\n');

describe('renderLicenceRtf', () => {
	it('is a plain RTF document with one paragraph per line, ending with a newline', () => {
		const rtf = renderLicenceRtf(TEXT);
		const lines = rtf.split('\n');

		expect(lines[0]).toBe('{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Arial;}}\\f0\\fs20');
		expect(lines.at(-2)).toBe('}');
		expect(rtf.endsWith('}\n')).toBe(true);
		// Five input lines, five paragraphs: the empty one is an empty paragraph.
		expect(lines.slice(1, 6).every((line) => line.endsWith('\\par'))).toBe(true);
		expect(lines[2]).toBe('\\par');
	});

	it('makes a Markdown heading bold and drops the emphasis marks', () => {
		const lines = renderLicenceRtf(TEXT).split('\n');

		expect(lines[1]).toBe('{\\b Fixture Private Licence}\\par');
		expect(lines[4]).toBe('{\\b Section}\\par');
		expect(lines[3]).toContain('Fixture private terms with code and a');
		expect(lines[3]).not.toContain('**');
		expect(lines[3]).not.toContain('`');
	});

	it('escapes the three syntax characters with a backslash', () => {
		const lines = renderLicenceRtf(TEXT).split('\n');

		expect(lines[3]).toBe('Fixture private terms with code and a \\{brace\\} \\\\ backslash.\\par');
	});

	it('writes every character outside ASCII as a signed 16-bit \\u escape, so no byte is above 0x7F', () => {
		const rtf = renderLicenceRtf(TEXT);

		expect(rtf.split('\n')[5]).toBe('\\u1042?\\u1090?\\u1086?\\u1088?\\u1086?\\u1081? \\u1072?\\u1073?\\u1079?\\u1072?\\u1094?.\\par');
		expect([...Buffer.from(rtf, 'utf8')].every((byte) => byte < 0x80)).toBe(true);
		// A code unit above 0x7FFF is written as its negative counterpart, and an
		// astral character as its two surrogate units.
		expect(renderLicenceRtf('Ａ\n')).toContain('\\u-223?\\par');
		expect(renderLicenceRtf('\u{1F600}\n')).toContain('\\u-10179?\\u-8704?\\par');
	});

	it('is deterministic', () => {
		expect(renderLicenceRtf(TEXT)).toBe(renderLicenceRtf(TEXT));
	});
});

describe('renderLicencePlainText', () => {
	it('strips the heading and emphasis marks, keeps the lines and ends with a newline', () => {
		expect(renderLicencePlainText(TEXT)).toBe(
			['Fixture Private Licence', '', 'Fixture private terms with code and a {brace} \\ backslash.', 'Section', 'Второй абзац.', ''].join(
				'\n'
			)
		);
	});

	it('adds the final newline a text without one lacks', () => {
		expect(renderLicencePlainText('# Title\ntext')).toBe('Title\ntext\n');
	});
});
