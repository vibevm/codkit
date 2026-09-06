/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Command vocabulary shared by main.ts and every command module.
//
// PROP-002 ##DEPENDENCY-RULE-BETWEEN-MODULES: commands are thin functions over
// the libraries; each receives an already-resolved context and returns an exit
// code, so a command can be exercised without a process.

import type { CodkitConfig } from './configFile.ts';
import type { Output } from './jsonOut.ts';
import { requireForkDir, requirePatchesDir } from './paths.ts';
import type { DirectoryResolution, ResolvedLocations, ResolverEnv } from './paths.ts';

/** Global flags, valid before and after the command name (PROP-007 ##CLI-GLOBAL-FLAGS). */
export type GlobalFlags = {
	/** --fork-dir <path>; null when not given. */
	readonly forkDir: string | null;
	/** --patches-dir <path>; null when not given. */
	readonly patchesDir: string | null;
	/** --json: machine-readable envelope on stdout (PROP-012 sec. 1). */
	readonly json: boolean;
	/** --ci: non-interactive, no network. */
	readonly ci: boolean;
	/** --verbose: diagnostics on stderr. */
	readonly verbose: boolean;
};

/**
 * Command-specific flags as parsed from argv: a value flag maps to its string,
 * a boolean flag to `true`, a repeatable flag to the list of its values. A flag
 * absent from argv is absent from the map.
 */
export type CommandFlagValues = ReadonlyMap<string, string | true | readonly string[]>;

/** Value of a `--name <value>` flag, or null when it was not given. */
export function commandFlagValue(flags: CommandFlagValues, name: string): string | null {
	const value = flags.get(name);
	return typeof value === 'string' ? value : null;
}

/** Values of a repeatable `--name <value>` flag, in the order they were given. */
export function commandFlagList(flags: CommandFlagValues, name: string): readonly string[] {
	const value = flags.get(name);
	if (Array.isArray(value)) {
		return value;
	}
	return typeof value === 'string' ? [value] : [];
}

/** Whether a boolean command flag was given. */
export function commandFlagGiven(flags: CommandFlagValues, name: string): boolean {
	return flags.has(name);
}

export type CommandContext = {
	/** Immutable Codkit installation/source root, derived from the module location. */
	readonly toolRoot: string;
	/** Independently resolved patch-set and managed-fork locations. */
	readonly locations: ResolvedLocations;
	/** Resolved patch-set repository root. */
	readonly patchesDir: string;
	/** Positional arguments left after the command name was consumed. */
	readonly args: readonly string[];
	readonly flags: GlobalFlags;
	/** Flags declared by this command in `CommandDefinition.commandFlags`. */
	readonly commandFlags: CommandFlagValues;
	readonly env: ResolverEnv;
	/** null when codkit.json is absent and the command tolerates that. */
	readonly config: CodkitConfig | null;
	readonly out: Output;
};

/** Absolute patch-set root required by commands that read or write patch data. */
export function patchesRoot(ctx: CommandContext): string {
	return requirePatchesDir(ctx.locations).path;
}

/** Managed VS Code checkout required by commands that operate on the fork. */
export function forkResolution(ctx: CommandContext): DirectoryResolution {
	return requireForkDir(ctx.locations);
}

/**
 * How a command relates to codkit.json.
 *   'none' - never read it;
 *   'load' - read it if present; a broken file is fatal, an absent one is not.
 */
export type ConfigMode = 'none' | 'load';

export type CommandDefinition = {
	/** Space-joined name, e.g. 'where' or 'marker new'. */
	readonly name: string;
	readonly summary: string;
	readonly configMode: ConfigMode;
	/**
	 * A namespace: the name is a prefix of real commands and carries no work of
	 * its own. main.ts answers it with the usage of its subcommands and exit 2,
	 * before any root is resolved, so it never quietly does something.
	 */
	readonly namespace?: boolean;
	/** Positional arguments the command accepts beyond its name. */
	readonly maxArgs: number;
	/**
	 * Command-specific flags this command accepts, e.g. ['--require-clean'].
	 * Their spelling and arity live in argv.ts; main.ts refuses a flag that is
	 * parsed but not listed here, so `where --from x` is a usage error.
	 */
	readonly commandFlags?: readonly string[];
	/**
	 * Flags the command accepts but does not advertise. They exist for codkit's
	 * own machinery - the hooks it installs call themselves through the CLI - and
	 * are not part of what a person is offered, so they stay out of `--help` and
	 * out of the generated command reference.
	 */
	readonly hiddenFlags?: readonly string[];
	readonly run: (ctx: CommandContext) => Promise<number>;
};

export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_ENVIRONMENT = 2;
export const EXIT_NEEDS_HUMAN = 3;
