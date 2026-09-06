/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-CONTAINERS */
// ICO container, hand-written (IMAGESET-CONTAINERS): a 6-byte header, 16 bytes
// of directory per frame and one payload each. Payloads here are PNG - legal
// in .ico since Vista and what the rasteriser produces anyway - so no
// DIB-with-mask encoding is needed. The directory byte for 256 is zero, the
// one value that cannot be stored in a byte.
//
// Parsing exists for target discovery: the structure of the file the
// distribution ships - how many frames, at which sizes, in which order - is
// read from that file, never assumed.

import { ckError } from './messages.ts';

export type IcoFrame = {
	/** Frame size in pixels; 256 is the value the directory stores as zero. */
	readonly width: number;
	readonly height: number;
};

export type IcoStructure = {
	readonly frames: readonly IcoFrame[];
};

const ICO_DIRECTORY_ENTRY = 16;
const ICO_HEADER = 6;

function broken(message: string, hint: string): Error {
	return ckError('ARTIFACT-BROKEN', `ICO: ${message}`, hint);
}

/** Read the frame list of an .ico: sizes in directory order, 0 meaning 256. */
export function parseIco(bytes: Uint8Array): IcoStructure {
	if (bytes.length < ICO_HEADER) {
		throw broken('file is shorter than the 6-byte header', 'the target must be an intact .ico file');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const type = view.getUint16(2, true);
	const count = view.getUint16(4, true);
	if (type !== 1) {
		throw broken(`resource type ${type} is not an icon directory`, 'the target must be an .ico file, not a cursor directory');
	}
	if (count === 0) {
		throw broken('directory lists no frames', 'the target must carry at least one frame');
	}
	if (bytes.length < ICO_HEADER + count * ICO_DIRECTORY_ENTRY) {
		throw broken(`directory announces ${count} frames but the file ends inside it`, 'the target must be an intact .ico file');
	}
	const frames: IcoFrame[] = [];
	for (let index = 0; index < count; index += 1) {
		const at = ICO_HEADER + index * ICO_DIRECTORY_ENTRY;
		frames.push({ width: byteOr256(bytes[at] ?? 0), height: byteOr256(bytes[at + 1] ?? 0) });
	}
	return { frames };
}

/**
 * Build an .ico from rendered PNG payloads. Frames keep the caller's order:
 * that order is part of what the distribution's own file declared.
 */
export function encodeIco(frames: readonly { width: number; height: number; png: Uint8Array }[]): Uint8Array {
	if (frames.length === 0 || frames.length > 0xffff) {
		throw broken(`cannot encode ${frames.length} frames`, 'an .ico carries between 1 and 65535 frames');
	}
	const out = new Uint8Array(ICO_HEADER + frames.length * ICO_DIRECTORY_ENTRY + frames.reduce((sum, frame) => sum + frame.png.length, 0));
	const view = new DataView(out.buffer);
	view.setUint16(0, 0, true);
	view.setUint16(2, 1, true);
	view.setUint16(4, frames.length, true);
	let offset = ICO_HEADER + frames.length * ICO_DIRECTORY_ENTRY;
	frames.forEach((frame, index) => {
		const at = ICO_HEADER + index * ICO_DIRECTORY_ENTRY;
		out[at] = widthByte(frame.width);
		out[at + 1] = widthByte(frame.height);
		out[at + 2] = 0;
		out[at + 3] = 0;
		view.setUint16(at + 4, 1, true);
		view.setUint16(at + 6, 32, true);
		view.setUint32(at + 8, frame.png.length, true);
		view.setUint32(at + 12, offset, true);
		out.set(frame.png, offset);
		offset += frame.png.length;
	});
	return out;
}

function byteOr256(value: number): number {
	return value === 0 ? 256 : value;
}

function widthByte(value: number): number {
	return value >= 256 ? 0 : value;
}
