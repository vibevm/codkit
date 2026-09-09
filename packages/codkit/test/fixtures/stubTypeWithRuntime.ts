// The stub type plus a runtime library, for the scenarios about the delivered
// library (PROP-015 ##RT-DELIVERED-NOT-OWN, PROP-016 ##TYPE-TEST-SEAM).
//
// The stub declares no runtime of its own: a runtime package exists to be
// shipped, and a second shipped package for nobody would be a lie in the
// supply. The tool ships exactly one (##RT-SHIPPED-LOCATION), so the runtime
// scenarios name that one here and nowhere else in the engine's fixtures.

import { fileURLToPath } from 'node:url';
import type { Capability, ProjectType } from '@codkit/type-api';
import { projectType as stubProjectType } from './stubType.ts';

/** The runtime package this installation ships. */
export const SHIPPED_RUNTIME_PACKAGE = 'runtime-vscode';

/** This module's own absolute path: what `CODKIT_TEST_TYPE_PACKAGE` names. */
export const STUB_RUNTIME_TYPE_MODULE = fileURLToPath(import.meta.url);

export const projectType: ProjectType = {
	...stubProjectType,
	capabilities: new Set<Capability>([...stubProjectType.capabilities, 'runtime-library']),
	runtime: {
		packageId: SHIPPED_RUNTIME_PACKAGE,
		targetDirName: 'codkit',
		nextSteps: (ownRoot) => [`next: import the delivered library once from the composition root of ${ownRoot}`]
	}
};

export default projectType;
