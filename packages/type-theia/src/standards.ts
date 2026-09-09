/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-STANDARDS */
// Area 8: the vibe packages of this type.
//
// `minimal-intervention` and the agent skills are universal and ship with the
// tool. The catalogue of the seams this family offers - contribution points,
// `rebind`, the application manifest, the plugin map - is knowledge of the
// family and travels as a package of the type.

import type { StandardsArea } from '@codkit/type-api';

/** Delivered next to the universal packages, in delivery order. */
export const STANDARDS_PACKAGES: readonly string[] = ['seams-theia'];

export const standards: StandardsArea = { packages: STANDARDS_PACKAGES };
