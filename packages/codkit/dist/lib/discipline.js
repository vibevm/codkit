/** @scope spec://codkit/modules/codkit/PROP-003#SCHEMA-MIGRATION-RULE */
// A patchset-owned axis, independent of upstream type and core invariants.
export const MINIMAL_DISCIPLINE = 'minimal-intervention@1';
/** Legacy config v2 resolves the current profile without changing its bytes. */
export function disciplineOf(config) {
    return config.discipline ?? MINIMAL_DISCIPLINE;
}
/** Only explicitly versioned declarations enter the new fingerprint domain. */
export function declaredDiscipline(config) {
    return config.codkitConfig >= 3 ? disciplineOf(config) : undefined;
}
