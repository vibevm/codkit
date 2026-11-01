/** @scope spec://codkit/modules/codkit/PROP-019#RELEASE-LICENSING-SELECTION */
// Fixed patchset data selects a profile; only trusted composition selects the store.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readContainedFile } from './containedFile.ts';
import { decodeUtf8Strict } from './bytes.ts';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.ts';
import { distributionDeclarationSchema, captureDistributionProvenance } from './distributionProvenance.ts';
import { organizationPolicySelectionSchema, parsePolicyExpression } from './organizationPolicy.ts';
import { organizationPolicyRoot, readOrganizationPolicy } from './organizationPolicyStore.ts';
import type { SelectedOrganizationPolicy } from './organizationPolicyStore.ts';
import { checkDistributionNotices } from './distributionNotices.ts';
import { checkDistributionDocument, renderDistributionDocuments } from './distributionDocuments.ts';
import { captureReleaseEntries } from './releaseArtifacts.ts';
import { checkConsumerLicenses, isConsumerLicenseMetadata } from './consumerLicenseCheck.ts';
import { ckError } from './messages.ts';
import { runGit } from './gitx.ts';

export const RELEASE_LICENSING_FILE = 'codkit.licensing.json';

/**
 * ##LICENSING-DECLARATION-V2: the `product` block of a version-2 declaration -
 * display choices only. The licence file is a base name; the holder must be one
 * of the profile's holders (checked against the store, not here); the year is
 * four digits; the retired notices are phrases the guard forbids.
 */
export const licensingProductSchema = z.strictObject({
	licenseFile: z
		.string()
		.min(1)
		.refine((value) => !/[\\/]/u.test(value) && value !== '.' && value !== '..', 'the licence file is a base name'),
	title: z.string().min(1).optional(),
	holder: z.string().min(1).optional(),
	year: z
		.string()
		.regex(/^\d{4}$/u)
		.optional(),
	url: z.url().optional(),
	retiredNotices: z.array(z.string().min(1)).optional()
});
const path = z.string().refine((value) => repoRelativePathProblem(value) === null);
const operation = z.strictObject({ declaration: distributionDeclarationSchema, sbomFile: path.nullable() });
export const releaseLicensingSchema = z.strictObject({
	codkitReleaseLicensing: z.literal(1),
	profile: organizationPolicySelectionSchema.shape.profile,
	additionalForbidden: organizationPolicySelectionSchema.shape.additionalForbidden,
	componentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
	created: z.iso.datetime().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
	sourceDirectory: z.union([z.literal('.'), path]),
	package: operation.optional(),
	publish: operation.optional()
});
/** Version 2 keeps every field of version 1 and adds the optional `product` block (##LICENSING-DECLARATION-V2). */
export const licensingDeclarationV2Schema = releaseLicensingSchema.extend({
	codkitReleaseLicensing: z.literal(2),
	product: licensingProductSchema.optional()
});
export const licensingDeclarationSchema = z.discriminatedUnion('codkitReleaseLicensing', [
	releaseLicensingSchema,
	licensingDeclarationV2Schema
]);
export type LicensingDeclaration = Readonly<z.infer<typeof licensingDeclarationSchema>>;

export type ReleaseLicensing = {
	readonly declaration: LicensingDeclaration;
	readonly sha256: string;
	readonly selected: SelectedOrganizationPolicy;
	/** Whether the declaration configures the requested operation; false is incomplete evidence, recorded (##LICENSING-DECLARATION-V2). */
	readonly configured: boolean;
};
export type ReleaseLicensingEvidence = {
	readonly policy: SelectedOrganizationPolicy;
	readonly evidence: readonly { readonly requirement: string; readonly reference: string; readonly sha256: string }[];
};

export function readReleaseLicensing(
	patchesDir: string,
	requested: 'package' | 'publish',
	trustedRoot: string = organizationPolicyRoot(),
	trustBoundaryPatchset: string = patchesDir
): ReleaseLicensing | null {
	const read = readContainedFile(patchesDir, RELEASE_LICENSING_FILE, { what: 'release licensing declaration' });
	if (read.state === 'absent') return null;
	try {
		const text = decodeUtf8Strict(read.bytes);
		if (text === null) throw new Error('release licensing declaration is not UTF-8');
		const declaration = licensingDeclarationSchema.parse(JSON.parse(text));
		// An operation the declaration leaves unconfigured is the caller's to report
		// as incomplete evidence (##LICENSING-DECLARATION-V2); the declaration still
		// selects the profile the operation is measured against.
		const selected = readOrganizationPolicy(trustedRoot, trustBoundaryPatchset, {
			profile: declaration.profile,
			...(declaration.additionalForbidden === undefined ? {} : { additionalForbidden: declaration.additionalForbidden })
		});
		if (!selected.ok) throw new Error(selected.problems.join('; '));
		return { declaration, sha256: hash(read.bytes), selected: selected.value, configured: declaration[requested] !== undefined };
	} catch (error) {
		throw ckError('CONFIG', error instanceof Error ? error.message : 'release licensing declaration is invalid');
	}
}

/**
 * ##LICENSING-DECLARATION-V2: the evidence of an operation the declaration leaves
 * unconfigured - the selected, trusted profile and nothing more. The notices, the
 * provenance and the SBOM stay missing, and the release says so.
 */
export function unconfiguredReleaseLicensing(licensing: ReleaseLicensing): ReleaseLicensingEvidence {
	const { selected } = licensing;
	return {
		policy: selected,
		evidence: [
			{
				requirement: 'organization-policy',
				reference: `profile:${selected.policy.id}@${selected.policy.version}`,
				sha256: hash(
					JSON.stringify({
						declaration: licensing.sha256,
						policy: { id: selected.policy.id, version: selected.policy.version, sha256: selected.sha256 }
					})
				)
			}
		]
	};
}

export function readSnapshotReleaseLicensing(
	repository: string,
	snapshot: string,
	commit: string,
	trustedRoot?: string
): ReleaseLicensing | null {
	const tree = runGit({ cwd: repository, args: ['ls-tree', '-z', commit, '--', RELEASE_LICENSING_FILE] });
	if (tree.status !== 0) throw ckError('CONFIG', 'cannot inspect selected licensing declaration');
	const current = readReleaseLicensing(snapshot, 'publish', trustedRoot, repository);
	if (tree.stdout === '') {
		if (current !== null) throw ckError('CONFIG', 'licensing declaration was added to immutable publish snapshot');
		return null;
	}
	if (!/^100(?:644|755) blob [0-9a-f]{40}\tcodkit\.licensing\.json\0$/u.test(tree.stdout))
		throw ckError('CONFIG', 'selected licensing declaration must be a regular Git blob');
	const blob = runGit({ cwd: repository, args: ['show', `${commit}:${RELEASE_LICENSING_FILE}`] });
	if (blob.status !== 0 || current === null || hash(blob.stdout) !== current.sha256)
		throw ckError('CONFIG', 'licensing declaration differs from selected immutable publish commit');
	return current;
}

export function assertReleaseLicensingUnchanged(
	patchesDir: string,
	requested: 'package' | 'publish',
	captured: ReleaseLicensing | null,
	trustedRoot?: string
): void {
	const current = readReleaseLicensing(patchesDir, requested, trustedRoot);
	if (
		current?.sha256 !== captured?.sha256 ||
		current?.selected.sha256 !== captured?.selected.sha256 ||
		current?.selected.storeSha256 !== captured?.selected.storeSha256
	)
		throw ckError('CONFIG', 'release licensing declaration or trusted organization store changed during the operation');
}

/** No document is created or repaired by this gate; packaging must attach the expected documents. */
export function checkReleaseLicensing(options: {
	readonly licensing: ReleaseLicensing;
	readonly sourceTree: string;
	readonly artifactRoot: string;
	readonly outputs: readonly string[];
	readonly operation: 'package' | 'publish';
}): ReleaseLicensingEvidence {
	const { licensing } = options;
	const declaration = licensing.declaration[options.operation];
	if (declaration === undefined) throw ckError('CONFIG', 'release operation has no licensing declaration');
	const source =
		licensing.declaration.sourceDirectory === '.'
			? { ok: true, absolute: options.sourceTree }
			: resolveContainedPath(options.sourceTree, licensing.declaration.sourceDirectory);
	if (!source.ok) throw ckError('CONFIG', 'licensing source directory is not a contained real directory');
	const selected = licensing.selected;
	const notices = checkDistributionNotices(options.artifactRoot, options.outputs, selected, options.operation === 'publish');
	if (notices.status !== 'complete')
		throw ckError('CONFIG', notices.problems.map((problem) => `${problem.file}: ${problem.message}`).join('; '));
	const noticePaths = notices.notices.map((notice) => notice.path);
	const expectsSbom = selected.policy.distribution.sbom === 'spdx-json';
	if (expectsSbom !== (declaration.sbomFile !== null))
		throw ckError('CONFIG', 'SBOM attachment must agree with selected organization policy');
	const approvedMetadata = [...noticePaths, ...(declaration.sbomFile === null ? [] : [declaration.sbomFile])];
	if (JSON.stringify([...approvedMetadata].sort()) !== JSON.stringify([...declaration.declaration.metadata].sort()))
		throw ckError('CONFIG', 'metadata exclusions must be exactly the required notices and selected SBOM');
	const proof = captureDistributionProvenance({
		sourceRoot: source.absolute,
		artifactRoot: options.artifactRoot,
		outputs: options.outputs,
		selected,
		declaration: declaration.declaration,
		approvedMetadata
	});
	if (!proof.ok) throw ckError('CONFIG', proof.problems.join('; '));
	const rendered = renderDistributionDocuments({
		provenance: proof.value,
		selected,
		componentId: licensing.declaration.componentId,
		created: licensing.declaration.created
	});
	if (!rendered.ok) throw ckError('CONFIG', rendered.problems.join('; '));
	const documents = [];
	for (const path of noticePaths) {
		const checked = checkDistributionDocument(options.artifactRoot, path, rendered.value.notice, proof.value);
		if (!checked.ok) throw ckError('CONFIG', checked.problems.join('; '));
		documents.push(checked.value);
	}
	const evidence = [
		{
			requirement: 'organization-policy',
			reference: `profile:${selected.policy.id}@${selected.policy.version}`,
			sha256: hash(JSON.stringify({ declaration: licensing.sha256, policy: proof.value.policy }))
		},
		{ requirement: 'distribution-notices', reference: 'attached:canonical-notices', sha256: hash(JSON.stringify(documents)) },
		{ requirement: 'distribution-provenance', reference: 'inspected:source-and-payload', sha256: hash(JSON.stringify(proof.value)) }
	];
	if (declaration.sbomFile !== null && rendered.value.sbom !== null) {
		const checked = checkDistributionDocument(options.artifactRoot, declaration.sbomFile, rendered.value.sbom, proof.value);
		if (!checked.ok) throw ckError('CONFIG', checked.problems.join('; '));
		evidence.push({ requirement: 'sbom', reference: `attached:${declaration.sbomFile}`, sha256: checked.value.sha256 });
	} else evidence.push({ requirement: 'sbom', reference: 'policy:sbom-none', sha256: hash(JSON.stringify(selected.policy.distribution)) });
	if (selected.policy.distribution.requireSourceCarriers) {
		const entries = captureReleaseEntries(options.artifactRoot, options.outputs);
		if (!entries.ok) throw ckError('CONFIG', entries.problem.message);
		const report = checkConsumerLicenses(
			options.artifactRoot,
			selected,
			entries.value.filter((entry) => entry.kind !== 'directory' && !approvedMetadata.includes(entry.path)).map((entry) => entry.path)
		);
		if (
			report.status !== 'complete' ||
			report.checked.length !== proof.value.files.filter((file) => !isConsumerLicenseMetadata(file.path)).length
		)
			throw ckError('CONFIG', 'delivered source carriers are incomplete');
		for (const file of report.checked) {
			const mapped = proof.value.files.find((entry) => entry.path === file.path);
			const license = parsePolicyExpression(file.license);
			if (mapped === undefined || mapped.scope !== file.kind || !license.ok || license.value.canonical !== mapped.license)
				throw ckError('CONFIG', 'delivered source carrier disagrees with the inspected build declaration');
		}
		for (const file of proof.value.files.filter((file) => isConsumerLicenseMetadata(file.path))) {
			if (file.path.endsWith('/REUSE.toml') || file.path === 'REUSE.toml' || file.path.endsWith('.license')) continue;
			const text = readContainedFile(options.artifactRoot, file.path, { what: 'delivered canonical license text' });
			const approved = [...selected.policy.customLicenses, ...(selected.policy.standardLicenseTexts ?? [])];
			if (text.state === 'absent' || !approved.some((record) => hash(text.bytes) === record.sha256))
				throw ckError('CONFIG', 'delivered license-text metadata differs from trusted canonical texts');
		}
		evidence.push({
			requirement: 'distribution-source-carriers',
			reference: 'inspected:delivered-carriers',
			sha256: hash(JSON.stringify(report))
		});
	}
	return { policy: selected, evidence };
}
function hash(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}
