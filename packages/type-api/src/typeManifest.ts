/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-API-STABILITY */
// Declarative registration metadata, validated before adapter execution.
import { z } from 'zod';
import { CAPABILITIES } from './capabilities.ts';

export const TYPE_MANIFEST_VERSION = 1;
export const TYPE_CONTRACT_VERSION = 1;

const versionSchema = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
const capabilitiesSchema = z
	.array(z.enum(CAPABILITIES))
	.refine((values) => new Set(values).size === values.length, 'capabilities must not repeat');

export const typeManifestSchema = z
	.object({
		typeManifestVersion: z.number().int().positive(),
		contractVersion: z.number().int().positive(),
		id: z.string().regex(/^[a-z][a-z0-9-]*$/),
		package: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/),
		version: versionSchema,
		engineRange: z.object({ min: versionSchema, maxExclusive: versionSchema }).strict(),
		capabilities: capabilitiesSchema,
		configurableCapabilities: capabilitiesSchema
	})
	.strict();

export type TypeManifest = z.infer<typeof typeManifestSchema>;
export type TypeManifestProblem = {
	readonly kind: 'shape' | 'manifest-version' | 'contract-version' | 'identity' | 'engine-version';
	readonly message: string;
};
export type TypeManifestResult =
	{ readonly ok: true; readonly manifest: TypeManifest } | { readonly ok: false; readonly problem: TypeManifestProblem };
export type TypeManifestExpectation = {
	readonly id: string;
	readonly package: string;
	readonly version: string;
	readonly engineVersion: string;
};

/**
 * @example
 * const result = validateTypeManifest(data, { id: 'generic', package: '@codkit/type-generic', version: '1.0.0', engineVersion: '1.0.0' });
 * if (result.ok) console.log(result.manifest.contractVersion);
 */
export function validateTypeManifest(raw: unknown, expected: TypeManifestExpectation): TypeManifestResult {
	const parsed = typeManifestSchema.safeParse(raw);
	if (!parsed.success)
		return refuse(
			'shape',
			`type manifest is invalid: ${parsed.error.issues[0]?.path.map(String).join('.') || 'document'}: ${parsed.error.issues[0]?.message ?? 'invalid data'}`
		);
	const manifest = parsed.data;
	if (manifest.typeManifestVersion !== TYPE_MANIFEST_VERSION)
		return refuse(
			'manifest-version',
			`${expected.package}: expected typeManifestVersion ${TYPE_MANIFEST_VERSION}, actual ${manifest.typeManifestVersion}`
		);
	if (manifest.contractVersion !== TYPE_CONTRACT_VERSION)
		return refuse(
			'contract-version',
			`${expected.package}: expected contractVersion ${TYPE_CONTRACT_VERSION}, actual ${manifest.contractVersion}`
		);
	if (manifest.id !== expected.id || manifest.package !== expected.package || manifest.version !== expected.version)
		return refuse(
			'identity',
			`type manifest identity ${manifest.id} ${manifest.package}@${manifest.version} differs from expected ${expected.id} ${expected.package}@${expected.version}`
		);
	const engine = versionSchema.safeParse(expected.engineVersion);
	if (
		!engine.success ||
		compareVersions(manifest.engineRange.min, manifest.engineRange.maxExclusive) >= 0 ||
		compareVersions(expected.engineVersion, manifest.engineRange.min) < 0 ||
		compareVersions(expected.engineVersion, manifest.engineRange.maxExclusive) >= 0
	)
		return refuse(
			'engine-version',
			`${expected.package}: expected engine >=${manifest.engineRange.min} <${manifest.engineRange.maxExclusive}, actual ${expected.engineVersion}`
		);
	return { ok: true, manifest };
}

function refuse(kind: TypeManifestProblem['kind'], message: string): TypeManifestResult {
	return { ok: false, problem: { kind, message } };
}

function compareVersions(left: string, right: string): number {
	const a = left.split('.');
	const b = right.split('.');
	for (let i = 0; i < 3; i++) {
		const x = BigInt(a[i] ?? '0');
		const y = BigInt(b[i] ?? '0');
		if (x < y) return -1;
		if (x > y) return 1;
	}
	return 0;
}
