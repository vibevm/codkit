/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-CONVENTIONS */
// Area 9: the conventions this type contributes to a patch set.
//
// The marker grammar, the shape of an intervention id, the types, the
// categories and the layers are the engine's. The subsystems an id may name are
// the family's, and a plain git upstream has no subsystems of its own - so the
// defaults are the few areas any repository can be divided into, and a patch
// set that knows better extends them additively through
// `conventionsExtensionFile`. Nothing may be re-registered because there is no
// service registry to re-register into.

import type { ConventionsArea } from '@codkit/type-api';

/** ##TYPE-GENERIC: the coarse areas of an arbitrary repository. */
export const SUBSYSTEMS: readonly string[] = ['app', 'build', 'config', 'docs', 'lib', 'test'];

export const conventions: ConventionsArea = { subsystems: SUBSYSTEMS, forbiddenServiceIds: [] };
