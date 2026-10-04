/** @scope spec://codkit/modules/codkit/PROP-019#DISTRIBUTION-PROVENANCE */
// A declared build mapping binds inspected sources to every delivered payload file.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { checkConsumerLicenses, consumerLicenseReportSchema } from './consumerLicenseCheck.ts';
import { captureReleaseEntries } from './releaseArtifacts.ts';
import { checkOrganizationArtifactExpression, parsePolicyExpression } from './organizationPolicy.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import type { SelectedOrganizationPolicy } from './organizationPolicyStore.ts';
import type { OrganizationPolicyResult } from './organizationPolicy.ts';

const path = z.string().refine((value) => repoRelativePathProblem(value) === null);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const distributionDeclarationSchema = z
	.strictObject({
		codkitDistributionDeclaration: z.literal(1),
		files: z.array(z.strictObject({ path, sources: z.array(path).min(1), license: z.string().min(1) })).min(1),
		metadata: z.array(path).default([])
	})
	.superRefine((value, ctx) => {
		const paths = [...value.files.map((file) => file.path), ...value.metadata];
		if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', message: 'payload and metadata paths must be unique' });
		if (value.files.some((file) => new Set(file.sources).size !== file.sources.length))
			ctx.addIssue({ code: 'custom', message: 'source references must be unique' });
	});
export const distributionProvenanceSchema = z.strictObject({
	codkitDistributionProvenance: z.literal(1),
	policy: z.strictObject({
		id: z.string(),
		version: z.number().int().positive(),
		sha256: digest,
		storeSha256: digest,
		additionalForbidden: z.array(z.string())
	}),
	sourceReportSha256: digest,
	declarationSha256: digest,
	artifactInventorySha256: digest,
	files: z
		.array(
			z.strictObject({
				path,
				kind: z.enum(['file', 'symlink']),
				sha256: digest,
				bytes: z.number().int().nonnegative(),
				license: z.string(),
				scope: z.enum(['own', 'third-party']),
				holders: z.array(z.string()).min(1),
				sources: z
					.array(
						z.strictObject({
							path,
							sha256: digest,
							carrierPath: path,
							carrierSha256: digest,
							license: z.string(),
							provenance: consumerLicenseReportSchema.shape.checked.element.shape.provenance
						})
					)
					.min(1)
			})
		)
		.min(1),
	metadata: z.array(z.strictObject({ path, sha256: digest, bytes: z.number().int().nonnegative() }))
});
export type DistributionProvenance = Readonly<z.infer<typeof distributionProvenanceSchema>>;

/** Metadata exemptions are supplied by trusted composition (e.g. inspected NOTICE/SBOM paths), never by declaration alone. */
export function captureDistributionProvenance(options: {
	readonly sourceRoot: string;
	readonly artifactRoot: string;
	readonly outputs: readonly string[];
	readonly selected: SelectedOrganizationPolicy;
	readonly declaration: unknown;
	readonly approvedMetadata: readonly string[];
}): OrganizationPolicyResult<DistributionProvenance> {
	try {
		const declaration = distributionDeclarationSchema.safeParse(options.declaration);
		if (!declaration.success) throw new Error('distribution declaration is malformed or has an unsupported version');
		if (declaration.data.metadata.some((entry) => !options.approvedMetadata.includes(entry)))
			throw new Error('declaration cannot exempt unapproved payload as metadata');
		const source = checkConsumerLicenses(options.sourceRoot, options.selected);
		if (source.status !== 'complete' || source.checked.length === 0)
			throw new Error('distribution source licensing evidence is incomplete');
		const before = captureReleaseEntries(options.artifactRoot, options.outputs);
		if (!before.ok) throw new Error(before.problem.message);
		const entries = before.value.filter((entry) => entry.kind !== 'directory');
		const payload = entries.filter((entry) => !declaration.data.metadata.includes(entry.path));
		if (
			payload.length !== declaration.data.files.length ||
			payload.some((entry) => !declaration.data.files.some((file) => file.path === entry.path))
		)
			throw new Error('distribution declaration must cover every delivered payload exactly once');
		if (declaration.data.metadata.some((path) => !entries.some((entry) => entry.path === path && entry.kind === 'file')))
			throw new Error('approved metadata must be an actual delivered regular file');
		const files: DistributionProvenance['files'] = [];
		for (const entry of payload) {
			const declared = declaration.data.files.find((file) => file.path === entry.path);
			if (declared === undefined) throw new Error('missing delivered file declaration');
			const sources = declared.sources.map((path) => {
				const found = source.checked.find((file) => file.path === path);
				if (found === undefined) throw new Error('provenance names an uninspected source file');
				return found;
			});
			const own = sources.every((file) => file.kind === 'own');
			const license = checkOrganizationArtifactExpression(
				options.selected.policy,
				declared.license,
				own,
				options.selected.additionalForbidden,
				sources
			);
			if (!license.ok) throw new Error(license.problems.join('; '));
			const sourceExpressions = sources.map((file) => parsePolicyExpression(file.license));
			if (sourceExpressions.some((expression) => !expression.ok)) throw new Error('source expression cannot be parsed');
			const expressions = [
				...new Set(sourceExpressions.flatMap((expression) => (expression.ok ? [expression.value.canonical] : [])))
			].sort();
			const combined = expressions.length === 1 ? expressions[0] : expressions.map((expression) => `( ${expression} )`).join(' AND ');
			if (license.value.canonical !== combined)
				throw new Error('artifact declaration must preserve complete source expressions; AND/OR/WITH cannot be rewritten');
			for (const key of ['licenses', 'exceptions'] as const) {
				const expected = new Set(sourceExpressions.flatMap((expression) => (expression.ok ? expression.value[key] : [])));
				if (expected.size !== new Set(license.value[key]).size || license.value[key].some((value) => !expected.has(value)))
					throw new Error('artifact license declaration drops or invents source license/exception identifiers');
			}
			if (entry.sha256 === undefined || entry.bytes === undefined || entry.kind === 'directory')
				throw new Error('artifact entry lacks byte evidence');
			files.push({
				path: entry.path,
				kind: entry.kind,
				sha256: entry.sha256,
				bytes: entry.bytes,
				license: license.value.canonical,
				scope: own ? 'own' : 'third-party',
				holders: [...new Set(sources.flatMap((file) => file.holders))].sort(),
				sources: sources
					.map((file) => ({
						path: file.path,
						sha256: file.sha256,
						carrierPath: file.carrierPath,
						carrierSha256: file.carrierSha256,
						license: file.license,
						...(file.provenance === undefined ? {} : { provenance: file.provenance })
					}))
					.sort((left, right) => compare(left.path, right.path))
			});
		}
		const after = captureReleaseEntries(options.artifactRoot, options.outputs);
		if (!after.ok || JSON.stringify(after.value) !== JSON.stringify(before.value))
			throw new Error('artifact inventory changed during provenance inspection');
		const sourceAfter = checkConsumerLicenses(options.sourceRoot, options.selected);
		if (JSON.stringify(sourceAfter) !== JSON.stringify(source))
			throw new Error('source licensing evidence changed during provenance inspection');
		return {
			ok: true,
			value: distributionProvenanceSchema.parse({
				codkitDistributionProvenance: 1,
				policy: {
					id: options.selected.policy.id,
					version: options.selected.policy.version,
					sha256: options.selected.sha256,
					storeSha256: options.selected.storeSha256,
					additionalForbidden: [...options.selected.additionalForbidden].sort()
				},
				sourceReportSha256: hash(JSON.stringify(source)),
				declarationSha256: hash(JSON.stringify(declaration.data)),
				artifactInventorySha256: hash(JSON.stringify(before.value)),
				files,
				metadata: entries
					.filter((entry) => declaration.data.metadata.includes(entry.path))
					.map((entry) => ({ path: entry.path, sha256: entry.sha256, bytes: entry.bytes }))
			})
		};
	} catch (error) {
		return { ok: false, problems: [error instanceof Error ? error.message : 'distribution provenance capture failed'] };
	}
}
function compare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}
function hash(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}
