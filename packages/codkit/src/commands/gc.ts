/** @scope spec://codkit/modules/codkit/PROP-007#CMD-GC */
// codkit gc - clear what is genuinely spent, never a recovery record
// (PROP-007 sec. 20 ##CMD-GC, classes: PROP-006 sec. 1 ##GC-CLASSES; campaign
// TREE-COMMITS-SAVE Phase 9, decision D22).
//
// The earlier phases of the campaign kept state on purpose: consumed refs so
// a replayed line stays diagnosable, crash scratch because a finally never
// ran, caches because a tree might come back. This command is where those
// reasons expire - and where they must not: a live transaction file or a
// pending draft is exactly the state somebody's recovery needs, so the plan
// names it as kept instead of sweeping it (##GC-CLASSES). --dry-run prints
// the identical plan without the removals, because the classification, not
// the deletion, is the decision the operator reviews.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { commandFlagGiven, forkResolution } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import { executeGc, gcCountFlag, planGc } from '../lib/gc.ts';
import type { GcEntry, GcPlan } from '../lib/gc.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { isAlive, lockPath, readLock, withLock } from '../lib/lock.ts';
import type { LockInfo } from '../lib/lock.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';

const DRY_RUN = '--dry-run';
const KEEP_CONSUMED = '--keep-consumed';
const OLDER_THAN = '--older-than';

/** D22's defaults: the newest 5 consumed refs, and 30 days of age beyond them. */
export const DEFAULT_KEEP_CONSUMED = 5;
export const DEFAULT_OLDER_THAN_DAYS = 30;

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}
	requireConfig(ctx.config);

	const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);
	const keepConsumed = gcCountFlag(ctx.commandFlags, KEEP_CONSUMED, DEFAULT_KEEP_CONSUMED);
	const olderThanDays = gcCountFlag(ctx.commandFlags, OLDER_THAN, DEFAULT_OLDER_THAN_DAYS);

	// Read before the acquisition so the plan can name the stale own-tree lock
	// the acquisition is about to take over (##LOCK-MECHANISM does this on every
	// acquisition, gc's included - also under --dry-run, which still takes the
	// tree lock to read the shared refs under it).
	const key = treeId(resolution.path);
	const holder = readLock(lockPath(ctx.patchesDir, key));
	const takeover: { readonly holder: LockInfo } | null = holder !== null && !isAlive(holder.pid) ? { holder } : null;

	return withLock(
		ctx.patchesDir,
		key,
		'gc',
		() => {
			const plan = planGc({
				patchesDir: ctx.patchesDir,
				treeDir: resolution.path,
				ownTreeKey: key,
				keepConsumed,
				olderThanDays,
				ownLockTakeover: takeover
			});
			const removals = [...plan.takeover, ...plan.entries.filter((entry) => entry.action === 'remove')];
			const keeps = plan.entries.filter((entry) => entry.action === 'keep');
			ctx.out.info(`gc plan: ${removals.length} to remove, ${keeps.length} to keep`);
			for (const entry of [...plan.takeover, ...plan.entries]) {
				ctx.out.info(formatEntry(entry));
			}
			if (dryRun) {
				ctx.out.info('dry run: nothing was removed');
				ctx.out.setData(buildData(plan, [], keeps));
				return 0;
			}
			const outcome = executeGc(plan, {
				patchesDir: ctx.patchesDir,
				treeDir: resolution.path,
				ownTreeKey: key,
				keepConsumed,
				olderThanDays
			});
			ctx.out.info(`removed ${outcome.removed.length} item(s); kept ${outcome.kept.length}`);
			ctx.out.setData(buildData(plan, outcome.removed, outcome.kept));
			return 0;
		},
		(text) => {
			ctx.out.warn(text);
		}
	);
}

function formatEntry(entry: GcEntry): string {
	return `  ${entry.action}  ${entry.klass.padEnd(13)} ${entry.path} - ${entry.reason}`;
}

function buildData(plan: GcPlan, removed: readonly GcEntry[], kept: readonly GcEntry[]): JsonValue {
	return {
		plan: [...plan.takeover, ...plan.entries].map((entry) => ({
			action: entry.action,
			class: entry.klass,
			path: entry.path,
			reason: entry.reason
		})),
		removed: removed.map((entry) => entry.path),
		kept: kept.map((entry) => entry.path)
	};
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: gc cleans the runtime state of this repository and needs its fork tree',
			'run gc from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

export const gcCommand: CommandDefinition = {
	name: 'gc',
	summary: 'remove spent runtime state: old consumed refs, crash scratch, dead locks, caches of gone trees',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [DRY_RUN, KEEP_CONSUMED, OLDER_THAN],
	run
};
