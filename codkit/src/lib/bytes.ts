/** @scope spec://codkit/modules/codkit/PROP-004#root */
// Byte-level helpers shared by the marker, patch and diff modules.
//
// codkit reasons about files as bytes, not as strings: the artifacts it writes
// are compared byte-for-byte (PROP-004 ##GEN-BYTE-COMPARE) and the files it reads
// are refused when they are not valid UTF-8 (PROP-004 sec. 3, ##GEN-BYTE-PREDICATES).
// Every module that needs those two operations gets them from here, so there is
// exactly one strict decoder and one comparison in the tool.

const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** NUL: the byte that makes a file binary for git and for codkit alike. */
export const NUL_BYTE = 0x00;

/** Carriage return: never a legal line ending in a codkit-managed tree. */
export const CR_BYTE = 0x0d;

/** Line feed: the only line ending codkit reads or writes. */
export const LF_BYTE = 0x0a;

/**
 * Decode UTF-8 or fail. Returns null instead of throwing so that callers can
 * turn the failure into their own diagnostic (CK-E-ENCODING) with a file name.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
	try {
		return strictDecoder.decode(bytes);
	} catch {
		return null;
	}
}

export function encodeUtf8(text: string): Uint8Array {
	return encoder.encode(text);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

export function containsByte(bytes: Uint8Array, value: number): boolean {
	return bytes.indexOf(value) !== -1;
}

/** Does the content end with a line feed? An empty file does not. */
export function endsWithNewline(bytes: Uint8Array): boolean {
	return bytes.length > 0 && bytes[bytes.length - 1] === LF_BYTE;
}

export type TextLines = {
	/** Lines without their terminators; an empty file has no lines at all. */
	readonly lines: readonly string[];
	/** False when the last line is not terminated by a line feed. */
	readonly finalNewline: boolean;
};

/**
 * Split decoded text into lines the way a diff tool sees them: the trailing
 * newline is a property of the file, not an extra empty line. An empty file
 * yields no lines and counts as terminated, which is what "no missing newline"
 * means for a file with nothing in it.
 */
export function splitTextLines(text: string): TextLines {
	if (text === '') {
		return { lines: [], finalNewline: true };
	}
	if (text.endsWith('\n')) {
		return { lines: text.slice(0, -1).split('\n'), finalNewline: true };
	}
	return { lines: text.split('\n'), finalNewline: false };
}

/** Inverse of splitTextLines. */
export function joinTextLines(lines: readonly string[], finalNewline: boolean): string {
	if (lines.length === 0) {
		return '';
	}
	return finalNewline ? `${lines.join('\n')}\n` : lines.join('\n');
}

/** Escape a literal so it can be embedded in a RegExp source. */
export function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
