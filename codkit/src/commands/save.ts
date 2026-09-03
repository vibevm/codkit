/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit save - extract the work done in the fork tree back into patchset.
// Contract: PROP-007 sec. 7 (##CMD-SAVE); algorithm: PROP-008 sec. 4.
//
// This is the command that makes the tree disposable: everything a developer
// did there becomes an artifact in patchset, and the tree is rebuilt from those
// artifacts in the same run. Without arguments it takes every changed file;
// with paths it takes only those.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { commandFlagGiven, commandFlagList, commandFlagValue, forkResolution } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { withLock } from '../lib/lock.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { runSave } from '../lib/saveEngine.ts';
import type { SaveResult } from '../lib/saveEngine.ts';

const COMMIT = '--commit';
const MESSAGE = '--message';
const ALLOW_NEW_FILE = '--allow-new-file';

/** Positional paths; a real change set is never longer than a few hundred. */
const MAX_PATHS = 1000;

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}

	const config = requireConfig(ctx.config);

	return withLock(
		ctx.patchesDir,
		treeId(resolution.path),
		'save',
		() => {
			const result = runSave({
				patchesDir: ctx.patchesDir,
				resolution,
				config,
				out: ctx.out,
				paths: ctx.args,
				allowNewFile: commandFlagList(ctx.commandFlags, ALLOW_NEW_FILE),
				commit: commandFlagGiven(ctx.commandFlags, COMMIT),
				message: commandFlagValue(ctx.commandFlags, MESSAGE),
				verbose: ctx.flags.verbose
			});
			ctx.out.setData(buildData(result));
			return result.exitCode;
		},
		(text) => {
			ctx.out.warn(text);
		}
	);
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: save needs the pin to regenerate patches against',
			'run save from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

function buildData(result: SaveResult): JsonValue {
	const files: JsonValue = result.files.map((file) => ({ target: file.target, artifact: file.artifact, action: file.action }));
	return {
		status: result.status,
		branch: result.branch,
		branchTip: result.branchTip,
		files,
		own: { extracted: result.own.copied, removed: result.own.removed, kept: result.own.kept },
		commit: result.commit
	};
}

export const saveCommand: CommandDefinition = {
	name: 'save',
	summary: 'extract the changes of the fork tree back into the patchset delta',
	configMode: 'load',
	maxArgs: MAX_PATHS,
	commandFlags: [COMMIT, MESSAGE, ALLOW_NEW_FILE],
	run
};
