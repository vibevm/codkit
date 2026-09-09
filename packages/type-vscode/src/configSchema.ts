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

export type VscodeQuality = (typeof QUALITY_CHANNELS)[number];

export type VscodeTypeConfig = {
	readonly ownRoot: string;
	/**
	 * Which channel the packaged product is. Absent means the patch set has not
	 * answered, and the packaging keeps the older behaviour of stamping the pin
	 * tag - so an existing patch set reads exactly as it did.
	 */
	readonly quality?: VscodeQuality | undefined;
};

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
		quality: z.enum(QUALITY_CHANNELS).optional()
	})
	.strict();

/** What the type answers for a section that never passed the schema. */
export const PLACEHOLDER_CONFIG: VscodeTypeConfig = { ownRoot: 'src/vs/patchset' };
