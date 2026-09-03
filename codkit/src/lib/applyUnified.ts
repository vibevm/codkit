/** @scope spec://codkit/modules/codkit/PROP-006#root */
// Applying a .ckpatch in memory, with exact context matching (PROP-006 sec. 5).
//
// This is not a patch tool: it never searches, never shifts a hunk and never
// fuzzes a context line. A codkit patch is regenerated against its own pin by
// construction, so the only correct behaviour when a context line disagrees is
// to say so. Everything that needs "the file with our change applied" - the
// hunks-in-markers check, the inventory, verify - goes through here, so a patch
// that drifted from its pin is caught once, in one place.

import { decodeUtf8Strict, encodeUtf8, joinTextLines, splitTextLines } from './bytes.ts';
import { ckError } from './messages.ts';
import type { Hunk, HunkLine, ParsedPatch } from './patchFormat.ts';

/** Apply `patch` to the bytes of its target at the pin. Throws on any mismatch. */
export function applyUnified(baseBytes: Uint8Array, patch: ParsedPatch): Uint8Array {
	const text = decodeUtf8Strict(baseBytes);
	if (text === null) {
		throw ckError(
			'ENCODING',
			'the file at the pin is not valid UTF-8, so the patch cannot be applied in memory',
			'a binary target belongs to the resource-file layer, not to a patch',
			patch.targetPath
		);
	}
	const base = splitTextLines(text);
	if (patch.isAddFile && base.lines.length > 0) {
		throw broken(patch, `the patch adds ${patch.targetPath} as a new file, but the pin already has it`, patch.hunks[0]?.headerLine);
	}

	const out: string[] = [];
	/** 1-based line of the pin that has not been consumed yet. */
	let oldLine = 1;
	/** Final-newline state of what has been emitted so far. */
	let noFinalNewline = false;
	/** Set when a directive told us the pin's last line has no terminator. */
	let pinNoNewlineSeen = false;

	for (const hunk of patch.hunks) {
		if (hunk.startOld < oldLine - 1 || (hunk.countOld > 0 && hunk.startOld < oldLine)) {
			throw broken(
				patch,
				`hunk "${hunk.header}" starts at or before line ${oldLine - 1}, which an earlier hunk already consumed`,
				hunk.headerLine
			);
		}
		// Copy the untouched lines between the previous hunk and this one.
		const from = hunk.countOld === 0 ? hunk.startOld + 1 : hunk.startOld;
		while (oldLine < from) {
			out.push(requireBaseLine(base.lines, oldLine, patch, hunk));
			oldLine += 1;
			noFinalNewline = false;
		}

		let seenOld = 0;
		let seenNew = 0;
		for (let index = 0; index < hunk.lines.length; index += 1) {
			const line = hunk.lines[index];
			if (line === undefined) {
				continue;
			}
			if (line.kind === '\\') {
				const sides = applyNoNewlineDirective(hunk, index, base, oldLine, patch);
				if (sides.old) {
					pinNoNewlineSeen = true;
				}
				if (sides.new) {
					noFinalNewline = true;
				}
				continue;
			}
			if (line.kind === ' ' || line.kind === '-') {
				const actual = requireBaseLine(base.lines, oldLine, patch, hunk);
				if (actual !== line.text) {
					throw broken(
						patch,
						`context mismatch at ${patch.targetPath}:${oldLine}: the patch expects ${quote(line.text)} but the pin has ${quote(actual)}`,
						hunk.headerLine
					);
				}
				oldLine += 1;
				seenOld += 1;
			}
			if (line.kind === ' ' || line.kind === '+') {
				out.push(line.text);
				seenNew += 1;
				noFinalNewline = false;
			}
		}
		if (seenOld !== hunk.countOld || seenNew !== hunk.countNew) {
			throw broken(
				patch,
				`hunk "${hunk.header}" applied ${seenOld}/${seenNew} lines instead of ${hunk.countOld}/${hunk.countNew}`,
				hunk.headerLine
			);
		}
	}

	// The tail after the last hunk is copied verbatim, and carries the pin's own
	// final-newline state with it.
	if (oldLine <= base.lines.length) {
		while (oldLine <= base.lines.length) {
			out.push(requireBaseLine(base.lines, oldLine, patch, patch.hunks[patch.hunks.length - 1]));
			oldLine += 1;
		}
		noFinalNewline = !base.finalNewline;
	} else if (!base.finalNewline && !pinNoNewlineSeen && !patch.isAddFile) {
		// The pin's last line has no terminator and the patch consumed it without
		// saying so: applying it would silently add a newline.
		throw broken(
			patch,
			`${patch.targetPath} has no newline at the end of the file at the pin, but the patch does not mark it`,
			patch.hunks[patch.hunks.length - 1]?.headerLine
		);
	}

	return encodeUtf8(joinTextLines(out, !noFinalNewline));
}

/** Which side of the diff a `\ No newline at end of file` directive describes. */
type NoNewlineSides = { readonly old: boolean; readonly new: boolean };

/**
 * `\ No newline at end of file` refers to the line above it: to the pin when
 * that line is context or removed, to the result when it is context or added.
 * The assertion about the pin is checked here, so a patch that claims a missing
 * terminator the pin does not have is refused instead of silently applied.
 */
function applyNoNewlineDirective(
	hunk: Hunk,
	index: number,
	base: { readonly lines: readonly string[]; readonly finalNewline: boolean },
	oldLine: number,
	patch: ParsedPatch
): NoNewlineSides {
	const previous = previousBodyLine(hunk, index);
	if (previous === null) {
		throw broken(patch, `hunk "${hunk.header}" starts with a "\\ No newline at end of file" directive`, hunk.headerLine);
	}
	if (previous.kind === '+') {
		return { old: false, new: true };
	}
	if (base.finalNewline || oldLine - 1 !== base.lines.length) {
		throw broken(
			patch,
			`the patch says ${patch.targetPath} has no newline at the end of the file at the pin, but it does`,
			hunk.headerLine
		);
	}
	return { old: true, new: previous.kind === ' ' };
}

function previousBodyLine(hunk: Hunk, index: number): HunkLine | null {
	for (let at = index - 1; at >= 0; at -= 1) {
		const line = hunk.lines[at];
		if (line !== undefined && line.kind !== '\\') {
			return line;
		}
	}
	return null;
}

function requireBaseLine(lines: readonly string[], oldLine: number, patch: ParsedPatch, hunk: Hunk | undefined): string {
	const line = lines[oldLine - 1];
	if (line === undefined) {
		throw broken(
			patch,
			`the patch reads line ${oldLine} of ${patch.targetPath}, but the file at the pin has ${lines.length} line(s)`,
			hunk?.headerLine
		);
	}
	return line;
}

function quote(text: string): string {
	return JSON.stringify(text);
}

function broken(patch: ParsedPatch, message: string, line: number | undefined): Error {
	return ckError(
		'ARTIFACT-BROKEN',
		message,
		`the patch no longer matches its pin (${patch.header.pin}); regenerate it with codkit save, or resolve it in an upgrade cycle`,
		patch.targetPath,
		line
	);
}
