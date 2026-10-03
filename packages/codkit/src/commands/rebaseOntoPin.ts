/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
import { pinKey } from '../lib/pinIdentity.ts';
// Thin command surface for the library transaction.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, forkResolution, requireProjectType } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { ckError, isCkError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { rebaseOntoPin } from '../lib/rebaseOntoPin.ts';
import type { RebaseOntoPinResult } from '../lib/rebaseOntoPin.ts';
import { treeId } from '../lib/fingerprint.ts';
import { withLock } from '../lib/lock.ts';
import { checkTree, formatCheckLine } from '../lib/treeIdentity.ts';

const FEATURE_FAILURE_CODES = new Set([
	'ARTIFACT-BROKEN',
	'ENCODING',
	'CRLF',
	'EOF-NEWLINE',
	'MARKER-MALFORMED',
	'MARKER-NESTED',
	'MARKER-UNBALANCED',
	'MARKER-UNCLOSED',
	'MARKER-DUP-ID',
	'MARKER-BAD-ID',
	'HUNK-OUTSIDE-MARKER',
	'DIRTY-TREE'
]);

async function run(ctx: CommandContext): Promise<number> {
	const config = requireConfig(ctx.config);
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) ctx.out.warn(resolution.warning);
	const identity = checkTree(resolution, config, { mode: 'write', type: requireProjectType(ctx) });
	if (ctx.flags.verbose) {
		for (const check of identity.checks) ctx.out.diag(formatCheckLine(check));
	}
	if (identity.fatal !== null) {
		ctx.out.addError(identity.fatal.toPayload());
		return EXIT_ENVIRONMENT;
	}

	return withLock(
		ctx.patchesDir,
		treeId(resolution.path),
		'rebase-onto-pin',
		() => {
			let result: RebaseOntoPinResult;
			try {
				result = rebaseOntoPin({
					patchesDir: ctx.patchesDir,
					resolution,
					config,
					type: requireProjectType(ctx),
					out: ctx.out,
					verbose: ctx.flags.verbose
				});
			} catch (error) {
				if (!isCkError(error) || !FEATURE_FAILURE_CODES.has(error.code)) throw error;
				ctx.out.addError(error.toPayload());
				return EXIT_CHECK_FAILED;
			}
			for (const patch of result.patches) {
				const cause = patch.cause.sha === null ? 'none' : `${patch.cause.approx ? '~' : ''}${patch.cause.sha.slice(0, 8)}`;
				ctx.out.info(`${patch.outcome}: ${patch.artifactId} ${patch.sourceTarget} -> ${patch.targetPath} cause ${cause}`);
			}
			if (result.blockers.length > 0) ctx.out.info(`rebase blocked by ${result.blockers.length} conflict/deleted target(s)`);
			else ctx.out.info(`rebase saved ${result.patches.length} feature patch(es) onto ${pinKey(result.targetPin)}`);
			ctx.out.setData(dataOf(result));
			return result.exitCode;
		},
		(text) => ctx.out.warn(text)
	);
}

function dataOf(result: RebaseOntoPinResult): JsonValue {
	return {
		sourcePin: { ...result.sourcePin },
		targetPin: { ...result.targetPin },
		mergeBase: result.mergeBase,
		patches: result.patches.map((patch) => ({
			artifact: patch.artifactPath,
			id: patch.artifactId,
			sourceTarget: patch.sourceTarget,
			target: patch.targetPath,
			outcome: patch.outcome,
			cause: { ...patch.cause }
		})),
		blockers: result.blockers.map((patch) => patch.artifactPath),
		save: result.save === null ? null : { status: result.save.status, files: result.save.files.map((file) => ({ ...file })) }
	};
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: rebase-onto-pin needs the merged target pin',
			'complete the target merge in a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

export const rebaseOntoPinCommand: CommandDefinition = {
	name: 'rebase-onto-pin',
	summary: 'replay feature-only patches after merging a target patchset branch',
	configMode: 'load',
	maxArgs: 0,
	run
};
