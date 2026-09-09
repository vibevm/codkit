// A project type built for the engine's own tests: the smallest thing that
// answers the contract (PROP-016 ##TYPE-ENGINE-TESTS).
//
// It names no real upstream, so a test written against it proves that the
// engine does the work rather than that one official type happens to answer the
// way the engine assumed. Every area is overridable, so a test states only the
// answers it is about.

import { z } from 'zod';
import type { AdvisoryReader, BrandGraft, Capability, GeneratorsArea, ProjectType } from '@codkit/type-api';

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
		ownRoots: (config) => [{ path: config.ownRoot, role: 'own', buildOutputs: [] }],
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
		watchProfilePath: null,
		foreignWatcherMarkers: []
	},
	advisory: { readers: [] },
	standards: { packages: [] },
	conventions: { subsystems: ['stub'], forbiddenServiceIds: [] },
	generators: stubGenerators()
};

/**
 * The smallest honest skeleton: identifiers, and a test inside the feature's
 * own directory. `brandGraft` is present only when a test asks for it, so the
 * refusal of a family without a string funnel can be proved too.
 */
export function stubGenerators(options: { readonly brand?: boolean; readonly testOutside?: boolean } = {}): GeneratorsArea {
	const area: GeneratorsArea = {
		featureSkeleton: (request) => {
			const directory = `delta/own/contrib/${request.name}`;
			return {
				directory,
				modules: [
					{
						path: `${directory}/${request.name}.ts`,
						text: `// the ${request.title} feature\nexport const FEATURE_ID = '${request.id}';\n`,
						role: 'identifiers'
					},
					{
						path: options.testOutside === true ? `delta/own/test/${request.name}.test.ts` : `${directory}/test/${request.name}.test.ts`,
						text: `// the test of ${request.id}\n`,
						role: 'test'
					}
				],
				importLine: `import './contrib/${request.name}/${request.name}.js';`,
				reminders: [`teach the stub family about ${request.name}`]
			};
		}
	};
	if (options.brand !== true) {
		return area;
	}
	return {
		...area,
		brandGraft: (ownRoot): BrandGraft => ({
			module: { path: 'delta/own/common/brand.ts', text: `// the brand table of ${ownRoot}\n`, role: 'table' },
			hookText: `graft brandMessage into the funnel of ${ownRoot}\n`,
			reminders: ['the graft is a patch of the product']
		})
	};
}

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
