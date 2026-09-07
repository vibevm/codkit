/** @scope spec://codkit/modules/codkit/PROP-014#STD-MANIFEST-STATE-MACHINE */
// The managed block: how codkit writes into a file it does not own.
//
// ##STD-MANIFEST-NO-TOML-PARSER: the block is found by a deterministic byte
// scan over whole marker lines, and every byte outside it belongs to someone
// else. Parsing and reserialising the file would lose the comments and the
// order its owner chose, and a "smart" detector would sooner or later delete
// something it misread.
//
// Two files use this automaton with different markers: the product manifest
// (##STD-MANIFEST-STATE-MACHINE) and the scrape contract
// (##STD-SCRAPE-STATE-MACHINE). One implementation, two instances - a second
// copy would drift.
//
// There is no auto-repair. A malformed block is a hard stop with the line
// numbers, and a person decides (managed-blocks: never auto-repair).

import { ckError } from './messages.ts';

export type BlockMarkers = {
	/** The whole line that opens the block, with no trailing spaces. */
	readonly begin: string;
	/** The whole line that closes it. */
	readonly end: string;
	/**
	 * Strings that must not appear outside the block: our own identifiers and
	 * paths. A line that carries one is somebody's private copy of what codkit
	 * maintains, and the two would contradict each other.
	 */
	readonly needles: readonly string[];
};

export type BlockState = 'absent' | 'present' | 'malformed';

export type BlockScan = {
	readonly state: BlockState;
	/** 1-based line of the begin marker, or null. */
	readonly beginLine: number | null;
	readonly endLine: number | null;
	/** 1-based line of a needle found outside the block, or null. */
	readonly outsideEntryLine: number | null;
	/**
	 * 1-based line of the first non-empty, non-comment line after the block:
	 * the block opens a table, and a key written there would land inside it
	 * (##STD-MANIFEST-TAIL-CAVEAT).
	 */
	readonly tailWarningLine: number | null;
	/** Why the block is malformed, for the refusal message. */
	readonly reason: string | null;
	/** The block's own bytes, when it is present. */
	readonly text: string | null;
};

export type BlockApply = {
	readonly text: string;
	readonly action: 'append' | 'update' | 'unchanged';
};

/**
 * Classify the file. CR is refused by the caller before this runs, so lines
 * split on LF alone.
 */
export function scanBlock(text: string, markers: BlockMarkers): BlockScan {
	const lines = text.split('\n');
	const begins: number[] = [];
	const ends: number[] = [];
	for (const [index, line] of lines.entries()) {
		if (line === markers.begin) begins.push(index);
		if (line === markers.end) ends.push(index);
	}
	const empty = { beginLine: null, endLine: null, outsideEntryLine: null, tailWarningLine: null, text: null } as const;

	if (begins.length === 0 && ends.length === 0) {
		return { ...empty, state: 'absent', reason: null, outsideEntryLine: needleOutside(lines, markers, null, null) };
	}
	if (begins.length !== 1 || ends.length !== 1) {
		return {
			...empty,
			state: 'malformed',
			beginLine: begins[0] === undefined ? null : begins[0] + 1,
			endLine: ends[0] === undefined ? null : ends[0] + 1,
			reason: `${begins.length} begin marker(s) and ${ends.length} end marker(s), expected one of each`
		};
	}
	const begin = begins[0] ?? 0;
	const end = ends[0] ?? 0;
	if (begin > end) {
		return {
			...empty,
			state: 'malformed',
			beginLine: begin + 1,
			endLine: end + 1,
			reason: `the end marker is on line ${end + 1}, before the begin marker on line ${begin + 1}`
		};
	}
	return {
		state: 'present',
		beginLine: begin + 1,
		endLine: end + 1,
		outsideEntryLine: needleOutside(lines, markers, begin, end),
		tailWarningLine: tailWarning(lines, end),
		reason: null,
		text: lines.slice(begin, end + 1).join('\n')
	};
}

/**
 * A needle in a line outside the block that is not itself a comment. A comment
 * mentioning our identifier is prose, not a competing entry.
 */
function needleOutside(lines: readonly string[], markers: BlockMarkers, begin: number | null, end: number | null): number | null {
	for (const [index, line] of lines.entries()) {
		if (begin !== null && end !== null && index >= begin && index <= end) continue;
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		if (markers.needles.some((needle) => line.includes(needle))) return index + 1;
	}
	return null;
}

function tailWarning(lines: readonly string[], end: number): number | null {
	for (let index = end + 1; index < lines.length; index += 1) {
		const trimmed = (lines[index] ?? '').trim();
		if (trimmed === '') continue;
		if (trimmed.startsWith('#')) continue;
		return trimmed.startsWith('[') ? null : index + 1;
	}
	return null;
}

/**
 * The bytes the file should have. `absent` appends the block at the end after a
 * blank line; `present` replaces the block's lines and nothing else. A result
 * equal to the input is reported `unchanged` and the caller does not write.
 */
export function applyBlock(text: string, canonical: string, markers: BlockMarkers): BlockApply {
	const scan = scanBlock(text, markers);
	if (scan.state === 'malformed') {
		throw ckError(
			'CONFIG',
			`the codkit block is malformed: ${scan.reason ?? 'unknown shape'}`,
			'repair the markers by hand; codkit never auto-repairs a block'
		);
	}
	if (scan.state === 'present') {
		if (scan.text === canonical) return { text, action: 'unchanged' };
		const lines = text.split('\n');
		const begin = (scan.beginLine ?? 1) - 1;
		const end = (scan.endLine ?? 1) - 1;
		const updated = [...lines.slice(0, begin), ...canonical.split('\n'), ...lines.slice(end + 1)].join('\n');
		return { text: updated, action: updated === text ? 'unchanged' : 'update' };
	}
	// Append: end the file with a newline, leave one blank line, then the block
	// with a trailing newline of its own.
	const head = text === '' || text.endsWith('\n') ? text : `${text}\n`;
	return { text: `${head}\n${canonical}\n`, action: 'append' };
}

/** CR anywhere means the file is not the LF text this automaton edits. */
export function refuseCarriageReturn(text: string, what: string): void {
	if (text.includes('\r')) {
		throw ckError('CRLF', `${what} contains CR`, `save ${what} with LF line endings before running codkit`, what);
	}
}
