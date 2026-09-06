/** @scope spec://codkit/modules/codkit/PROP-007#root */
// argv parser for codkit. Hand-written on purpose: the flag surface is tiny and
// fixed by PROP-007 ##CLI-GLOBAL-FLAGS, and the parser must not disagree with
// the generated command reference (PROP-012 ##DOC-COMMANDS-REF).
//
// Grammar:
//   token        := global-flag | command-flag | '--' | positional
//   global-flag  := root-flag | '--json' | '--ci' | '--verbose'
//   root-flag    := ('--fork-dir' | '--patches-dir') <path>
//                 | ('--fork-dir=' | '--patches-dir=') <path>
//   command-flag := any name in COMMAND_FLAG_KINDS, with a value when declared so
// Global flags are accepted before and after the command name. Everything after
// a bare '--' is positional, whatever it looks like.
//
// Command-specific flags are spelled out centrally, in one table, so that the
// parser stays a single pass over argv and does not need the command name to
// know whether a flag swallows the next token. Which command may use which flag
// is enforced afterwards, in main.ts, against CommandDefinition.commandFlags.

import type { CommandFlagValues, GlobalFlags } from './command.ts';

export type ParsedArgv = {
	readonly flags: GlobalFlags;
	readonly commandFlags: CommandFlagValues;
	readonly positional: readonly string[];
};

/** A usage problem: reported plainly, without a CK error code (PROP-007 sec. 1). */
export type ArgvProblem = { readonly error: string; readonly hint: string };

export type ArgvParseResult = { readonly ok: true; readonly value: ParsedArgv } | { readonly ok: false; readonly problem: ArgvProblem };

export const GLOBAL_FLAG_HELP: readonly string[] = [
	'--fork-dir <path>  path of the VS Code fork tree (source: flag)',
	'--patches-dir <path>  path of the Codkit patch-set repository (source: flag)',
	'--json             machine-readable output on stdout',
	'--ci               non-interactive mode, no network',
	'--verbose          diagnostics on stderr'
];

const KNOWN_GLOBAL_FLAGS: readonly string[] = ['--fork-dir', '--patches-dir', '--json', '--ci', '--verbose'];

/**
 * Every command-specific flag codkit knows, and how it consumes argv:
 *   'boolean'    - stands alone;
 *   'value'      - takes one value, last one wins;
 *   'repeatable' - takes one value and may be given several times.
 */
const COMMAND_FLAG_KINDS: ReadonlyMap<string, 'boolean' | 'value' | 'repeatable'> = new Map([
	// check-tree (PROP-007 sec. 3)
	['--require-clean', 'boolean'],
	// clone (PROP-007 sec. 4)
	['--from', 'value'],
	// load (PROP-007 sec. 5)
	['--fresh', 'boolean'],
	['--dry-run', 'boolean'],
	['--clone-if-missing', 'boolean'],
	['--discard', 'boolean'],
	// save (PROP-007 sec. 7)
	['--commit', 'boolean'],
	['--message', 'value'],
	['--allow-new-file', 'repeatable'],
	['--squash', 'boolean'],
	// inventory (PROP-007 sec. 10)
	['--diff', 'value'],
	['--md', 'boolean'],
	// verify (PROP-007 sec. 11); --staged-fast is codkit's own, see hiddenFlags
	['--staged-fast', 'boolean'],
	// build up|down|status|errors (PROP-007 sec. 13); ci reuses --timeout for the
	// single compilation pass it waits for
	['--channel', 'value'],
	['--mine', 'boolean'],
	['--timeout', 'value'],
	// ci (PROP-007 sec. 17, PROP-011)
	['--profile', 'value'],
	['--effective-diff', 'value'],
	['--pin-guard-base', 'value'],
	// cycle restart (PROP-007 sec. 14)
	['--yes', 'boolean'],
	// marker new (PROP-007 sec. 8)
	['--id', 'value'],
	['--type', 'value'],
	['--owner', 'value'],
	['--reason', 'value'],
	['--category', 'value'],
	['--layer', 'value'],
	['--line', 'value'],
	// reresolve (PROP-007 sec. 9)
	['--patch', 'value'],
	// forecast (PROP-007 sec. 15)
	['--ref', 'value'],
	// publish (PROP-007 sec. 18)
	['--release', 'value'],
	['--yes-i-am-publish-bot', 'boolean']
]);

export function parseArgv(argv: readonly string[]): ArgvParseResult {
	let forkDir: string | null = null;
	let patchesDir: string | null = null;
	let json = false;
	let ci = false;
	let verbose = false;
	const commandFlags = new Map<string, string | true | string[]>();
	const positional: string[] = [];
	let onlyPositional = false;

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === undefined) {
			continue;
		}
		if (onlyPositional) {
			positional.push(token);
			continue;
		}
		if (token === '--') {
			onlyPositional = true;
			continue;
		}
		if (!token.startsWith('--')) {
			positional.push(token);
			continue;
		}

		const equals = token.indexOf('=');
		const name = equals === -1 ? token : token.slice(0, equals);
		const inlineValue = equals === -1 ? null : token.slice(equals + 1);

		if (name === '--fork-dir' || name === '--patches-dir') {
			if (inlineValue !== null) {
				if (name === '--fork-dir') forkDir = inlineValue;
				else patchesDir = inlineValue;
				continue;
			}
			const next = argv[index + 1];
			if (next === undefined) {
				return { ok: false, problem: { error: `flag ${name} needs a path`, hint: `usage: ${name} <path>` } };
			}
			if (name === '--fork-dir') forkDir = next;
			else patchesDir = next;
			index += 1;
			continue;
		}

		if (name === '--json' || name === '--ci' || name === '--verbose') {
			if (inlineValue !== null) {
				return {
					ok: false,
					problem: { error: `flag ${name} takes no value`, hint: `pass ${name} on its own` }
				};
			}
			if (name === '--json') {
				json = true;
			} else if (name === '--ci') {
				ci = true;
			} else {
				verbose = true;
			}
			continue;
		}

		const kind = COMMAND_FLAG_KINDS.get(name);
		if (kind === 'boolean') {
			if (inlineValue !== null) {
				return {
					ok: false,
					problem: { error: `flag ${name} takes no value`, hint: `pass ${name} on its own` }
				};
			}
			commandFlags.set(name, true);
			continue;
		}
		if (kind === 'value' || kind === 'repeatable') {
			let value: string;
			if (inlineValue !== null) {
				value = inlineValue;
			} else {
				const next = argv[index + 1];
				if (next === undefined) {
					return { ok: false, problem: { error: `flag ${name} needs a value`, hint: `usage: ${name} <value>` } };
				}
				value = next;
				index += 1;
			}
			if (kind === 'value') {
				commandFlags.set(name, value);
				continue;
			}
			const collected = commandFlags.get(name);
			commandFlags.set(name, Array.isArray(collected) ? [...collected, value] : [value]);
			continue;
		}

		return {
			ok: false,
			problem: {
				error: `unknown flag ${name}`,
				hint: `known global flags: ${KNOWN_GLOBAL_FLAGS.join(', ')}`
			}
		};
	}

	return { ok: true, value: { flags: { forkDir, patchesDir, json, ci, verbose }, commandFlags, positional } };
}
