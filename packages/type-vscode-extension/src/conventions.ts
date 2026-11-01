/** @scope spec://codkit/modules/vscode-extension/PROP-005#VSX-CONVENTIONS */
// Area 9: the conventions this family contributes to a patch set.
//
// The marker grammar, the shape of an intervention id, the types, the
// categories and the layers are the engine's. The subsystems an id may name are
// the family's: the surfaces and concerns an extension is divided into. No
// service id is forbidden, because the family has no service registry
// (PROP-003 ##VSX-NO-SERVICE-OVERRIDE); a product extends the subsystems
// additively through `conventionsExtensionFile`.

import type { ConventionsArea } from '@codkit/type-api';

/** ##VSX-CONVENTIONS: the subsystems an intervention of this family belongs to. */
export const SUBSYSTEMS: readonly string[] = ['extension', 'webview', 'i18n', 'assets', 'build', 'config', 'docs', 'test'];

/** ##VSX-CONVENTIONS: empty, and honestly so - there is no registry to re-register into. */
export const FORBIDDEN_SERVICE_IDS: readonly string[] = [];

export const conventions: ConventionsArea = { subsystems: SUBSYSTEMS, forbiddenServiceIds: FORBIDDEN_SERVICE_IDS };
