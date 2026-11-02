/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONFIG-FIELD */
// The schema of `typeConfig` for this type.
//
// The engine validates the universal fields of `codkit.json` and hands the rest
// here; a refusal becomes `CK-E-CONFIG` naming the field. The first field of
// this type is the own root, and it is required and has no default - schema 2
// is the only schema (##VSCODE-OWN-ROOT-CONSTRAINT). The second one is optional
// and is the product's own word about the packaging it wants
// (##VSCODE-QUALITY-IS-A-PRODUCT-ANSWER).

import { z } from 'zod';
import { ownRootProblem } from './layout.ts';

/**
 * ##VSCODE-QUALITY-IS-A-PRODUCT-ANSWER: the quality channel the packaging of
 * this family bakes into the distributable. The three words are the ones the
 * upstream build itself distinguishes; anything else is a refusal rather than a
 * value handed to a packager that will read it as "not the released channel".
 */
export const QUALITY_CHANNELS = ['stable', 'insider', 'exploration'] as const;
export const PACKAGE_TARGET_IDS = [
	'windows-x64',
	'windows-arm64',
	'linux-x64',
	'linux-arm64',
	'linux-armhf',
	'macos-x64',
	'macos-arm64',
	'linux-x64-tar',
	'linux-x64-deb',
	'linux-x64-rpm',
	'windows-x64-archive',
	'windows-x64-setup-system',
	'windows-x64-setup-user',
	'server-linux-x64-tar'
] as const;

export type VscodeQuality = (typeof QUALITY_CHANNELS)[number];
export type VscodePackageTargetId = (typeof PACKAGE_TARGET_IDS)[number];

/** The platforms a package target of this family builds for. */
export const PACKAGE_PLATFORMS = ['windows', 'linux', 'macos'] as const;
export type VscodePackagePlatform = (typeof PACKAGE_PLATFORMS)[number];

/** One command of the product's packaging step: an argv, no shell (##VSCODE-PRODUCT-PACKAGING). */
export type VscodePackagingCommand = {
	readonly label?: string | undefined;
	readonly command: string;
	readonly args: readonly string[];
	/** The platforms whose targets it serves; absent, every one. */
	readonly platforms?: readonly VscodePackagePlatform[] | undefined;
};

/** An output of the product's step that only the targets of some platforms make. */
export type VscodePackagingOutput = { readonly path: string; readonly platforms: readonly VscodePackagePlatform[] };

/**
 * ##VSCODE-PRODUCT-PACKAGING: the product's own step after the upstream tasks,
 * and where it leaves what it makes, as tree-relative output patterns.
 */
export type VscodePackaging = {
	readonly commands: readonly VscodePackagingCommand[];
	readonly outputs?: readonly (string | VscodePackagingOutput)[] | undefined;
};

export type VscodeTypeConfig = {
	readonly ownRoot: string;
	/**
	 * Which channel the packaged product is. Absent means the patch set has not
	 * answered, and the packaging keeps the older behaviour of stamping the pin
	 * tag - so an existing patch set reads exactly as it did.
	 */
	readonly quality?: VscodeQuality | undefined;
	readonly packageTargets?: readonly VscodePackageTargetId[] | undefined;
	readonly packaging?: VscodePackaging | undefined;
};

/** A tree-relative output pattern: forward slashes, no leading slash, no empty, dot or dot-dot segment. */
export function packagingOutputProblem(value: string): string | null {
	if (value.includes('\\')) return 'must use forward slashes';
	if (value.startsWith('/')) return 'must be a path from the tree root, without a leading slash';
	const inner = value.endsWith('/') ? value.slice(0, -1) : value;
	if (inner === '' || inner.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return 'must stay inside the tree: no empty, dot or dot-dot segment';
	}
	return null;
}

const withoutNul = z.string().refine((value) => !value.includes('\u0000'), { message: 'must not contain NUL' });

const platformsSchema = z
	.array(z.enum(PACKAGE_PLATFORMS))
	.min(1)
	.refine((values) => new Set(values).size === values.length, { message: 'platforms must be unique' });

const packagingCommandSchema = z.strictObject({
	label: z.string().min(1).optional(),
	command: withoutNul.refine((value) => value !== '', { message: 'must name a program' }),
	args: z.array(withoutNul),
	platforms: platformsSchema.optional()
});

const outputPattern = z.string().superRefine((value, context) => {
	const problem = packagingOutputProblem(value);
	if (problem !== null) context.addIssue({ code: 'custom', message: problem });
});

const packagingSchema = z.strictObject({
	commands: z.array(packagingCommandSchema).min(1),
	outputs: z.array(z.union([outputPattern, z.strictObject({ path: outputPattern, platforms: platformsSchema })])).optional()
});

export const configSchema = z
	.object({
		ownRoot: z
			.string()
			.min(1)
			.superRefine((value, context) => {
				const problem = ownRootProblem(value);
				if (problem !== null) {
					context.addIssue({ code: 'custom', message: problem });
				}
			}),
		quality: z.enum(QUALITY_CHANNELS).optional(),
		packageTargets: z
			.array(z.enum(PACKAGE_TARGET_IDS))
			.min(1)
			.max(PACKAGE_TARGET_IDS.length)
			.refine((values) => new Set(values).size === values.length, {
				message: 'package target ids must be unique'
			})
			.optional(),
		packaging: packagingSchema.optional()
	})
	.strict();

/** What the type answers for a section that never passed the schema. */
export const PLACEHOLDER_CONFIG: VscodeTypeConfig = { ownRoot: 'src/vs/patchset' };
