/** @scope spec://codkit/modules/codkit/PROP-007#CMD-INPUTS-PIN */
// codkit inputs pin <name>...|--all - move the pin of an input to the HEAD of
// its repository (PROP-007 ##CMD-INPUTS-PIN).
//
// The release takes an input from the commit codkit.json names, so the pin is
// what makes a release reproducible, and it must name committed content: a
// repository whose working tree has changes of its own is refused with the
// paths, before anything is written. The rewrite is canonical and happens once,
// for every named input or none of them; the change and the pin that goes with
// it then land in the same patch-set commit.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, patchesRoot } from '../lib/command.ts';
import type { CodkitConfig, InputConfig } from '../lib/configFile.ts';
import { inputRepositoryState, writeInputRefs } from '../lib/inputsRepository.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { withLock } from '../lib/lock.ts';
import { ckError } from '../lib/messages.ts';

const ALL = '--all';
/** The lock every writer of codkit.json takes (the pin update of a cycle included). */
const CONFIG_LOCK_ID = 'cycle-global';
const LIST_LIMIT = 20;

/** main.ts answers a bare namespace before this runs. */
async function runNamespace(): Promise<number> {
	return EXIT_ENVIRONMENT;
}

async function runPin(ctx: CommandContext): Promise<number> {
	const config = requireConfig(ctx.config);
	const selected = selectedInputs(ctx, config);
	const moves: { input: InputConfig; head: string }[] = [];
	for (const input of selected) {
		const state = inputRepositoryState(input);
		if (!state.present || state.head === null) {
			throw ckError(
				'CONFIG',
				`input ${input.name}: ${input.repository} is not a git repository with a commit at HEAD`,
				'clone the repository there, or name its location on this machine in codkit.local.json'
			);
		}
		if (state.uncommitted.length > 0) {
			for (const path of state.uncommitted.slice(0, LIST_LIMIT)) ctx.out.info(`  uncommitted: ${path}`);
			if (state.uncommitted.length > LIST_LIMIT) ctx.out.info(`  ... and ${state.uncommitted.length - LIST_LIMIT} more`);
			throw ckError(
				'CONFIG',
				`input ${input.name}: the working tree of ${input.repository} has ${state.uncommitted.length} uncommitted change(s); a pin names committed content only`,
				`commit or drop them in ${input.repository}, then run codkit inputs pin ${input.name} again`
			);
		}
		moves.push({ input, head: state.head });
	}
	const patchesDir = patchesRoot(ctx);
	const changed = withLock(patchesDir, CONFIG_LOCK_ID, 'inputs pin', () =>
		writeInputRefs(patchesDir, new Map(moves.map((move) => [move.input.name, move.head])))
	);
	for (const move of moves) {
		ctx.out.info(
			move.input.ref === move.head
				? `input ${move.input.name}: already at ${move.head.slice(0, 12)}`
				: `input ${move.input.name}: ${move.input.ref.slice(0, 12)} -> ${move.head.slice(0, 12)}`
		);
	}
	if (changed) ctx.out.info('codkit.json rewritten; commit it together with the change that needs the new content');
	ctx.out.setData({
		changed,
		inputs: moves.map((move) => ({ name: move.input.name, from: move.input.ref, to: move.head, moved: move.input.ref !== move.head }))
	} satisfies JsonValue);
	return EXIT_OK;
}

/** The inputs the arguments name, or every one with `--all`; a name codkit.json does not declare is refused. */
function selectedInputs(ctx: CommandContext, config: CodkitConfig): readonly InputConfig[] {
	const declared = config.inputs ?? [];
	const all = commandFlagGiven(ctx.commandFlags, ALL);
	if (all === ctx.args.length > 0) {
		throw ckError('CONFIG', 'inputs pin needs the names of inputs, or --all', 'usage: codkit inputs pin <name>...|--all');
	}
	if (all) {
		if (declared.length === 0) throw ckError('CONFIG', 'codkit.json declares no inputs', 'declare one in the inputs list of codkit.json');
		return declared;
	}
	return ctx.args.map((name) => {
		const input = declared.find((candidate) => candidate.name === name);
		if (input === undefined) {
			throw ckError(
				'CONFIG',
				`codkit.json declares no input named ${name}`,
				`the declared inputs: ${declared.map((entry) => entry.name).join(', ') || 'none'}`
			);
		}
		return input;
	});
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: inputs pin rewrites its inputs',
			'run from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

export const inputsCommand: CommandDefinition = {
	name: 'inputs',
	summary: 'namespace of the inputs other repositories build; run inputs pin',
	configMode: 'none',
	namespace: true,
	roots: 'none',
	maxArgs: 0,
	run: runNamespace
};

export const inputsPinCommand: CommandDefinition = {
	name: 'inputs pin',
	summary: 'move the pin of inputs to the HEAD of their repositories, refusing uncommitted content',
	configMode: 'load',
	roots: 'patches',
	maxArgs: 100,
	commandFlags: [ALL],
	run: runPin
};
