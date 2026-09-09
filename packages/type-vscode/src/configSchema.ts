/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONFIG-FIELD */
// The schema of `typeConfig` for this type.
//
// The engine validates the universal fields of `codkit.json` and hands the rest
// here; a refusal becomes `CK-E-CONFIG` naming the field. The one field of this
// type is the own root, and it is required and has no default - schema 2 is the
// only schema (##VSCODE-OWN-ROOT-CONSTRAINT).

import { z } from 'zod';
import { ownRootProblem } from './layout.ts';

export type VscodeTypeConfig = {
	readonly ownRoot: string;
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
			})
	})
	.strict();
