// A PNG writer for the tests of the decoder, sharing no code with it: every
// colour type at every depth the format allows, tRNS, the five scanline filters
// and Adam7 interlacing. It writes what a designer's tool may hand over - a
// 16-bit RGBA export, a 2-bit grey mark, an interlaced palette file - so the
// decoder is proved against bytes it did not produce (PROP-007
// ##IMAGESET-PNG-MASTERS).

import { deflateSync } from 'node:zlib';

export type ColourType = 0 | 2 | 3 | 4 | 6;

export type Variant = {
	readonly colorType: ColourType;
	readonly bitDepth: 1 | 2 | 4 | 8 | 16;
	/** Adam7 when true. */
	readonly interlaced?: boolean;
	/** The filter of each scanline, cycled; every row type 0 when absent. */
	readonly filters?: readonly (0 | 1 | 2 | 3 | 4)[];
	/** RGB triples of a palette image. */
	readonly palette?: readonly (readonly [number, number, number])[];
	/** The raw tRNS body. */
	readonly trns?: Uint8Array;
};

/** The raw samples of one pixel at the variant's own depth, in channel order. */
export type SampleSource = (x: number, y: number) => readonly number[];

const CHANNELS: Record<ColourType, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const ADAM7: readonly (readonly [number, number, number, number])[] = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2]
];

/** Write a PNG of the given variant whose pixel (x, y) carries `samples(x, y)`. */
export function writePng(width: number, height: number, variant: Variant, samples: SampleSource): Uint8Array {
	const channels = CHANNELS[variant.colorType];
	const passes = variant.interlaced === true ? ADAM7 : [[0, 0, 1, 1] as const];
	const scanlines: Buffer[] = [];
	let rowIndex = 0;
	for (const [x0, y0, dx, dy] of passes) {
		const passWidth = Math.ceil((width - x0) / dx);
		const passHeight = Math.ceil((height - y0) / dy);
		if (passWidth <= 0 || passHeight <= 0) {
			continue;
		}
		const bytesPerRow = Math.ceil((passWidth * channels * variant.bitDepth) / 8);
		const unit = Math.max(1, (channels * variant.bitDepth) / 8);
		let previous: Buffer = Buffer.alloc(bytesPerRow);
		for (let y = 0; y < passHeight; y += 1) {
			const raw = packRow(passWidth, variant.bitDepth, (x) => samples(x0 + x * dx, y0 + y * dy), bytesPerRow);
			const filters = variant.filters ?? [0];
			const filter = filters[rowIndex % filters.length] ?? 0;
			rowIndex += 1;
			scanlines.push(Buffer.concat([Buffer.from([filter]), filterRow(raw, previous, unit, filter)]));
			previous = raw;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = variant.bitDepth;
	ihdr[9] = variant.colorType;
	ihdr[12] = variant.interlaced === true ? 1 : 0;
	const chunks = [chunk('IHDR', ihdr)];
	if (variant.palette !== undefined) {
		chunks.push(chunk('PLTE', Buffer.from(variant.palette.flat())));
	}
	if (variant.trns !== undefined) {
		chunks.push(chunk('tRNS', Buffer.from(variant.trns)));
	}
	chunks.push(chunk('IDAT', deflateSync(Buffer.concat(scanlines))), chunk('IEND', Buffer.alloc(0)));
	return Uint8Array.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]));
}

/** Pack the samples of one row at the given depth, most significant bits first. */
function packRow(width: number, bitDepth: number, pixel: (x: number) => readonly number[], bytesPerRow: number): Buffer {
	const row = Buffer.alloc(bytesPerRow);
	let bit = 0;
	for (let x = 0; x < width; x += 1) {
		for (const sample of pixel(x)) {
			if (bitDepth === 16) {
				row.writeUInt16BE(sample, bit / 8);
			} else if (bitDepth === 8) {
				row[bit / 8] = sample;
			} else {
				const at = Math.floor(bit / 8);
				row[at] = (row[at] ?? 0) | (sample << (8 - bitDepth - (bit % 8)));
			}
			bit += bitDepth;
		}
	}
	return row;
}

/** Apply one PNG filter to a raw row, against the raw row above it. */
function filterRow(raw: Buffer, previous: Buffer, unit: number, filter: number): Buffer {
	const out = Buffer.alloc(raw.length);
	for (let index = 0; index < raw.length; index += 1) {
		const left = index >= unit ? (raw[index - unit] ?? 0) : 0;
		const up = previous[index] ?? 0;
		const upperLeft = index >= unit ? (previous[index - unit] ?? 0) : 0;
		let predictor = 0;
		if (filter === 1) predictor = left;
		else if (filter === 2) predictor = up;
		else if (filter === 3) predictor = Math.floor((left + up) / 2);
		else if (filter === 4) predictor = paeth(left, up, upperLeft);
		out[index] = ((raw[index] ?? 0) - predictor) & 0xff;
	}
	return out;
}

function paeth(left: number, up: number, upperLeft: number): number {
	const estimate = left + up - upperLeft;
	const toLeft = Math.abs(estimate - left);
	const toUp = Math.abs(estimate - up);
	const toUpperLeft = Math.abs(estimate - upperLeft);
	if (toLeft <= toUp && toLeft <= toUpperLeft) return left;
	return toUp <= toUpperLeft ? up : upperLeft;
}

function chunk(type: string, body: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(body.length, 0);
	head.write(type, 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
	return Buffer.concat([head, body, crc]);
}

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}
