/** @scope spec://codkit/modules/codkit/PROP-014#STD-MANIFEST-BLOCK-FORM */
// The managed block of the product manifest (PROP-014 sec. 4).
//
// ##STD-MANIFEST-BLOCK-FORM: the exact bytes codkit keeps between its markers -
// a table header for the dependency, its exact version and a static link. The
// header is a full table name, which is valid at any position of a TOML
// document, so the block can simply be appended (##STD-MANIFEST-NO-TOML-PARSER).
import { ckError } from './messages.js';
export const MANIFEST_PATH = 'vibe.toml';
export const STANDARDS_DEPENDENCY = 'org.vibevm.codkit/standards';
export const MANIFEST_MARKERS = {
    begin: '# codkit:begin standards',
    end: '# codkit:end standards',
    needles: [`"${STANDARDS_DEPENDENCY}"`]
};
/** The canonical block for one package version. */
export function canonicalManifestBlock(version) {
    return [
        MANIFEST_MARKERS.begin,
        '# Managed by `codkit standards load`; do not edit inside this block.',
        `[requires.packages."${STANDARDS_DEPENDENCY}"]`,
        `version = "=${version}"`,
        'link = "static"',
        MANIFEST_MARKERS.end
    ].join('\n');
}
/**
 * ##STD-MANIFEST-PRECONDITIONS: the manifest must be a vibevm project already.
 * Codkit does not create one - a `[project]` table is the operator's statement
 * that this repository is a vibevm project at all.
 */
export function requireProjectTable(text) {
    if (!text.split('\n').some((line) => line.trim() === '[project]')) {
        throw ckError('CONFIG', `${MANIFEST_PATH} has no [project] table`, 'run vibe init in the patch set first; codkit does not create vibevm projects', MANIFEST_PATH);
    }
}
