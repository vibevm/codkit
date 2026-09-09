/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// XPM for the RPM icon, hand-written (IMAGESET-CONTAINERS): XPM3, the C-array
// form the distribution ships - `static char * <name>_xpm[] = {` - with one
// character per pixel while the palette fits 92 colours and two while it does
// not. The palette is built by exact-colour histogram first, so flat artwork
// keeps the small palette it deserves; quantisation fills in only when the
// master really has more colours. Parsing reads the header - the RPM icon's
// dimensions and palette size are discovered from the shipped file.

import { brokenArtifact } from '@codkit/type-api';
import type { Rgba } from '@codkit/type-api';
import { nearestPaletteIndex, quantisePalette } from './palette.ts';
import type { PaletteColor } from './palette.ts';

export type XpmStructure = {
	readonly width: number;
	readonly height: number;
	readonly colors: number;
	readonly charsPerPixel: number;
};

/** Printable ASCII minus the two characters XPM strings cannot carry. */
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_{|}~';

function broken(message: string, hint: string): Error {
	return brokenArtifact(`XPM: ${message}`, hint);
}

/** Read the header of an XPM3 file: dimensions, palette size, code width. */
export function parseXpm(text: string): XpmStructure {
	const values = headerValues(text);
	if (values.length < 4) {
		throw broken('no four-value header line was found', 'the target must be an ordinary XPM3 file');
	}
	const width = values[0];
	const height = values[1];
	const colors = values[2];
	const charsPerPixel = values[3];
	if (width === undefined || height === undefined || colors === undefined || charsPerPixel === undefined) {
		throw broken('the header line does not carry four numbers', 'the target must be an ordinary XPM3 file');
	}
	if (width <= 0 || height <= 0 || colors <= 0 || charsPerPixel <= 0) {
		throw broken(`nonsensical header ${width} ${height} ${colors} ${charsPerPixel}`, 'the target must be an intact XPM file');
	}
	return { width, height, colors, charsPerPixel };
}

function headerValues(text: string): number[] {
	for (const line of text.split('\n')) {
		const inQuotes = /"([^"]*)"/.exec(line);
		if (inQuotes === null) {
			continue;
		}
		const fields = (inQuotes[1] ?? '').trim().split(/\s+/);
		if (fields.length >= 4 && fields.slice(0, 4).every((field) => /^\d+$/.test(field))) {
			return fields.slice(0, 4).map((field) => Number.parseInt(field, 10));
		}
	}
	return [];
}

/**
 * Write XPM3: palette by exact histogram with median-cut overflow, 'None' for
 * transparency, one pixel per code with no separator. `name` is the C
 * identifier the array carries; it is the target file's stem, because the
 * distribution's own file names it that way.
 */
export function encodeXpm(image: Rgba, name: string, maxColors = 92): string {
	const palette = quantisePalette(image, maxColors);
	if (palette.length === 0) {
		throw broken('the image quantised to an empty palette', 'the master must carry at least one colour');
	}
	const charsPerPixel = palette.length <= CODE_ALPHABET.length ? 1 : 2;
	const codes = palette.map((_, index) => code(index, charsPerPixel));
	const { width, height, data } = image;
	const lines: string[] = ['/* XPM */', `static char * ${name}_xpm[] = {`, `"${width} ${height} ${palette.length} ${charsPerPixel}",`];
	palette.forEach((color, index) => {
		lines.push(`"${codes[index] ?? ''}\tc ${colorText(color)}",`);
	});
	// Flat art maps a handful of distinct colours over a million pixels; the
	// cache keeps the nearest-colour search from running per pixel.
	const nearest = new Map<number, number>();
	for (let y = 0; y < height; y += 1) {
		let row = '';
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const key = ((data[at] ?? 0) << 16) | ((data[at + 1] ?? 0) << 8) | (data[at + 2] ?? 0) | ((data[at + 3] ?? 0) < 128 ? 1 << 24 : 0);
			let index = nearest.get(key);
			if (index === undefined) {
				index = nearestPaletteIndex(image, at, palette);
				nearest.set(key, index);
			}
			row += codes[index] ?? '';
		}
		lines.push(`"${row}",`);
	}
	lines.push('};', '');
	return lines.join('\n');
}

function colorText(color: PaletteColor): string {
	if (color.transparent) {
		return 'None';
	}
	return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

function hex(value: number): string {
	return value.toString(16).padStart(2, '0').toUpperCase();
}

function code(index: number, charsPerPixel: number): string {
	const alphabetLength = CODE_ALPHABET.length;
	if (charsPerPixel === 1) {
		return CODE_ALPHABET[index] ?? '?';
	}
	const high = Math.floor(index / alphabetLength);
	const low = index % alphabetLength;
	return `${CODE_ALPHABET[high] ?? '?'}${CODE_ALPHABET[low] ?? '?'}`;
}
