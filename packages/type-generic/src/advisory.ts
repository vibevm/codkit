/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-ADVISORY */
// Area 5: what the upgrade advisory reads between two pins.
//
// Which file of an upstream carries a meaning worth stopping an upgrade for is
// knowledge of a family. A plain git upstream has none that this type could
// name without inventing it, so it declares no reader and the capability
// `upgrade-advisory` with it: the cycle's advisory phase then reports the two
// pins and no semantic change, and nothing has to be acknowledged before the
// cycle continues.

import type { AdvisoryArea } from '@codkit/type-api';

export const advisory: AdvisoryArea = { readers: [] };
