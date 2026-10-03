/** @scope spec://codkit/modules/codkit/PROP-019#ORGANIZATION-POLICY-TRUST */
// The composition root supplies the user/admin policy directory; patchsets select only IDs.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { readContainedFile } from './containedFile.js';
import { decodeUtf8Strict } from './bytes.js';
import { loadSpdxLicenseIds } from './spdxIds.js';
import { organizationPolicySchema, organizationPolicySelectionSchema, selectOrganizationPolicy, validateOrganizationPolicy } from './organizationPolicy.js';
export const ORGANIZATION_POLICY_STORE_FILE = 'organization-policies.json';
export const organizationPolicyStoreSchema = z.strictObject({
    codkitOrganizationPolicyStore: z.literal(1),
    policies: z.array(organizationPolicySchema).min(1)
});
export function organizationPolicyRoot(home = homedir()) {
    return join(home, '.codkit');
}
export function readOrganizationPolicy(root, patchesDir, rawSelection, standard) {
    try {
        const identifiers = standard ?? loadSpdxLicenseIds();
        const trusted = realpathSync(root);
        const patchset = realpathSync(patchesDir);
        const fromPatchset = relative(patchset, trusted);
        if (fromPatchset === '' || (!isAbsolute(fromPatchset) && fromPatchset !== '..' && !fromPatchset.startsWith(`..${sep}`)))
            return refuse('organization policy store must not be inside the patchset');
        const selection = organizationPolicySelectionSchema.safeParse(rawSelection);
        if (!selection.success)
            return refuse('patchset selection may contain only profile ID and additional prohibitions');
        const read = readContainedFile(trusted, ORGANIZATION_POLICY_STORE_FILE, { what: 'organization policy store' });
        if (read.state === 'absent')
            return refuse('trusted organization policy store is missing; no patchset fallback is allowed');
        const text = decodeUtf8Strict(read.bytes);
        if (text === null)
            return refuse('organization policy store is not UTF-8');
        let raw;
        try {
            raw = JSON.parse(text);
        }
        catch {
            return refuse('organization policy store is not JSON');
        }
        const version = z.object({ codkitOrganizationPolicyStore: z.number().int() }).safeParse(raw);
        if (version.success && version.data.codkitOrganizationPolicyStore > 1)
            return refuse('organization policy store is newer than this tool; update codkit');
        const store = organizationPolicyStoreSchema.safeParse(raw);
        if (!store.success)
            return refuse('organization policy store has an unsupported or malformed schema');
        const ids = new Set();
        let selected = null;
        for (const entry of store.data.policies) {
            const key = entry.id.toLowerCase();
            if (ids.has(key))
                return refuse('organization policy IDs conflict, including case aliases');
            ids.add(key);
            const checked = validateOrganizationPolicy(entry, identifiers);
            if (!checked.ok)
                return checked;
            if (entry.id === selection.data.profile)
                selected = checked.value;
        }
        if (selected === null)
            return refuse('organization policy profile is not approved by the trusted store');
        const restricted = selectOrganizationPolicy(selected, selection.data);
        if (!restricted.ok)
            return restricted;
        return {
            ok: true,
            value: {
                policy: selected,
                additionalForbidden: restricted.value.additionalForbidden,
                sha256: createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
                storeSha256: createHash('sha256').update(read.bytes).digest('hex')
            }
        };
    }
    catch (error) {
        return refuse(error instanceof Error ? error.message : 'organization policy store cannot be read');
    }
}
function refuse(message) {
    return { ok: false, problems: [message] };
}
