/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Thin CLI surface for PROP-007 CMD-MARKER-REASON.
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { commandFlagGiven, commandFlagValue, EXIT_CHECK_FAILED, EXIT_OK, forkResolution, requireProjectType } from '../lib/command.ts';
import { loadConventions } from '../lib/conventionsFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import { withLock } from '../lib/lock.ts';
import { ckError, isCkError } from '../lib/messages.ts';
import { authorPatchReason } from '../lib/patchReason.ts';
import { formatForkTreeLine } from '../lib/paths.ts';

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	const target = ctx.args[0];
	if (target === undefined) throw ckError('CONFIG', 'marker reason needs one target', 'supply the existing upstream target');
	const request = {
		target,
		expectedId: commandFlagValue(ctx.commandFlags, '--id'),
		expectedHash: commandFlagValue(ctx.commandFlags, '--expected-sha256'),
		reason: commandFlagValue(ctx.commandFlags, '--reason'),
		dryRun: commandFlagGiven(ctx.commandFlags, '--dry-run')
	};
	const conventions = loadConventions(requireProjectType(ctx), ctx.patchesDir);
	const author = () => authorPatchReason(ctx.patchesDir, request, conventions);
	try {
		const result = request.dryRun
			? author()
			: withLock(ctx.patchesDir, treeId(resolution.path), 'marker reason', author, (text) => ctx.out.warn(text));
		ctx.out.setData(result);
		ctx.out.info(`${result.artifact}: reason ${result.status}`);
		return EXIT_OK;
	} catch (error) {
		if (!isCkError(error) || error.code !== 'ARTIFACT-BROKEN') throw error;
		ctx.out.addError(error.toPayload());
		return EXIT_CHECK_FAILED;
	}
}
export const markerReasonCommand: CommandDefinition = {
	name: 'marker reason',
	summary: 'author one existing patch reason without changing its body',
	configMode: 'load',
	maxArgs: 1,
	commandFlags: ['--id', '--expected-sha256', '--reason', '--dry-run'],
	run
};
