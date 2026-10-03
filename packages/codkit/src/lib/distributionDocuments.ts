/** @scope spec://codkit/modules/codkit/PROP-019#DISTRIBUTION-DOCUMENTS */
// Render payload evidence without metadata hashes, avoiding NOTICE/SBOM self-reference.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { distributionProvenanceSchema } from './distributionProvenance.ts';
import type { DistributionProvenance } from './distributionProvenance.ts';
import { readContainedFile } from './containedFile.ts';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import { checkOrganizationExpression, parsePolicyExpression } from './organizationPolicy.ts';
import type { OrganizationPolicyResult } from './organizationPolicy.ts';
import type { SelectedOrganizationPolicy } from './organizationPolicyStore.ts';
import { captureReleaseEntries } from './releaseArtifacts.ts';

export const SPDX_EXPORT_VERSION = 'SPDX-2.3';
export const DISTRIBUTION_NOTICE_VERSION = 1;
const createdTime = z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const spdxId = z.string().regex(/^SPDXRef-[A-Za-z0-9.+-]+$/);
export const distributionSpdxSchema = z.strictObject({
	spdxVersion: z.literal(SPDX_EXPORT_VERSION),
	dataLicense: z.literal('CC0-1.0'),
	SPDXID: z.literal('SPDXRef-DOCUMENT'),
	name: z.string().min(1),
	documentNamespace: z.url().refine((value) => !value.includes('#')),
	creationInfo: z.strictObject({ creators: z.array(z.string().regex(/^Tool: /)).min(1), created: createdTime }),
	documentDescribes: z.array(spdxId).min(1),
	comment: z.string(),
	files: z
		.array(
			z.strictObject({
				SPDXID: spdxId,
				fileName: z.string().min(1),
				checksums: z.array(z.strictObject({ algorithm: z.literal('SHA256'), checksumValue: z.string().regex(/^[0-9a-f]{64}$/) })).length(1),
				licenseConcluded: z.string().min(1),
				licenseComments: z.string(),
				comment: z.string()
			})
		)
		.min(1),
	hasExtractedLicensingInfos: z.array(z.strictObject({ licenseId: z.string().regex(/^LicenseRef-/), extractedText: z.string().min(1) }))
});
export type DistributionSpdx = Readonly<z.infer<typeof distributionSpdxSchema>>;
export type DistributionDocuments = { readonly notice: string; readonly spdx: DistributionSpdx | null; readonly sbom: string | null };

/** Conclusions are the explicit policy-checked build declarations, never inferred from disappeared minified headers. */
export function renderDistributionDocuments(options: {
	readonly provenance: DistributionProvenance;
	readonly selected: SelectedOrganizationPolicy;
	readonly componentId: string;
	readonly created: string;
}): OrganizationPolicyResult<DistributionDocuments> {
	try {
		const proof = distributionProvenanceSchema.parse(options.provenance);
		if (
			proof.policy.id !== options.selected.policy.id ||
			proof.policy.version !== options.selected.policy.version ||
			proof.policy.sha256 !== options.selected.sha256 ||
			proof.policy.storeSha256 !== options.selected.storeSha256 ||
			JSON.stringify(proof.policy.additionalForbidden) !== JSON.stringify([...options.selected.additionalForbidden].sort())
		)
			throw new Error('distribution provenance differs from selected organization authority');
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.componentId)) throw new Error('component identifier is invalid');
		if (!createdTime.safeParse(options.created).success)
			throw new Error('SPDX creation time must be an explicit UTC timestamp in whole seconds');
		const files = [...proof.files].sort((left, right) => compare(left.path, right.path));
		if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error('distribution payload paths repeat');
		const used = new Set<string>();
		for (const file of files) {
			const verdict = checkOrganizationExpression(
				options.selected.policy,
				file.license,
				file.scope === 'own',
				options.selected.additionalForbidden
			);
			if (!verdict.ok) throw new Error(verdict.problems.join('; '));
			for (const id of [...verdict.value.licenses, ...verdict.value.exceptions]) used.add(id);
		}
		const terms = [...used].sort().map((id) => {
			const records = id.startsWith('LicenseRef-')
				? options.selected.policy.customLicenses
				: (options.selected.policy.standardLicenseTexts ?? []);
			const record = records.find((entry) => entry.id === id);
			if (record === undefined || hash(record.text) !== record.sha256)
				throw new Error('license/exception text is missing or differs from selected trusted policy');
			return { licenseId: id, extractedText: record.text };
		});
		const evidence = { componentId: options.componentId, policy: proof.policy, sourceReportSha256: proof.sourceReportSha256, files };
		const lines = [
			`Codkit distribution notices v${DISTRIBUTION_NOTICE_VERSION}`,
			`Component: ${options.componentId}`,
			`Policy: ${proof.policy.id}@${proof.policy.version} sha256:${proof.policy.sha256}`,
			`Authority: ${JSON.stringify(proof.policy)}`,
			`Source evidence: sha256:${proof.sourceReportSha256}`,
			'Build mapping is declared provenance, not a legal approval or proof of compilation.',
			''
		];
		for (const file of files) {
			lines.push(
				`File: ${JSON.stringify(file.path)}`,
				`SHA256: ${file.sha256}`,
				`License: ${file.license}`,
				`Scope: ${file.scope}`,
				`Holders: ${JSON.stringify(file.holders)}`
			);
			for (const source of file.sources) lines.push(`Source: ${JSON.stringify(source)}`);
			lines.push('');
		}
		let notice = `${lines.join('\n')}\n`;
		for (const term of terms) notice += `License text: ${term.licenseId}\n${term.extractedText}\n`;
		if (options.selected.policy.distribution.sbom === 'none') return { ok: true, value: { notice, spdx: null, sbom: null } };
		const body = {
			spdxVersion: SPDX_EXPORT_VERSION,
			dataLicense: 'CC0-1.0',
			SPDXID: 'SPDXRef-DOCUMENT',
			name: options.componentId,
			creationInfo: { creators: ['Tool: Codkit'], created: options.created },
			comment: `Codkit distribution evidence sha256:${hash(JSON.stringify(evidence))}; declared build provenance; policy approval is not a legal ruling. Metadata documents are excluded to avoid self-referential hashes.`,
			documentDescribes: files.map((file) => `SPDXRef-file-${hash(file.path)}`),
			files: files.map((file) => ({
				SPDXID: `SPDXRef-file-${hash(file.path)}`,
				fileName: `./${file.path}`,
				checksums: [{ algorithm: 'SHA256', checksumValue: file.sha256 }],
				licenseConcluded: file.license,
				licenseComments: `Explicit policy-checked build declaration; scope ${file.scope}; sources ${JSON.stringify(file.sources)}`,
				comment: `Artifact kind ${file.kind}; ${file.bytes} bytes; declared source holders ${JSON.stringify(file.holders)}. File-level copyright and in-file license information are not inferred from source.`
			})),
			hasExtractedLicensingInfos: terms.filter((term) => term.licenseId.startsWith('LicenseRef-'))
		};
		const spdx = distributionSpdxSchema.parse({
			...body,
			documentNamespace: `https://spdx.org/spdxdocs/codkit-${hash(JSON.stringify(body))}`
		});
		return { ok: true, value: { notice, spdx, sbom: `${JSON.stringify(spdx, null, 2)}\n` } };
	} catch (error) {
		return { ok: false, problems: [error instanceof Error ? error.message : 'distribution document rendering failed'] };
	}
}

/** Exact expected bytes plus a fresh payload observation; arbitrary JSON or a stale document cannot satisfy evidence. */
export function checkDistributionDocument(
	root: string,
	path: string,
	expected: string,
	proof: DistributionProvenance
): OrganizationPolicyResult<{ readonly path: string; readonly sha256: string }> {
	try {
		const read = readContainedFile(root, path, { what: 'distribution evidence document' });
		if (read.state === 'absent' || decodeUtf8Strict(read.bytes) === null || !bytesEqual(read.bytes, encodeUtf8(expected)))
			throw new Error('attached distribution document is missing, stale or noncanonical');
		const entries = captureReleaseEntries(
			root,
			proof.files.map((file) => file.path)
		);
		if (!entries.ok) throw new Error(entries.problem.message);
		for (const file of proof.files) {
			const actual = entries.value.find((entry) => entry.path === file.path);
			if (actual?.sha256 !== file.sha256 || actual.bytes !== file.bytes || actual.kind !== file.kind)
				throw new Error('distribution payload changed after document rendering');
			if (!parsePolicyExpression(file.license).ok) throw new Error('distribution declaration has an undetermined license');
		}
		const confirmed = readContainedFile(root, path, { what: 'distribution evidence document confirmation' });
		if (confirmed.state === 'absent' || !bytesEqual(confirmed.bytes, read.bytes))
			throw new Error('attached distribution document changed during inspection');
		return { ok: true, value: { path, sha256: hash(read.bytes) } };
	} catch (error) {
		return { ok: false, problems: [error instanceof Error ? error.message : 'distribution document inspection failed'] };
	}
}
function hash(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}
function compare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}
