/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-API-STABILITY */
// The public surface of the contract package. A type package imports from here
// and from nowhere else in the tool; the CLI imports a type only through it.

export { CAPABILITIES, isCapability } from './capabilities.ts';
export type { Capability } from './capabilities.ts';
export type { FingerprintFiles, IdentityArea, TreeFingerprint } from './identity.ts';
export { oneOwnedDirectory } from './layout.ts';
export type { LayoutArea, LayoutConfig, OwnedDirectory, OwnedRole, Refusal } from './layout.ts';
export type {
	EntryModuleLocator,
	ExtensionMaterializer,
	LayersArea,
	OverlayTarget,
	ServiceOverrideContext,
	ServiceOverrideProblem,
	ServiceOverrideVerifier
} from './layers.ts';
export type {
	BuildArea,
	BuildCommand,
	BuildStamp,
	PackageContainer,
	PackageHost,
	PackageInput,
	PackageInputUse,
	PackageTarget
} from './build.ts';
export type { AdvisoryArea, AdvisoryFiles, AdvisoryReader, AdvisoryValue } from './advisory.ts';
export type { BrandImagesArea, ImageCodec, ImageFrame, ImagePayload, ImageTargetPattern } from './brandImages.ts';
export { brokenArtifact, isBrokenArtifact } from './refusal.ts';
export type { BrokenArtifact } from './refusal.ts';
export { decodePng, encodePng, isPng, pngHeader, pngSize, rgba } from './png.ts';
export type { PngHeader, Rgba } from './png.ts';
export type { RuntimeArea } from './runtime.ts';
export type { StandardsArea } from './standards.ts';
export type { ConventionsArea } from './conventions.ts';
export type { BrandGraft, FeatureRequest, FeatureSkeleton, GeneratedModule, GeneratedRole, GeneratorsArea } from './generators.ts';
export { OPTIONAL_AREAS, projectTypeProblems } from './projectType.ts';
export type { ProjectType } from './projectType.ts';
export { TYPE_MANIFEST_VERSION, TYPE_CONTRACT_VERSION, typeManifestSchema, validateTypeManifest } from './typeManifest.ts';
export type { TypeManifest, TypeManifestExpectation, TypeManifestProblem, TypeManifestResult } from './typeManifest.ts';
