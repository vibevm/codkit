/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-TERM-CAPABILITY */
// The named optional abilities a project type may declare.
//
// A capability is not a feature switch: it is the answer to "does this family
// of upstreams have such a thing at all". A verb that needs one refuses with
// `CK-E-TYPE-CAPABILITY` when the type does not declare it, before any write
// (##TYPE-CAPABILITY-REFUSAL), so the roster of verbs stays the same for every
// type and only the answers differ.
/** The closed list of capability names (##TYPE-TERM-CAPABILITY). */
export const CAPABILITIES = [
    'brand-images',
    'gen-brand',
    'build-channels',
    'runtime-library',
    'own-extensions',
    'service-override',
    'entry-module',
    'config-overlay',
    'dev-channel',
    'upgrade-advisory',
    'preview'
];
/** Whether a string is one of the declared capability names. */
export function isCapability(value) {
    return CAPABILITIES.includes(value);
}
