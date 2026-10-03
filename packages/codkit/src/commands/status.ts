/** @scope spec://codkit/modules/codkit/PROP-007#root */
import { pinKey, pinData as serializePinData } from '../lib/pinIdentity.ts';
// codkit status - what is in the tree, what is in patchset, and what is not in
// both. Contract: PROP-007 sec. 6 (##CMD-STATUS).
//
// Read-only by construction and lock-free on purpose: `status` is the command a
// developer runs *because* something looks wrong, including while another codkit
// command holds the tree, so it must never wait for a lock and never write.
//
// Exit code 1 is not a failure of the command; it means "there is unextracted
// work or an invalid marker", which is what makes `status` usable in a script.

import { declaredDiscipline } from '../lib/discipline.ts';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, forkResolution, requireProjectType } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { loadLocalConfig } from '../lib/configFile.ts';
import { inputRepositoryState } from '../lib/inputsRepository.ts';
import { inspectInputCopies } from '../lib/inputsTree.ts';
import { loadConventions } from '../lib/conventionsFile.ts';
import type { Conventions } from '../lib/conventionsFile.ts';
import { expandCollapsedUntracked, porcelainZEntries } from '../lib/driftGuard.ts';
import { deltaFingerprint, treeId } from '../lib/fingerprint.ts';
import { runGit } from '../lib/gitx.ts';
import type { JsonValue, Output } from '../lib/jsonOut.ts';
import { markerFormFor, parseMarkers } from '../lib/markers.ts';
import { ckError } from '../lib/messages.ts';
import {
	compareOwnExtensions,
	extensionsTreeDir,
	materializerOf,
	ownExtensionTreePrefixes,
	pinShipsExtension,
	strandedMaterializations
} from '../lib/layers/ownExtensions.ts';
import type { Materializer } from '../lib/layers/ownExtensions.ts';
import type { OwnExtension } from '../lib/layers/ownManifest.ts';
import { loadOwnManifest } from '../lib/layers/ownManifest.ts';
import { loadOverlays } from '../lib/layers/overlay.ts';
import { classifyAllOwn, ownMarkFilesOf } from '../lib/ownSides.ts';
import { ownedRootsOf, ownedTreePrefixes } from '../lib/ownedRoots.ts';
import type { OwnedRoot } from '../lib/ownedRoots.ts';
import type { OwnSideClass, OwnSideKind } from '../lib/ownSides.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { listPendingHeaders } from '../lib/pendingHeader.ts';
import { matchesTreePattern } from '../lib/packagePaths.ts';
import { overlayMaterializationClassifier, overlayVarContext, pinCommitDate, patchSetCommitId } from '../lib/syncEngine.ts';
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
	ctx.out.info(`pin: ${pinKey(config.pin)}@${config.pin.sha.slice(0, 8)} (${config.pin.date})`);

	// Read-only: the write probe of ##ID-CHECK-WRITE is not part of this command.
	const identity = checkTree(resolution, config, { mode: 'read', type: requireProjectType(ctx) });
	if (identity.fatal !== null) {
		ctx.out.addError(identity.fatal.toPayload());
		ctx.out.setData({ pin: pinData(config), tree: 'unusable' });
		return EXIT_ENVIRONMENT;
	}

	const tree = resolution.path;
	const conventions = loadConventions(requireProjectType(ctx), ctx.patchesDir);
	const branch = `${config.generatedBranchPrefix}${pinKey(config.pin)}`;

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
		deltaFingerprint: deltaFingerprint(ctx.patchesDir, config.pin.sha, declaredDiscipline(config))
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
	const roots = ownedRootsOf(requireProjectType(ctx), config.typeConfig, { treeDir: tree, pinSha: config.pin.sha });
	const loaded = loadedFrom({ treeDir: tree, base: treeCommits.base, pinSha: config.pin.sha, mark });
	ctx.out.info(`loaded from patchset commit: ${loadedFromLabel(loaded)}`);
	const movedArtifacts = movedArtifactsOf(
		classifyTargets({
			patchesDir: ctx.patchesDir,
			treeDir: tree,
			pinSha: config.pin.sha,
			type: requireProjectType(ctx),
			base: treeCommits.base,
			mark,
			roots,
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
	const own = classifyAllOwn(ctx.patchesDir, tree, roots, (owned) => ownMarkFilesOf(mark, owned)).filter((entry) => entry.kind !== 'same');
	reportOwn(ctx.out, own, roots);

	// 2a. Own extensions (modules/vscode/PROP-002 ##OWN-EXTENSION-UNIT): materialized under
	// the materialization directory of the type, they are own code in the upstream zone - drift is
	// reported here, and their paths never count as upstream dirt below.
	//
	// The third count is the one nobody owns any more (##OWN-EXTENSION-STRANDED):
	// a directory `load` stopped mirroring when its record went away and no
	// command but `load --fresh` removes. The line is printed even when all
	// three counts are zero, like the own-code line above it: "no stranded
	// materialization" is an answer, and silence would not be one.
	const materializer = materializerOf(requireProjectType(ctx));
	const declared = materializer === null ? [] : declaredExtensionsOf(ctx.patchesDir);
	const extensionDrift = materializer === null ? [] : compareOwnExtensions(materializer, ctx.patchesDir, tree, declared);
	const stranded =
		materializer === null
			? []
			: strandedMaterializations(materializer, untrackedUnderExtensions(materializer, tree), declared, (name) =>
					pinShipsExtension(materializer, tree, config.pin.sha, name)
				);
	ctx.out.info(
		`own extensions: ${declared.length} declared, ${extensionDrift.length} path(s) differ between tree and patchset, ` +
			`${stranded.length} stranded materialization(s)`
	);
	for (const entry of extensionDrift.slice(0, LIST_LIMIT)) {
		ctx.out.info(`  ${entry.kind.padEnd(13)} ${materializer?.deltaRoot ?? ''}/${entry.relative}`);
	}
	for (const path of stranded.slice(0, LIST_LIMIT)) {
		ctx.out.info(`  ${path} - codkit load --fresh removes it`);
	}
	if (stranded.length > LIST_LIMIT) {
		ctx.out.info(`  ... and ${stranded.length - LIST_LIMIT} more`);
	}

	// 2b. The inputs (PROP-007 ##CMD-STATUS-INPUTS): what the tree carries of
	// each, the edits in their directories, and where each repository stands
	// against its pin - a pin behind HEAD or a working tree with changes of its
	// own is what would make a release take other content than the tree shows.
	const inputs = reportInputs(ctx, config, tree);

	// 3. Upstream files: what git sees outside the own directory and outside
	// the declared own extensions, and whether the markers of those files are
	// still valid.
	const upstream = upstreamFiles(tree, roots, conventions, materializer === null ? [] : ownExtensionTreePrefixes(materializer, declared));
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
	const treeClean = upstream.length === 0 && own.length === 0 && extensionDrift.length === 0;
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

	// 3a. Of the changed upstream files, the ones that are not somebody's edit at
	// all but the packaging state codkit itself writes (PROP-005
	// ##OVERLAY-KNOWN-MATERIALIZATION). `save` has nothing to do with such a
	// file - it is an overlay target, not a patch target - and the command that
	// returns it is `load --fresh`, so the advice below has to say so.
	const materializedTargets = knownMaterializations(ctx, config, tree, upstream);
	// 3b. And the other half of the same question: the paths the packager of the
	// project type rewrites as a side effect of packaging (PROP-016
	// ##TYPE-PACKAGE-SCRATCH). `codkit package` returns them itself, so what is
	// left here is the residue of a run that died before its restore - and the
	// step that returns it gives up working-tree bytes, which `save` would
	// instead extract into the delta.
	const packagingScratch = upstream
		.map((file) => file.path)
		.filter(
			(path) =>
				!materializedTargets.includes(path) &&
				requireProjectType(ctx).build.packageScratch.some((pattern) => matchesTreePattern(path, pattern))
		);
	const unextracted =
		upstream.length + own.filter((entry) => entry.kind !== 'patchset-edited').length + extensionDrift.length + treeCommits.commits.length;
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
		ownExtensions: {
			declared: declared.length,
			differing: extensionDrift.map((entry) => ({ path: `${materializer?.deltaRoot ?? ''}/${entry.relative}`, kind: entry.kind })),
			stranded: [...stranded]
		},
		upstream: {
			changed: upstream.length,
			markerBlocks: blocks,
			markerErrors,
			files: upstream.map((file) => ({ path: file.path, status: file.status, blocks: file.blocks, markerErrors: file.markerErrors })),
			materializedOverlayTargets: [...materializedTargets],
			packagingScratch: [...packagingScratch]
		},
		patchset: { uncommittedDelta: [...uncommitted] },
		pendingHeaders: pending.map((entry) => entry.header.id),
		inputs: inputs.data
	});

	if (unextracted > 0) {
		ctx.out.info(nextStepLine(unextracted, upstream, materializedTargets, packagingScratch));
	}
	// A stranded materialization raises the code without joining `unextracted`:
	// there is something to remove, but `save` is not what removes it, and the
	// recipe stands beside the path itself.
	// An edit in the directory of an input raises the code too, on the same
	// terms: the recipe stands beside it, and it is not `save`.
	return unextracted > 0 || stranded.length > 0 || markerErrors > 0 || inputs.edits > 0 ? EXIT_CHECK_FAILED : EXIT_OK;
}

/**
 * One line per input: what the tree carries of it and the edits of its
 * directory; then a line for a pin behind the HEAD of its repository, for
 * changes its working tree has of its own, and for a repository that is not
 * there. A location codkit.local.json gives for an input codkit.json does not
 * declare is named as well.
 */
function reportInputs(ctx: CommandContext, config: CodkitConfig, tree: string): { readonly data: JsonValue; readonly edits: number } {
	const declared = config.inputs ?? [];
	const unmatched = unmatchedLocalInputs(ctx.patchesDir, declared);
	if (declared.length === 0 && unmatched.length === 0) return { data: [], edits: 0 };
	ctx.out.info(`inputs: ${declared.length} declared`);
	let edits = 0;
	const data: JsonValue[] = [];
	for (const copy of inspectInputCopies(tree, declared, (text) => ctx.out.warn(text))) {
		const { input, recorded } = copy;
		const delivered =
			recorded === null
				? 'not delivered yet'
				: `${Object.keys(recorded.files).length} file(s) from ${recorded.commit === null ? 'the working tree' : recorded.commit.slice(0, 12)}`;
		ctx.out.info(
			`  ${input.name} -> ${input.to}: ${delivered}${copy.edits.length === 0 ? '' : `, ${copy.edits.length} path(s) edited in the fork tree`}`
		);
		for (const edit of copy.edits.slice(0, LIST_LIMIT)) {
			ctx.out.info(`    ${edit.kind.padEnd(8)} ${input.to}/${edit.path} - belongs to ${input.repository}; codkit load puts the input back`);
		}
		edits += copy.edits.length;
		const state = inputRepositoryState(input);
		if (!state.present) ctx.out.warn(`input ${input.name}: the repository ${input.repository} is not there`);
		if (state.pin === 'behind') {
			ctx.out.warn(
				`input ${input.name}: the pin ${input.ref.slice(0, 12)} is ${state.behind ?? '?'} commit(s) behind HEAD ${state.head?.slice(0, 12) ?? ''} of its repository; codkit inputs pin ${input.name} moves it`
			);
		} else if (state.pin === 'diverged' || state.pin === 'missing-commit') {
			ctx.out.warn(
				`input ${input.name}: the pin ${input.ref.slice(0, 12)} is ${state.pin === 'diverged' ? 'not an ancestor of' : 'not a commit of the repository at'} HEAD ${state.head?.slice(0, 12) ?? ''}`
			);
		}
		if (state.uncommitted.length > 0) {
			ctx.out.warn(
				`input ${input.name}: the working tree of ${input.repository} has ${state.uncommitted.length} uncommitted change(s); the pin does not carry them`
			);
		}
		data.push({
			name: input.name,
			to: input.to,
			repository: input.repository,
			ref: input.ref,
			delivered: recorded === null ? null : { mode: recorded.mode, commit: recorded.commit, files: Object.keys(recorded.files).length },
			edits: copy.edits.map((edit) => ({ path: `${input.to}/${edit.path}`, kind: edit.kind })),
			repositoryState: {
				present: state.present,
				head: state.head,
				pin: state.pin,
				behind: state.behind,
				uncommitted: state.uncommitted.length
			}
		});
	}
	for (const name of unmatched) ctx.out.warn(`codkit.local.json names input ${name}, which codkit.json does not declare`);
	return { data, edits };
}

/** Names of codkit.local.json inputs that codkit.json does not declare; none when the file does not read. */
function unmatchedLocalInputs(patchesDir: string, declared: readonly { readonly name: string }[]): readonly string[] {
	try {
		const local = loadLocalConfig(patchesDir);
		return (local?.inputs ?? []).map((entry) => entry.name).filter((name) => !declared.some((input) => input.name === name));
	} catch {
		return [];
	}
}

/**
 * What to run about the work this tree carries.
 *
 * `save` is the answer for an edit somebody made, and the wrong answer twice
 * over. A materialized overlay target is not a patch target: `save` refuses it
 * or extracts nothing, and the state was written by `overlay apply` or by
 * `codkit package --keep-overlay`. A path the packager of the type rewrites in
 * passing is not somebody's work either - it is the residue of a packaging run
 * that did not reach its own restore - and extracting it would carry a bumped
 * version or a build flag into the delta, which is exactly what the first real
 * packaging run of a fork was advised to do.
 *
 * Both recipes stand only while such paths are the ONLY thing the tree carries,
 * and the residue's one names `--discard`, because those bytes are a real edit
 * of a tracked file and nothing but the discard gives them up. So the line says
 * which paths it is talking about and leaves `save` named for the case where
 * the reader, not the packager, wrote them.
 */
function nextStepLine(
	unextracted: number,
	upstream: readonly UpstreamFile[],
	materialized: readonly string[],
	scratch: readonly string[]
): string {
	const known = materialized.length + scratch.length;
	const onlyKnown = known > 0 && known === upstream.length && unextracted === upstream.length;
	if (!onlyKnown) {
		return 'run codkit save to extract the changes of the fork tree into patchset';
	}
	if (scratch.length === 0) {
		return (
			`${materialized.join(', ')} carries the exact overlay materialization codkit itself writes, so codkit save is not what returns it; ` +
			'run codkit load --fresh (codkit package --keep-overlay and codkit overlay apply are what leave this state behind)'
		);
	}
	return (
		`${scratch.join(', ')} is a path the packager of the project type rewrites while it packages, so codkit save would extract a build ` +
		'side effect into patchset; run codkit load --fresh --discard to give those bytes up (codkit package returns them itself unless the ' +
		'run was interrupted) - or codkit save, if you edited the file yourself'
	);
}

/**
 * Which of the changed upstream files are exactly the strict composition of the
 * configured overlays over the clean pin file - the bytes `overlay apply`
 * writes. Read-only and never fatal: `status` is the command somebody runs
 * *because* something looks wrong, so an unreadable pin or a broken overlay
 * artifact costs the hint and nothing else.
 */
function knownMaterializations(
	ctx: CommandContext,
	config: CodkitConfig,
	treeDir: string,
	upstream: readonly UpstreamFile[]
): readonly string[] {
	if (upstream.length === 0) {
		return [];
	}
	const found: string[] = [];
	try {
		const overlays = loadOverlays(ctx.patchesDir, ctx.type ?? undefined);
		if (overlays.length === 0) {
			return [];
		}
		const context = overlayVarContext(config, pinCommitDate(treeDir, config.pin.sha), patchSetCommitId(ctx.patchesDir));
		const classify = overlayMaterializationClassifier(overlays, treeDir, config.pin.sha, context, found);
		for (const file of upstream) {
			classify(file.path);
		}
	} catch {
		return [];
	}
	return found;
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
	return serializePinData(config.pin);
}

function conditionsData(conditions: readonly { id: string; ok: boolean; reason: string }[]): JsonValue {
	return conditions.map((condition) => ({ id: condition.id, ok: condition.ok, reason: condition.reason }));
}

function firstUnmet(conditions: readonly { ok: boolean; reason: string }[]): string {
	return conditions.find((condition) => !condition.ok)?.reason ?? '';
}

function reportOwn(out: Output, own: readonly OwnSideClass[], roots: readonly OwnedRoot[]): void {
	const counts = countKinds(own);
	out.info(
		`own code: ${own.length} changed file(s) - ${counts['tree-edited']} in the tree, ${counts['patchset-edited']} in patchset, ` +
			`${counts['both-edited']} on both sides, ${counts['unknown']} undecidable`
	);
	// The owned directories are named when there is more than one of them: the
	// daily line of a patch set that owns one directory does not change, and a
	// patch set that owns two says which one it is talking about
	// (PROP-016 ##TYPE-AREA-LAYOUT).
	if (roots.length > 1) {
		out.info(`owned directories: ${roots.map((owned) => `${owned.path} (${owned.role})`).join(', ')}`);
	}
	for (const entry of own.slice(0, LIST_LIMIT)) {
		out.info(`  ${entry.kind} ${entry.owned.path}/${entry.relative}`);
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
		files: own.map((entry) => ({ path: `${entry.owned.path}/${entry.relative}`, kind: entry.kind, role: entry.owned.role }))
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
function upstreamFiles(
	treeDir: string,
	roots: readonly OwnedRoot[],
	conventions: Conventions,
	ownedPrefixes: readonly string[]
): readonly UpstreamFile[] {
	const status = runGit({ args: ['status', '--porcelain', '-z'], cwd: treeDir });
	if (status.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`git status failed in ${treeDir}: ${status.stderr.trim()}`,
			'check that the fork tree is a healthy git work tree'
		);
	}
	const owned = [...ownedTreePrefixes(roots), ...ownedPrefixes];
	const files: UpstreamFile[] = [];
	for (const entry of expandCollapsedUntracked(treeDir, porcelainZEntries(status.stdout), ownedPrefixes)) {
		if (owned.some((prefix) => entry.path.startsWith(prefix))) {
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

/**
 * What git reports as untracked under the materialization root, in its own order.
 *
 * The pathspec keeps the walk to the one directory the question is about. A
 * wholly untracked materialization root is reported as that one directory and hides
 * the names inside it, so the same expansion the drift guard uses opens it up;
 * a tree whose materialization root carries tracked files gets the collapsed
 * per-unit entries and no second git call. A failing git status is
 * left silent here: the upstream half below runs the same command over the
 * whole tree and raises the real failure.
 */
function untrackedUnderExtensions(materializer: Materializer, treeDir: string): readonly string[] {
	const root = extensionsTreeDir(materializer);
	const status = runGit({ args: ['status', '--porcelain', '-z', '--', root], cwd: treeDir });
	if (status.status !== 0) {
		return [];
	}
	return expandCollapsedUntracked(treeDir, porcelainZEntries(status.stdout), [`${root}/`])
		.filter((entry) => entry.status === '??')
		.map((entry) => entry.path);
}

/** The own extensions the manifest declares; a manifest that does not parse declares none. */
function declaredExtensionsOf(patchesDir: string): readonly OwnExtension[] {
	try {
		return loadOwnManifest(patchesDir).extensions;
	} catch {
		return [];
	}
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
