/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-CONFIG-FIELD */
// The schema of `typeConfig` for the `generic` type - and, unusually, the whole
// knowledge of the type.
//
// A family with a product model can state its answers as constants: there is
// one product manifest, one extension directory, one test runner. A plain git
// upstream has none of that, so everything this type answers is declared by the
// patch set instead: where own code lives, which JSON files an overlay may
// touch, what installs, lints, compiles and tests the tree, what a fresh pass
// may delete, and which file proves that a directory is this upstream at all
// (##TYPE-GENERIC).
//
// The engine validates the universal fields of `codkit.json` and hands this the
// rest; a refusal becomes `CK-E-CONFIG` naming the field.

import { z } from 'zod';
import { ownRootProblem } from './layout.ts';

/**
 * One command to run in the fork tree: either the argv words, or one string
 * split on whitespace. Nothing is passed to a shell, so a word that has to
 * carry a space is written as an element of the array form.
 */
const commandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/** A list of regular-expression sources, matched against one log line. */
const patternListSchema = z.array(z.string().min(1));

/**
 * One watch channel of a plain upstream: the npm script that starts it and the
 * pass boundaries of its output. The fields are those of the build-watch
 * profile the engine reads (PROP-010 sec. 2), because that is exactly what this
 * becomes.
 */
const channelSchema = z
	.object({
		/** The channel's name in `build up|down|status|errors`; the script by default. */
		channel: z.string().min(1).optional(),
		/** The npm script of the tree that starts the watcher. */
		script: z.string().min(1),
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

/** A repository-relative POSIX path with no escape and no trailing slash. */
const treePathSchema = z.string().min(1).refine(isSafeTreePath, {
	message: 'must be a path from the tree root, POSIX, without a leading or trailing slash, a backslash or a dot-dot segment'
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
		/**
		 * What builds this upstream. Every field is optional: a patch set that
		 * only carries a delta declares none of them, and the build steps that
		 * would have run them are simply empty.
		 */
		commands: z
			.object({
				/** Installing the tree's dependencies, e.g. `"npm ci"`. */
				install: commandSchema.optional(),
				/** The hygiene and lint gates, in the order they must run. */
				lint: z.array(commandSchema).optional(),
				/**
				 * The watch channels of the tree: the npm script each one runs and
				 * where a pass begins and ends in its output. Declaring one is what
				 * gives this patch set the capability `build-channels`. The pass
				 * boundaries have to be declared with the script because the tool
				 * refuses to guess them (PROP-010 ##PASS-BOUNDARIES-ARE-DATA): a
				 * channel whose passes cannot be recognized reports nothing, which
				 * is worse than not having the channel.
				 */
				compile: z.array(channelSchema).min(1).optional(),
				/** The runner of the patch set's own tests inside the tree. */
				test: z
					.object({
						command: commandSchema,
						/**
						 * The flag through which the runner takes a glob, e.g.
						 * `"--glob"`. Absent means the runner takes the glob as a
						 * bare argument; the glob itself is always the own root.
						 */
						ownGlobArg: z.string().min(1).optional()
					})
					.strict()
					.optional()
			})
			.strict()
			.optional(),
		/**
		 * The JSON files a `config-overlay` artifact may target. Declaring one is
		 * what gives this patch set the capability `config-overlay`. There is no
		 * development channel: a sidecar the running product reads instead of the
		 * target is a product model, and this type has none.
		 */
		overlayTargets: z.array(treePathSchema).optional(),
		/** Untracked build outputs a fresh pass may remove without asking. */
		cleanupWhitelist: z.array(z.string().min(1)).optional(),
		/** What proves that a directory really is a tree of this upstream. */
		identity: z
			.object({
				manifest: z
					.object({
						/** The manifest file, from the tree root. */
						path: treePathSchema,
						/** The field of it that carries the name of the project. */
						nameField: z.string().min(1).optional()
					})
					.strict()
					.optional()
			})
			.strict()
			.optional()
	})
	.strict();

export type GenericTypeConfig = z.infer<typeof configSchema>;

/** The argv of a declared command, whichever form it was written in. */
export function argvOf(command: string | readonly string[]): readonly string[] {
	return typeof command === 'string' ? command.split(/\s+/u).filter((word) => word !== '') : command;
}

function isSafeTreePath(value: string): boolean {
	if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) {
		return false;
	}
	return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
