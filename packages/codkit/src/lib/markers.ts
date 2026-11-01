/** @scope spec://codkit/modules/codkit/PROP-004#root */
// Marker parsing: the algorithm of PROP-004 sec. 3, with the marker forms of sec. 1
// and the rules of sec. 2.
//
// A marker carries an id and nothing else (##MARKER-CARRIES-ONLY-ID); everything a
// human needs about the intervention lives in the artifact that owns the id. So
// this module answers exactly one question about a file: which line ranges are
// codkit blocks, and what is wrong with the marker lines it found.
//
// The pass is linear and allocates one regular expression per call: pre-commit
// runs it over every changed file (##PARSER-PERFORMANCE).

import { decodeUtf8Strict, escapeRegExp } from './bytes.ts';
import { ckError } from './messages.ts';
import type { CkError } from './messages.ts';

/** One marker form: the text before the keyword and the text after the id. */
export type MarkerForm = {
	/** Everything up to and including `codkit:`, e.g. `// codkit:`. */
	readonly open: string;
	/** Comment terminator (the CSS form ends the comment); empty for line comments. */
	readonly close: string;
};

/**
 * The slice of conventions.json this module reads (PROP-003 sec. 3). It is a
 * structural type on purpose: the parsed conventions object satisfies it, and
 * tests can pass a hand-made one without inventing a loader.
 */
export type MarkerConventions = {
	readonly idPattern: string;
	readonly markerComment: Readonly<Record<string, unknown>>;
};

export type MarkerBlock = {
	readonly id: string;
	/** 1-based line of the `begin` marker. */
	readonly beginLine: number;
	/** 1-based line of the `end` marker. */
	readonly endLine: number;
};

export type MarkerParseResult = {
	readonly blocks: readonly MarkerBlock[];
	readonly errors: readonly CkError[];
};

/**
 * The keyword pair the parser looks for when a line fails to match the form.
 * Exported because the rewrite-rule layer has to check that the lines a rule
 * inserts open and close a block, and there is one definition of the words.
 */
export const BEGIN_TOKEN = 'codkit:begin';
export const END_TOKEN = 'codkit:end';

/** Documentation keys of `markerComment`; never matched against an extension. */
const DOC_KEY_PREFIX = '_';

/**
 * The marker form for a file extension, or null when the extension has none.
 * A file without a form cannot carry a marker at all (##MR-BLIND-ZONES): its
 * interventions belong to the overlay or resource-file layer.
 */
export function markerFormFor(ext: string, conventions: MarkerConventions): MarkerForm | null {
	const key = normalizeExtension(ext);
	if (key.startsWith(`.${DOC_KEY_PREFIX}`)) {
		return null;
	}
	const raw = conventions.markerComment[key];
	if (raw === undefined) {
		return null;
	}
	return readForm(raw, key);
}

/**
 * Parse the marker blocks of one file (PROP-004 sec. 3).
 *
 * Diagnosed conditions are returned, not thrown: `verify` reports every problem
 * of a file in one pass. `file` is the path used in the diagnostics.
 */
/**
 * ##ADD-FILE-EXEMPTION: the markers of a file the pin does not carry. A new file
 * whose extension has no marker form carries no block, and that is a legal
 * state - there are no upstream lines to protect in it - rather than the
 * refusal `parseMarkers` gives a patched upstream file without a comment syntax.
 */
export function parseMarkersOfNewFile(bytes: Uint8Array, ext: string, conventions: MarkerConventions, file?: string): MarkerParseResult {
	return markerFormFor(ext, conventions) === null ? { blocks: [], errors: [] } : parseMarkers(bytes, ext, conventions, file);
}

export function parseMarkers(bytes: Uint8Array, ext: string, conventions: MarkerConventions, file?: string): MarkerParseResult {
	const form = markerFormFor(ext, conventions);
	if (form === null) {
		return {
			blocks: [],
			errors: [
				ckError(
					'FORBIDDEN-TARGET',
					`no marker form is defined for "${normalizeExtension(ext)}" files, so this file cannot carry a codkit marker`,
					'a target without a comment syntax belongs to the config-overlay or resource-file layer, not to a patch',
					file
				)
			]
		};
	}

	const text = decodeUtf8Strict(bytes);
	if (text === null) {
		return {
			blocks: [],
			errors: [
				ckError(
					'ENCODING',
					'file is not valid UTF-8',
					'codkit reads and writes UTF-8 only; re-save the file as UTF-8 without a byte order mark',
					file
				)
			]
		};
	}

	const pattern = markerPattern(form);
	const idPattern = new RegExp(conventions.idPattern);
	const lines = text.split('\n');
	const open: { id: string; line: number }[] = [];
	const blocks: MarkerBlock[] = [];
	const errors: CkError[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		const lineNumber = index + 1;

		if (line.includes('\r')) {
			// A carriage return makes every later line number a guess; stop here.
			errors.push(
				ckError(
					'CRLF',
					'file has CRLF line endings',
					'codkit works on LF only; set core.autocrlf=false and core.eol=lf, then re-check out the tree',
					file,
					lineNumber
				)
			);
			return { blocks: [], errors };
		}

		const match = pattern.exec(line);
		if (match === null) {
			if (line.includes(BEGIN_TOKEN) || line.includes(END_TOKEN)) {
				errors.push(
					ckError(
						'MARKER-MALFORMED',
						`line mentions a codkit marker but does not have the marker form for "${normalizeExtension(ext)}"`,
						`write it as: ${form.open}begin <id>${form.close}`,
						file,
						lineNumber
					)
				);
			}
			continue;
		}

		const kind = match[1];
		const id = match[2];
		if (kind === undefined || id === undefined) {
			continue;
		}
		if (!idPattern.test(id)) {
			errors.push(
				ckError(
					'MARKER-BAD-ID',
					`marker id "${id}" does not match the id pattern of conventions.json`,
					`use an id of the form CK-<subsystem>-<NNN> with a subsystem from conventions.json (pattern: ${conventions.idPattern})`,
					file,
					lineNumber
				)
			);
		}

		if (kind === 'begin') {
			if (open.length > 0) {
				errors.push(
					ckError(
						'MARKER-NESTED',
						`marker block "${id}" starts inside block "${open[open.length - 1]?.id ?? ''}"`,
						'nested marker blocks are forbidden; close the outer block first (PROP-004 ##MR-NO-NESTING)',
						file,
						lineNumber
					)
				);
			}
			// The same id may open several blocks in one file: a graft is usually
			// an import line and a call site (PROP-004 ##MR-SEVERAL-BLOCKS-ONE-ID).
			open.push({ id, line: lineNumber });
			continue;
		}

		const top = open[open.length - 1];
		if (top === undefined || top.id !== id) {
			errors.push(
				ckError(
					'MARKER-UNBALANCED',
					top === undefined
						? `end marker "${id}" has no matching begin marker`
						: `end marker "${id}" does not close the open block "${top.id}"`,
					'every codkit:end must close the codkit:begin directly above it',
					file,
					lineNumber
				)
			);
			continue;
		}
		blocks.push({ id, beginLine: top.line, endLine: lineNumber });
		open.pop();
	}

	// The stack is unwound from the innermost block outwards, so the deepest
	// unclosed marker is reported first.
	for (let index = open.length - 1; index >= 0; index -= 1) {
		const entry = open[index];
		if (entry === undefined) {
			continue;
		}
		errors.push(
			ckError(
				'MARKER-UNCLOSED',
				`marker block "${entry.id}" is never closed`,
				`add ${form.open}end ${entry.id}${form.close} at the end of the block`,
				file,
				entry.line
			)
		);
	}

	return { blocks, errors };
}

/** Is `line` (1-based) inside one of the blocks, markers included? */
export function blockAt(blocks: readonly MarkerBlock[], line: number): MarkerBlock | null {
	for (const block of blocks) {
		if (line >= block.beginLine && line <= block.endLine) {
			return block;
		}
	}
	return null;
}

/** `.TS` and `ts` both mean `.ts`; conventions.json is keyed by the dotted form. */
export function normalizeExtension(ext: string): string {
	const lowered = ext.toLowerCase();
	return lowered.startsWith('.') ? lowered : `.${lowered}`;
}

/**
 * ##MR-FORM-KEY: the key of a path in `markerComment` - its extension, or the
 * whole name of a file that begins with a dot and carries no extension
 * (`.vscodeignore`, `.gitignore`), which `extname` reads as nameless. Every
 * reader and writer of markers keys a path through this one function, so a
 * file without a key has no form everywhere alike.
 */
export function markerKeyOf(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	if (dot > 0) return name.slice(dot);
	return dot === 0 ? name : '';
}

/**
 * `^\s*<open>(begin|end)\s+(CK-[a-z]+-[0-9]{3})\s*<close>\s*$` with the form
 * quoted (PROP-004 sec. 3). The id shape here is deliberately looser than
 * `idPattern`: a well-formed marker with an unknown subsystem must be reported
 * as a bad id, not as a malformed line.
 */
function markerPattern(form: MarkerForm): RegExp {
	return new RegExp(`^\\s*${escapeRegExp(form.open)}(begin|end)\\s+(CK-[a-z]+-[0-9]{3})\\s*${escapeRegExp(form.close)}\\s*$`);
}

function readForm(raw: unknown, key: string): MarkerForm {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw ckError('INTERNAL', `conventions.markerComment["${key}"] must be an object with "open" and "close"`);
	}
	const record = raw as Record<string, unknown>;
	const open = record['open'];
	const close = record['close'];
	if (typeof open !== 'string' || open === '' || typeof close !== 'string') {
		throw ckError('INTERNAL', `conventions.markerComment["${key}"] must be {"open": "<prefix>", "close": "<suffix>"}`);
	}
	return { open, close };
}
