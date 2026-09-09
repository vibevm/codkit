/** @scope spec://codkit/modules/codkit/PROP-014#STD-SCRAPE-STATE-MACHINE */
// The managed block of the product's scrape contract (PROP-014 sec. 4a).
//
// ##STD-SCRAPE-CONTRACT-ROWS: a clean export of the product repository must not
// carry codkit's licence notice, and the owner ruled that codkit keeps those
// rows itself rather than printing them and hoping: a product may have its own
// contract, and a person forgets.
//
// ##STD-SCRAPE-NO-CONTRACT: codkit never creates the contract. Schema 1 demands
// health checks that belong to the product and that codkit cannot know, and
// without a contract there is no export to clean anyway.
export const SCRAPE_CONTRACT_PATH = 'vibevm/scrape/contract.toml';
import { NOTICE_LEGACY_PATH, NOTICE_OWN_PATH, NOTICE_ROOT_PATH } from './licenceNotice.js';
/**
 * The notice file in every place a codkit command has ever put it: both
 * current copies and the edition-2 own copy, so an export is cleaned of old
 * copies too (##STD-SCRAPE-CONTRACT-ROWS).
 */
export const NOTICE_PATHS = [NOTICE_ROOT_PATH, NOTICE_LEGACY_PATH, NOTICE_OWN_PATH];
const CLASSIFY_ID = 'remove-codkit-licence-notice';
const ASSERT_ID = 'codkit-licence-notice-absent';
export const SCRAPE_MARKERS = {
    begin: '# codkit:begin scrape',
    end: '# codkit:end scrape',
    needles: [CLASSIFY_ID, ASSERT_ID, 'LICENSE-CODKIT.md']
};
/** ##STD-SCRAPE-BLOCK-FORM: the exact rows, as verified against vibe scrape. */
export const SCRAPE_CONTRACT_ROWS = [
    '[[classify]]',
    `id = "${CLASSIFY_ID}"`,
    'kind = "delete"',
    `patterns = [${NOTICE_PATHS.map((path) => `"${path}"`).join(', ')}]`,
    'owner = "vibe"',
    'proof = "contract-assertion-v1"',
    'modified = "delete"',
    'require_match = false',
    '',
    '[[assert]]',
    `id = "${ASSERT_ID}"`,
    'kind = "paths-absent-v1"',
    `patterns = [${NOTICE_PATHS.map((path) => `"${path}"`).join(', ')}]`
].join('\n');
export const CANONICAL_SCRAPE_BLOCK = [
    SCRAPE_MARKERS.begin,
    '# Managed by `codkit standards load`; do not edit inside this block.',
    SCRAPE_CONTRACT_ROWS,
    SCRAPE_MARKERS.end
].join('\n');
/** What `standards load` prints when the product has no contract at all. */
export const NO_CONTRACT_LINE = 'scrape contract: none - run vibe scrape contract init, then codkit standards load again to record the licence-notice rows';
