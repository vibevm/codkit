/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-BRAND-IMAGES */
// Area 6 of the contract: brand images (capability `brand-images`).
//
// The type says which image files a distribution of this family carries, what
// each of them is for, and how the containers of this family are read and
// written. The generator, the index and the verifier - discovery over the
// declared patterns, the masters folder, the round trip and the guard groups -
// are the engine's, and they never name a container by hand: everything they
// need about a container arrives through a codec.
export {};
