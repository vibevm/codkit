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

/**
 * How one container of this family is read and written.
 *
 * The engine never names a container: it looks the codec up by the `kind` of
 * the target it is working on and asks it everything - the frames, the payload
 * of a frame, the bytes of a regenerated file, and the sentences a report says
 * about the container. A function here refuses a file it cannot read with
 * `brokenArtifact`, and the engine turns that into `CK-E-ARTIFACT-BROKEN`
 * naming the file.
 */
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
	/**
	 * The container is a vector document: the master IS the artifact, so nothing
	 * is rasterised and the master's bytes are emitted unchanged. Such a target
	 * needs a master of this same container, drawn at the size the distribution
	 * ships (##IMAGESET-SVG-PASSTHROUGH).
	 */
	readonly vector: boolean;
	/**
	 * A first run may seed a master from a file of this container. False for a
	 * container that does not give the drawing back the way it was drawn - a
	 * palette-quantised one - or that only repeats artwork another target of the
	 * same family carries in a better form.
	 */
	readonly seedsMasters: boolean;
	/** What someone drawing for this container has to know, one line each. */
	readonly constraints: readonly string[];
	/** The frames the file carries and a write reproduces, in file order. */
	parse(bytes: Uint8Array): readonly ImageFrame[];
	/** Element types found in a file and not reproduced on a write. */
	legacyTypes(bytes: Uint8Array): readonly string[];
	/**
	 * The picture of every frame as PNG bytes, in the order `parse` returns the
	 * frames; null where a frame carries no picture this container gives back.
	 * Frames are addressed by position and not by their size, because a
	 * container may carry two frames of one size.
	 */
	extract(bytes: Uint8Array): readonly (Uint8Array | null)[];
	/**
	 * Write a container carrying these payloads, in the given order. `stem` is
	 * the file stem of the target, for a container that names its own content.
	 */
	encode(payloads: readonly ImagePayload[], stem: string): Uint8Array;
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
