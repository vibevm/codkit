// The containers the imageset tests read and write, reached the way the engine
// reaches them: through the codecs of the project type (PROP-016
// ##TYPE-AREA-BRAND-IMAGES). No test names a container encoder of its own, for
// the same reason no module of the engine does.

import { decodePng, encodePng } from '@codkit/type-api';
import type { ImageCodec, ImageFrame, Rgba } from '@codkit/type-api';
import { projectType as vscodeType } from '@codkit/type-vscode';

/** The codec of one container of the `vscode` type. */
export function codecOf(kind: string): ImageCodec {
	const codec = vscodeType.brandImages?.codecs.find((candidate) => candidate.kind === kind);
	if (codec === undefined) {
		throw new Error(`the vscode type declares no ${kind} codec`);
	}
	return codec;
}

/** The frames of a file of the given container, in file order. */
export function framesOf(kind: string, bytes: Uint8Array): readonly ImageFrame[] {
	return codecOf(kind).parse(bytes);
}

/** Every frame of a file, decoded to pixels. */
export function imagesOf(kind: string, bytes: Uint8Array): readonly Rgba[] {
	const payloads = codecOf(kind).extract(bytes);
	return payloads.map((png, index) => {
		if (png === null) {
			throw new Error(`the ${kind} codec gave back no picture for frame ${index}`);
		}
		return decodePng(png);
	});
}

/** Write a container from images, in the order given. */
export function containerOf(kind: string, images: readonly { frame: ImageFrame; image: Rgba }[], stem = 'code'): Uint8Array {
	return codecOf(kind).encode(
		images.map((item) => ({ frame: item.frame, png: encodePng(item.image) })),
		stem
	);
}

/** A frame named by an element type, for a container that names its elements. */
export function namedFrame(type: string, image: Rgba): ImageFrame {
	return { width: image.width, height: image.height, type, pngCapable: true };
}

/** A frame told apart by its size, for a container that does not name them. */
export function sizedFrame(image: Rgba): ImageFrame {
	return { width: image.width, height: image.height, type: null, pngCapable: true };
}
