// The project type the engine's own tests run against (PROP-016
// ##TYPE-ENGINE-TESTS, ##TYPE-TEST-SEAM).
//
// It answers the contract with the smallest layout that still exercises every
// engine mechanism: one source root, one own root inside it, one JSON manifest
// as the overlay target, one directory where an add-on materializes, one
// registration call an override is proved by, one list of entry modules. It
// names no upstream product, so a test written against it proves that the
// engine does the work rather than that one official type happens to answer the
// way the engine assumed.
//
// The module is loaded two ways: in process, by the unit suites, which override
// the answers they are about with `stubType({...})`; and by the real CLI of the
// e2e suites, which reaches it through `CODKIT_TEST_TYPE_PACKAGE` and takes the
// `projectType` export below.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type {
	AdvisoryFiles,
	AdvisoryReader,
	AdvisoryValue,
	BrandGraft,
	BuildCommand,
	Capability,
	EntryModuleLocator,
	ExtensionMaterializer,
	GeneratorsArea,
	LicensingArea,
	OverlayTarget,
	OwnedDirectory,
	PreviewArea,
	ProjectType,
	Refusal,
	ServiceOverrideVerifier
} from '@codkit/type-api';

/** The identifier a fixture patch set declares in `codkit.json`. */
export const STUB_TYPE_ID = 'stub';

/** The source root of the stub layout; the own root sits inside it. */
export const SOURCE_ROOT_PREFIX = 'source/';

/** The own root every fixture patch set of this type declares. */
export const STUB_OWN_ROOT = 'source/own';

/** The JSON manifest that is the overlay target of this layout. */
export const MANIFEST_TARGET = 'manifest.json';

/** The sidecar the running product of this layout reads instead of the target. */
export const MANIFEST_OVERRIDES_FILE = 'manifest.overrides.json';

/** Where an own add-on materializes, from the tree root. */
export const ADDONS_TREE_DIR = 'addons';

/** This module's own absolute path: what `CODKIT_TEST_TYPE_PACKAGE` names. */
export const STUB_TYPE_MODULE = fileURLToPath(import.meta.url);

/** The pass-boundary profile of the stub's watch channels. */
export const STUB_WATCH_PROFILE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'stubBuildWatch.json');

/** Keys the packaging step of this layout stamps by itself. */
export const STAMPED_MANIFEST_KEYS: readonly string[] = ['commit', 'date', 'checksums', 'version'];

/** The subsystem names an intervention id of a fixture patch set may take. */
export const SUBSYSTEMS: readonly string[] = ['shell', 'editor', 'platform', 'addons', 'build', 'product', 'base', 'server', 'test'];

/** Service ids own code may never re-register in this layout. */
export const FORBIDDEN_SERVICE_IDS: readonly string[] = ['ILogService', 'IFileService', 'IProductService'];

/** ##TYPE-AREA-LAYOUT: the own root must sit under the source root. */
export function ownRootProblem(ownRoot: string): Refusal {
	if (ownRoot === '') {
		return `must be a path from the tree root under ${SOURCE_ROOT_PREFIX}`;
	}
	if (ownRoot.startsWith('/') || ownRoot.endsWith('/')) {
		return 'must be written without a leading or trailing slash';
	}
	if (ownRoot.includes('\\')) {
		return 'must use forward slashes';
	}
	if (ownRoot.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return 'must not contain an empty, dot or dot-dot segment';
	}
	if (!ownRoot.startsWith(SOURCE_ROOT_PREFIX) || ownRoot.length === SOURCE_ROOT_PREFIX.length) {
		return `must be a directory under ${SOURCE_ROOT_PREFIX}: the build of this layout is anchored there`;
	}
	return null;
}

/** ##OWN-EXTENSION-UNIT: `addons/<name>`, relative to the tree root. */
export function ownExtensionPath(name: string): string {
	return `${ADDONS_TREE_DIR}/${name}`;
}

/** One owned directory and no build output inside it: this layout compiles to `out/`. */
export function ownRoots(config: { readonly ownRoot: string }): readonly OwnedDirectory[] {
	return [{ path: config.ownRoot, role: 'own', buildOutputs: [] }];
}

/** The overlay targets: the manifest with its dev channel, and the tree manifest's scripts. */
export const overlayTargets: readonly OverlayTarget[] = [
	{ path: MANIFEST_TARGET, devChannel: MANIFEST_OVERRIDES_FILE, stampedKeys: STAMPED_MANIFEST_KEYS, allowedKeys: null },
	{ path: 'package.json', devChannel: null, stampedKeys: [], allowedKeys: ['scripts'], allowedScalarKeys: ['license'] }
];

/** ##OWN-EXTENSION-UNIT: the delta directory and its materialization. */
export const ownExtensions: ExtensionMaterializer = {
	deltaRoot: 'delta/own-extensions',
	materializedPath: ownExtensionPath,
	namePattern: /^[a-z0-9][a-z0-9-]*$/,
	manifestFile: 'package.json'
};

/** ##SO-MECHANISM, ##SO-FORBIDDEN-IDS: how an override is proved and refused. */
export const serviceOverride: ServiceOverrideVerifier = {
	registrationCall: 'registerService',
	registrationModule: null,
	forbiddenReason:
		'this service is set explicitly before the shell is created, so a later registration is ignored and the product breaks at load',
	forbiddenHint: 'override a service the shell itself instantiates, or replace the behaviour through the entry-module layer'
};

/** The entry modules of this layout: the import lists the product is assembled from. */
export const entryModule: EntryModuleLocator = {
	entries: ['source/app/entry.common.main.ts', 'source/app/entry.desktop.main.ts', 'source/app/entry.web.main.ts'],
	why: 'these modules are the import lists the product of this layout is assembled from, so a contribution reaches it by being imported there'
};

/** The dependency install of the tree. */
export const INSTALL: readonly BuildCommand[] = [{ label: 'install', command: 'npm', args: ['ci'] }];

/**
 * Two dependency roots, because one root would not exercise the engine at all:
 * a build profile has to refuse over a tree that restored the first and not the
 * second, and has to say which one is missing.
 */
export const DEPENDENCY_ROOTS: readonly string[] = ['node_modules', 'vendor/node_modules'];

/** The hygiene and lint gates, in the order they must run. */
export const HYGIENE: readonly BuildCommand[] = [
	{ label: 'hygiene', command: 'npm', args: ['run', 'hygiene'] },
	{ label: 'eslint', command: 'npm', args: ['run', 'eslint'] }
];

/** The distributable build of this layout; nothing in `ci` runs it. */
export const PACKAGE_BUILD: readonly BuildCommand[] = [{ label: 'package', command: 'npm', args: ['run', 'package'] }];

/** The product's own packaging step, after the layout's build made the application. */
export const PACKAGE_DISTRIBUTABLE: readonly BuildCommand[] = [
	{ label: 'package distributable', command: 'npm', args: ['run', 'package-distributable'] }
];

/**
 * Where the two commands above leave their artifacts. One plain directory and
 * one pattern with a wildcard, so the engine's matcher is exercised by both
 * shapes a type may answer with.
 */
export const PACKAGE_OUTPUTS: readonly string[] = ['.build/package/', '.build/app-*.tar'];

/**
 * What the packager of this layout rewrites in place while it runs: the
 * manifest of the tree, whose version it bumps. It is a tracked file of the
 * pseudo-upstream and nobody asked for the edit, so the package run has to put
 * it back (PROP-016 ##TYPE-PACKAGE-SCRATCH).
 */
export const PACKAGE_SCRATCH: readonly string[] = ['package.json'];

/**
 * The channels a run that names none starts. The stub's profile declares four,
 * and the two below are the ones a bare `build up` and the single pass of the
 * build profile take.
 */
export const DEFAULT_CHANNELS: readonly string[] = ['transpile', 'typecheck'];

/** Argv fragments that mean somebody else's watcher already runs over this tree. */
export const FOREIGN_WATCHER_MARKERS: readonly string[] = ['build/watch.mjs transpile --watch', 'foreign watch-'];

/**
 * The licensing answer of this layout (##TYPE-AREA-LICENSING): the block header,
 * the licence file at the root, component licences under `licenses/`, three
 * fields of the manifest and the `license` key of the tree manifest, the
 * upstream's `LICENSE` as the component `upstream`, one RTF rendering, and a
 * guard under the own tests found by `describe`/`it`.
 */
export const LICENCE_GUARD_PATH = 'delta/own/test/licence.leftovers.test.ts';
export const licensingArea: LicensingArea = {
	headerStyle: 'block',
	licenceFileDirectory: '',
	componentLicenceDirectory: 'licenses',
	subsystem: 'product',
	fields: [
		{ target: MANIFEST_TARGET, path: ['licenseName'], role: 'expression' },
		{ target: MANIFEST_TARGET, path: ['licenseFileName'], role: 'file-name' },
		{ target: MANIFEST_TARGET, path: ['licenseUrl'], role: 'url' },
		{ target: 'package.json', path: ['license'], role: 'expression' }
	],
	upstreamLicenceFiles: [{ path: 'LICENSE', component: 'upstream' }],
	renderings: [{ path: 'LICENSE.rtf', format: 'rtf' }],
	guard: () => ({ path: LICENCE_GUARD_PATH, suite: 'describe', test: 'it' })
};

/** The host the preview of this layout starts when nothing names one; no machine has it on PATH. */
export const PREVIEW_DEFAULT_HOST = 'codkit-stub-host';

/** The two ways a person looks at this layout: from the tree, or from its packaged distributable. */
export const PREVIEW_MODES: readonly string[] = ['development', 'artifact'];

/** Set in the environment of the CLI, the recipe places one isolation directory outside the state directory (FEAT-002 S88). */
export const PREVIEW_BREAK_ISOLATION_VARIABLE = 'CODKIT_TEST_PREVIEW_BREAK_ISOLATION';

/** Set in the environment of the CLI, the preparation of the development mode exits 3. */
export const PREVIEW_PREPARE_FAIL_VARIABLE = 'CODKIT_TEST_PREVIEW_PREPARE_FAIL';

/** What the preparation of the development mode leaves in the tree; `.build/` is ignored by the fixture upstream. */
export const PREVIEW_PREPARED_MARKER = '.build/preview-prepared';

/** What the preparation of the artifact mode writes into the isolated extensions directory. */
export const PREVIEW_INSTALLED_FILE = 'installed.json';

/** The environment variable the launch of this layout carries, so a host can tell which mode started it. */
export const PREVIEW_MODE_VARIABLE = 'CODKIT_STUB_PREVIEW_MODE';

/** The preparation of the development mode: a marker in the tree, or a red exit when the suite asks for one. */
const PREPARE_TREE_SCRIPT = [
	"const fs = require('node:fs');",
	`if ((process.env.${PREVIEW_PREPARE_FAIL_VARIABLE} ?? '') !== '') { console.error('prepare: fixture preparation failed'); process.exit(3); }`,
	"fs.mkdirSync('.build', { recursive: true });",
	`fs.writeFileSync('${PREVIEW_PREPARED_MARKER}', 'prepared\\n', 'utf8');`,
	"console.log('prepare: fixture preparation finished');"
].join(' ');

/** The preparation of the artifact mode: the artifact path, written into the extensions directory it was handed. */
const INSTALL_ARTIFACT_SCRIPT = [
	"const fs = require('node:fs');",
	"const path = require('node:path');",
	'fs.mkdirSync(process.argv[1], { recursive: true });',
	`fs.writeFileSync(path.join(process.argv[1], '${PREVIEW_INSTALLED_FILE}'), JSON.stringify({ artifact: process.argv[2] }) + '\\n', 'utf8');`,
	"console.log('install: ' + process.argv[2]);"
].join(' ');

/**
 * ##TYPE-AREA-PREVIEW: the launch of this layout's host over the tree. The
 * development mode runs the product from the tree after a preparation that
 * leaves a marker; the artifact mode needs the distributable and installs it
 * into the isolated extensions directory before the launch. Both keep the
 * person's own profile out of reach - unless the suite asks the recipe to break
 * the rule, so that the engine's refusal can be proved. The preparation runs
 * the node that runs codkit, so the fixture depends on no script of the tree.
 */
export const previewArea: PreviewArea = {
	modes: PREVIEW_MODES,
	defaultMode: 'development',
	defaultHost: PREVIEW_DEFAULT_HOST,
	recipe(request) {
		const broken = (process.env[PREVIEW_BREAK_ISOLATION_VARIABLE] ?? '') !== '';
		const userDataDir = broken
			? join(dirname(request.stateDir), 'outside-the-state-dir', 'user-data')
			: join(request.stateDir, 'user-data');
		const extensionsDir = join(request.stateDir, 'extensions');
		const needsArtifact = request.mode === 'artifact';
		const args = [
			'--dev-path',
			request.treeDir,
			'--user-data-dir',
			userDataDir,
			'--extensions-dir',
			extensionsDir,
			...(request.workspaceDir === null ? [] : [request.workspaceDir]),
			...(request.artifact === null ? [] : ['--artifact', request.artifact])
		];
		const prepare: readonly BuildCommand[] = needsArtifact
			? [
					{
						label: 'install artifact',
						command: process.execPath,
						args: ['-e', INSTALL_ARTIFACT_SCRIPT, extensionsDir, request.artifact ?? '']
					}
				]
			: [{ label: 'prepare', command: process.execPath, args: ['-e', PREPARE_TREE_SCRIPT] }];
		return {
			prepare,
			needsArtifact,
			launch: { command: request.host, args, env: { [PREVIEW_MODE_VARIABLE]: request.mode } },
			isolation: { userDataDir, extensionsDir }
		};
	}
};

/** The own-test runner of this layout takes the own root as a glob. */
export function ownTests(ownRoot: string): BuildCommand | null {
	const leaf =
		ownRoot
			.split('/')
			.filter((segment) => segment !== '')
			.at(-1) ?? '';
	if (leaf === '') {
		return null;
	}
	return {
		label: 'product tests',
		command: 'npm',
		args: ['run', 'test-own', '--', '--runGlob', `${leaf}/**/test/{common,node}/**/*.test.js`]
	};
}

/** The one nonempty line of the toolchain pin file. */
function toolchainPin(files: AdvisoryFiles): AdvisoryValue {
	const content = files.get('.nvmrc') ?? null;
	if (content === null) {
		return null;
	}
	const line = content.split('\n').find((candidate) => candidate.trim() !== '');
	return line === undefined ? null : line.trim();
}

/** The dependency block of the tree manifest, as the advisory compares it. */
function treeDependencies(files: AdvisoryFiles): AdvisoryValue {
	const content = files.get('package.json') ?? null;
	if (content === null) {
		return null;
	}
	try {
		const parsed = JSON.parse(content) as { readonly dependencies?: AdvisoryValue };
		return parsed.dependencies ?? null;
	} catch {
		return null;
	}
}

/** The readers of the upgrade advisory: the toolchain pin and the tree manifest. */
export const readers: readonly AdvisoryReader[] = [
	{
		id: 'toolchain-pin',
		paths: ['.nvmrc'],
		changeIsNews: true,
		read: toolchainPin,
		meaning: () => 'the toolchain the tree is built with moved; rebuild the managed tree from a clean install'
	},
	{
		id: 'tree-dependencies',
		paths: ['package.json'],
		changeIsNews: false,
		read: treeDependencies,
		meaning: () => 'the dependency block of the tree changed; own code compiled against it may need the same move'
	}
];

/** The stub's own configuration: an own root and nothing else. */
const configSchema = z
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

/**
 * The capabilities the engine's suites need answered. `brand-images` and
 * `runtime-library` are deliberately absent: each of them is a payload the tool
 * ships for one family, and the suites that prove those live with the family
 * that ships them.
 */
export const CAPABILITIES: readonly Capability[] = [
	'gen-brand',
	'build-channels',
	'own-extensions',
	'service-override',
	'entry-module',
	'config-overlay',
	'dev-channel',
	'upgrade-advisory',
	'preview',
	'licensing'
];

const base: ProjectType = {
	id: STUB_TYPE_ID,
	capabilities: new Set<Capability>(CAPABILITIES),
	configSchema,
	identity: {
		tagPattern: /^\d+\.\d+\.\d+$/u,
		tagShape: '<major>.<minor>.<patch>',
		fingerprints: [
			{
				path: 'package.json',
				kind: 'file',
				why: 'the tree of this layout is an npm project, and every build command of the type is one of its scripts'
			},
			{ path: MANIFEST_TARGET, kind: 'file', why: 'the manifest of the product: the target of the configuration overlay' },
			{ path: 'source', kind: 'directory', why: 'the source root of this layout; the own root of a patch set lives inside it' }
		]
	},
	layout: {
		ownRootProblem,
		ownRoots,
		ownExtensionPath,
		cleanupWhitelist: ['node_modules/', '.build/', '/out*/', 'addons/*/out/', 'addons/*/dist/', '.eslintcache', '*.tsbuildinfo'],
		forbiddenPatchTargets: ['.config/generated/**']
	},
	layers: { overlayTargets, ownExtensions, serviceOverride, entryModule },
	build: {
		install: INSTALL,
		dependencyRoots: DEPENDENCY_ROOTS,
		hygiene: HYGIENE,
		ownTests,
		packageBuild: PACKAGE_BUILD,
		packageDistributable: PACKAGE_DISTRIBUTABLE,
		packageOutputs: PACKAGE_OUTPUTS,
		packageScratch: PACKAGE_SCRATCH,
		packageStamps: [
			{ name: 'BUILD_SOURCE_VERSION', source: 'tree-head' },
			{ name: 'BUILD_QUALITY', source: 'pin-tag' }
		],
		defaultChannels: DEFAULT_CHANNELS,
		watchProfilePath: STUB_WATCH_PROFILE_PATH,
		foreignWatcherMarkers: FOREIGN_WATCHER_MARKERS
	},
	advisory: { readers },
	preview: previewArea,
	licensing: licensingArea,
	standards: { packages: [] },
	conventions: { subsystems: SUBSYSTEMS, forbiddenServiceIds: FORBIDDEN_SERVICE_IDS },
	generators: stubGenerators({ brand: true })
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
						path: `${directory}/common/${request.name}.ts`,
						text: `// Identifiers of the ${request.title} feature.\nexport const FEATURE_ID = '${request.id}';\n`,
						role: 'identifiers'
					},
					{
						path: `${directory}/browser/${request.name}.contribution.ts`,
						text: [
							`import { registerStubFeature } from '../../../codkit/browser/featureRegistry.js';`,
							`import { FEATURE_ID } from '../common/${request.name}.js';`,
							'',
							'registerStubFeature({',
							'\tid: FEATURE_ID,',
							`\ttitle: '${request.title}',`,
							`\tsetting: ${String(request.setting)},`,
							`\thotToggle: ${String(!request.cold)},`,
							'});',
							''
						].join('\n'),
						role: 'feature'
					},
					{
						path:
							options.testOutside === true ? `delta/own/test/${request.name}.test.ts` : `${directory}/test/browser/${request.name}.test.ts`,
						text: `// the test of ${request.id}\n`,
						role: 'test'
					}
				],
				importLine: `import '../contrib/${request.name}/browser/${request.name}.contribution.js';`,
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
			module: {
				path: 'delta/own/common/brand.ts',
				text: [
					`// the brand table of ${ownRoot}`,
					`import { createStubBrandTransform, type IBrandRule } from '../codkit/common/brand/brandRules.js';`,
					'',
					'const RULES: IBrandRule[] = [];',
					'',
					'export const brandMessage = createStubBrandTransform(RULES);',
					''
				].join('\n'),
				role: 'table'
			},
			hookText: `graft brandMessage(text) into the string funnel of ${ownRoot}\n`,
			reminders: ['the graft is a patch of the product: type = hook', 'declare the import of the table in the layering rules of the family']
		})
	};
}

/** The stub, with the answers this test cares about written over it. */
export function stubType(answers: Partial<ProjectType> = {}): ProjectType {
	return { ...base, ...answers };
}

/** What the CLI loads through `CODKIT_TEST_TYPE_PACKAGE` (##TYPE-TEST-SEAM). */
export const projectType: ProjectType = base;

export default projectType;

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
