/** @scope spec://codkit/modules/codkit/PROP-014#LIC-POLICY-FILE */
// Reading config/license-policy.json of the tool root (PROP-014 sec. 2).
//
// ##LIC-POLICY-FILE: who counts as us, which licence our own files carry, and
// which third-party licences are allowed at all. The lists are edited by a
// person: widening the allowlist is a decision someone makes, never a side
// effect of a tool run.
//
// The file is read only from toolRoot, through the contained reader, and a
// patch set can never shadow it - the same rule conventions.json lives under
// (PROP-003 ##CONVENTIONS-SINGLE-DEFINITION). A patch set is untrusted input,
// and a policy it could override would not be a policy.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readContainedFile } from './containedFile.js';
import { ckError } from './messages.js';
export const LICENSE_POLICY_RELATIVE_PATH = 'config/license-policy.json';
const licensePolicySchema = z
    .object({
    codkitLicensePolicy: z.literal(1),
    holders: z.array(z.string().min(1)).min(1),
    ownLicense: z.string().min(1),
    allowedThirdParty: z.array(z.string().min(1)).default([]),
    allowedExceptions: z.array(z.string().min(1)).default([])
})
    .strict();
/** Where this module sits, so the shipped policy can be found from it. */
const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let cached = null;
/** The shipped licence policy. Any defect is `CK-E-CONFIG` and exit 2. */
export function loadLicensePolicy() {
    if (cached !== null)
        return cached;
    let raw;
    try {
        const read = readContainedFile(codkitRoot, 'config/license-policy.json', { what: LICENSE_POLICY_RELATIVE_PATH });
        if (read.state === 'absent') {
            throw new Error('the file does not exist');
        }
        raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
    }
    catch (error) {
        throw ckError('CONFIG', `cannot be read: ${error instanceof Error ? error.message : String(error)}`, 'license-policy.json ships with codkit; restore it from the repository', LICENSE_POLICY_RELATIVE_PATH);
    }
    const parsed = licensePolicySchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
        throw ckError('CONFIG', `${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`, 'see PROP-014 sec. 2 for the licence policy schema', LICENSE_POLICY_RELATIVE_PATH);
    }
    cached = parsed.data;
    return parsed.data;
}
/** Test seam: forget the cached policy so a fixture file is read again. */
export function forgetLicensePolicyCache() {
    cached = null;
}
