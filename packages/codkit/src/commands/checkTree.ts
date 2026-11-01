/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit check-tree - is the fork tree the upstream tree this patchset expects?
// Contract: PROP-007 sec. 3 (##CMD-CHECK-TREE), checks and order: PROP-008 sec. 2.
//
// Read-only by construction: the command never writes to the tree, so the write
// probe of ##ID-CHECK-WRITE is not part of its check list.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, forkResolution, requireProjectType } from '../lib/command.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { checkTree, formatCheckLine } from '../lib/treeIdentity.ts';
import type { TreeCheck } from '../lib/treeIdentity.ts';

const REQUIRE_CLEAN = '--require-clean';

/** How many dirty paths are listed before the rest is summarized. */
const DIRTY_LIST_LIMIT = 20;

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}

	if (ctx.config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: check-tree needs the pin and the upstream anchor to check against',
			'run check-tree from a patchset checkout that carries codkit.json'
		);
	}

	const requireClean = commandFlagGiven(ctx.commandFlags, REQUIRE_CLEAN);
	const result = checkTree(resolution, ctx.config, {
		mode: 'read',
		requireClean,
		type: requireProjectType(ctx),
		patchesDir: ctx.patchesDir,
		onWarn: (text) => ctx.out.warn(text)
	});

	for (const check of result.checks) {
		ctx.out.info(formatCheckLine(check));
	}
	if (result.dirtyFiles !== undefined) {
		for (const path of result.dirtyFiles.slice(0, DIRTY_LIST_LIMIT)) {
			ctx.out.info(`  dirty: ${path}`);
		}
		if (result.dirtyFiles.length > DIRTY_LIST_LIMIT) {
			ctx.out.info(`  ... and ${result.dirtyFiles.length - DIRTY_LIST_LIMIT} more`);
		}
	}
	ctx.out.setData(buildData(result.checks, requireClean, result.dirtyFiles));

	if (result.fatal !== null) {
		// Fatal: the tree cannot be used at all, and no codkit command fixes it.
		ctx.out.addError(result.fatal.toPayload());
		return EXIT_ENVIRONMENT;
	}
	if (result.dirtyFiles !== undefined && result.dirtyFiles.length > 0) {
		// The one condition that is unfit but fixable from inside codkit.
		ctx.out.addError({
			code: 'DIRTY-TREE',
			message: `${result.dirtyFiles.length} path(s) in the fork tree differ from HEAD outside the own directory`,
			hint: 'run: codkit save   (or codkit status to see what changed)'
		});
		return EXIT_CHECK_FAILED;
	}
	ctx.out.info('tree is usable');
	return EXIT_OK;
}

function buildData(checks: readonly TreeCheck[], requireClean: boolean, dirtyFiles: readonly string[] | undefined): JsonValue {
	const rendered: JsonValue = checks.map((check) => {
		const entry: { [key: string]: JsonValue } = { id: check.id, name: check.name, ok: check.ok };
		if (check.info !== undefined) {
			entry['info'] = check.info;
		}
		return entry;
	});
	// `clean` appears only when the check actually ran: a fatal condition earlier
	// in the sequence stops it, and reporting `false` then would be a lie.
	if (!requireClean || dirtyFiles === undefined) {
		return { checks: rendered };
	}
	return { checks: rendered, clean: dirtyFiles.length === 0 };
}

export const checkTreeCommand: CommandDefinition = {
	name: 'check-tree',
	summary: 'check that the fork tree is the upstream tree this patchset tracks',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [REQUIRE_CLEAN],
	run
};
