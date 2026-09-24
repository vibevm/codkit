/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit load - bring the fork tree to the pin and put the delta on it.
// Contract: PROP-007 sec. 5 (##CMD-LOAD); algorithm: PROP-008 sec. 3. The name
// `sync` is reserved for the future two-way save+load command; until then it is
// a plain usage error in main.ts.
//
// This command is the one a developer runs every day, so its two guarantees
// matter more than its features: it never destroys work that was not extracted
// back into patchset (the drift guard), and running it twice costs nothing (the
// fast path of PROP-006 sec. 1). `--discard` (D11) is the one sanctioned way to
// give up the commit half of that guarantee: the loss is named in advance, the
// dropped line stays reachable under refs/codkit/consumed/, and a non-interactive
// run may not make the decision at all. Together with `--fresh` the same flag
// gives up the working-tree edits of tracked upstream files that carry no marker
// block (PROP-007 ##CMD-LOAD-DISCARD-WORKTREE): building the tree writes an
// artifact over such a file, and returning to dev mode must not require a git
// command typed by hand inside a managed tree. Every dropped path is printed as
// `discard <path>` before the first write.
//
// Cloning is not a side effect of a typo: a missing tree is an error unless
// --clone-if-missing says otherwise, and even then --ci refuses, because a
// container run must never start downloading gigabytes.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_ENVIRONMENT, commandFlagGiven, forkResolution, requireProjectType } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { withLock } from '../lib/lock.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine, refreshResolution } from '../lib/paths.ts';
import type { ForkDirResolution } from '../lib/paths.ts';
import { runSync } from '../lib/syncEngine.ts';
import type { SyncResult } from '../lib/syncEngine.ts';
import { cloneForkTree } from './clone.ts';

const FRESH = '--fresh';
const DRY_RUN = '--dry-run';
const CLONE_IF_MISSING = '--clone-if-missing';
const DISCARD = '--discard';

async function run(ctx: CommandContext): Promise<number> {
	// Before anything is resolved or read: a non-interactive run must never
	// decide on its own to drop somebody's work (D11). The flag names a loss, and
	// naming a loss is an interactive act.
	const discard = commandFlagGiven(ctx.commandFlags, DISCARD);
	if (discard && ctx.flags.ci) {
		throw ckError(
			'CONFIG',
			'load --discard drops fork-tree commits on purpose, and a --ci run must not make that decision',
			'run codkit save to keep the commits, or codkit load --discard interactively'
		);
	}
	let resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}

	const config = requireConfig(ctx.config);
	const fresh = commandFlagGiven(ctx.commandFlags, FRESH);
	const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);

	if (!resolution.exists && commandFlagGiven(ctx.commandFlags, CLONE_IF_MISSING)) {
		const cloned = cloneMissingTree(ctx, resolution, config);
		if (cloned !== null) {
			return cloned;
		}
		// The path exists now: resolve again so the tree id is the realpath.
		resolution = refreshResolution(resolution);
		ctx.out.setForkTree(resolution.path, resolution.source);
	}

	// The lock is keyed by the tree, so two patchset checkouts driving the same
	// tree exclude each other, and one patchset driving two trees does not.
	return withLock(
		ctx.patchesDir,
		treeId(resolution.path),
		'load',
		() => {
			const result = runSync({
				patchesDir: ctx.patchesDir,
				resolution,
				config,
				type: requireProjectType(ctx),
				out: ctx.out,
				fresh,
				dryRun,
				verbose: ctx.flags.verbose,
				discardTreeCommits: discard,
				discardWorktreeEdits: discard && fresh,
				// PROP-008 ##DRIFT-GUARD-PREDICATE: `load` is the one command
				// that passes over a materialization nobody declares any more
				// (modules/vscode/PROP-002 ##OWN-EXTENSION-STRANDED). It is set here rather
				// than inside the engine because it is a property of the
				// command, not of the run: every other caller of the engine
				// keeps the rule about a new file in the upstream zone.
				passStrandedExtensions: true
			});
			report(ctx, result, { fresh, dryRun, discard });
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
			'codkit.json was not found in the patchset root: load needs the pin and the delta of this repository',
			'run load from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

/**
 * --clone-if-missing. Returns an exit code when the command is finished (the
 * clone failed or is forbidden), or null when the tree is now in place.
 */
function cloneMissingTree(ctx: CommandContext, resolution: ForkDirResolution, config: CodkitConfig): number | null {
	if (ctx.flags.ci) {
		ctx.out.addError({
			code: 'NET-FORBIDDEN',
			message: 'the fork tree is missing and --clone-if-missing needs the network, which --ci forbids',
			hint: `provide the tree to the container and point CODKIT_FORK_DIR at it, or clone it beforehand: codkit clone --fork-dir ${resolution.path}`
		});
		return EXIT_ENVIRONMENT;
	}
	const source = config.publishRemoteUrl;
	if (source === null || source === '') {
		throw ckError(
			'CONFIG',
			`the fork tree ${resolution.path} does not exist and codkit.json has no publishRemoteUrl to clone from`,
			'run: codkit clone --from <url>   (load itself takes no source, so the clone is an explicit step)'
		);
	}
	ctx.out.info(`fork tree is missing; cloning ${source}`);
	const failure = cloneForkTree({ path: resolution.path, source, config, out: ctx.out });
	if (failure !== null) {
		ctx.out.addError(failure);
		return EXIT_ENVIRONMENT;
	}
	return null;
}

function report(ctx: CommandContext, result: SyncResult, flags: { fresh: boolean; dryRun: boolean; discard: boolean }): void {
	ctx.out.setData(buildData(result, flags));
}

function buildData(result: SyncResult, flags: { fresh: boolean; dryRun: boolean; discard: boolean }): JsonValue {
	const data: { [key: string]: JsonValue } = {
		status: result.status,
		branch: result.branch,
		branchTip: result.branchTip,
		artifacts: result.artifacts,
		own: { total: result.own.total, copied: result.own.copied, removed: result.own.removed },
		changedFiles: result.changedFiles,
		dryRun: flags.dryRun
	};
	if (flags.fresh) {
		data['cleaned'] = result.cleaned;
	}
	if (flags.discard) {
		data['discarded'] = [...result.discarded];
		data['discardedRef'] = result.discardedRef;
		data['discardedPaths'] = [...result.discardedPaths];
	}
	if (result.dirtyFiles.length > 0) {
		data['dirtyFiles'] = [...result.dirtyFiles];
	}
	if (result.broken.length > 0) {
		data['brokenArtifacts'] = [...result.broken];
	}
	if (result.fastPathReason !== null) {
		data['fastPathReason'] = result.fastPathReason;
	}
	// PROP-008 ##WORKTREE-DELTA-BYTES: the files whose converted bytes this run put back.
	if (result.restoredBytes.length > 0) {
		data['restoredBytes'] = [...result.restoredBytes];
	}
	return data;
}

export const loadCommand: CommandDefinition = {
	name: 'load',
	summary: 'bring the fork tree to the pin and apply the delta',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [FRESH, DRY_RUN, CLONE_IF_MISSING, DISCARD],
	run
};
