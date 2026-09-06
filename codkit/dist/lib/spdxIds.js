/** @scope spec://codkit/modules/codkit/PROP-014#LIC-SPDX-ID-LIST */
// The SPDX identifier list as data, and the parsing of an SPDX expression.
//
// ##LIC-SPDX-ID-LIST: the list lives in codkit/config/spdx-license-ids.json, not
// in this file. It changes a few times a year and a person updates it
// deliberately; a data file diffs and reviews, a constant in code does not.
// Fetching it at check time is not an option either - `--ci` forbids the
// network (PROP-011 ##NFR-NETWORK).
//
// ##LIC-SPDX-REGEX: an expression is split on AND / OR / WITH and every
// identifier must be in the list. `LicenseRef-*` is recognised by shape and
// refused for a package; `NOASSERTION` is refused outright.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readContainedFile } from './containedFile.js';
import { ckError } from './messages.js';
export const SPDX_IDS_RELATIVE_PATH = 'codkit/config/spdx-license-ids.json';
/** Prefix of a licence identifier defined by a document rather than by SPDX. */
export const LICENSE_REF_PREFIX = 'LicenseRef-';
/** The identifier SPDX uses for "the licence was not determined". */
export const NO_ASSERTION = 'NOASSERTION';
const spdxIdsSchema = z
    .object({
    codkitSpdxLicenseIds: z.literal(1),
    listVersion: z.string().min(1),
    releaseDate: z.string().min(1),
    ids: z.array(z.string().min(1)).min(1)
})
    .strict();
const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let cached = null;
/** The shipped SPDX identifier list. Any defect is `CK-E-CONFIG` and exit 2. */
export function loadSpdxLicenseIds() {
    if (cached !== null)
        return cached;
    let raw;
    try {
        const read = readContainedFile(codkitRoot, 'config/spdx-license-ids.json', { what: SPDX_IDS_RELATIVE_PATH });
        if (read.state === 'absent') {
            throw new Error('the file does not exist');
        }
        raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
    }
    catch (error) {
        throw ckError('CONFIG', `cannot be read: ${error instanceof Error ? error.message : String(error)}`, 'spdx-license-ids.json ships with codkit; restore it from the repository', SPDX_IDS_RELATIVE_PATH);
    }
    const parsed = spdxIdsSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
        throw ckError('CONFIG', `${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`, 'see PROP-014 sec. 2 for the SPDX identifier list schema', SPDX_IDS_RELATIVE_PATH);
    }
    cached = { listVersion: parsed.data.listVersion, releaseDate: parsed.data.releaseDate, ids: new Set(parsed.data.ids) };
    return cached;
}
/** Test seam: forget the cached list so a fixture file is read again. */
export function forgetSpdxIdsCache() {
    cached = null;
}
/** The identifiers an SPDX expression is built from, in the order they appear. */
export function expressionIds(expression) {
    return expression.split(/\s+(?:AND|OR|WITH)\s+/u);
}
/**
 * Identifiers of `expression` that SPDX does not define. A `LicenseRef-*` name
 * is well-formed by construction and is judged by the policy instead, so it is
 * not reported here.
 */
export function unknownIds(expression, list) {
    return expressionIds(expression).filter((id) => !list.ids.has(id) && !id.startsWith(LICENSE_REF_PREFIX));
}
/**
 * The extra sentence a person needs when they wrote the licence's common name
 * instead of its identifier: `UPL`, `UPL 1.0` and `upl-1.0` all mean UPL-1.0,
 * and none of them is an SPDX identifier.
 */
export function spdxIdHint(unknown) {
    return unknown.some((id) => id.toUpperCase().startsWith('UPL')) ? ' (the only valid form is UPL-1.0)' : '';
}
