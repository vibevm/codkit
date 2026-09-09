/** @scope spec://codkit/modules/vscode/PROP-007#VSCODE-RUNTIME-IS-THE-TYPES-LIBRARY */
// Area 7: the runtime library this type delivers (capability `runtime-library`).
//
// The delivery, the managed-copy discipline, the version literal and the drift
// check are the engine's; which library is delivered, what it is called inside
// the own layer and what a person does in the tree afterwards is the answer.

import type { RuntimeArea } from '@codkit/type-api';

/** The shipped runtime package of this type, under the installation's `runtime/`. */
export const RUNTIME_PACKAGE_ID = 'runtime-vscode';

/** ##RT-DIRECTORY-IS-CODKIT: the name of the copy inside the own layer. */
export const RUNTIME_TARGET_DIR_NAME = 'codkit';

/** ##RT-LOAD-STEPS step 7: the lines a person needs after a successful load. */
export function nextSteps(ownRoot: string): readonly string[] {
	return [
		"next: import the library once from the product's composition root: import '../codkit/browser/featureFlags.contribution.js';",
		`next: add the code-import-patterns block for ${ownRoot}/${RUNTIME_TARGET_DIR_NAME}/~ from the library's LAYERS.md`,
		'next: declare the first feature with codkit gen feature <id> --title <text>'
	];
}

export const runtime: RuntimeArea = {
	packageId: RUNTIME_PACKAGE_ID,
	targetDirName: RUNTIME_TARGET_DIR_NAME,
	nextSteps
};
