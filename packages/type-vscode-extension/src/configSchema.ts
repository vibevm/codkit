/** @scope spec://codkit/modules/vscode-extension/PROP-002#VSX-TYPE-CONFIG */
// The schema of `typeConfig` for the `vscode-extension` type.
//
// The family has no constant layout and no constant scripts: where the
// extension sits, which package manager runs its scripts, what builds, lints,
// tests and packages it, which locale manifests the pin carries and which
// module the host activates are facts of one repository. Two of them have no
// default and are required - the own root and the extension root - and every
// other field has the family's default (##VSX-TYPE-CONFIG). The engine
// validates the universal fields of `codkit.json` and hands this the rest;
// unknown fields are refused, and every refusal becomes `CK-E-CONFIG` naming
// the field (`spec://codkit/modules/codkit/PROP-016#TYPE-CONFIG-FIELD`).

import { z } from 'zod';
import { isTreePath, ownRootProblem, treePath } from './layout.ts';

/** ##VSX-PACKAGE-MANAGER (PROP-004): the four managers the family runs on. */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const TREE_PATH_MESSAGE = 'must be a path from the tree root, POSIX, without a leading or trailing slash, a backslash or a dot-dot segment';

/** A repository-relative POSIX path with no escape and no trailing slash. */
const treePathSchema = z.string().min(1).refine(isTreePath, { message: TREE_PATH_MESSAGE });

/** The extension root: a tree path, or `.` for a repository that is one extension. */
const extensionRootSchema = z
	.string()
	.min(1)
	.refine((value) => value === '.' || isTreePath(value), { message: `${TREE_PATH_MESSAGE}, or . for a repository that is one extension` });

/** The name of a script of the extension manifest. */
const scriptNameSchema = z.string().min(1);

/**
 * One command to run in the fork tree, as the `generic` type takes it: either
 * the argv words, or one string split on whitespace.
 */
const commandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** A list of regular-expression sources, matched against one log line. */
const patternListSchema = z.array(z.string().min(1));

/**
 * ##VSX-BUILD-CHANNELS (PROP-004): one declared watch channel, in the shape of
 * the `generic` type's `commands.compile` - the npm script of the extension
 * manifest that starts the watcher and the pass boundaries of its output,
 * which the engine validates with its profile schema
 * (`spec://codkit/modules/codkit/PROP-010#PASS-BOUNDARIES-ARE-DATA`).
 */
const channelSchema = z
	.object({
		/** The channel's name in `build up|down|status|errors`; the script by default. */
		channel: z.string().min(1).optional(),
		/** The script of the extension manifest that starts the watcher. */
		script: scriptNameSchema,
		passStart: patternListSchema.min(1),
		passEnd: patternListSchema.min(1),
		errorLine: patternListSchema.optional(),
		errorCountLine: patternListSchema.optional(),
		falseEndGuards: patternListSchema.optional()
	})
	.strict()
	.refine((channel) => (channel.errorLine ?? []).length > 0 || (channel.errorCountLine ?? []).length > 0, {
		message: 'at least one of errorLine or errorCountLine must carry a detector',
		path: ['errorLine']
	});

/** ##VSX-PIN-TAGS: a tag pattern is a regular-expression source the engine can compile. */
const regExpSourceSchema = z.string().min(1).refine(compiles, { message: 'must be a regular expression source that compiles' });

/** One file name inside the extension root: no separator, no dot segment. */
const fileNameSchema = z
	.string()
	.min(1)
	.refine((value) => !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..', {
		message: 'must be one file name without a separator'
	});

/** PROP-006 ##VSX-COMPONENT-LICENCES: a lower-case component name, and never the tool's own. */
const componentNameSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]*$/u, { message: 'must be a lower-case name of letters, digits and dashes' })
	.refine((value) => value !== 'codkit', { message: "is the tool's own component" });

/** ##VSX-STAMPS (PROP-004): one literal stamp, `{name, value}`. */
const stampSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, { message: 'must be the name of an environment variable' }),
		value: z.string().min(1)
	})
	.strict();

export const configSchema = z
	.object({
		/** ##VSX-OWN-ROOT: a directory under `<extensionRoot>/src/`; the cross-field rule is checked below. */
		ownRoot: z.string().min(1),
		/** The directory whose `package.json` is the extension manifest; `.` for a repository that is one extension. */
		extensionRoot: extensionRootSchema,
		/**
		 * True when the extension is one workspace package of a larger repository:
		 * the root manifest becomes a second fingerprint and the extension root's
		 * `node_modules` a second dependency root.
		 */
		monorepo: z.boolean().optional(),
		/** ##VSX-PACKAGE-MANAGER: the manager every command is spelled for; npm by default. */
		packageManager: z.enum(PACKAGE_MANAGERS).optional(),
		/** ##VSX-PIN-TAGS: the release train of a repository whose tags are not `v<major>.<minor>.<patch>`. */
		tagPattern: regExpSourceSchema.optional(),
		/** The scripts of the extension manifest the build area runs (PROP-004). */
		scripts: z
			.object({
				/** ##VSX-PACKAGE-BUILD: the family's build of the extension; `compile` by default. */
				build: scriptNameSchema.optional(),
				/** ##VSX-LINT: the hygiene gates, in order; `["lint"]` by default. */
				lint: z.array(scriptNameSchema).optional(),
				/** ##VSX-OWN-TESTS: the runner of the own tests, as the `generic` type takes it; absent means none. */
				test: z
					.object({
						command: commandSchema,
						/** The flag through which the runner takes a glob; absent means the glob is a bare argument. */
						ownGlobArg: z.string().min(1).optional()
					})
					.strict()
					.optional(),
				/** ##VSX-PACKAGE-DISTRIBUTABLE: the script that writes the `.vsix`; absent means no distributable step. */
				package: scriptNameSchema.optional()
			})
			.strict()
			.optional(),
		/**
		 * ##VSX-ENTRY-MODULE (PROP-003): the activation modules, by default
		 * `<extensionRoot>/src/extension.ts`. A webview with its own entry adds it.
		 */
		// REVIEW: an empty list is refused rather than taken as "no entry", because
		// the capability `entry-module` is constant for the family and a locator
		// with no entries would answer the layer with nothing to graft into.
		entryModules: z.array(treePathSchema).min(1).optional(),
		/** ##VSX-LOCALE-MANIFEST-OVERLAYS (PROP-003): the `package.nls*.json` files the pin carries. */
		localeManifests: z.array(treePathSchema).optional(),
		/** ##VSX-CLEANUP-WHITELIST: patterns added to the family's whitelist. */
		cleanupWhitelist: z.array(z.string().min(1)).optional(),
		/** ##VSX-PACKAGE-SCRATCH (PROP-004): tracked files the product's build rewrites in passing. */
		packageScratch: z.array(z.string().min(1)).optional(),
		/** ##VSX-PACKAGE-OUTPUTS (PROP-004): patterns replacing `<extensionRoot>/dist/*.vsix`. */
		outputs: z.array(z.string().min(1)).optional(),
		/** ##VSX-STAMPS (PROP-004): literal stamps the packaging reads. */
		stamps: z.array(stampSchema).optional(),
		/** ##VSX-BUILD-CHANNELS (PROP-004): channels replacing the family's defaults whole. */
		watch: z
			.object({ channels: z.array(channelSchema).min(1) })
			.strict()
			.optional(),
		/**
		 * ##VSX-PREVIEW-HOST (PROP-004): an executable the engine's host resolution
		 * reads third, and the folder the host opens when a run names none.
		 */
		preview: z
			.object({
				host: z.string().min(1).nullable().optional(),
				workspace: z.string().min(1).nullable().optional()
			})
			.strict()
			.optional(),
		/**
		 * PROP-006 ##VSX-COMPONENT-LICENCES: the upstream's licence file in the
		 * extension root (`LICENSE` by default) and the component its text ships
		 * under (`upstream` by default) - the family cannot know the upstream's name.
		 */
		licensing: z
			.object({
				upstreamLicenceFile: fileNameSchema.optional(),
				upstreamComponent: componentNameSchema.optional()
			})
			.strict()
			.optional()
	})
	.strict()
	.superRefine((config, context) => {
		const problem = ownRootProblem(config.ownRoot, config.extensionRoot);
		if (problem !== null) {
			context.addIssue({ code: 'custom', path: ['ownRoot'], message: problem });
		}
		// REVIEW: a locale manifest that repeats another or names the extension
		// manifest itself is refused, because the overlay targets are listed from
		// this field and the engine expects each target once; the specification
		// states the list and not its uniqueness.
		const manifestPath = treePath(config.extensionRoot, 'package.json');
		const seen = new Set<string>();
		(config.localeManifests ?? []).forEach((path, index) => {
			if (path === manifestPath) {
				context.addIssue({
					code: 'custom',
					path: ['localeManifests', index],
					message: `is the extension manifest, which is an overlay target already`
				});
			} else if (seen.has(path)) {
				context.addIssue({ code: 'custom', path: ['localeManifests', index], message: 'is named twice' });
			}
			seen.add(path);
		});
	});

export type VsxTypeConfig = z.infer<typeof configSchema>;

/** The configuration of a patch set that declared nothing yet; see `projectType`. */
export const PLACEHOLDER_CONFIG: VsxTypeConfig = {
	ownRoot: 'src/own',
	extensionRoot: '.'
};

/** The argv of a declared command, whichever form it was written in. */
export function argvOf(command: string | readonly string[]): readonly string[] {
	return typeof command === 'string' ? command.split(/\s+/u).filter((word) => word !== '') : command;
}

function compiles(source: string): boolean {
	try {
		new RegExp(source);
		return true;
	} catch {
		return false;
	}
}
