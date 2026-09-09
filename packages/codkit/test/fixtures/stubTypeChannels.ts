// The stub type with a different answer to `build.defaultChannels`, for the
// scenarios that prove the engine starts the channels the TYPE names rather
// than a pair of names it carries itself (PROP-016 ##TYPE-BUILD-CHANNELS,
// ##TYPE-TEST-SEAM).
//
// The profile of the stub declares four channels; this variant names two of
// them that the plain stub does not default to, so a run over it can only look
// the way it does if the default came from the type.

import { fileURLToPath } from 'node:url';
import type { ProjectType } from '@codkit/type-api';
import { projectType as stubProjectType } from './stubType.ts';

/** The channels this variant names; neither is the default of the plain stub. */
export const VARIANT_CHANNELS: readonly string[] = ['typecheck', 'extras'];

/** This module's own absolute path: what `CODKIT_TEST_TYPE_PACKAGE` names. */
export const STUB_CHANNELS_TYPE_MODULE = fileURLToPath(import.meta.url);

export const projectType: ProjectType = {
	...stubProjectType,
	build: { ...stubProjectType.build, defaultChannels: VARIANT_CHANNELS }
};

export default projectType;
