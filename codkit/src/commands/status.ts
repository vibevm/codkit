/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit status - what is in the tree, what is in patchset, and what is not in
// both. Contract: PROP-007 sec. 6 (##CMD-STATUS).
//
// Read-only by construction and lock-free on purpose: `status` is the command a
// developer runs *because* something looks wrong, including while another codkit
// command holds the tree, so it must never wait for a lock and never write.
//
// Exit code 1 is not a failure of the command; it means "there is unextracted
// work or an invalid marker", which is what makes `status` usable in a script.

import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, forkResolution } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { loadConventions } from '../lib/conventionsFile.ts';
import type { Conventions } from '../lib/conventionsFile.ts';
import { porcelainZEntries } from '../lib/driftGuard.ts';
import { deltaFingerprint, treeId } from '../lib/fingerprint.ts';
import { runGit } from '../lib/gitx.ts';
import type { JsonValue, Output } from '../lib/jsonOut.ts';
import { markerFormFor, parseMarkers } from '../lib/markers.ts';
import { ckError } from '../lib/messages.ts';
import { classifyOwn, ownTargetRelativeDir } from '../lib/ownCopy.ts';
import type { OwnSideClass, OwnSideKind } from '../lib/ownCopy.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { listPendingHeaders } from '../lib/pendingHeader.ts';
import { readSyncTransaction } from '../lib/syncTransaction.ts';
import { classifyTargets, loadedFrom, loadedFromLabel, movedArtifactsOf } from '../lib/syncMerge.ts';
import { foreignCommits } from '../lib/treeCommits.ts';
import { fastPathConditions, readTreeCache, readTreeMark, revParse } from '../lib/treeCache.ts';
import { checkTree } from '../lib/treeIdentity.ts';

/** How many paths are listed before the rest is summarized. */
const LIST_LIMIT = 20;

type UpstreamFile = {
	readonly path: string;
	readonly status: string;
	/** Marker blocks the working file carries. */
	readonly blocks: number;
	readonly markerErrors: number;
};

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}

	const config = requireConfig(ctx.config);
	ctx.out.info(`pin: ${config.pin.tag}@${config.pin.sha.slice(0, 8)} (${config.pin.date})`);

	// Read-only: the write probe of ##ID-CHECK-WRITE is not part of this command.
	const identity = checkTree(resolution, config, { mode: 'read' });
	if (identity.fatal !== null) {
		ctx.out.addError(identity.fatal.toPayload());
		ctx.out.setData({ pin: pinData(config), tree: 'unusable' });
		return EXIT_ENVIRONMENT;
	}

	const tree = resolution.path;
	const conventions = loadConventions(ctx.patchesDir);
	const branch = `${config.generatedBranchPrefix}${config.pin.tag}`;

	// 0. A live two-way sync outranks every question below: while its
	// transaction record exists, the tree may be half one state and half
	// another, and `status` - the command a developer runs *because* something
	// looks wrong - is where that says its name (PROP-008 ##SYNC-TRANSACTION).
	const liveSync = readSyncTransaction(ctx.patchesDir);
	if (liveSync !== null) {
		ctx.out.info(`sync in progress: ${liveSync.id}, conflicts: ${liveSync.conflicts.length}`);
	}

	// 1. The branch, how far it is from being up to date, and the tree commits
	// that are not in patchset yet (PROP-008 ##TREE-COMMITS-ARE-WORK). While
	// such commits exist they are the question to answer: the reload move is
	// exactly what would destroy them, so the reload line stays silent and the
	// commits are reported instead.
	const mark = readTreeMark(tree);
	const conditions = fastPathConditions({
		treeDir: tree,
		branch,
		cache: readTreeCache(ctx.patchesDir, treeId(tree)),
		mark,
		pinSha: config.pin.sha,
		deltaFingerprint: deltaFingerprint(ctx.patchesDir, config.pin.sha)
	});
	const met = conditions.filter((condition) => condition.ok).length;
	const upToDate = met === conditions.length;
	const tip = revParse(tree, `refs/heads/${branch}`);
	const treeCommits = foreignCommits(tree, config.pin.sha, branch);
	ctx.out.info(`branch ${branch}: ${tip === null ? 'not created yet' : tip.slice(0, 8)}`);
	if (treeCommits.commits.length > 0) {
		ctx.out.info(`tree commits not in patchset: ${treeCommits.commits.length}`);
		for (const commit of treeCommits.commits.slice(0, LIST_LIMIT)) {
			ctx.out.info(`  ${commit.sha.slice(0, 8)} ${commit.subject}`);
		}
		if (treeCommits.commits.length > LIST_LIMIT) {
			ctx.out.info(`  ... and ${treeCommits.commits.length - LIST_LIMIT} more`);
		}
	} else {
		ctx.out.info(
			upToDate
				? `branch up to date (${met}/${conditions.length} conditions)`
				: `reload needed (${met}/${conditions.length} conditions): ${firstUnmet(conditions)}`
		);
	}

	// 1b. The other side of the same question: what the tree was loaded from,
	// and whether the delta moved under it since (PROP-008 ##LINEAGE-CHECK,
	// ##PATCHSET-MOVED-RULE). This is the data the manual merge recipe of
	// CK-E-PATCHSET-MOVED works from, so it belongs in the report even while
	// the tree itself is clean.
	const loaded = loadedFrom({ treeDir: tree, base: treeCommits.base, pinSha: config.pin.sha, mark });
	ctx.out.info(`loaded from patchset commit: ${loadedFromLabel(loaded)}`);
	const movedArtifacts = movedArtifactsOf(
		classifyTargets({
			patchesDir: ctx.patchesDir,
			treeDir: tree,
			pinSha: config.pin.sha,
			base: treeCommits.base,
			mark,
			ownDirName: config.ownDirName,
			commits: treeCommits.commits
		})
	);
	if (movedArtifacts.length > 0) {
		ctx.out.info(`patchset moved since load: ${movedArtifacts.length} artifact(s)`);
		for (const path of movedArtifacts.slice(0, LIST_LIMIT)) {
			ctx.out.info(`  ${path}`);
		}
		if (movedArtifacts.length > LIST_LIMIT) {
			ctx.out.info(`  ... and ${movedArtifacts.length - LIST_LIMIT} more`);
		}
	}

	// 2. Own code, per file and per side (PROP-008 ##PATCHSET-SIDE-EDIT-RULE).
	const own = classifyOwn(ctx.patchesDir, tree, config.ownDirName, mark?.ownFiles ?? null).filter((entry) => entry.kind !== 'same');
	reportOwn(ctx.out, own, config.ownDirName);

	// 3. Upstream files: what git sees outside the own directory, and whether
	// the markers of those files are still valid.
	const upstream = upstreamFiles(tree, config.ownDirName, conventions);
	const blocks = upstream.reduce((sum, file) => sum + file.blocks, 0);
	const markerErrors = upstream.reduce((sum, file) => sum + file.markerErrors, 0);
	ctx.out.info(`upstream files: ${upstream.length} changed, ${blocks} marker block(s) in them, ${markerErrors} marker error(s)`);
	for (const file of upstream.slice(0, LIST_LIMIT)) {
		ctx.out.info(`  ${file.status} ${file.path}`);
	}
	if (upstream.length > LIST_LIMIT) {
		ctx.out.info(`  ... and ${upstream.length - LIST_LIMIT} more`);
	}

	// 4. The other direction of truth: delta/ edited in patchset and not committed.
	const uncommitted = uncommittedDelta(ctx.patchesDir);
	const treeClean = upstream.length === 0 && own.length === 0;
	if (uncommitted.length > 0 && treeClean) {
		ctx.out.warn(
			`${uncommitted.length} path(s) under delta/ are modified in patchset and not committed while the fork tree is clean; ` +
				'the direction of truth is patchset: run codkit load to put them into the tree'
		);
	}

	// 5. Drafts left by `marker new` that no save has turned into a patch yet.
	const pending = listPendingHeaders(ctx.patchesDir);
	if (pending.length > 0) {
		ctx.out.info(`pending patch header(s): ${pending.length} (from codkit marker new)`);
	}

	const unextracted = upstream.length + own.filter((entry) => entry.kind !== 'patchset-edited').length + treeCommits.commits.length;
	ctx.out.setData({
		pin: pinData(config),
		syncInProgress: liveSync === null ? null : { id: liveSync.id, conflicts: liveSync.conflicts.length, startedAt: liveSync.startedAt },
		branch: { name: branch, tip, upToDate, conditionsMet: met, conditionsTotal: conditions.length, conditions: conditionsData(conditions) },
		treeCommits: {
			base: treeCommits.base,
			count: treeCommits.commits.length,
			commits: treeCommits.commits.map((commit) => ({ sha: commit.sha, subject: commit.subject }))
		},
		loadedFrom: loaded.kind === 'sha' ? loaded.sha : loadedFromLabel(loaded),
		patchsetMoved: { count: movedArtifacts.length, artifacts: [...movedArtifacts] },
		own: ownData(own),
		upstream: {
			changed: upstream.length,
			markerBlocks: blocks,
			markerErrors,
			files: upstream.map((file) => ({ path: file.path, status: file.status, blocks: file.blocks, markerErrors: file.markerErrors }))
		},
		patchset: { uncommittedDelta: [...uncommitted] },
		pendingHeaders: pending.map((entry) => entry.header.id)
	});

	if (unextracted > 0) {
		ctx.out.info('run codkit save to extract the changes of the fork tree into patchset');
	}
	return unextracted > 0 || markerErrors > 0 ? EXIT_CHECK_FAILED : EXIT_OK;
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: status needs the pin and the delta of this repository',
			'run status from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

function pinData(config: CodkitConfig): JsonValue {
	return { tag: config.pin.tag, sha: config.pin.sha, date: config.pin.date };
}

function conditionsData(conditions: readonly { id: string; ok: boolean; reason: string }[]): JsonValue {
	return conditions.map((condition) => ({ id: condition.id, ok: condition.ok, reason: condition.reason }));
}

function firstUnmet(conditions: readonly { ok: boolean; reason: string }[]): string {
	return conditions.find((condition) => !condition.ok)?.reason ?? '';
}

function reportOwn(out: Output, own: readonly OwnSideClass[], ownDirName: string): void {
	const counts = countKinds(own);
	out.info(
		`own code: ${own.length} changed file(s) - ${counts['tree-edited']} in the tree, ${counts['patchset-edited']} in patchset, ` +
			`${counts['both-edited']} on both sides, ${counts['unknown']} undecidable`
	);
	const prefix = ownTargetRelativeDir(ownDirName);
	for (const entry of own.slice(0, LIST_LIMIT)) {
		out.info(`  ${entry.kind} ${prefix}/${entry.relative}`);
	}
	if (own.length > LIST_LIMIT) {
		out.info(`  ... and ${own.length - LIST_LIMIT} more`);
	}
}

function ownData(own: readonly OwnSideClass[]): JsonValue {
	const counts = countKinds(own);
	return {
		changed: own.length,
		treeEdited: counts['tree-edited'],
		patchsetEdited: counts['patchset-edited'],
		bothEdited: counts['both-edited'],
		unknown: counts['unknown'],
		files: own.map((entry) => ({ path: entry.relative, kind: entry.kind }))
	};
}

function countKinds(own: readonly OwnSideClass[]): Record<OwnSideKind, number> {
	const counts: Record<OwnSideKind, number> = { same: 0, 'patchset-edited': 0, 'tree-edited': 0, 'both-edited': 0, unknown: 0 };
	for (const entry of own) {
		counts[entry.kind] += 1;
	}
	return counts;
}

/** Changed upstream files, with the marker verdict of each readable one. */
function upstreamFiles(treeDir: string, ownDirName: string, conventions: Conventions): readonly UpstreamFile[] {
	const status = runGit({ args: ['status', '--porcelain', '-z'], cwd: treeDir });
	if (status.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`git status failed in ${treeDir}: ${status.stderr.trim()}`,
			'check that the fork tree is a healthy git work tree'
		);
	}
	const ownPrefix = `${ownTargetRelativeDir(ownDirName)}/`;
	const files: UpstreamFile[] = [];
	for (const entry of porcelainZEntries(status.stdout)) {
		if (entry.path.startsWith(ownPrefix)) {
			continue;
		}
		const absolute = join(treeDir, ...entry.path.split('/'));
		// A deleted file has nothing to parse (and `save` refuses it anyway,
		// CK-E-DELETES-UPSTREAM-FILE); a file whose extension has no marker form
		// is a blind zone by construction (PROP-004 ##MR-BLIND-ZONES), not a file
		// with broken markers.
		if (!existsSync(absolute) || markerFormFor(extname(entry.path), conventions) === null) {
			files.push({ path: entry.path, status: entry.status, blocks: 0, markerErrors: 0 });
			continue;
		}
		const parsed = parseMarkers(readFileSync(absolute), extname(entry.path), conventions, entry.path);
		files.push({ path: entry.path, status: entry.status, blocks: parsed.blocks.length, markerErrors: parsed.errors.length });
	}
	return files;
}

/** Paths under delta/ that patchset carries as uncommitted work. */
function uncommittedDelta(patchesDir: string): readonly string[] {
	const status = runGit({ args: ['status', '--porcelain', '-z', '--', 'delta'], cwd: patchesDir });
	if (status.status !== 0) {
		return [];
	}
	return porcelainZEntries(status.stdout).map((entry) => entry.path);
}

export const statusCommand: CommandDefinition = {
	name: 'status',
	summary: 'show the pin, the branch, and what is not extracted into patchset yet',
	configMode: 'load',
	maxArgs: 0,
	run
};
