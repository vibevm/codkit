/** @scope spec://codkit/modules/codkit/PROP-019#ORGANIZATION-POLICY-FORMAT */
// Consumer enforcement data; never a replacement for installed Codkit supply policy.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SpdxLicenseIds } from './spdxIds.ts';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const expression = z.string().min(1).max(4096);
export const organizationPolicySchema = z.strictObject({
	codkitOrganizationPolicy: z.literal(1),
	id: id.brand<'OrganizationPolicyId'>(),
	version: z.number().int().positive(),
	holders: z.array(z.string().min(1)).min(1),
	ownLicense: expression,
	allowedThirdParty: z.array(expression),
	forbiddenThirdParty: z.array(expression),
	allowedExceptions: z.array(id),
	licenseRefNamespace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/),
	customLicenses: z.array(
		z.strictObject({
			id: z.string().regex(/^LicenseRef-[A-Za-z0-9.-]+$/),
			text: z
				.string()
				.min(1)
				.max(1024 * 1024),
			sha256: z.string().regex(/^[0-9a-f]{64}$/)
		})
	),
	distribution: z.strictObject({ requiredNotices: z.array(id), sbom: z.enum(['spdx-json', 'none']), requireSourceCarriers: z.boolean() }),
	legalReviewReference: z.string().min(1).optional()
});
export const organizationPolicySelectionSchema = z.strictObject({
	profile: id,
	additionalForbidden: z.array(expression).optional()
});
export type OrganizationPolicy = Readonly<z.infer<typeof organizationPolicySchema>>;
export type OrganizationPolicySelection = Readonly<z.infer<typeof organizationPolicySelectionSchema>>;
export type OrganizationPolicyResult<T> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };
export type LicenseExpression = {
	readonly canonical: string;
	readonly licenses: readonly string[];
	readonly exceptions: readonly string[];
};

/** Syntax is validated; approved combinations are exact policy expressions, not inferred legal permissions. */
export function parsePolicyExpression(input: string): OrganizationPolicyResult<LicenseExpression> {
	if (input.length === 0 || input.length > 4096) return refuse('license expression is empty or too long');
	const tokens = input.match(/\(|\)|[A-Za-z0-9.+-]+|\S/g) ?? [];
	const licenses: string[] = [];
	const exceptions: string[] = [];
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
				if (depth > 64) return refuse('license expression is too deeply nested');
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
			if (depth === 0) return refuse('license expression has an unmatched parenthesis');
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
	if (expectingLicense || needException || depth !== 0) return refuse('license expression is incomplete');
	return { ok: true, value: { canonical: tokens.join(' '), licenses, exceptions } };
}

export function validateOrganizationPolicy(raw: unknown, standard: SpdxLicenseIds): OrganizationPolicyResult<OrganizationPolicy> {
	const version = z.object({ codkitOrganizationPolicy: z.number().int() }).safeParse(raw);
	if (version.success && version.data.codkitOrganizationPolicy > 1)
		return refuse('organization policy format is newer than this tool; update codkit');
	const parsed = organizationPolicySchema.safeParse(raw);
	if (!parsed.success) return refuse(`organization policy shape is invalid: ${parsed.error.issues[0]?.path.join('.') || 'document'}`);
	const policy = parsed.data;
	const problems: string[] = [];
	const custom = new Set<string>();
	for (const license of policy.customLicenses) {
		if (
			!license.id.startsWith(`LicenseRef-${policy.licenseRefNamespace}-`) ||
			license.id.length <= `LicenseRef-${policy.licenseRefNamespace}-`.length
		)
			problems.push('custom license is outside the organization namespace');
		if (custom.has(license.id)) problems.push('custom license identifiers repeat');
		custom.add(license.id);
		if (license.text.trim().length === 0) problems.push('custom license text is empty');
		if (license.text.startsWith('\ufeff') || license.text.includes('\r') || !license.text.endsWith('\n'))
			problems.push('custom license text must be canonical LF-only text with a final LF');
		if (createHash('sha256').update(license.text).digest('hex') !== license.sha256)
			problems.push(`custom license text digest differs: ${license.id}`);
	}
	for (const group of [policy.holders, policy.allowedExceptions, policy.distribution.requiredNotices])
		if (new Set(group).size !== group.length) problems.push('organization policy declarations repeat');
	for (const value of [policy.ownLicense, ...policy.allowedThirdParty, ...policy.forbiddenThirdParty]) {
		const checked = parsePolicyExpression(value);
		if (!checked.ok) {
			problems.push(...checked.problems);
			continue;
		}
		for (const license of checked.value.licenses)
			if (!standard.ids.has(license) && !custom.has(license))
				problems.push(`license is neither standard nor declared with text: ${license}`);
		for (const exception of checked.value.exceptions)
			if (!policy.allowedExceptions.includes(exception)) problems.push(`exception is not approved: ${exception}`);
	}
	return problems.length === 0 ? { ok: true, value: policy } : { ok: false, problems };
}

/** A patchset can select an ID and add prohibitions; it cannot supply policy paths, holders or permissions. */
export function selectOrganizationPolicy(
	policy: OrganizationPolicy,
	raw: unknown
): OrganizationPolicyResult<{ readonly policy: OrganizationPolicy; readonly additionalForbidden: readonly string[] }> {
	const selection = organizationPolicySelectionSchema.safeParse(raw);
	if (!selection.success || selection.data.profile !== policy.id)
		return refuse('patchset policy selection is unknown or contains policy authority fields');
	const forbidden: string[] = [];
	for (const value of selection.data.additionalForbidden ?? []) {
		const checked = parsePolicyExpression(value);
		if (!checked.ok) return checked;
		forbidden.push(checked.value.canonical);
	}
	return { ok: true, value: { policy, additionalForbidden: [...new Set(forbidden)].sort() } };
}

export function checkOrganizationExpression(
	policy: OrganizationPolicy,
	input: string,
	own: boolean,
	additionalForbidden: readonly string[] = []
): OrganizationPolicyResult<LicenseExpression> {
	const checked = parsePolicyExpression(input);
	if (!checked.ok) return checked;
	const value = checked.value;
	const prohibited = [...(own ? [] : policy.forbiddenThirdParty), ...additionalForbidden].map(parsePolicyExpression);
	if (prohibited.some((entry) => !entry.ok)) return refuse('policy prohibition is malformed');
	for (const entry of prohibited)
		if (entry.ok && (entry.value.canonical === value.canonical || entry.value.licenses.some((license) => value.licenses.includes(license))))
			return refuse('license expression contains a policy prohibition');
	if (value.exceptions.some((exception) => !policy.allowedExceptions.includes(exception)))
		return refuse('license exception is not approved');
	const allowed = own ? [policy.ownLicense] : policy.allowedThirdParty;
	if (
		!allowed.some((entry) => {
			const parsed = parsePolicyExpression(entry);
			return parsed.ok && parsed.value.canonical === value.canonical;
		})
	)
		return refuse(own ? 'own license differs from the trusted organization policy' : 'third-party expression is not approved');
	return checked;
}
function refuse(message: string): { readonly ok: false; readonly problems: readonly string[] } {
	return { ok: false, problems: [message] };
}
