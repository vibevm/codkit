/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-STANDARDS */
// Area 8: the vibe packages of this type.
//
// `minimal-intervention` is universal and ships with the tool. A seam catalogue
// belongs to a family whose seams are known; a plain git upstream has none that
// the tool could catalogue, so this type delivers no package of its own and the
// installation of a generic patch set is the universal set exactly.

import type { StandardsArea } from '@codkit/type-api';

export const standards: StandardsArea = { packages: [] };
