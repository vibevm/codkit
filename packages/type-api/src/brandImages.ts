/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-BRAND-IMAGES */
// Area 6 of the contract: brand images (capability `brand-images`).
//
// The type says which image files a distribution of this family carries, what
// each of them is for, and how the containers of this family are read and
// written. The generator, the index and the verifier - discovery over the
// declared patterns, the masters folder, the round trip and the guard groups -
// are the engine's, and they never name a container by hand: everything they
// need about a container arrives through a codec.

/** One frame inside an image container. */
export type ImageFrame = {
	readonly width: number;
	readonly height: number;
	/** Element type of a container that names its elements; null otherwise. */
	readonly type: string | null;
	/** The element may carry a PNG payload rather than raw pixels. */
	readonly pngCapable: boolean;
};

/** A frame together with the PNG bytes that fill it. */
export type ImagePayload = {
	readonly frame: ImageFrame;
	readonly png: Uint8Array;
};

/** How one container of this family is read and written. */
export type ImageCodec = {
	/** The container name, also the value of a target's `kind`. */
	readonly kind: string;
	/** The file extension the container is written with, with the dot. */
	readonly extension: string;
	/**
	 * The container holds several drawings of one image at several sizes, so a
	 * guard compares it frame by frame rather than as one picture.
	 */
	readonly layered: boolean;
	/** The frames the file carries, in file order. */
	parse(bytes: Uint8Array): readonly ImageFrame[];
	/** Element types found in a file and not reproduced on a write. */
	legacyTypes(bytes: Uint8Array): readonly string[];
	/** The PNG payload of one frame, or null when the frame is not PNG-capable. */
	extract(bytes: Uint8Array, frame: ImageFrame): Uint8Array | null;
	/** Write a container carrying these payloads, in the given order. */
	encode(payloads: readonly ImagePayload[]): Uint8Array;
};

/** One file - or one glob of files - of the distribution's image set. */
export type ImageTargetPattern = {
	/** Guard group and masters folder, e.g. `icon`, `installer-big`. */
	readonly family: string;
	/** Path from the tree root, POSIX; a glob when `glob` is true. */
	readonly path: string;
	readonly glob: boolean;
	/** The container of this target; a codec of the same `kind` must exist. */
	readonly kind: string;
	/** Where a person sees this image. Never names a downstream product. */
	readonly role: string;
	/**
	 * Present when every file the pattern matches carries its own drawing: the
	 * artwork name is the file stem with this prefix removed. Absent when the
	 * whole family shares one drawing.
	 */
	readonly artworkFromStem?: { readonly strip: string };
	/** Base names this glob must not claim - another pattern owns them. */
	readonly exclude?: readonly string[];
};

export type BrandImagesArea = {
	readonly targets: readonly ImageTargetPattern[];
	readonly codecs: readonly ImageCodec[];
	/** One line per family, for the help of the `imageset` verbs. */
	readonly familyNotes: readonly string[];
};
