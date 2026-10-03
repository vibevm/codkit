/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The save engine: take the work out of the fork tree and put it into patchset.
// The pseudocode of PROP-008 sec. 4 is normative and this file follows its order.
//
// `save` is the inverse of `load`, and the asymmetry between them is the point:
//
//   * `load` writes the tree from patchset, so it refuses to run over work that is
//     not in patchset yet (the drift guard);
//   * `save` reads the tree into patchset, so it must never lose what only patchset
//     has. Own code is mirrored back file by file, and only for the files the
//     *tree* moved (PROP-008 ##PATCHSET-SIDE-EDIT-RULE); a file both sides moved has
//     no direction of truth and stops the command.
//
// Every upstream file is validated before anything is written: markers parse,
// the target is allowed to carry a patch, no upstream file is deleted, no new
// file appears without being asked for, and every hunk lands inside a marker
// block. Only then are the artifacts written, and only when their bytes differ
// (##GEN-BYTE-COMPARE, so mtimes stay put and watch daemons stay asleep).

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative as relativePath } from 'node:path';
import { bytesEqual, encodeUtf8 } from './bytes.ts';
import { applyUnified } from './applyUnified.ts';
import type { CodkitConfig } from './configFile.ts';
import { loadConventions, matchesPatternList } from './conventionsFile.ts';
import type { Conventions } from './conventionsFile.ts';
import { gitLocal, runGit } from './gitx.ts';
import { checkHunksInsideMarkers, checkMarkerArtifactConsistency } from './hunksInMarkers.ts';
import { inputSaveRefusal } from './inputsTree.ts';
import type { Output } from './jsonOut.ts';
import { parseMarkers } from './markers.ts';
import { ckError, isCkError } from './messages.ts';
import type { CkError } from './messages.ts';
import {
	NO_OWN_EXTENSIONS,
	materializerOf,
	mirrorOwnExtensionsBack,
	ownExtensionTargetRelativeDir,
	ownExtensionTreePrefixes
} from './layers/ownExtensions.ts';
import type { Materializer, OwnExtensionSyncReport } from './layers/ownExtensions.ts';
import { loadResourceMap } from './layers/resource.ts';
import { loadOverlays } from './layers/overlay.ts';
import type { ResourceEntry, ResourceMap } from './layers/resource.ts';
import { mirrorAllOwnBack } from './ownCopy.ts';
import { classifyAllOwn, ownMarkFilesOf } from './ownSides.ts';
import { ownedRootsOf, ownedTreePrefixes } from './ownedRoots.ts';
import { isDeliveredByCodkit, loadOwnManifest } from './layers/ownManifest.ts';
import type { OwnExtension } from './layers/ownManifest.ts';
import type { OwnMirrorReport } from './ownCopy.ts';
import type { OwnSideClass } from './ownSides.ts';
import { encodePatchName, extractHeaderText, formatPatchHeader, parseCkpatch, serializeCkpatch } from './patchFormat.ts';
import type { ParsedPatch } from './patchFormat.ts';
import { regeneratePatch } from './patchGenerate.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import type { ForkDirResolution } from './paths.ts';
import { removePendingHeader } from './pendingHeader.ts';
import { listRebasePendingRecords, readRebasePending, rebaseHeaderMetadataSha256, removeRebasePending } from './rebaseOntoPinPending.ts';
import type { RebasePendingOverride } from './rebaseOntoPinPending.ts';
import { sha256 } from './renameFileState.ts';
import { advanceCompletedRebaseMove, assertRebasePendingMoveBinding } from './rebaseOntoPinMove.ts';
import { ArtifactStore, planStates, replayCommitMessage, writeStates } from './saveReplay.ts';
import type { PlannedCommitState, ReplayWrites } from './saveReplay.ts';
import { checkLineage, classifyTargets, loadedFrom, movedArtifactsOf, patchsetMovedError } from './syncMerge.ts';
import {
	PATCHES_DIR,
	bothSidesError,
	overlayMaterializationClassifier,
	overlayVarContext,
	patchSetCommitId,
	pinCommitDate,
	runSync,
	toPosix
} from './syncEngine.ts';
import type { SyncEngineOptions } from './syncEngine.ts';
import { refuseOverLiveSyncTransaction, SYNC_TRANSACTION_TRAILER } from './syncTransaction.ts';
import { readTreeMark } from './treeCache.ts';
import { CONSUMED_REF_PREFIX, foreignCommits, recordConsumedRef, treeHeadError } from './treeCommits.ts';
import type { TreeCommit, TreeCommits } from './treeCommits.ts';
import { bytesOf, changesSince } from './treeState.ts';
import type { StateChange, TreeState } from './treeState.ts';
import { checkTree, formatCheckLine } from './treeIdentity.ts';
import { assertGeneratedRefExclusive } from './worktrees.ts';
import type { ProjectType } from '@codkit/type-api';

export type SaveEngineOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	/** The project type of the patch set. */
	readonly type: ProjectType;
	readonly out: Output;
	/** Positional paths; empty means "every changed file". */
	readonly paths: readonly string[];
	/** `--allow-new-file`, repeatable (PROP-005 ##NEW-FILES-LIVE-IN-OWN). */
	readonly allowNewFile: readonly string[];
	readonly commit: boolean;
	readonly message: string | null;
	readonly verbose: boolean;
	/** `--squash`: fold the consumed tree commits into one patchset commit (D3). */
	readonly squash?: boolean;
	/**
	 * Only the cycle and rebase-onto-pin extraction paths set this (campaign
	 * decisions D12/D18): they move the delta themselves between the load and
	 * the extraction - the cycle regenerates and commits artifacts, the rebase
	 * replays them onto a new pin - so the moved state is theirs, not a
	 * foreign edit under the tree. An escape hatch for those named callers,
	 * never a general flag: the public `save` keeps the check armed.
	 */
	readonly skipPatchsetMovedCheck?: boolean;
	/** Cycle-only metadata, validated and incorporated before artifact writes and the load. */
	readonly patchHeaderOverrides?: readonly SavePatchHeaderOverride[];
	/** Internal addressed files that must be regenerated even when tree HEAD already has their bytes. */
	readonly forcedPaths?: readonly string[];
	/** Internal extraction-only mode: leave refs, index, and work tree where the caller put them. */
	readonly deferSync?: boolean;
	readonly rebasePendingCheckpoint?: (stage: 'artifact-written' | 'receipt-updated' | 'before-pending-remove', target: string) => void;
	/** Test-only observation point after each replayed state's patchset commit. */
	readonly replayCheckpoint?: (stage: 'state-committed', sha: string) => void;
	/** Test-only propagation of the two post-checkout load crash windows. */
	readonly syncCheckpoint?: SyncEngineOptions['checkpoint'];
	/**
	 * `--fresh` of the two-way sync (campaign decision D15): the rebuild at the
	 * end of the extraction honors it the way `load --fresh` does. The public
	 * `save` has no such flag and leaves it unset.
	 */
	readonly fresh?: boolean;
	/**
	 * Targets the patch set moved under the tree while the tree did not touch
	 * them (campaign decision D16): the two-way sync passes the `patchsetOnly`
	 * targets here, because its rebuild is *supposed* to apply their patchset
	 * state into the tree - the rewrite is explained, not foreign. The public
	 * `save` never passes any: for it, such a rewrite is the H1 defect.
	 */
	readonly explainedRewrites?: readonly string[];
	/**
	 * Only the two-way `codkit sync` sets this (decision D20): it owns the live
	 * transaction record and calls this engine for its save half, so the step 0
	 * CK-E-SYNC-IN-PROGRESS refusal must not fire against its own record.
	 */
	readonly skipSyncInProgressCheck?: boolean;
	/**
	 * The id of the sync transaction this extraction belongs to (decision D20):
	 * every patchset commit this engine then makes carries the
	 * `Codkit-Sync-Transaction` trailer, so a recovery recognizes the run's
	 * commits by content even where the record's list ends mid-crash.
	 */
	readonly syncTransactionId?: string;
};

export type SavePatchHeaderOverride = {
	readonly targetPath: string;
	readonly artifactPath: string;
	readonly artifactId: string;
	readonly cause: string;
	readonly pin: { readonly tag: string; readonly sha: string };
};

export type SaveStatus = 'unfit' | 'blocked' | 'nothing' | 'saved';

/** What happened to the artifact of one upstream file. */
export type SaveAction = 'created' | 'updated' | 'unchanged' | 'removed';

export type SaveFileReport = {
	readonly target: string;
	/** Artifact path relative to the patchset root. */
	readonly artifact: string;
	readonly action: SaveAction;
};

export type SaveResult = {
	readonly exitCode: number;
	readonly status: SaveStatus;
	readonly files: readonly SaveFileReport[];
	readonly own: OwnMirrorReport;
	readonly branch: string;
	readonly branchTip: string | null;
	/** PatchSet commit made by `--commit`, or null. */
	readonly commit: string | null;
	/** The consumed ref written for consumed tree commits, or null (##CONSUMED-REFS). */
	readonly consumedRef: string | null;
};

const NO_OWN: OwnMirrorReport = { copied: 0, removed: 0, kept: 0, total: 0 };

/** Identity used for a patchset commit when git has no configured user. */
const FALLBACK_COMMIT_NAME = 'codkit';
const FALLBACK_COMMIT_EMAIL = 'codkit@patchset.invalid';

/** One file's outcome after validation, before anything is written. */
export type PlannedFile = {
	readonly target: string;
	readonly artifact: string;
	readonly artifactAbsolute: string;
	readonly action: SaveAction;
	/** Bytes to write; null for 'unchanged' and 'removed'. */
	readonly bytes: Uint8Array | null;
	/** True when the draft header for this target must be dropped afterwards. */
	readonly consumesPending: boolean;
};

/**
 * One `save`. The caller holds the lock and owns the output envelope.
 */
export function runSave(options: SaveEngineOptions): SaveResult {
	const { patchesDir, resolution, config, out } = options;
	const tree = resolution.path;
	// The directories the delta owns (PROP-016 ##TYPE-AREA-LAYOUT): what git may
	// not judge, what the mirror extracts from, and what a positional path may
	// name as own code.
	const roots = ownedRootsOf(options.type, config.typeConfig, { treeDir: tree, pinSha: config.pin.sha });
	const branch = `${config.generatedBranchPrefix}${config.pin.tag}`;

	// 0. A live two-way sync leaves the tree and the patch set half-mutated;
	// extracting into that state is what this refusal prevents (PROP-008
	// ##SYNC-TWO-PASS, decision D20). Only the sync that owns the record passes
	// its save half through (skipSyncInProgressCheck).
	if (options.skipSyncInProgressCheck !== true && refuseOverLiveSyncTransaction(patchesDir, 'save', out)) {
		return result('blocked', 1, { branch });
	}

	// 1. Is this the tree we think it is, and may we write to it?
	const identity = checkTree(resolution, config, { mode: 'write', type: options.type });
	if (options.verbose) {
		for (const check of identity.checks) {
			out.diag(formatCheckLine(check));
		}
	}
	if (identity.fatal !== null) {
		out.addError(identity.fatal.toPayload());
		return result('unfit', 2, { branch });
	}

	// 1b. The shared-ref preflight precedes everything below (the D7 ruling of
	// 2026-09-06; PROP-008 §4): while a sibling worktree holds the generated
	// branch, nothing here may extract - the neighbour can move the shared ref
	// under the extraction.
	try {
		assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
	} catch (error) {
		if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
			out.addError(error.toPayload());
			return result('unfit', 2, { branch });
		}
		throw error;
	}

	// 1c. Commits made in the fork tree are work (##TREE-COMMITS-ARE-WORK), and
	// this run extracts them: the selection below reads the tree relative to
	// their base - the last applied tip - so a commit and an uncommitted edit
	// are the same kind of fact. A HEAD outside the generated branch while
	// carrying work still refuses first (D8): extracting from the wrong line
	// has no honest meaning.
	const treeState = foreignCommits(tree, config.pin.sha, branch);
	const head = treeHeadError(treeState, branch);
	if (head !== null) {
		out.addError(head.toPayload());
		return result('blocked', 1, { branch });
	}
	// The selection state of this run: the worktree, read as a diff against the
	// base the walk just named (D4).
	const selection: TreeState = { kind: 'worktree' };

	// 1d. The other side of the load: the patchset this tree was loaded from
	// must still be the one under it (##LINEAGE-CHECK, ##PATCHSET-MOVED-RULE).
	// Somebody editing an artifact, or switching the patchset branch, moves the
	// delta under a tree whose work belongs to the older state; extracting then
	// would rebuild the tree from artifacts it was never loaded from (the H1
	// defect, spike S0.7) or bury a patchset-side edit under an artifact
	// regenerated from the tree. Both refusals come before any write of this
	// run - own mirroring and the replay's pass 2 included - which is what
	// separates them from the CK-E-INTERNAL they replace.
	const mark = readTreeMark(tree, (text) => {
		out.warn(text);
	});
	if (options.skipPatchsetMovedCheck !== true) {
		// D17 first: the lineage is a question about commits, answered without
		// the mark's byte map and independent of it.
		const loaded = loadedFrom({ treeDir: tree, base: treeState.base, pinSha: config.pin.sha, mark });
		if (loaded.kind === 'sha') {
			const lineage = checkLineage(patchesDir, loaded.sha);
			if (!lineage.ok) {
				out.addError(patchsetMovedError({ loaded, lineageHead: lineage.head, moved: [] }).toPayload());
				return result('blocked', 1, { branch });
			}
		} else if (loaded.kind === 'dirty' || loaded.kind === 'none') {
			// A state that cannot be named cannot be verified either; the tree's
			// work still belongs to it, so the run continues over the warning.
			out.warn(
				loaded.kind === 'dirty'
					? 'the tree was loaded from an uncommitted patchset state (dirty); save cannot verify the patchset lineage and proceeds'
					: 'the tree was loaded from a patchset without a HEAD (none); save cannot verify the patchset lineage and proceeds'
			);
		}
		// Then D16: the byte question, artifact by artifact against the mark.
		const classes = classifyTargets({
			patchesDir,
			treeDir: tree,
			pinSha: config.pin.sha,
			type: options.type,
			base: treeState.base,
			mark,
			roots,
			commits: treeState.commits
		});
		if (classes.unknown) {
			// R13: a mark without the artifact map cannot answer by bytes. A
			// matching fingerprint proves the delta did not move; a differing one
			// may be a foreign edit or codkit's own partial extraction (a scoped
			// save, an interrupted replay) - which a refusal would deadlock, since
			// the tree's work is exactly what the next save must extract - so the
			// run says what it cannot verify and stays on the old behaviour.
			if (!classes.fingerprintMatches) {
				out.warn(
					'the apply mark carries no delta artifact map, so save cannot verify whether the delta moved since the load; the next load that rebuilds the tree records the map'
				);
			}
		} else {
			const moved = movedArtifactsOf(classes);
			if (moved.length > 0) {
				out.addError(patchsetMovedError({ loaded, lineageHead: null, moved }).toPayload());
				return result('blocked', 1, { branch });
			}
		}
	}

	const conventions = loadConventions(options.type, patchesDir);
	// ##SAVE-UPDATES-A-CARRIED-RESOURCE: the delta's resource-file layer, read
	// once. A changed tree file the delta already carries as a resource is an
	// update of that copy, not a patch and not a refusal.
	const resources = loadResourceMap(patchesDir);
	// ##OWN-EXTENSION-UNIT: the tree roots the own-extension layer supplies. Like
	// the own directory they are never selected as upstream changes, and their
	// tree side is mirrored back into the delta instead.
	const declaredExtensions = loadOwnManifest(patchesDir).extensions;
	const materializer = materializerOf(options.type);
	const ownedPrefixes = [
		...ownedTreePrefixes(roots.slice(1)),
		...(materializer === null ? [] : ownExtensionTreePrefixes(materializer, declaredExtensions))
	];
	const entryModuleIds = loadEntryModuleIds(patchesDir, conventions);
	const knownOverlayTargets: string[] = [];
	const isKnownOverlayMaterialization = overlayMaterializationClassifier(
		loadOverlays(patchesDir),
		tree,
		config.pin.sha,
		overlayVarContext(config, pinCommitDate(tree, config.pin.sha), patchSetCommitId(patchesDir)),
		knownOverlayTargets
	);
	const headerOverrides = validateHeaderOverrides(options);
	// Paths on the command line name files of the tree; they are read the same
	// way whether they were typed relative, absolute or with a trailing slash.
	const filters = normalizeFilters(options.paths, tree);
	const allowNewFile = normalizeFilters(options.allowNewFile, tree);
	// PROP-007 ##INPUTS-EDITS: the directory of an input belongs to another
	// repository. An edit there is never extracted into the patch set and never
	// dropped without a word: save refuses it, naming where it belongs, before
	// anything is written - and so it refuses a path that names such a directory.
	const inputRefusal = inputSaveRefusal(tree, config.inputs ?? [], filters, (text) => out.warn(text));
	if (inputRefusal !== null) {
		for (const line of inputRefusal.lines) out.info(`  ${line}`);
		out.addError({ code: 'DIRTY-TREE', message: inputRefusal.message, hint: inputRefusal.hint });
		return result('blocked', 1, { branch });
	}
	const forcedPaths = [
		...new Set([...(options.forcedPaths ?? []), ...listRebasePendingRecords(patchesDir).map((entry) => entry.targetPath)])
	];
	if (headerOverrides.size > 0) {
		const addressed = new Set(
			changesSince(tree, treeState.base, selection, roots, forcedPaths, ownedPrefixes)
				.filter((entry) => matchesFilters(entry.path, filters))
				.map((entry) => entry.path)
		);
		const unused = [...headerOverrides.keys()].filter((target) => !addressed.has(target));
		if (unused.length > 0)
			throw ckError('CONFIG', `cycle patch header override target is not an addressed dirty file: ${unused.join(', ')}`);
	}

	// A full save over tree commits plans every state before writing anything
	// (D5, ##SAVE-REPLAYS-TREE-COMMITS). Scoped saves and the internal cycle and
	// rebase extractions keep the direct single-state path: the first cannot
	// rebuild the branch over commits it did not take, and the second owns its
	// own commit discipline (##SAVE-SCOPED-BRANCH-RULE, campaign decision D12).
	const replayEligible = treeState.commits.length > 0 && filters.length === 0 && headerOverrides.size === 0 && options.deferSync !== true;
	const squashing = options.squash === true;
	if (squashing && treeState.commits.length === 0) {
		out.info('--squash: no tree commits in the fork tree to fold');
	}

	// 2. Own code: tree -> patchset, file by file, and only where the tree moved.
	// The classification and its refusal stay first; the mirror itself is a
	// write, so in replay mode it waits for pass 2 (D5), after every state has
	// been validated - a refusal must leave patchset without new commits *and*
	// without new own bytes. The mark itself was read at 1d, before the
	// moved-check needed it.
	const classes = classifyAllOwn(patchesDir, tree, roots, (owned) => ownMarkFilesOf(mark, owned)).filter((entry) => entry.kind !== 'same');
	// ##RT-SAVE-REFUSES-DELIVERED-EDITS: a file codkit delivered is not the
	// product's to edit, and `save` extracts nothing at all over such an edit -
	// not the delivered file and not the rest, so the refusal leaves one state to
	// reason about instead of a half-extracted tree.
	// `patchset-edited` is excluded on purpose: there the tree still matches the
	// mark and the delta moved ahead, which is exactly what `runtime load
	// --upgrade` does - codkit updating what it delivered, not the product
	// editing it. The next `codkit load` carries the new bytes into the tree.
	const deliveredEdits = classes.filter(
		(entry) =>
			entry.tree !== null && entry.tree !== entry.patchset && entry.kind !== 'patchset-edited' && isDeliveredByCodkit(entry.relative)
	);
	if (deliveredEdits.length > 0) {
		const paths = deliveredEdits.map((entry) => `${entry.owned.path}/${entry.relative}`);
		out.addError(
			ckError(
				'DELIVERED-EDIT',
				`${paths.length} file(s) delivered by codkit were changed in the fork tree:\n  ${paths.join('\n  ')}`,
				'delivered by codkit; change it in codkit and run codkit runtime load --upgrade, then codkit load - nothing was extracted',
				paths[0]
			).toPayload()
		);
		return result('blocked', 1, { branch });
	}
	const conflict = classes.find((entry) => entry.kind === 'both-edited');
	if (conflict !== undefined) {
		out.addError(bothSidesError(conflict).toPayload());
		return result('blocked', 1, { branch });
	}
	const ownInScope = filterOwn(classes, filters);
	// An addressed save mirrors only the extensions its paths name, the way it
	// mirrors only the own files they name. An extension is mirrored as a whole
	// directory, so naming one file inside it names the extension.
	const extensionsInScope = filterOwnExtensions(materializer, declaredExtensions, filters);

	const store = new ArtifactStore(patchesDir);
	const planFor = (entry: StateChange, state: TreeState, planning: ArtifactStore): PlannedFile | null =>
		planFile(
			entry,
			state,
			planning,
			options,
			conventions,
			resources,
			allowNewFile,
			out,
			headerOverrides.get(entry.path),
			entryModuleIds,
			isKnownOverlayMaterialization
		);

	let own: OwnMirrorReport = NO_OWN;
	let ownExtensions: OwnExtensionSyncReport = NO_OWN_EXTENSIONS;
	let planned: readonly PlannedFile[] = [];
	let written = 0;
	let replayWrites: ReplayWrites | null = null;
	let leftOut = 0;
	let dirty: readonly StateChange[] = [];
	const errors: CkError[] = [];

	if (replayEligible) {
		// Pass 1: every state - each foreign commit, then the worktree remainder -
		// over one artifact store; a refusal names its state and blocks all writes.
		const replayPlan = planStates({
			patchesDir,
			type: options.type,
			tree,
			base: treeState.base,
			roots,
			forcedPaths,
			commits: treeState.commits,
			planFile: planFor
		});
		planned = replayPlan.worktreePlans;
		errors.push(...replayPlan.errors);
		if (replayPlan.skipped.length > 0) {
			out.info(`${replayPlan.skipped.length} tree commit(s) are already replayed into patchset; skipped`);
		}
		if (errors.length === 0 && !squashing) {
			// Pass 2: artifacts and one patchset commit per state, oldest first,
			// with the state's own subject, author and date (##SAVE-REPLAYS-TREE-COMMITS).
			replayWrites = writeStates({
				states: replayPlan.states,
				out,
				writeArtifacts: (statePlans) => commitArtifacts(patchesDir, tree, statePlans, out, options.rebasePendingCheckpoint),
				commitState: (state) => commitReplayState(patchesDir, state, out, options.syncTransactionId),
				...(options.replayCheckpoint === undefined ? {} : { checkpoint: options.replayCheckpoint })
			});
			written = replayWrites.written;
			// S_wt of pass 2: own mirrors only after every state is written and
			// committed (D5) - a refusal higher above never wrote any of it. The
			// worktree remainder writes below read a store that pass 2 has already
			// put on disk, so their 'unchanged' verdicts describe the real files.
			own = mirrorAllOwnBack(patchesDir, tree, roots, ownInScope);
			ownExtensions =
				materializer === null ? NO_OWN_EXTENSIONS : mirrorOwnExtensionsBack(materializer, patchesDir, tree, extensionsInScope);
			reportOwn(out, own);
			reportOwnExtensions(out, ownExtensions);
		}
	}

	// The direct write path: the plain save, and `--squash` after its states were
	// validated. Own first, then the one selection there is - the final state of
	// the worktree - planned against the DISK, not the store: `--squash` writes
	// no intermediate state, so what its final plan must name are disk-changing
	// actions ('updated' against the pre-save artifact, not 'unchanged' against
	// the store's copy of the last state).
	if (!replayEligible || (squashing && errors.length === 0)) {
		own = mirrorAllOwnBack(patchesDir, tree, roots, ownInScope);
		ownExtensions = materializer === null ? NO_OWN_EXTENSIONS : mirrorOwnExtensionsBack(materializer, patchesDir, tree, extensionsInScope);
		reportOwn(out, own);
		reportOwnExtensions(out, ownExtensions);
		// 3. Upstream files: everything the tree's final state holds outside the own
		// directory, relative to the last applied tip - not `git status`, which is
		// blind to everything a commit already carries (D4).
		const changed = changesSince(tree, treeState.base, selection, roots, forcedPaths, ownedPrefixes);
		dirty = changed.filter((entry) => matchesFilters(entry.path, filters));
		if (options.verbose) {
			out.diag(`changed upstream file(s): ${dirty.length === 0 ? 'none' : dirty.map((entry) => entry.path).join(', ')}`);
		}
		// An addressed save leaves the rest of the tree as it is - including the
		// branch, which may not be rebuilt while work outside the given paths is
		// still only in the tree: the rebuild rewrites every file that differs from
		// the new tip, and that work would be exactly what it overwrites.
		leftOut = changed.length - dirty.length + (classes.length - ownInScope.length);
		planned = [];
		for (const entry of dirty) {
			try {
				const plan = planFor(entry, selection, store);
				if (plan !== null) {
					planned = [...planned, plan];
				}
			} catch (error) {
				if (!isCkError(error)) {
					throw error;
				}
				errors.push(error);
			}
		}
	}

	// Nothing is written while a single file is still in doubt: a half-extracted
	// delta is worse than one the developer has to fix and re-run.
	if (errors.length > 0) {
		for (const error of errors) {
			out.addError(error.toPayload());
		}
		return result('blocked', 1, { branch, files: planned.map(toReport), own });
	}
	if (knownOverlayTargets.length > 0) {
		out.info(
			`save: ${[...new Set(knownOverlayTargets)].join(', ')} carries exact overlay materialization; rebuilding the development channel`
		);
	}

	// 4. Write the artifacts of the worktree remainder (replay already wrote the
	// states' artifacts in pass 2; --squash writes only this final state).
	written += commitArtifacts(patchesDir, tree, planned, out, options.rebasePendingCheckpoint);

	// Nothing moved in patchset *and* nothing is out of place in the tree: there is
	// no work to extract and no branch to rebuild. A tree that is dirty while
	// every artifact stays byte-identical is not this case - the branch is then
	// behind the artifacts and step 5 has to put it back on top of them. A tree
	// with commits but without file changes is not this case either: the commits
	// are work, and consuming them is exactly what this run is for.
	if (
		written === 0 &&
		own.copied === 0 &&
		own.removed === 0 &&
		ownExtensions.copied === 0 &&
		ownExtensions.removed === 0 &&
		dirty.length === 0 &&
		treeState.commits.length === 0
	) {
		out.info('nothing to save');
		return result('nothing', 0, { branch, files: planned.map(toReport), own });
	}

	// 5. Rebuild the generated branch by re-running the sync engine. Everything
	// the tree carries is in patchset now, so the guard has nothing left to protect
	// and the rebuild must not touch a single work-tree file (PROP-008 sec. 4).
	let branchTip: string | null = null;
	let consumed: readonly TreeCommit[] = [];
	let consumedRefOfRun: string | null = null;
	if (leftOut > 0) {
		out.warn(
			`${leftOut} changed path(s) are outside the paths given to save, so the generated branch is left where it is; ` +
				'run codkit save without paths to extract the rest and rebuild the branch'
		);
		if (treeState.commits.length > 0) {
			// ##SAVE-SCOPED-BRANCH-RULE: the unreplayed line keeps its commits
			// until a full save takes them.
			out.info(`${treeState.commits.length} tree commit(s) stay in the tree until a full save`);
		}
	} else if (options.deferSync === true) {
		out.info('saved addressed rebase artifacts without moving the generated branch');
	} else {
		// The rebuild is the destructive half of the run: HEAD moves onto the
		// branch and every commit above the old tip stops being reachable from
		// it. That is safe only over the exact set this run extracted - a commit
		// that appeared in between would be buried by the very rebuild that is
		// supposed to rescue it (D6), so the set is re-read and compared before
		// any ref or work-tree byte moves.
		assertCommitsHeld(treeState, foreignCommits(tree, config.pin.sha, branch));
		const rebuilt = runSync({
			patchesDir,
			resolution,
			config,
			type: options.type,
			out,
			fresh: options.fresh === true,
			dryRun: false,
			verbose: options.verbose,
			skipDriftGuard: true,
			skipSyncInProgressCheck: options.skipSyncInProgressCheck === true,
			...(options.syncCheckpoint === undefined ? {} : { checkpoint: options.syncCheckpoint })
		});
		if (rebuilt.exitCode !== 0) {
			return result(rebuilt.status === 'unfit' ? 'unfit' : 'blocked', rebuilt.exitCode, {
				branch,
				branchTip: rebuilt.branchTip,
				files: planned.map(toReport),
				own
			});
		}
		assertNothingMoved(rebuilt.changedPaths, rebuilt.nonPatchTargets, options.explainedRewrites ?? [], out);
		branchTip = rebuilt.branchTip;
		// The consumed commits stay reachable for diagnosis (##CONSUMED-REFS):
		// the ref is written after the rebuild, under the common-repository
		// lock, pointing at the tree's former HEAD.
		if (treeState.commits.length > 0) {
			consumedRefOfRun = recordConsumedRef(tree, treeState.head);
			const first = treeState.commits[0]?.sha.slice(0, 8) ?? treeState.head.slice(0, 8);
			const last = treeState.commits[treeState.commits.length - 1]?.sha.slice(0, 8) ?? first;
			out.info(`tree commits consumed: ${treeState.commits.length} (${first}..${last}); kept as ${consumedRefOfRun}`);
			consumed = treeState.commits;
		}
	}

	// 6. The patchset commits. Replay already made one per state in pass 2;
	// `--squash` folds everything this run extracted into the one commit of D3;
	// `--commit` keeps its ordinary meaning - the remainder's own commit, on top
	// of the replayed ones when both apply.
	let commitSha: string | null = null;
	if (replayWrites !== null) {
		commitSha = replayWrites.commits[replayWrites.commits.length - 1] ?? null;
		if (replayWrites.commits.length > 0) {
			out.info(`replayed ${replayWrites.commits.length} tree commit(s) into patchset history`);
		}
		if (options.commit) {
			commitSha = commitDelta(options, planned, own, out) ?? commitSha;
		}
	} else if (consumed.length > 0) {
		commitSha = commitTreeSquash(options, planned, own, consumed, out);
	} else if (options.commit) {
		commitSha = commitDelta(options, planned, own, out);
	}

	out.info(`saved ${planned.filter((plan) => plan.action !== 'unchanged').length} file(s)`);
	return result('saved', 0, {
		branch,
		branchTip,
		files: planned.map(toReport),
		own,
		commit: commitSha,
		consumedRef: consumedRefOfRun
	});
}

// ---------------------------------------------------------------------------
// Which files are in play
// ---------------------------------------------------------------------------

function loadEntryModuleIds(patchesDir: string, conventions: Conventions): readonly string[] {
	const directory = join(patchesDir, ...PATCHES_DIR.split('/'));
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith('.ckpatch'))
		.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
		.flatMap((name): readonly string[] => {
			const artifact = `${PATCHES_DIR}/${name}`;
			const patch = parseCkpatch(readFileSync(join(directory, name)), conventions, artifact);
			return patch.header.layer === 'entry-module' ? [patch.header.id] : [];
		});
}

/**
 * The D6 precondition: the foreign set this run is about to consume by rebuild
 * is the set it selected from. Anything else - a commit that landed after the
 * walk - means the rebuild would bury work it never extracted, and the refusal
 * comes while the tree still holds every byte of it.
 */
function assertCommitsHeld(selected: TreeCommits, current: TreeCommits): void {
	const held = new Set(current.commits.map((commit) => commit.sha));
	const same = selected.commits.length === current.commits.length && selected.commits.every((commit) => held.has(commit.sha));
	if (same) {
		return;
	}
	const appeared = current.commits.filter((commit) => !selected.commits.some((other) => other.sha === commit.sha));
	const named = appeared[0];
	throw ckError(
		'INTERNAL',
		`the fork tree changed during save: ${current.commits.length} commit(s) not in patchset now, ${selected.commits.length} when the extraction started` +
			(named === undefined ? '' : `; first difference: ${named.sha.slice(0, 8)} "${named.subject}"`),
		'nothing was rebuilt and nothing was consumed; re-run codkit save over the new state'
	);
}

/** Positional paths, as tree-relative POSIX paths. */
function normalizeFilters(paths: readonly string[], treeDir: string): readonly string[] {
	return paths.map((given) => {
		const absolute = isAbsolute(given) ? given : join(treeDir, given);
		const inside = relativePath(treeDir, absolute);
		const chosen = inside === '' || inside.startsWith('..') ? given : inside;
		return toPosix(chosen).replace(/^\.\//, '').replace(/\/+$/, '');
	});
}

function matchesFilters(path: string, filters: readonly string[]): boolean {
	if (filters.length === 0) {
		return true;
	}
	return filters.some((filter) => path === filter || path.startsWith(`${filter}/`));
}

/**
 * ##OWN-EXTENSION-UNIT: the extensions the positional paths reach. An extension
 * is mirrored whole, so a filter that names the directory, a path inside it, or
 * a directory above it all select the same extension.
 */
function filterOwnExtensions(
	materializer: Materializer | null,
	extensions: readonly OwnExtension[],
	filters: readonly string[]
): readonly OwnExtension[] {
	if (materializer === null) {
		return [];
	}
	if (filters.length === 0) {
		return extensions;
	}
	return extensions.filter((extension) => {
		const dir = ownExtensionTargetRelativeDir(materializer, extension.name);
		return filters.some((filter) => filter === dir || filter.startsWith(`${dir}/`) || dir.startsWith(`${filter}/`));
	});
}

/** Own divergences narrowed by the positional paths, which name tree paths. */
function filterOwn(classes: readonly OwnSideClass[], filters: readonly string[]): readonly OwnSideClass[] {
	if (filters.length === 0) {
		return classes;
	}
	return classes.filter((entry) => matchesFilters(`${entry.owned.path}/${entry.relative}`, filters));
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

/**
 * Validate one changed upstream file and compute the artifact it produces.
 * Throws the first diagnosed condition of that file; returns null when the file
 * has nothing to contribute (its patch stays exactly as it is on disk).
 */
function planFile(
	entry: StateChange,
	state: TreeState,
	store: ArtifactStore,
	options: SaveEngineOptions,
	conventions: Conventions,
	resources: ResourceMap | null,
	allowNewFile: readonly string[],
	out: Output,
	headerOverride: SavePatchHeaderOverride | undefined,
	entryModuleIds: readonly string[],
	isKnownOverlayMaterialization: (target: string) => boolean
): PlannedFile | null {
	const { patchesDir, config } = options;
	const tree = options.resolution.path;
	const target = entry.path;
	const artifactName = encodePatchName(target);
	const artifact = `${PATCHES_DIR}/${artifactName}`;
	const artifactAbsolute = join(patchesDir, ...PATCHES_DIR.split('/'), artifactName);

	if (isDeletion(entry.status)) {
		throw ckError(
			'DELETES-UPSTREAM-FILE',
			'was deleted from the fork tree; a patch never removes an upstream file',
			'restore the file and hide it from the product instead (PROP-005 sec. 8), then record the removal in delta/removed.json',
			target
		);
	}

	if (matchesPatternList(target, conventions.forbiddenPatchTargets)) {
		if (state.kind === 'worktree' && isKnownOverlayMaterialization(target)) {
			return null;
		}
		// ##SAVE-UPDATES-A-CARRIED-RESOURCE: a target the delta already owns
		// through the resource-file layer is not a target without an owner. The
		// file is regenerated in the tree - a lockfile the install rewrites is the
		// case this was measured on - and the delta carries the result as a
		// resource, so the extraction updates that copy. Nothing about the layer
		// changes: the target still reaches the tree by materialization, and the
		// only path that ever refuses is one no layer of the delta names.
		const carried = resources?.entries.find((resource) => resource.target === target);
		if (carried !== undefined) {
			return planCarriedResource(carried, target, bytesOf(tree, state, target), store, patchesDir);
		}
		throw ckError(
			'FORBIDDEN-TARGET',
			'is a forbidden patch target',
			`conventions.json forbids patching it (forbiddenPatchTargets: ${conventions.forbiddenPatchTargets.join(', ')}); ` +
				'revert the change in the tree',
			target
		);
	}

	// The artifact bytes come from the planning store: over the disk for an
	// ordinary save, over what the earlier states of a replay produced for the
	// later ones (##SAVE-REPLAYS-TREE-COMMITS).
	const existingBytes = store.read(artifact);
	const existing = existingBytes === null ? null : parseCkpatch(existingBytes, conventions, artifact);

	// Whether the file is new is decided by the pin, not by the index: a file an
	// earlier add-file patch introduced is tracked in the tree and still absent
	// from the pin, and it must keep producing an add-file patch.
	const pinBytes = bytesAtPin(tree, config.pin.sha, target);
	const isAddFile = pinBytes === null;
	if (isAddFile && !allowNewFile.includes(target) && existing?.isAddFile !== true) {
		throw ckError(
			'NEW-FILE-IN-UPSTREAM-ZONE',
			'is a new file in the upstream zone: the pin does not carry it',
			`new files belong to own code (delta/own/, materialized as ${config.typeConfig.ownRoot}/); ` +
				`if this one has to live at this exact path, say so: codkit save --allow-new-file ${target}`,
			target
		);
	}

	// The working bytes come from the selection state (D4): the worktree today,
	// a commit's blob the day Phase 4 replays one.
	const curBytes = bytesOf(tree, state, target);
	const ext = extname(target);

	// Markers of the working file: a block that is not closed, nested or
	// duplicated must be fixed by a human before any patch is generated.
	const markers = parseMarkers(curBytes, ext, conventions, target);
	const markerError = markers.errors[0];
	if (markerError !== undefined) {
		throw markerError;
	}

	const base = pinBytes ?? new Uint8Array(0);
	const missingArtifactPending = existing === null ? store.readRebasePending(target) : null;
	if (missingArtifactPending !== null && !isAddFile && bytesEqual(base, curBytes)) {
		validateHeaderOverride(missingArtifactPending, config);
		if (missingArtifactPending.artifactPath !== artifact || missingArtifactPending.targetPath !== target) {
			throw ckError('ARTIFACT-BROKEN', `${artifact}: removed conflict pending identity does not match addressed target`);
		}
		assertRebasePendingMoveBinding(patchesDir, tree, missingArtifactPending, true);
		return { target, artifact, artifactAbsolute, action: 'removed', bytes: null, consumesPending: true };
	}
	const header = headerFor(patchesDir, tree, state, store, target, artifact, existing, config, headerOverride);

	const regenerated = regeneratePatch({
		targetPath: target,
		pinBytes: base,
		pinExists: !isAddFile,
		curBytes,
		header: header.text,
		existingBytes,
		tmpDir: join(patchesDir, '.codkit', 'tmp')
	});

	if (regenerated.unchanged && regenerated.empty) {
		// The file is back at the pin: the artifact has nothing left to describe.
		if (existingBytes === null) {
			return null;
		}
		return { target, artifact, artifactAbsolute, action: 'removed', bytes: null, consumesPending: false };
	}
	const bytes = regenerated.unchanged ? (existingBytes ?? new Uint8Array(0)) : regenerated.bytes;

	checkPatchAgainstMarkers(bytes, base, curBytes, ext, conventions, artifact, isAddFile, out, entryModuleIds);

	if (regenerated.unchanged) {
		return { target, artifact, artifactAbsolute, action: 'unchanged', bytes: null, consumesPending: header.fromPending };
	}
	return {
		target,
		artifact,
		artifactAbsolute,
		action: existingBytes === null ? 'created' : 'updated',
		bytes,
		consumesPending: header.fromPending
	};
}

/** ` D`, `D `, `AD`, ...: the file is gone from the work tree or from the index. */
/**
 * The tree's bytes into the resource copy the delta carries for this target. The
 * source path is the map's own and was validated when the map was read, so this
 * writes inside `delta/resources/files/` and nowhere else.
 */
function planCarriedResource(
	resource: ResourceEntry,
	target: string,
	curBytes: Uint8Array,
	store: ArtifactStore,
	patchesDir: string
): PlannedFile {
	const artifact = resource.source;
	const existing = store.read(artifact);
	const unchanged = existing !== null && bytesEqual(existing, curBytes);
	return {
		target,
		artifact,
		artifactAbsolute: join(patchesDir, ...artifact.split('/')),
		action: unchanged ? 'unchanged' : 'updated',
		bytes: unchanged ? null : curBytes,
		consumesPending: false
	};
}

function isDeletion(status: string): boolean {
	return status.includes('D');
}

/** The file at the pin, or null when the pin does not carry it at all. */
function bytesAtPin(treeDir: string, pinSha: string, target: string): Uint8Array | null {
	const shown = runGit({ args: ['show', `${pinSha}:${toPosix(target)}`], cwd: treeDir });
	return shown.status === 0 ? encodeUtf8(shown.stdout) : null;
}

type ChosenHeader = { readonly text: string; readonly fromPending: boolean };

/**
 * ##GEN-HEADER-PRESERVED and ##PENDING-HEADER-MECHANISM: an existing artifact
 * keeps its header byte for byte, a new one takes it from the draft `marker new`
 * left behind, and a target with neither is a target nobody described yet.
 */
function headerFor(
	patchesDir: string,
	treeDir: string,
	state: TreeState,
	store: ArtifactStore,
	target: string,
	artifact: string,
	existing: ParsedPatch | null,
	config: CodkitConfig,
	override: SavePatchHeaderOverride | undefined
): ChosenHeader {
	const localOverride = override === undefined && existing !== null ? store.readRebasePending(target) : null;
	if (localOverride !== null && existing !== null) {
		const advanced = sha256(serializeCkpatch(existing)) !== localOverride.artifactSha256;
		assertRebasePendingMoveBinding(patchesDir, treeDir, localOverride, advanced);
		if (advanced) assertAdvancedPendingArtifact(treeDir, state, target, existing, localOverride, config);
	}
	const selectedOverride = override ?? localOverride ?? undefined;
	if (selectedOverride !== undefined) {
		if (existing === null) {
			throw ckError('ARTIFACT-BROKEN', `${artifact}: cycle header override requires the existing patch artifact`);
		}
		validateHeaderOverride(selectedOverride, config);
		if (
			selectedOverride.artifactPath !== artifact ||
			selectedOverride.artifactId !== existing.header.id ||
			existing.targetPath !== target
		) {
			throw ckError('ARTIFACT-BROKEN', `${artifact}: cycle header override does not match the exact patch identity`);
		}
		return {
			text: formatPatchHeader({
				id: existing.header.id,
				...(existing.header.layerExplicit ? { layer: existing.header.layer } : {}),
				type: existing.header.type,
				category: existing.header.category,
				owner: existing.header.owner,
				reason: existing.header.reason,
				link: existing.header.link,
				cause: selectedOverride.cause,
				pin: `${selectedOverride.pin.tag}@${selectedOverride.pin.sha}`,
				contractTests: existing.header.contractTests
			}),
			fromPending: localOverride !== null
		};
	}
	if (existing !== null) {
		return { text: extractHeaderText(existing), fromPending: false };
	}
	const pending = store.readPendingHeader(target);
	if (pending === null) {
		throw ckError(
			'HEADER-MISSING',
			'changed, but no patch describes it and no pending header says what a new one would carry',
			`run codkit marker new ${target} --id CK-<subsystem>-<NNN> --type <type> --owner <owner> --reason <why> first`,
			target
		);
	}
	return {
		text: formatPatchHeader({
			id: pending.id,
			layer: pending.layer,
			type: pending.type,
			category: pending.category,
			owner: pending.owner,
			reason: pending.reason,
			link: pending.link,
			cause: 'none',
			pin: `${config.pin.tag}@${config.pin.sha}`,
			contractTests: []
		}),
		fromPending: true
	};
}

function validateHeaderOverrides(options: SaveEngineOptions): ReadonlyMap<string, SavePatchHeaderOverride> {
	const overrides = new Map<string, SavePatchHeaderOverride>();
	for (const override of options.patchHeaderOverrides ?? []) {
		const problem = repoRelativePathProblem(override.targetPath);
		const expectedArtifact = `${PATCHES_DIR}/${encodePatchName(override.targetPath)}`;
		if (problem !== null || override.artifactPath !== expectedArtifact) {
			throw ckError('CONFIG', `invalid cycle patch header override target ${JSON.stringify(override.targetPath)}`);
		}
		validateHeaderOverride(override, options.config);
		if (override.artifactId.trim() === '' || /[\r\n]/.test(override.artifactId)) {
			throw ckError('CONFIG', `${override.artifactPath}: cycle patch header override has an invalid artifact id`);
		}
		if (overrides.has(override.targetPath)) throw ckError('CONFIG', `duplicate cycle patch header override for ${override.targetPath}`);
		overrides.set(override.targetPath, override);
	}
	return overrides;
}

function assertAdvancedPendingArtifact(
	treeDir: string,
	state: TreeState,
	target: string,
	patch: ParsedPatch,
	pending: RebasePendingOverride,
	config: CodkitConfig
): void {
	if (
		rebaseHeaderMetadataSha256(patch.header) !== pending.headerMetadataSha256 ||
		patch.header.cause !== pending.cause ||
		patch.header.pin !== `${pending.pin.tag}@${pending.pin.sha}`
	) {
		throw ckError('ARTIFACT-BROKEN', `${pending.artifactPath}: transitioned conflict artifact header is not exact`);
	}
	const pinBytes = bytesAtPin(treeDir, config.pin.sha, target);
	if ((pinBytes === null) !== patch.isAddFile) {
		throw ckError('ARTIFACT-BROKEN', `${pending.artifactPath}: transitioned conflict artifact has wrong add-file semantics`);
	}
	const applied = applyUnified(pinBytes ?? new Uint8Array(0), patch);
	// The resolved state is read through the selection's byte provider (D4), the
	// same one the patch was planned from: for a commit state of the replay this
	// is the commit's blob, and the two reads must not diverge.
	const current = bytesOf(treeDir, state, target);
	if (!bytesEqual(applied, current)) {
		throw ckError('ARTIFACT-BROKEN', `${pending.artifactPath}: transitioned conflict artifact body is not the resolved tree state`);
	}
}

function validateHeaderOverride(override: SavePatchHeaderOverride, config: CodkitConfig): void {
	if (override.cause !== 'none' && !/^[0-9a-f]{40}$/.test(override.cause)) {
		throw ckError('CONFIG', `invalid cycle patch cause ${JSON.stringify(override.cause)}`);
	}
	if (override.pin.tag !== config.pin.tag || override.pin.sha !== config.pin.sha) {
		throw ckError('CONFIG', `${override.artifactPath}: cycle patch header override does not match the configured pin`);
	}
}

/**
 * "Every hunk inside a marker" (PROP-006 sec. 5), run before the artifact is
 * written so that a violation leaves the previous patch untouched.
 *
 * An add-file patch is checked differently on purpose: every line of a new file
 * is an added line, and the rule that protects upstream lines has nothing to
 * protect there (PROP-005 ##NEW-FILES-LIVE-IN-OWN - the whole file is ours). What
 * still holds is the marker/artifact correspondence: the block that carries the
 * id of the patch has to exist.
 */
function checkPatchAgainstMarkers(
	bytes: Uint8Array,
	pinBytes: Uint8Array,
	curBytes: Uint8Array,
	ext: string,
	conventions: Conventions,
	artifact: string,
	isAddFile: boolean,
	out: Output,
	entryModuleIds: readonly string[]
): void {
	const parsed = parseCkpatch(bytes, conventions, artifact);
	const allowIds = parsed.header.layer === 'entry-module' ? entryModuleIds : [];
	if (isAddFile) {
		// The target state of an add-file patch is the working file itself.
		const markers = parseMarkers(curBytes, ext, conventions, parsed.targetPath);
		const errors = [...markers.errors, ...checkMarkerArtifactConsistency(markers.blocks, parsed.header.id, allowIds, artifact)];
		const first = errors[0];
		if (first !== undefined) {
			throw first;
		}
		return;
	}
	const outcome = checkHunksInsideMarkers(parsed, pinBytes, ext, conventions, { patchFile: artifact, allowIds });
	const first = outcome.errors[0];
	if (first !== undefined) {
		throw first;
	}
	for (const warning of outcome.warnings) {
		// A block that adds nothing but its own markers is legal and almost
		// always a half-finished edit, so it is said out loud (CK-W-EMPTY-BLOCK).
		out.warn(`${warning.file}: ${warning.message}`, warning.code);
	}
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write what the plan says and drop the drafts it consumed. Returns the count. */
export function commitArtifacts(
	patchesDir: string,
	treeDir: string,
	planned: readonly PlannedFile[],
	out: Output,
	checkpoint?: SaveEngineOptions['rebasePendingCheckpoint']
): number {
	let touched = 0;
	for (const plan of planned) {
		const rebasePending = readRebasePending(patchesDir, plan.target);
		if (plan.action === 'removed') {
			rmSync(plan.artifactAbsolute, { force: true });
			if (rebasePending !== null) {
				checkpoint?.('artifact-written', plan.target);
				advanceCompletedRebaseMove(patchesDir, treeDir, plan.target);
				checkpoint?.('receipt-updated', plan.target);
				checkpoint?.('before-pending-remove', plan.target);
			}
			removePendingHeader(patchesDir, plan.target);
			removeRebasePending(patchesDir, plan.target);
			out.info(`${plan.artifact}: removed, ${plan.target} is back at the pin`);
			touched += 1;
			continue;
		}
		if (plan.action === 'unchanged' || plan.bytes === null) {
			if (plan.consumesPending) {
				if (rebasePending !== null) {
					checkpoint?.('artifact-written', plan.target);
					advanceCompletedRebaseMove(patchesDir, treeDir, plan.target);
					checkpoint?.('receipt-updated', plan.target);
					checkpoint?.('before-pending-remove', plan.target);
				}
				removePendingHeader(patchesDir, plan.target);
				removeRebasePending(patchesDir, plan.target);
			}
			continue;
		}
		mkdirSync(dirname(plan.artifactAbsolute), { recursive: true });
		writeFileSync(plan.artifactAbsolute, plan.bytes);
		if (plan.consumesPending) {
			if (rebasePending !== null) {
				checkpoint?.('artifact-written', plan.target);
				advanceCompletedRebaseMove(patchesDir, treeDir, plan.target);
				checkpoint?.('receipt-updated', plan.target);
				checkpoint?.('before-pending-remove', plan.target);
			}
			removePendingHeader(patchesDir, plan.target);
			removeRebasePending(patchesDir, plan.target);
		}
		out.info(`${plan.artifact}: ${plan.action}`);
		touched += 1;
	}
	return touched;
}

/**
 * The invariant of PROP-008 sec. 4: the rebuilt branch is byte for byte the
 * working state of the tree, so moving HEAD onto it touches no file at all. A
 * rewritten file means the delta codkit just extracted does not reproduce the
 * tree it was extracted from - a bug in codkit, not something the developer can
 * act on, and never something to pass over in silence.
 *
 * With one exception, and it is the exception the invariant was always about:
 * `save` extracts two layers, patch and own, while the other layers are authored
 * by hand in patchset and reach the tree only by materialization (PROP-007 sec. 7).
 * A developer who adds a resource entry and then runs `save` gives the rebuild a
 * file that is in patchset and not yet in the tree, and writing it is the rebuild
 * doing its job. Such a rewrite is explained by the artifact that asked for it
 * and is reported; every other one is still the internal error above.
 *
 * The two-way sync owns a second, explicit exception (campaign decision D16):
 * the `patchsetOnly` targets it passes as `explainedRewrites` are files the
 * patch set moved while the tree did not touch them, and the rebuild applying
 * their patchset state is exactly what that command is for. The public `save`
 * passes none, and its invariant is unchanged.
 */
function assertNothingMoved(
	changedPaths: readonly string[],
	nonPatchTargets: readonly string[],
	explainedRewrites: readonly string[],
	out: Output
): void {
	if (changedPaths.length === 0) {
		return;
	}
	const materialized = new Set(nonPatchTargets);
	const patchsetSide = new Set(explainedRewrites.filter((path) => !materialized.has(path)));
	const explained = new Set([...nonPatchTargets, ...explainedRewrites]);
	const materializedHits = changedPaths.filter((path) => materialized.has(path));
	const patchsetSideHits = changedPaths.filter((path) => patchsetSide.has(path));
	const unexplained = changedPaths.filter((path) => !explained.has(path));

	if (materializedHits.length > 0) {
		out.info(
			`reconciled ${materializedHits.length} file(s) through normative overlay/resource/own materialization ` +
				`(${materializedHits.slice(0, 5).join(', ')}); the rebuild put their patchset-authored state into the selected tree channel`
		);
	}
	if (patchsetSideHits.length > 0) {
		out.info(
			`applied the patchset side of ${patchsetSideHits.length} target(s) the fork tree had not moved ` +
				`(${patchsetSideHits.slice(0, 5).join(', ')}); the per-target merge rule of codkit sync took the patch set there`
		);
	}
	if (unexplained.length === 0) {
		return;
	}
	throw ckError(
		'INTERNAL',
		`the rebuilt branch does not match the working tree: ${unexplained.length} file(s) had to be rewritten ` +
			`(${unexplained.slice(0, 5).join(', ')}); the delta codkit extracted does not reproduce the tree it was extracted from`,
		're-run with --verbose and attach the output to a bug report'
	);
}

// ---------------------------------------------------------------------------
// Patchset commits
// ---------------------------------------------------------------------------

/**
 * Stage exactly the delta paths this run touched and report whether anything
 * was staged. The delta can already be what the last commit holds - a change
 * made, undone and made again ends there - and git refuses an empty commit;
 * that is a result, not a failure.
 */
function stageDeltaPaths(
	patchesDir: string,
	planned: readonly PlannedFile[],
	own: OwnMirrorReport,
	out: Output,
	quietEmpty: boolean
): readonly string[] | null {
	const paths = [...new Set(planned.filter((plan) => plan.action !== 'unchanged').map((plan) => plan.artifact))].sort();
	if (own.copied > 0 || own.removed > 0) {
		paths.push('delta/own');
	}
	if (paths.length === 0) {
		return null;
	}

	const added = runGit({ args: ['add', '--all', '--', ...paths], cwd: patchesDir });
	if (added.status !== 0) {
		throw ckError(
			'INTERNAL',
			`cannot stage the saved delta in ${patchesDir}: ${added.stderr.trim()}`,
			'stage and commit delta/ yourself, or re-run without --commit'
		);
	}

	const staged = runGit({ args: ['diff', '--cached', '--name-only', '--', ...paths], cwd: patchesDir });
	if (staged.status === 0 && staged.stdout.trim() === '') {
		if (!quietEmpty) {
			out.info('nothing to commit: the saved delta is already what the last commit of patchset holds');
		}
		return null;
	}
	return paths;
}

/**
 * `--commit`: stage exactly the delta paths this run touched and commit them
 * in patchset.
 *
 * The commit is an ordinary commit of the person running the command, so the
 * identity is read with the machine's own git configuration (##gitLocal) rather
 * than with the isolated environment the tree work uses.
 */
function commitDelta(options: SaveEngineOptions, planned: readonly PlannedFile[], own: OwnMirrorReport, out: Output): string | null {
	const { patchesDir } = options;
	const paths = stageDeltaPaths(patchesDir, planned, own, out, false);
	if (paths === null) {
		return null;
	}

	const count = planned.filter((plan) => plan.action !== 'unchanged').length + own.copied + own.removed;
	const message = options.message ?? `codkit save: ${count} file(s)`;
	// A plain subject needs the blank-line separator before a trailer paragraph;
	// the sync trailer names the transaction this commit belongs to (D20).
	const withTrailer =
		options.syncTransactionId === undefined ? message : `${message}\n\n${SYNC_TRANSACTION_TRAILER}: ${options.syncTransactionId}`;
	return commitPatchSet(patchesDir, { message: withTrailer, paths }, out);
}

/**
 * `--squash`: one patchset commit holds everything this run extracted, named
 * for the squash it is, with every consumed sha as a `Codkit-Tree-Commit`
 * trailer so the history stays answerable for what it folded (D3/D5). This is
 * the behaviour `save` had over tree commits before replay became the default,
 * and the flag is what keeps it reachable.
 */
function commitTreeSquash(
	options: SaveEngineOptions,
	planned: readonly PlannedFile[],
	own: OwnMirrorReport,
	commits: readonly TreeCommit[],
	out: Output
): string | null {
	const { patchesDir } = options;
	const paths = stageDeltaPaths(patchesDir, planned, own, out, true);
	if (paths === null) {
		out.info(
			`no artifact changes to commit for ${commits.length} consumed tree commit(s); the commits stay named in ${CONSUMED_REF_PREFIX}...`
		);
		return null;
	}

	const subject = options.message ?? `codkit save: squash of ${commits.length} tree commit(s)`;
	const listing = commits.map((commit) => `${commit.sha} ${commit.subject}`);
	const trailers = commits.map((commit) => `Codkit-Tree-Commit: ${commit.sha}`);
	// The sync trailer joins the squash's own trailer paragraph: a second
	// paragraph would fall outside the trailer block git reads (D20).
	if (options.syncTransactionId !== undefined) {
		trailers.push(`${SYNC_TRANSACTION_TRAILER}: ${options.syncTransactionId}`);
	}
	const message = [subject, '', ...listing, '', ...trailers].join('\n');
	return commitPatchSet(patchesDir, { message, paths }, out);
}

/**
 * One replayed state's patchset commit (##SAVE-REPLAYS-TREE-COMMITS): the tree
 * commit's message verbatim plus the `Codkit-Tree-Commit` trailer, authored as
 * the tree commit was - same name, address and date - and committed by whoever
 * runs the command. A state that stages nothing is skipped out loud: the work
 * is consumed either way, but patchset history has nothing to hold for it.
 */
function commitReplayState(patchesDir: string, state: PlannedCommitState, out: Output, syncTransactionId?: string): string | null {
	const paths = stageDeltaPaths(patchesDir, state.plans, NO_OWN, out, true);
	if (paths === null) {
		out.info(`tree commit ${state.commit.sha.slice(0, 8)} "${state.commit.subject}" changes no artifact; no patchset commit for it`);
		return null;
	}
	// The replay message ends inside its trailer paragraph, so the sync trailer
	// joins it there rather than opening a paragraph git would not read (D20).
	const message =
		syncTransactionId === undefined
			? replayCommitMessage(state.message, state.commit.sha)
			: `${replayCommitMessage(state.message, state.commit.sha)}${SYNC_TRANSACTION_TRAILER}: ${syncTransactionId}\n`;
	return commitPatchSet(
		patchesDir,
		{
			message,
			paths,
			author: {
				name: state.commit.authorName,
				email: state.commit.authorEmail,
				date: state.commit.authorDate
			}
		},
		out
	);
}

/** The patchset commit this engine makes: `{ message, author?, paths }`. */
type PatchSetCommit = {
	readonly message: string;
	readonly paths: readonly string[];
	/** Overrides the author only; the committer is always the local user (D5). */
	readonly author?: { readonly name: string; readonly email: string; readonly date: string };
};

/** The one way this engine commits in patchset; identity is the local user's. */
function commitPatchSet(patchesDir: string, commit: PatchSetCommit, out: Output): string | null {
	const { message, paths, author } = commit;
	const identity = commitIdentity(patchesDir);
	const committed = runGit({
		args: [
			'-c',
			`user.name=${identity.name}`,
			'-c',
			`user.email=${identity.email}`,
			'commit',
			'--quiet',
			'--message',
			message,
			'--',
			...paths
		],
		cwd: patchesDir,
		// The author of a replayed state is the author of the tree commit; the
		// isolation keeps the committer at the local user, as D5 fixes it.
		...(author === undefined ? {} : { env: { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date } })
	});
	if (committed.status !== 0) {
		throw ckError(
			'INTERNAL',
			`cannot commit the saved delta in ${patchesDir}: ${firstLine(committed.stderr) ?? firstLine(committed.stdout) ?? 'git refused the commit'}`,
			'commit delta/ yourself, or re-run without --commit'
		);
	}
	const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: patchesDir });
	const sha = head.status === 0 ? head.stdout.trim() : null;
	const [subject] = message.split('\n');
	out.info(`committed ${paths.length} delta path(s) in patchset${sha === null ? '' : ` at ${sha.slice(0, 8)}`}: ${subject ?? message}`);
	return sha;
}

type CommitIdentity = { readonly name: string; readonly email: string };

function commitIdentity(patchesDir: string): CommitIdentity {
	return {
		name: localConfigValue(patchesDir, 'user.name') ?? FALLBACK_COMMIT_NAME,
		email: localConfigValue(patchesDir, 'user.email') ?? FALLBACK_COMMIT_EMAIL
	};
}

function localConfigValue(patchesDir: string, key: string): string | null {
	const result = gitLocal({ args: ['config', '--get', key], cwd: patchesDir });
	if (result.status !== 0) {
		return null;
	}
	const value = result.stdout.trim();
	return value === '' ? null : value;
}

function firstLine(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === '') {
		return null;
	}
	const [line] = trimmed.split('\n');
	return line ?? null;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportOwn(out: Output, own: OwnMirrorReport): void {
	if (own.copied === 0 && own.removed === 0 && own.kept === 0) {
		return;
	}
	out.info(`own code: ${own.copied} extracted, ${own.removed} removed, ${own.kept} left as patchset has them`);
}

function reportOwnExtensions(out: Output, report: OwnExtensionSyncReport): void {
	if (report.copied === 0 && report.removed === 0) {
		return;
	}
	out.info(`own extensions: ${report.copied} extracted, ${report.removed} removed`);
}

function toReport(plan: PlannedFile): SaveFileReport {
	return { target: plan.target, artifact: plan.artifact, action: plan.action };
}

type ResultParts = {
	readonly branch: string;
	readonly branchTip?: string | null;
	readonly files?: readonly SaveFileReport[];
	readonly own?: OwnMirrorReport;
	readonly commit?: string | null;
	readonly consumedRef?: string | null;
};

function result(status: SaveStatus, exitCode: number, parts: ResultParts): SaveResult {
	return {
		exitCode,
		status,
		files: parts.files ?? [],
		own: parts.own ?? NO_OWN,
		branch: parts.branch,
		branchTip: parts.branchTip ?? null,
		commit: parts.commit ?? null,
		consumedRef: parts.consumedRef ?? null
	};
}
