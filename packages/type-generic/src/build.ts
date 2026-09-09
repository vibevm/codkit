/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-BUILD */
// Area 4: what installs, lints, compiles and tests a plain git upstream.
//
// Nothing here is knowledge of a family: every command is declared by the patch
// set, and the type only puts it into the shape the universal build skeleton
// asks for. A command the patch set did not declare is an empty list, and the
// step that would have run it does nothing rather than guessing a script name.
//
// The compile channels are the npm scripts the patch set names. Where the
// boundaries of a pass are inside their output is not something this type can
// know, so a patch set declares them with the script it names; a patch set that
// wants a stricter profile still declares its own `buildWatchFile`, which wins
// over this answer (PROP-010 sec. 2).

import type { BuildArea, BuildCommand } from '@codkit/type-api';
import { argvOf } from './configSchema.ts';
import type { GenericTypeConfig } from './configSchema.ts';

/** The watch channels a patch set declared, as its section carries them. */
type GenericChannels = NonNullable<GenericTypeConfig['commands']>['compile'];

/** The build-watch document this type answers as data, or undefined for none. */
export function watchProfileOf(compile: GenericChannels): unknown {
	if (compile === undefined || compile.length === 0) {
		return undefined;
	}
	return {
		codkitBuildWatch: 1,
		channels: Object.fromEntries(
			compile.map((channel) => [
				channel.channel ?? channel.script,
				{
					script: channel.script,
					passStart: channel.passStart,
					passEnd: channel.passEnd,
					errorLine: channel.errorLine ?? [],
					errorCountLine: channel.errorCountLine ?? [],
					falseEndGuards: channel.falseEndGuards ?? []
				}
			])
		)
	};
}

/**
 * The names of the channels a patch set declared, in the order it declared
 * them: for this type every declared channel is a default, because the type
 * knows no family and has no reason to prefer one of the patch set's own names
 * over another.
 */
export function defaultChannelsOf(compile: GenericChannels): readonly string[] {
	return (compile ?? []).map((channel) => channel.channel ?? channel.script);
}

/**
 * The one dependency root a plain npm upstream has. A patch set of this type
 * declares its install command itself, but where an install lands is not a free
 * choice: npm writes into `node_modules/` of the directory it runs in, and the
 * build profile runs it at the tree root.
 */
export const DEPENDENCY_ROOTS: readonly string[] = ['node_modules'];

/** One declared command as the build skeleton wants it. */
export function toCommand(label: string, declared: string | readonly string[]): BuildCommand | null {
	const argv = argvOf(declared);
	const [command, ...args] = argv;
	if (command === undefined) {
		return null;
	}
	return { label, command, args };
}

export function makeBuild(config: GenericTypeConfig): BuildArea {
	const commands = config.commands ?? {};
	const install = commands.install === undefined ? null : toCommand('install', commands.install);
	const lint = (commands.lint ?? []).map((declared, index) => toCommand(`lint ${index + 1}`, declared)).filter(isCommand);
	const test = commands.test;
	const watchProfile = watchProfileOf(commands.compile);
	return {
		install: install === null ? [] : [install],
		dependencyRoots: DEPENDENCY_ROOTS,
		hygiene: lint,
		/**
		 * The own tests of the patch set, restricted to its own root. A runner
		 * that takes a glob behind a flag gets the flag; one that takes it as a
		 * bare argument gets it appended.
		 */
		ownTests: (ownRoot: string): BuildCommand | null => {
			if (test === undefined || ownRoot === '') {
				return null;
			}
			const base = toCommand('own tests', test.command);
			if (base === null) {
				return null;
			}
			const glob = `${ownRoot}/**/*.test.*`;
			const tail = test.ownGlobArg === undefined ? [glob] : [test.ownGlobArg, glob];
			return { ...base, args: [...base.args, ...tail] };
		},
		// A plain upstream has no distributable this tool knows how to build,
		// nothing to stamp into one, and no place to look for the result.
		packageBuild: [],
		packageDistributable: [],
		packageStamps: [],
		packageOutputs: [],
		packageScratch: [],
		defaultChannels: defaultChannelsOf(commands.compile),
		watchProfilePath: null,
		...(watchProfile === undefined ? {} : { watchProfile }),
		foreignWatcherMarkers: []
	};
}

export const build: BuildArea = makeBuild({ ownRoot: 'own' });

function isCommand(command: BuildCommand | null): command is BuildCommand {
	return command !== null;
}
