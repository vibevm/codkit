/** @scope spec://codkit/modules/codkit/PROP-018#COMPONENT-RELEASE-FORMAT */
// Immutable release data. This seam never executes adapters or authorizes delivery.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { typeManifestSchema } from '@codkit/type-api';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.ts';
import { readContainedFile, writeContainedFileExclusive } from './containedFile.ts';
import { MINIMAL_DISCIPLINE } from './discipline.ts';
import { repoRelativePathProblem } from './pathSafety.ts';

export const COMPONENT_RELEASE_VERSION = 1;
export const COMPONENT_RELEASE_DIRECTORY = '.codkit/releases';
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z
	.string()
	.regex(/^[0-9a-f]{40}$/)
	.brand<'ReleaseCommit'>();
const tree = z
	.string()
	.regex(/^[0-9a-f]{40}$/)
	.brand<'ReleaseTree'>();
const digest = sha256.brand<'ComponentReleaseDigest'>();
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const artifactPath = z.string().refine((value) => repoRelativePathProblem(value) === null, 'must be a contained repository path');

const byteArtifact = z.strictObject({
	kind: z.enum(['file', 'directory', 'symlink']),
	path: artifactPath,
	sha256: sha256.brand<'ReleaseArtifactDigest'>(),
	bytes: z.number().int().nonnegative()
});
const artifact = z.union([
	byteArtifact,
	z.strictObject({ kind: z.literal('git-commit'), objectId: commit }),
	z.strictObject({ kind: z.literal('git-tree'), objectId: tree })
]);
const evidence = z.strictObject({
	requirement: identifier,
	reference: z.string().min(1),
	sha256: sha256.brand<'DistributionEvidenceDigest'>()
});
const distribution = z
	.strictObject({
		requirements: z.array(identifier).min(1),
		evidence: z.array(evidence),
		missing: z.array(identifier),
		status: z.enum(['complete', 'incomplete'])
	})
	.superRefine((value, context) => {
		for (const [key, entries] of [
			['requirements', value.requirements],
			['missing', value.missing],
			['evidence', value.evidence.map((entry) => entry.requirement)]
		] as const) {
			if (new Set(entries).size !== entries.length)
				context.addIssue({ code: 'custom', path: [key], message: 'requirements and evidence must not repeat' });
		}
		const requirements = new Set(value.requirements);
		const supplied = new Set(value.evidence.map((entry) => entry.requirement));
		if (value.evidence.some((entry) => !requirements.has(entry.requirement)))
			context.addIssue({ code: 'custom', path: ['evidence'], message: 'evidence must name a declared requirement' });
		const missing = value.requirements.filter((entry) => !supplied.has(entry)).sort();
		if (
			JSON.stringify([...value.missing].sort()) !== JSON.stringify(missing) ||
			value.status !== (missing.length === 0 ? 'complete' : 'incomplete')
		)
			context.addIssue({
				code: 'custom',
				path: ['status'],
				message: 'evidence status and missing list must follow the supplied requirement receipts'
			});
	});

export const componentReleaseBodySchema = z
	.strictObject({
		codkitComponentRelease: z.literal(COMPONENT_RELEASE_VERSION),
		componentId: identifier.brand<'ReleaseComponentId'>(),
		operation: z.enum(['package', 'publish']),
		upstream: z.strictObject({
			revision: commit,
			label: z.string().min(1).nullable(),
			commitDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			resolvedAt: z.iso.datetime({ offset: true }).optional(),
			provenance: z.strictObject({ source: z.string().min(1), sha256: sha256.brand<'UpstreamProvenanceDigest'>() }).optional()
		}),
		patchset: z.strictObject({ commit, configSha256: sha256.brand<'ReleaseConfigDigest'>() }),
		type: z.strictObject({
			id: typeManifestSchema.shape.id,
			package: typeManifestSchema.shape.package,
			version: typeManifestSchema.shape.version,
			contractVersion: typeManifestSchema.shape.contractVersion,
			manifestSha256: sha256.brand<'ReleaseTypeManifestDigest'>()
		}),
		discipline: z.literal(MINIMAL_DISCIPLINE),
		generated: z.strictObject({ tip: commit, tree }),
		artifacts: z.array(artifact).min(1),
		buildRecipeSha256: sha256.brand<'ReleaseBuildRecipeDigest'>(),
		licensePolicies: z
			.array(
				z.strictObject({
					scope: z.enum(['codkit-supply', 'organization']),
					id: identifier,
					version: z.number().int().positive(),
					sha256: sha256.brand<'ReleaseLicensePolicyDigest'>()
				})
			)
			.min(1),
		distribution
	})
	.superRefine((body, context) => {
		const paths = body.artifacts.map(artifactKey);
		if (new Set(paths).size !== paths.length)
			context.addIssue({ code: 'custom', path: ['artifacts'], message: 'artifact identities must not repeat' });
		const policies = body.licensePolicies.map((policy) => `${policy.scope}:${policy.id}`);
		if (new Set(policies).size !== policies.length)
			context.addIssue({ code: 'custom', path: ['licensePolicies'], message: 'policy identities must not repeat' });
	});
// Schema/version stays at the root; the digest seals every other field.
export const componentReleaseSchema = componentReleaseBodySchema.safeExtend({ descriptorSha256: digest });
export type ComponentReleaseBody = Readonly<z.infer<typeof componentReleaseBodySchema>>;
export type ComponentRelease = Readonly<z.infer<typeof componentReleaseSchema>>;
export type ComponentReleaseDigest = z.infer<typeof digest>;
export type ComponentReleaseProblem = {
	readonly kind: 'version' | 'shape' | 'canonical' | 'integrity' | 'storage';
	readonly message: string;
};
export type ComponentReleaseResult<T> =
	{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: ComponentReleaseProblem };

/**
 * @example
 * const sealed = sealComponentRelease(data);
 * if (sealed.ok) console.log(sealed.value.descriptorSha256);
 */
export function sealComponentRelease(raw: unknown): ComponentReleaseResult<ComponentRelease> {
	const parsed = componentReleaseBodySchema.safeParse(raw);
	if (!parsed.success) return refuse('shape', issueMessage(parsed.error));
	const body = canonicalBody(parsed.data);
	return { ok: true, value: { ...body, descriptorSha256: digest.parse(hash(body)) } };
}

/** Exact bytes are LF-only UTF-8, canonical order and one terminal newline. */
export function serializeComponentRelease(raw: unknown): ComponentReleaseResult<Uint8Array> {
	const parsed = componentReleaseSchema.safeParse(raw);
	if (!parsed.success) return refuse('shape', issueMessage(parsed.error));
	const { descriptorSha256, ...body } = parsed.data;
	const sealed = sealComponentRelease(body);
	if (!sealed.ok) return sealed;
	if (sealed.value.descriptorSha256 !== descriptorSha256) return refuse('integrity', 'component release digest does not match its body');
	return { ok: true, value: encodeUtf8(`${JSON.stringify(sealed.value, null, 2)}\n`) };
}

export function parseComponentRelease(bytes: Uint8Array): ComponentReleaseResult<ComponentRelease> {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return refuse('canonical', 'component release must not contain a BOM');
	const text = decodeUtf8Strict(bytes);
	if (text === null || text.includes('\r') || !text.endsWith('\n') || text.endsWith('\n\n'))
		return refuse('canonical', 'component release must be LF-only UTF-8 with one final newline');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return refuse('shape', 'component release is not JSON');
	}
	const version = z.object({ codkitComponentRelease: z.number().int() }).safeParse(raw);
	if (version.success && version.data.codkitComponentRelease > COMPONENT_RELEASE_VERSION)
		return refuse('version', 'component release is newer than this tool; update codkit');
	const parsed = componentReleaseSchema.safeParse(raw);
	if (!parsed.success) return refuse('shape', issueMessage(parsed.error));
	const canonical = serializeComponentRelease(parsed.data);
	if (!canonical.ok) return canonical;
	if (!bytesEqual(bytes, canonical.value)) return refuse('canonical', 'component release bytes are not canonical');
	return { ok: true, value: parsed.data };
}

/** Atomic publish-if-absent; a retry compares bytes and never replaces a receipt. */
export function writeComponentRelease(
	root: string,
	raw: unknown
): ComponentReleaseResult<{ readonly path: string; readonly created: boolean; readonly release: ComponentRelease }> {
	const serialized = serializeComponentRelease(raw);
	if (!serialized.ok) return serialized;
	const parsed = parseComponentRelease(serialized.value);
	if (!parsed.ok) return parsed;
	const path = releasePath(parsed.value.descriptorSha256);
	try {
		const created = writeContainedFileExclusive(root, path, { what: 'component release', bytes: serialized.value });
		const read = readContainedFile(root, path, { what: 'component release' });
		if (read.state === 'absent' || !bytesEqual(read.bytes, serialized.value))
			return refuse('storage', 'immutable component release path contains conflicting or missing bytes');
		return { ok: true, value: { path, created, release: parsed.value } };
	} catch (error) {
		return refuse('storage', error instanceof Error ? error.message : 'component release publication failed');
	}
}

export function readComponentRelease(root: string, rawDigest: unknown): ComponentReleaseResult<ComponentRelease> {
	const key = digest.safeParse(rawDigest);
	if (!key.success) return refuse('shape', 'component release key must be a full lower-case SHA-256 digest');
	try {
		const read = readContainedFile(root, releasePath(key.data), { what: 'component release' });
		if (read.state === 'absent') return refuse('storage', 'component release does not exist');
		const parsed = parseComponentRelease(read.bytes);
		if (!parsed.ok) return parsed;
		return parsed.value.descriptorSha256 === key.data ? parsed : refuse('integrity', 'component release key does not match its receipt');
	} catch (error) {
		return refuse('storage', error instanceof Error ? error.message : 'component release read failed');
	}
}

function canonicalBody(body: ComponentReleaseBody): ComponentReleaseBody {
	return {
		...body,
		artifacts: [...body.artifacts].sort((left, right) => compare(artifactKey(left), artifactKey(right))),
		licensePolicies: [...body.licensePolicies].sort((left, right) => compare(`${left.scope}:${left.id}`, `${right.scope}:${right.id}`)),
		distribution: {
			...body.distribution,
			requirements: [...body.distribution.requirements].sort(compare),
			evidence: [...body.distribution.evidence].sort((left, right) => compare(left.requirement, right.requirement)),
			missing: [...body.distribution.missing].sort(compare)
		}
	};
}
function artifactKey(entry: z.infer<typeof artifact>): string {
	return entry.kind === 'git-commit' || entry.kind === 'git-tree' ? `${entry.kind}:${entry.objectId}` : entry.path;
}
function compare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}
function hash(body: ComponentReleaseBody): string {
	return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
function releasePath(key: ComponentReleaseDigest): string {
	return `${COMPONENT_RELEASE_DIRECTORY}/${key}.json`;
}
function issueMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	return `${issue?.path.map(String).join('.') || 'document'}: ${issue?.message ?? 'invalid release data'}`;
}
function refuse(kind: ComponentReleaseProblem['kind'], message: string): { readonly ok: false; readonly problem: ComponentReleaseProblem } {
	return { ok: false, problem: { kind, message } };
}
