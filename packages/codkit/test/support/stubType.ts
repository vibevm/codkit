// A project type built for the engine's own tests: the smallest thing that
// answers the contract (PROP-016 ##TYPE-ENGINE-TESTS).
//
// It names no real upstream, so a test written against it proves that the
// engine does the work rather than that one official type happens to answer the
// way the engine assumed. Every area is overridable, so a test states only the
// answers it is about.

import { z } from 'zod';
import type { AdvisoryReader, Capability, ProjectType } from '@codkit/type-api';

/** The stub's own configuration: an own root and nothing else. */
const configSchema = z.object({ ownRoot: z.string().min(1) }).strict();

const base: ProjectType = {
	id: 'stub',
	capabilities: new Set<Capability>(),
	configSchema,
	identity: {
		tagPattern: /^\d+\.\d+\.\d+$/u,
		tagShape: '<major>.<minor>.<patch>',
		fingerprints: []
	},
	layout: {
		ownRootProblem: () => null,
		ownExtensionPath: () => null,
		cleanupWhitelist: [],
		forbiddenPatchTargets: []
	},
	layers: {
		overlayTargets: [],
		ownExtensions: null,
		serviceOverride: null,
		entryModule: null
	},
	build: {
		install: [],
		hygiene: [],
		ownTests: () => null,
		packageBuild: [],
		packageStamps: [],
		watchProfilePath: '',
		foreignWatcherMarkers: []
	},
	advisory: { readers: [] },
	standards: { packages: [] },
	conventions: { subsystems: ['stub'], forbiddenServiceIds: [] }
};

/** The stub, with the answers this test cares about written over it. */
export function stubType(answers: Partial<ProjectType> = {}): ProjectType {
	return { ...base, ...answers };
}

/**
 * A reader of one file that reads its trimmed text. `changeIsNews` says whether
 * a change of the file is worth naming even when the text reads the same.
 */
export function stubReader(
	id: string,
	path: string,
	options: { readonly changeIsNews?: boolean; readonly meaning?: string | null } = {}
): AdvisoryReader {
	return {
		id,
		paths: [path],
		changeIsNews: options.changeIsNews ?? false,
		read: (files) => files.get(path)?.trim() ?? null,
		meaning: () => (options.meaning === undefined ? `${id} changed` : options.meaning)
	};
}
