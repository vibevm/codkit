/** @scope spec://codkit/modules/theia/PROP-005#THEIA-SUBSYSTEMS */
// Area 9: the conventions this family contributes to a patch set.
//
// The marker grammar, the shape of an intervention id, the types, the
// categories and the layers are the engine's. The subsystems an id may name are
// the family's, and here they are the processes and containers an application
// of this family is divided into rather than the directories of a source tree:
// a Theia monorepo has no single source tree to divide.
/** ##THEIA-SUBSYSTEMS: the areas an intervention of this family belongs to. */
export const SUBSYSTEMS = ['core', 'frontend', 'backend', 'electron', 'plugin', 'app', 'build', 'test', 'deps'];
/**
 * ##THEIA-FORBIDDEN-SERVICES: empty, and honestly so. In this family nothing is
 * bound before the container exists - the generated entry builds the container
 * and loads every module into it - so there is no upstream list of services a
 * rebind cannot reach. Candidates appear from measurement of a rebind that did
 * not win, and a product adds them, with the failure that proved them, through
 * `conventionsExtensionFile`.
 */
export const FORBIDDEN_SERVICE_IDS = [];
export const conventions = { subsystems: SUBSYSTEMS, forbiddenServiceIds: FORBIDDEN_SERVICE_IDS };
