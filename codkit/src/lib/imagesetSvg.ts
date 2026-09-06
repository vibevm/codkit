/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-SVG-PASSTHROUGH */
// SVG targets (IMAGESET-SVG-PASSTHROUGH): the distribution ships a few brand
// images as vectors that the application loads as vectors - the empty-editor
// watermarks. For those there is nothing to rasterise: the master IS the
// artifact, and regeneration means emitting the master's bytes unchanged.
//
// Only two things are read out of the document, and both are read to be
// checked rather than to be trusted: the nominal size the distribution ships
// the image at, so `index` can report it, and the same size of the master, so
// a master drawn at the wrong size is refused instead of silently shipping.

/** Nominal size of an SVG document, from width/height or from the viewBox. */
export type SvgSize = { readonly width: number; readonly height: number };

/**
 * The document's nominal size, or null when the text is not an SVG document
 * or carries no size this code can read. Percentage widths and unit suffixes
 * other than px are deliberately not guessed at: an image whose size depends
 * on its container has no nominal size to compare against.
 */
export function parseSvg(text: string): SvgSize | null {
	const open = openingTag(text);
	if (open === null) {
		return null;
	}
	const width = lengthAttribute(open, 'width');
	const height = lengthAttribute(open, 'height');
	if (width !== null && height !== null) {
		return { width, height };
	}
	const box = viewBoxSize(open);
	return box;
}

/** True when the bytes begin an SVG document, comments and prolog allowed. */
export function isSvg(text: string): boolean {
	return openingTag(text) !== null;
}

function openingTag(text: string): string | null {
	const match = /<svg\b[^>]*>/i.exec(text);
	if (match === null) {
		return null;
	}
	// An <svg> inside a comment or a CDATA block is not the document element;
	// requiring it to be the first tag of the document keeps that honest.
	const before = text.slice(0, match.index);
	const stripped = before
		.replace(/<\?[\s\S]*?\?>/g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!DOCTYPE[^>]*>/gi, '');
	return stripped.trim() === '' ? match[0] : null;
}

function lengthAttribute(tag: string, name: string): number | null {
	const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag);
	const raw = (match?.[1] ?? match?.[2] ?? '').trim();
	if (raw === '') {
		return null;
	}
	const number = /^([0-9]+(?:\.[0-9]+)?)(px)?$/i.exec(raw);
	if (number === null) {
		return null;
	}
	const value = Number(number[1]);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function viewBoxSize(tag: string): SvgSize | null {
	const match = /\bviewBox\s*=\s*"([^"]*)"|\bviewBox\s*=\s*'([^']*)'/i.exec(tag);
	const raw = (match?.[1] ?? match?.[2] ?? '').trim();
	if (raw === '') {
		return null;
	}
	const parts = raw.split(/[\s,]+/).map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
		return null;
	}
	const width = Math.round(parts[2] ?? 0);
	const height = Math.round(parts[3] ?? 0);
	return width > 0 && height > 0 ? { width, height } : null;
}
