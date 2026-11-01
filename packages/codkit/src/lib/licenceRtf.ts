/** @scope spec://codkit/modules/codkit/PROP-019#GEN-LICENSING */
// The renderings of the canonical licence text that an installer of a family
// reads instead of the text itself (##GEN-LICENSING (4)): a plain RTF document
// for the installers that show a licence page, and the text with its Markdown
// marks stripped for the ones that show a text file.
//
// Both are pure functions of the canonical text, so the artifact `gen
// licensing` writes and the expectation `verify` compares are the same bytes on
// every machine: one font face, no colour table, no timestamp, and every
// character outside printable ASCII written as an escape, which is what keeps
// the RTF readable by an installer that assumes a single-byte code page.

const RTF_PROLOGUE = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Arial;}}\\f0\\fs20';

/** A Markdown heading line: the marks, at least one space, the text. */
const HEADING = /^#{1,6}\s+(.*)$/u;

/** The emphasis marks a licence text written in Markdown carries: strong emphasis and code spans. */
const EMPHASIS_MARKS = /\*\*|`/gu;

/** The three characters RTF reads as syntax. */
const RTF_SYNTAX = new Set(['\\', '{', '}']);

/**
 * ##GEN-LICENSING (4): the canonical text as a plain RTF document, one
 * paragraph per line. A Markdown heading becomes a bold paragraph, an empty
 * line an empty paragraph, any other line its text; the emphasis marks are
 * dropped, because an installer's licence page has no Markdown renderer.
 */
export function renderLicenceRtf(text: string): string {
	const paragraphs = linesOf(text).map((line) => {
		const heading = HEADING.exec(line);
		if (heading !== null) return `{\\b ${rtfText(stripMarks(heading[1] ?? ''))}}\\par`;
		if (line.trim() === '') return '\\par';
		return `${rtfText(stripMarks(line))}\\par`;
	});
	return `${[RTF_PROLOGUE, ...paragraphs, '}'].join('\n')}\n`;
}

/** ##GEN-LICENSING (4): the canonical text with the heading and emphasis marks stripped, lines kept, ending with a newline. */
export function renderLicencePlainText(text: string): string {
	return `${linesOf(text)
		.map((line) => stripMarks(line.replace(HEADING, '$1')))
		.join('\n')}\n`;
}

/** The lines of the text, a final line terminator not counted as an empty line. */
function linesOf(text: string): readonly string[] {
	const lines = text.replace(/\r\n?/gu, '\n').split('\n');
	if (lines.at(-1) === '') lines.pop();
	return lines;
}

function stripMarks(line: string): string {
	return line.replace(EMPHASIS_MARKS, '');
}

/**
 * One line as RTF text: the syntax characters escaped with a backslash, a tab
 * as the control word, and every code unit outside printable ASCII as `\uN?`
 * with N the signed 16-bit value the format wants - an astral character is two
 * surrogate units and becomes two escapes, which RTF readers reassemble.
 */
function rtfText(line: string): string {
	let out = '';
	for (let index = 0; index < line.length; index += 1) {
		const character = line.charAt(index);
		const unit = line.charCodeAt(index);
		if (RTF_SYNTAX.has(character)) out += `\\${character}`;
		else if (unit === 0x09) out += '\\tab ';
		else if (unit >= 0x20 && unit <= 0x7e) out += character;
		else out += `\\u${unit > 0x7fff ? unit - 0x10000 : unit}?`;
	}
	return out;
}
