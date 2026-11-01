/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-API-STABILITY */
// The public surface of the contract package. A type package imports from here
// and from nowhere else in the tool; the CLI imports a type only through it.
export { CAPABILITIES, isCapability } from './capabilities.js';
export { oneOwnedDirectory } from './layout.js';
export { brokenArtifact, isBrokenArtifact } from './refusal.js';
export { decodePng, encodePng, isPng, pngHeader, pngSize, rgba } from './png.js';
export { licensingShapeProblems, treePathProblem } from './licensing.js';
export { OPTIONAL_AREAS, projectTypeProblems } from './projectType.js';
export { TYPE_MANIFEST_VERSION, TYPE_CONTRACT_VERSION, typeManifestSchema, validateTypeManifest } from './typeManifest.js';
