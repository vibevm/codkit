/** @scope spec://codkit/modules/codkit/PROP-019#ORGANIZATION-POLICY-FORMAT */
// Consumer enforcement data; never a replacement for installed Codkit supply policy.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { licenseGlobMatches } from './licenseCarrier.js';
import { repoRelativePathProblem } from './pathSafety.js';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const expression = z.string().min(1).max(4096);
export const organizationPolicyV1Schema = z.strictObject({
    codkitOrganizationPolicy: z.literal(1),
    id: id.brand(),
    version: z.number().int().positive(),
    holders: z.array(z.string().min(1)).min(1),
    ownLicense: expression,
    allowedThirdParty: z.array(expression),
    forbiddenThirdParty: z.array(expression),
    allowedExceptions: z.array(id),
    licenseRefNamespace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/),
    customLicenses: z.array(z.strictObject({
        id: z.string().regex(/^LicenseRef-[A-Za-z0-9.-]+$/),
        text: z
            .string()
            .min(1)
            .max(1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/)
    })),
    standardLicenseTexts: z
        .array(z.strictObject({
        id: z.string().min(1),
        text: z
            .string()
            .min(1)
            .max(1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/)
    }))
        .optional(),
    distribution: z.strictObject({ requiredNotices: z.array(id), sbom: z.enum(['spdx-json', 'none']), requireSourceCarriers: z.boolean() }),
    legalReviewReference: z.string().min(1).optional()
});
export const organizationPolicyV2Schema = organizationPolicyV1Schema.extend({
    codkitOrganizationPolicy: z.literal(2),
    ownLicenseScopes: z
        .array(z.strictObject({
        paths: z
            .array(z
            .string()
            .min(1)
            .refine((value) => repoRelativePathProblem(value.replace(/[?*]/g, 'x')) === null))
            .min(1),
        license: expression
    }))
        .min(1)
});
export const organizationPolicySchema = z.discriminatedUnion('codkitOrganizationPolicy', [
    organizationPolicyV1Schema,
    organizationPolicyV2Schema
]);
export const organizationPolicySelectionSchema = z.strictObject({
    profile: id,
    additionalForbidden: z.array(expression).optional()
});
/** Syntax is validated; approved combinations are exact policy expressions, not inferred legal permissions. */
export function parsePolicyExpression(input) {
    if (input.length === 0 || input.length > 4096)
        return refuse('license expression is empty or too long');
    const tokens = input.match(/\(|\)|[A-Za-z0-9.+-]+|\S/g) ?? [];
    const licenses = [];
    const exceptions = [];
    let expectingLicense = true;
    let depth = 0;
    let previous = '';
    let needException = false;
    for (const token of tokens) {
        if (needException) {
            if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(token) || ['AND', 'OR', 'WITH', 'NOASSERTION'].includes(token))
                return refuse('WITH requires one exception identifier');
            exceptions.push(token);
            needException = false;
            previous = 'exception';
            continue;
        }
        if (expectingLicense) {
            if (token === '(') {
                depth += 1;
                if (depth > 64)
                    return refuse('license expression is too deeply nested');
                previous = '(';
                continue;
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(token) || ['AND', 'OR', 'WITH', 'NOASSERTION'].includes(token))
                return refuse('license expression requires a determined license identifier');
            licenses.push(token);
            expectingLicense = false;
            previous = 'license';
            continue;
        }
        if (token === ')') {
            if (depth === 0)
                return refuse('license expression has an unmatched parenthesis');
            depth -= 1;
            previous = ')';
            continue;
        }
        if (token === 'WITH' && previous === 'license') {
            needException = true;
            previous = 'WITH';
            continue;
        }
        if (token === 'AND' || token === 'OR') {
            expectingLicense = true;
            previous = token;
            continue;
        }
        return refuse('license expression has an invalid operator or adjacent identifiers');
    }
    if (expectingLicense || needException || depth !== 0)
        return refuse('license expression is incomplete');
    return { ok: true, value: { canonical: tokens.join(' '), licenses, exceptions } };
}
export function validateOrganizationPolicy(raw, standard) {
    const version = z.object({ codkitOrganizationPolicy: z.number().int() }).safeParse(raw);
    if (version.success && version.data.codkitOrganizationPolicy > 2)
        return refuse('organization policy format is newer than this tool; update codkit');
    const parsed = organizationPolicySchema.safeParse(raw);
    if (!parsed.success)
        return refuse(`organization policy shape is invalid: ${parsed.error.issues[0]?.path.join('.') || 'document'}`);
    const policy = parsed.data;
    const problems = [];
    const custom = new Set();
    for (const license of policy.customLicenses) {
        if (!license.id.startsWith(`LicenseRef-${policy.licenseRefNamespace}-`) ||
            license.id.length <= `LicenseRef-${policy.licenseRefNamespace}-`.length)
            problems.push('custom license is outside the organization namespace');
        if (custom.has(license.id))
            problems.push('custom license identifiers repeat');
        custom.add(license.id);
        if (license.text.trim().length === 0)
            problems.push('custom license text is empty');
        if (license.text.startsWith('\ufeff') || license.text.includes('\r') || !license.text.endsWith('\n'))
            problems.push('custom license text must be canonical LF-only text with a final LF');
        if (createHash('sha256').update(license.text).digest('hex') !== license.sha256)
            problems.push(`custom license text digest differs: ${license.id}`);
    }
    for (const group of [policy.holders, policy.allowedExceptions, policy.distribution.requiredNotices])
        if (new Set(group).size !== group.length)
            problems.push('organization policy declarations repeat');
    const standardTexts = new Set();
    for (const record of policy.standardLicenseTexts ?? []) {
        if (!standard.ids.has(record.id) && !policy.allowedExceptions.includes(record.id))
            problems.push('standard text identifier is neither installed SPDX license nor approved exception');
        if (standardTexts.has(record.id))
            problems.push('standard license text identifiers repeat');
        standardTexts.add(record.id);
        if (record.text.trim() === '' || record.text.startsWith('\ufeff') || record.text.includes('\r') || !record.text.endsWith('\n'))
            problems.push('standard license text must be nonempty canonical LF text with a final LF');
        if (createHash('sha256').update(record.text).digest('hex') !== record.sha256)
            problems.push('standard license text digest differs');
    }
    const scopes = policy.codkitOrganizationPolicy === 2 ? policy.ownLicenseScopes : [];
    const scopePaths = scopes.flatMap((scope) => scope.paths);
    if (new Set(scopePaths).size !== scopePaths.length)
        problems.push('own licence scope paths repeat');
    for (const value of [
        policy.ownLicense,
        ...scopes.map((scope) => scope.license),
        ...policy.allowedThirdParty,
        ...policy.forbiddenThirdParty
    ]) {
        const checked = parsePolicyExpression(value);
        if (!checked.ok) {
            problems.push(...checked.problems);
            continue;
        }
        for (const license of checked.value.licenses)
            if (!standard.ids.has(license) && !custom.has(license))
                problems.push(`license is neither standard nor declared with text: ${license}`);
        for (const exception of checked.value.exceptions)
            if (!policy.allowedExceptions.includes(exception))
                problems.push(`exception is not approved: ${exception}`);
    }
    return problems.length === 0 ? { ok: true, value: policy } : { ok: false, problems };
}
/** A patchset can select an ID and add prohibitions; it cannot supply policy paths, holders or permissions. */
export function selectOrganizationPolicy(policy, raw) {
    const selection = organizationPolicySelectionSchema.safeParse(raw);
    if (!selection.success || selection.data.profile !== policy.id)
        return refuse('patchset policy selection is unknown or contains policy authority fields');
    const forbidden = [];
    for (const value of selection.data.additionalForbidden ?? []) {
        const checked = parsePolicyExpression(value);
        if (!checked.ok)
            return checked;
        forbidden.push(checked.value.canonical);
    }
    return { ok: true, value: { policy, additionalForbidden: [...new Set(forbidden)].sort() } };
}
export function checkOrganizationExpression(policy, input, own, additionalForbidden = [], sourcePath) {
    const checked = parsePolicyExpression(input);
    if (!checked.ok)
        return checked;
    const value = checked.value;
    const prohibited = [...(own ? [] : policy.forbiddenThirdParty), ...additionalForbidden].map(parsePolicyExpression);
    if (prohibited.some((entry) => !entry.ok))
        return refuse('policy prohibition is malformed');
    for (const entry of prohibited)
        if (entry.ok && (entry.value.canonical === value.canonical || entry.value.licenses.some((license) => value.licenses.includes(license))))
            return refuse('license expression contains a policy prohibition');
    if (value.exceptions.some((exception) => !policy.allowedExceptions.includes(exception)))
        return refuse('license exception is not approved');
    const scoped = own ? organizationOwnLicense(policy, sourcePath) : { ok: true, value: '' };
    if (!scoped.ok)
        return scoped;
    const allowed = own ? [scoped.value] : policy.allowedThirdParty;
    if (!allowed.some((entry) => {
        const parsed = parsePolicyExpression(entry);
        return parsed.ok && parsed.value.canonical === value.canonical;
    }))
        return refuse(own ? 'own license differs from the trusted organization policy' : 'third-party expression is not approved');
    return checked;
}
/** Scope resolution is trusted policy data; ownership is established separately. */
export function organizationOwnLicense(policy, sourcePath) {
    if (policy.codkitOrganizationPolicy === 1)
        return { ok: true, value: policy.ownLicense };
    if (sourcePath === undefined || repoRelativePathProblem(sourcePath) !== null)
        return refuse('scoped own licence requires a contained source path');
    const matched = policy.ownLicenseScopes.filter((scope) => scope.paths.some((pattern) => licenseGlobMatches(pattern, sourcePath)));
    if (matched.length > 1)
        return refuse('own licence scopes overlap for source path');
    return { ok: true, value: matched[0]?.license ?? policy.ownLicense };
}
/** All-own assembled artifacts keep the exact AND of their inspected source licences. */
export function checkOrganizationArtifactExpression(policy, input, own, additionalForbidden, sources) {
    if (policy.codkitOrganizationPolicy === 1 || !own)
        return checkOrganizationExpression(policy, input, own, additionalForbidden);
    if (sources.length === 0)
        return refuse('scoped own artifact requires inspected source licences');
    const expressions = [];
    for (const source of sources) {
        const checked = checkOrganizationExpression(policy, source.license, true, additionalForbidden, source.path);
        if (!checked.ok)
            return checked;
        expressions.push(checked.value.canonical);
    }
    const unique = [...new Set(expressions)].sort();
    const combined = unique.length === 1 ? unique[0] : unique.map((value) => `( ${value} )`).join(' AND ');
    const parsed = parsePolicyExpression(input);
    if (!parsed.ok)
        return parsed;
    return parsed.value.canonical === combined ? parsed : refuse('own artifact must retain exact source-scope licence conjunction');
}
function refuse(message) {
    return { ok: false, problems: [message] };
}
