/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-API-STABILITY */
// The public surface of the contract package. A type package imports from here
// and from nowhere else in the tool; the CLI imports a type only through it.

export { CAPABILITIES, isCapability } from './capabilities.ts';
export type { Capability } from './capabilities.ts';
export type { IdentityArea, TreeFingerprint } from './identity.ts';
export type { LayoutArea, Refusal } from './layout.ts';
export type { EntryModuleLocator, ExtensionMaterializer, LayersArea, OverlayTarget, ServiceOverrideVerifier } from './layers.ts';
export type { BuildArea, BuildCommand, BuildStamp } from './build.ts';
export type { AdvisoryArea, AdvisoryFiles, AdvisoryReader, AdvisoryValue } from './advisory.ts';
export type { BrandImagesArea, ImageCodec, ImageFrame, ImagePayload, ImageTargetPattern } from './brandImages.ts';
export type { RuntimeArea } from './runtime.ts';
export type { StandardsArea } from './standards.ts';
export type { ConventionsArea } from './conventions.ts';
export { OPTIONAL_AREAS, projectTypeProblems } from './projectType.ts';
export type { ProjectType } from './projectType.ts';
