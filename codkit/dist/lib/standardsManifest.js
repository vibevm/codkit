/** @scope spec://codkit/modules/codkit/PROP-014#STD-MANIFEST-BLOCK-FORM */
// The managed block of the product manifest (PROP-014 sec. 4).
//
// ##STD-MANIFEST-BLOCK-FORM: the exact bytes codkit keeps between its markers -
// a table header for the dependency, its exact version and a static link. The
// header is a full table name, which is valid at any position of a TOML
// document, so the block can simply be appended (##STD-MANIFEST-NO-TOML-PARSER).
//
// ##STD-LOAD-ALL-PACKAGES: one block, between the same two markers, with one
// table per shipped package. A second block per package would give the product
// two places to look and codkit two places to keep current.
import { ckError } from './messages.js';
import { STANDARDS_PACKAGE_GROUP } from './standardsPackage.js';
export const MANIFEST_PATH = 'vibe.toml';
/** The dependency name of a shipped package, as `vibe` spells it. */
export function packageDependency(name) {
    return `${STANDARDS_PACKAGE_GROUP}/${name}`;
}
export const MANIFEST_BEGIN = '# codkit:begin standards';
export const MANIFEST_END = '# codkit:end standards';
/**
 * The markers, with one needle per shipped package: a table of ours outside the
 * block would either break the TOML document or pin the same package twice
 * (##STD-MANIFEST-ENTRY-OUTSIDE-BLOCK).
 */
export function manifestMarkers(names) {
    return { begin: MANIFEST_BEGIN, end: MANIFEST_END, needles: names.map((name) => `"${packageDependency(name)}"`) };
}
/** The canonical block for the shipped set, in the order the packages are given. */
export function canonicalManifestBlock(packages) {
    return [
        MANIFEST_BEGIN,
        '# Managed by `codkit standards load`; do not edit inside this block.',
        ...packages.flatMap((entry) => [
            `[requires.packages."${packageDependency(entry.name)}"]`,
            `version = "=${entry.version}"`,
            'link = "static"'
        ]),
        MANIFEST_END
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
