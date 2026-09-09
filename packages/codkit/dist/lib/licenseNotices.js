/** @scope spec://codkit/modules/codkit/PROP-014#LIC-NOTICES-FILE */
// Generating THIRD-PARTY-NOTICES.md from the REUSE.toml registry.
//
// ##LIC-NOTICES-FILE: the file is generated and never hand-edited, so one
// function produces it and the licence check compares against that same
// function's output (##LIC-NEVER-EDIT-NOTICES-BY-HAND). A generator and a
// separate "is it current?" reader would drift, and the drift would be
// invisible until someone shipped a wrong notice.
import { thirdPartyAnnotations } from './reuseRegistry.js';
export const NOTICES_FILE_NAME = 'THIRD-PARTY-NOTICES.md';
/** The provenance text of an annotation, without the marker the registry uses. */
function sourceOf(comment) {
    return comment.replace('third-party; ', '');
}
/**
 * The body of the notices file for this registry, or null when no third-party
 * file is declared - in which case the package must not carry the file at all.
 */
export function renderThirdPartyNotices(registry, holders, notice) {
    const rows = thirdPartyAnnotations(registry, holders);
    if (rows.length === 0)
        return null;
    const head = [
        '<!--',
        ...notice,
        '-->',
        '# Third-party notices',
        '',
        'This package includes the following third-party components. Each keeps its',
        'own copyright notice and license; the license texts are in `LICENSES/`.',
        '',
        '| Path | Copyright | License | Source |',
        '|---|---|---|---|',
        ''
    ].join('\n');
    const body = rows
        .map((row) => `| \`${row.paths.join('`, `')}\` | ${row.copyright ?? ''} | ${row.license ?? ''} | ${sourceOf(row.comment)} |\n`)
        .join('');
    return head + body;
}
