#!/usr/bin/env node
// Generates the committed imageset fixture binaries: a miniature "shipped
// icon set" of a distribution, built by an implementation that shares no code
// with codkit's own encoders. Deliberate differences from the production
// pipeline, so a structural test against these files cannot pass by reading
// back what it just wrote:
//   - fixture ICO frames are raw BGRA DIBs with AND masks (like the real
//     distribution's small frames), while codkit writes PNG payloads;
//   - fixture PNGs use filter type Sub and a palette (the distribution's
//     linux icon is a palette PNG), while codkit writes RGBA with filter 0;
//   - fixture XPM uses two-character pixel codes in one row style of its own.
//
// Run: node codkit/test/fixtures/imageset/generate.mjs   (writes ./*.bin files)

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// --- fixture artwork ---------------------------------------------------------

/** A blue rounded square with a white disc, alpha-antialiased. Deterministic. */
function artwork(size) {
	const data = new Uint8Array(size * size * 4);
	const radius = size * 0.18;
	const center = size / 2;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const at = (y * size + x) * 4;
			const edge = distanceToRoundedSquare(x + 0.5, y + 0.5, size, radius);
			const alpha = clamp01(0.5 - edge) * 255;
			const disc = Math.hypot(x + 0.5 - center, y + 0.5 - center) - size * 0.22;
			const insideDisc = clamp01(0.5 - disc);
			data[at] = Math.round(22 + (255 - 22) * insideDisc);
			data[at + 1] = Math.round(122 + (255 - 122) * insideDisc);
			data[at + 2] = Math.round(191 + (255 - 191) * insideDisc);
			data[at + 3] = Math.round(alpha);
		}
	}
	return data;
}

function distanceToRoundedSquare(px, py, size, radius) {
	const half = size / 2 - size * 0.06;
	const inner = Math.max(Math.abs(px - size / 2) - (half - radius), 0);
	const innerY = Math.max(Math.abs(py - size / 2) - (half - radius), 0);
	return Math.hypot(inner, innerY) - radius;
}

function clamp01(value) {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}

// --- fixture PNG encoder (palette or RGBA, filter Sub) ----------------------

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
	const out = Buffer.alloc(12 + body.length);
	out.writeUInt32BE(body.length, 0);
	out.write(type, 4, 'latin1');
	body.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
	return out;
}

function pngChunked(ihdr, scanlines, middleChunks = []) {
	const ihdrBody = Buffer.alloc(13);
	ihdrBody.writeUInt32BE(ihdr.width, 0);
	ihdrBody.writeUInt32BE(ihdr.height, 4);
	ihdrBody[8] = ihdr.bitDepth;
	ihdrBody[9] = ihdr.colorType;
	const idat = deflateSync(scanlines, { level: 6 });
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdrBody),
		...middleChunks,
		chunk('IDAT', idat),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function encodeRgbaPng(width, height, rgba) {
	const channels = 4;
	const rows = [];
	for (let y = 0; y < height; y += 1) {
		const row = Buffer.alloc(1 + width * channels);
		row[0] = 1; // Sub
		for (let x = 0; x < width; x += 1) {
			for (let c = 0; c < channels; c += 1) {
				const at = (y * width + x) * channels + c;
				const left = x === 0 ? 0 : (rgba[at - channels] ?? 0);
				row[1 + x * channels + c] = ((rgba[at] ?? 0) - left) & 0xff;
			}
		}
		rows.push(row);
	}
	return pngChunked({ width, height, bitDepth: 8, colorType: 6 }, Buffer.concat(rows));
}

function encodePalettePng(width, height, rgba, palette) {
	// The last palette entry is the transparent margin, like a hand-drawn
	// small icon: hard edges, no partial alpha.
	const transparent = palette.length - 1;
	const rows = [];
	for (let y = 0; y < height; y += 1) {
		const row = Buffer.alloc(1 + width);
		row[0] = 1; // Sub filters against the previous *raw* byte, not the filtered one
		let previous = 0;
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const index = (rgba[at + 3] ?? 0) < 128 ? transparent : nearestPaletteIndex(rgba, at, palette);
			row[1 + x] = (index - previous) & 0xff;
			previous = index;
		}
		rows.push(row);
	}
	const plte = Buffer.concat(palette.map((color) => Buffer.from([color[0], color[1], color[2]])));
	const trns = Buffer.from(palette.map((_, index) => (index === transparent ? 0 : 255)));
	return pngChunked({ width, height, bitDepth: 8, colorType: 3 }, Buffer.concat(rows), [chunk('PLTE', plte), chunk('tRNS', trns)]);
}

function nearestPaletteIndex(rgba, at, palette) {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	palette.forEach((color, index) => {
		const dr = (rgba[at] ?? 0) - color[0];
		const dg = (rgba[at + 1] ?? 0) - color[1];
		const db = (rgba[at + 2] ?? 0) - color[2];
		const distance = dr * dr + dg * dg + db * db;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = index;
		}
	});
	return best;
}

// --- fixture ICO (raw BGRA frames with AND masks, like the distribution) ----

function encodeIcoRaw(frames) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(frames.length, 4);
	const entries = Buffer.alloc(frames.length * 16);
	const payloads = [];
	let offset = 6 + frames.length * 16;
	frames.forEach((frame, index) => {
		const { size, rgba } = frame;
		const maskStride = Math.ceil(size / 8 / 4) * 4;
		const dib = Buffer.alloc(40 + size * size * 4 + maskStride * size);
		dib.writeUInt32LE(40, 0);
		dib.writeInt32LE(size, 4);
		dib.writeInt32LE(size * 2, 8);
		dib.writeUInt16LE(1, 12);
		dib.writeUInt16LE(32, 14);
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				const source = (y * size + x) * 4;
				const target = 40 + ((size - 1 - y) * size + x) * 4;
				dib[target] = rgba[source + 2] ?? 0;
				dib[target + 1] = rgba[source + 1] ?? 0;
				dib[target + 2] = rgba[source] ?? 0;
				dib[target + 3] = rgba[source + 3] ?? 0;
				if ((rgba[source + 3] ?? 0) < 128) {
					dib[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
				}
			}
		}
		entries.writeUInt8(size >= 256 ? 0 : size, index * 16);
		entries.writeUInt8(size >= 256 ? 0 : size, index * 16 + 1);
		entries.writeUInt16LE(1, index * 16 + 4);
		entries.writeUInt16LE(32, index * 16 + 6);
		entries.writeUInt32LE(dib.length, index * 16 + 8);
		entries.writeUInt32LE(offset, index * 16 + 12);
		payloads.push(dib);
		offset += dib.length;
	});
	return Buffer.concat([header, entries, ...payloads]);
}

// --- fixture ICNS (PNG elements plus a legacy chunk) -------------------------

function encodeIcns(elements) {
	const total = 8 + elements.reduce((sum, element) => sum + 8 + element.payload.length, 0);
	const out = Buffer.alloc(total);
	out.write('icns', 0, 'latin1');
	out.writeUInt32BE(total, 4);
	let at = 8;
	for (const element of elements) {
		out.write(element.type, at, 'latin1');
		out.writeUInt32BE(8 + element.payload.length, at + 4);
		element.payload.copy(out, at + 8);
		at += 8 + element.payload.length;
	}
	return out;
}

// --- fixture BMP (24-bit, bottom-up) -----------------------------------------

function encodeBmp24(width, height, rgba) {
	const rowLength = width * 3;
	const padding = (4 - (rowLength % 4)) % 4;
	const pixels = Buffer.alloc(height * (rowLength + padding));
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const source = (y * width + x) * 4;
			const at = (height - 1 - y) * (rowLength + padding) + x * 3;
			pixels[at] = rgba[source + 2] ?? 0;
			pixels[at + 1] = rgba[source + 1] ?? 0;
			pixels[at + 2] = rgba[source] ?? 0;
		}
	}
	const header = Buffer.alloc(54);
	header.write('BM', 0, 'latin1');
	header.writeUInt32LE(54 + pixels.length, 2);
	header.writeUInt32LE(54, 10);
	header.writeUInt32LE(40, 14);
	header.writeInt32LE(width, 18);
	header.writeInt32LE(height, 22);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(24, 28);
	return Buffer.concat([header, pixels]);
}

// --- fixture XPM (two-character codes) ---------------------------------------

function encodeXpm2(width, height, rgba, colors) {
	// Codes are doubled letters for the palette entries and '--' for None;
	// the colour of a pixel is picked by its red channel against `colors`,
	// which the caller orders by ascending red.
	const codes = colors.map((_, index) => `${'abcdef'[index] ?? 'a'}${'abcdef'[index] ?? 'a'}`);
	const transparent = '--';
	const rows = [
		'/* XPM */',
		'static char * code_xpm[] = {',
		`"${width} ${height} ${colors.length + 1} 2",`,
		...colors.map((color, index) => `"${codes[index]}\tc ${color}",`),
		`"${transparent}\tc None",`
	];
	for (let y = 0; y < height; y += 1) {
		let row = '';
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			row += (rgba[at + 3] ?? 0) < 128 ? transparent : (codes[quantise(rgba, at, colors.length)] ?? transparent);
		}
		rows.push(`"${row}",`);
	}
	rows.push('};', '');
	return rows.join('\n');
}

function quantise(rgba, at, levels) {
	const value = rgba[at] ?? 0;
	return Math.min(levels - 1, Math.floor((value / 256) * levels));
}

// --- the shipped set ---------------------------------------------------------

const PALETTE = [
	[255, 255, 255],
	[22, 122, 191],
	[140, 190, 225],
	[0, 0, 0]
];

const files = new Map();
files.set(
	'code.ico',
	encodeIcoRaw([
		{ size: 16, rgba: artwork(16) },
		{ size: 32, rgba: artwork(32) }
	])
);
files.set(
	'code.icns',
	encodeIcns([
		{ type: 'ic11', payload: encodeRgbaPng(32, 32, artwork(32)) },
		{ type: 'ic07', payload: encodeRgbaPng(128, 128, artwork(128)) },
		{ type: 'info', payload: Buffer.from('fixture-icns-bookkeeping') }
	])
);
files.set('code.png', encodePalettePng(64, 64, artwork(64), PALETTE));
files.set('code_70x70.png', encodeRgbaPng(70, 70, artwork(70)));
files.set('code.xpm', encodeXpm2(64, 64, artwork(64), ['#167ABF', '#FFFFFF', '#8CBEDF']));
files.set('inno-big-100.bmp', encodeBmp24(32, 16, banner(32, 16)));
files.set('inno-big-125.bmp', encodeBmp24(40, 20, banner(40, 20)));
files.set('inno-small-100.bmp', encodeBmp24(12, 12, banner(12, 12)));

/** Installer banner: white field with a blue bar at the bottom. */
function banner(width, height) {
	const rgba = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const at = (y * width + x) * 4;
			const bar = y > height * 0.75;
			rgba[at] = bar ? 22 : 255;
			rgba[at + 1] = bar ? 122 : 255;
			rgba[at + 2] = bar ? 191 : 255;
			rgba[at + 3] = 255;
		}
	}
	return rgba;
}

for (const [name, bytes] of files) {
	writeFileSync(join(here, name), bytes);
	process.stdout.write(`wrote ${name} (${bytes.length} bytes)\n`);
}
