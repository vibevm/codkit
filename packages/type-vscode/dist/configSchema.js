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
import { ownRootProblem } from './layout.js';
/**
 * ##VSCODE-QUALITY-IS-A-PRODUCT-ANSWER: the quality channel the packaging of
 * this family bakes into the distributable. The three words are the ones the
 * upstream build itself distinguishes; anything else is a refusal rather than a
 * value handed to a packager that will read it as "not the released channel".
 */
export const QUALITY_CHANNELS = ['stable', 'insider', 'exploration'];
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
    'server-linux-x64-tar'
];
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
        .optional()
})
    .strict();
/** What the type answers for a section that never passed the schema. */
export const PLACEHOLDER_CONFIG = { ownRoot: 'src/vs/patchset' };
