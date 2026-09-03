/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The sync engine: bring the fork tree to the pin and put the delta on it.
// The pseudocode of PROP-008 sec. 3 is normative and this file follows its order.
//
// Three properties shape the implementation, and each of them is a requirement
// rather than a preference:
//
//   * the generated commits are built in a temporary index, from the pin's tree,
//     with a fixed author and the pin's own date - so their shas are identical
//     on every machine (##NFR-DETERMINISM) and CI caches keyed by them work;
//   * the work tree is moved by rewriting only the files that actually differ
//     from the new tip (##MTIME-DISCIPLINE) - a full checkout would restart every
//     watch daemon in the tree;
//   * `git clean` is never run: untracked content is only ever removed by
//     `--fresh`, and then only what the cleanup whitelist does not protect.
//
// The tree is the truth about what is applied (##TREE-IS-TRUTH); the cache in
// patchset and the mark inside .git are hints that let the next run skip the work.

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyUnified } from './applyUnified.ts';
import { encodeUtf8 } from './bytes.ts';
import type { CodkitConfig } from './configFile.ts';
import { loadConventions, matchesPatternList } from './conventionsFile.ts';
import type { Conventions } from './conventionsFile.ts';
import { driftDirty, porcelainPaths } from './driftGuard.ts';
import { deltaFingerprint, treeId } from './fingerprint.ts';
import { appendGeneratedOwnCommit, assertGeneratedTargetOwnership, generatedHistoryFingerprint } from './generatedBranch.ts';
import type { GeneratedLayerTarget, GeneratedOwnEvidence } from './generatedBranch.ts';
import { gitOk, runGit } from './gitx.ts';
import type { GitEnv } from './gitx.ts';
import type { Output } from './jsonOut.ts';
import {
	OVERLAYS_DIR,
	checkOverlay,
	loadOverlays,
	overlayDriftErrors,
	renderOverlayTarget,
	writeProductOverridesDev
} from './layers/overlay.ts';
import type { Overlay, OverlayVarContext } from './layers/overlay.ts';
import { RESOURCE_MAP_PATH, assertTargetAtPin, loadResourceMap, resourceSourcePath } from './layers/resource.ts';
import type { ResourceEntry } from './layers/resource.ts';
import { ckError, isCkError } from './messages.ts';
import type { CkError } from './messages.ts';
import { OWN_SOURCE_DIR, classifyOwn, ownStateOfPatchSet, ownTargetRelativeDir, syncOwnCode } from './ownCopy.ts';
import type { OwnDivergence, OwnSyncReport } from './ownCopy.ts';
import { PATCH_FILE_SUFFIX, encodePatchName, parseCkpatch } from './patchFormat.ts';
import type { ParsedPatch } from './patchFormat.ts';
import type { ForkDirResolution } from './paths.ts';
import { checkTree, formatCheckLine } from './treeIdentity.ts';
import {
	TREE_CACHE_SCHEMA_VERSION,
	TREE_MARK_SCHEMA_VERSION,
	fastPathOk,
	gitDirOf,
	readTreeCache,
	readTreeMark,
	writeTreeCache,
	writeTreeMark
} from './treeCache.ts';
import type { TreeMark } from './treeCache.ts';
import { assertCompletedRebaseMoveSyncTree, completedRebaseMoveForSync, finishCompletedRebaseMoveSync } from './rebaseOntoPinMove.ts';
import { hasRebasePendingRecords } from './rebaseOntoPinPending.ts';

/** Patch artifacts live here, relative to the patchset root. */
export const PATCHES_DIR = 'delta/patches';

/** Identity of every generated commit; fixed, so the shas are reproducible. */
export const COMMIT_AUTHOR_NAME = 'codkit';
export const COMMIT_AUTHOR_EMAIL = 'codkit@patchset.invalid';

/** Managed block of .git/info/exclude (PROP-005 ##OWN-EXCLUDED-LOCALLY). */
export const EXCLUDE_BEGIN = '# codkit:begin managed';
export const EXCLUDE_END = '# codkit:end managed';

type ExcludePlan = {
	readonly path: string;
	readonly existing: string;
	readonly next: string;
};

/** Environment variable the tree's pre-commit hook lets through. */
export const INTERNAL_COMMIT_ENV = 'CODKIT_INTERNAL_COMMIT';

/** How many paths are passed to one git invocation. */
const PATH_BATCH = 100;

/** How many dirty paths the guard lists before summarizing the rest. */
const DIRTY_LIST_LIMIT = 20;

export type SyncEngineOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	readonly out: Output;
	readonly fresh: boolean;
	readonly dryRun: boolean;
	readonly verbose: boolean;
	/**
	 * Channel 2 of the config-overlay layer (PROP-005 ##OVERLAY-TWO-CHANNELS): the
	 * overlay targets are materialized into commits of the generated branch,
	 * between the patches and the resource map (PROP-008 sec. 3).
	 *
	 * Off by default, and deliberately so: a local `sync` uses the dev channel and
	 * leaves the upstream files alone, so the tree of a developer never carries a
	 * rewritten product.json that `git status` would call dirt. `ci` and `publish`
	 * turn it on, on a tree they own.
	 */
	readonly materializeOverlays?: boolean;
	/**
	 * Complete reproducible history for CI/publish: patches, one aggregate own
	 * commit, overlay targets, then resources. Local sync leaves this off.
	 */
	readonly generatedBranch?: boolean;
	/** Exact immutable patchset commit represented by this materialization. */
	readonly patchSetCommit?: string;
	/** Internal source of Git modes for an object-only scratch patchset checkout. */
	readonly generatedModeSource?: { readonly repositoryRoot: string; readonly ref: string };
	/**
	 * Only `save` sets this. It has just extracted every change of the tree into
	 * patchset, so what the guard would call unextracted work is exactly the work it
	 * is about to put on the branch (PROP-008 sec. 4, step 3). No other caller may
	 * skip the guard.
	 */
	readonly skipDriftGuard?: boolean;
	/** Internal crash recovery: rebuild even when cache/mark would take the fast path. */
	readonly forceApply?: boolean;
	/** Test seam around the only two post-checkout durable metadata windows. */
	readonly checkpoint?: (checkpoint: 'worktree-moved' | 'mark-written') => void;
};

export type SyncStatus = 'unfit' | 'dirty' | 'broken' | 'up-to-date' | 'applied' | 'dry-run';

export type SyncResult = {
	readonly exitCode: number;
	readonly status: SyncStatus;
	readonly branch: string;
	readonly branchTip: string | null;
	readonly artifacts: number;
	readonly own: OwnSyncReport;
	readonly cleaned: number;
	/** Work-tree files rewritten to reach the new tip. */
	readonly changedFiles: number;
	/** Which files those were; `save` asserts on this list (PROP-008 sec. 4). */
	readonly changedPaths: readonly string[];
	/**
	 * Targets whose rewrite is explained by a non-patch materialization: every
	 * resource/overlay target in the complete materializable plan, plus every
	 * delivered own-code target. `save` needs the complete set even when the
	 * selected local channel omits overlays or carries own code outside Git:
	 * moving from a provisional/full tip to that channel legitimately rewrites
	 * those targets. Any changed path outside this set remains unexplained
	 * (PROP-007 sec. 7).
	 */
	readonly nonPatchTargets: readonly string[];
	/** Collision-free own targets carried by a full generated branch. */
	readonly generatedOwnPaths: readonly string[];
	readonly dirtyFiles: readonly string[];
	readonly broken: readonly string[];
	/** Why the fast path was refused; null when it was taken. */
	readonly fastPathReason: string | null;
};

type PatchArtifact = {
	readonly kind: 'patch';
	readonly id: string;
	readonly target: string;
	readonly artifactPath: string;
	readonly patch: ParsedPatch;
};

type ResourceArtifact = {
	readonly kind: 'resource';
	readonly id: string;
	readonly target: string;
	readonly artifactPath: string;
	readonly entry: ResourceEntry;
};

/** One materialized overlay target; several overlay files may feed one. */
type OverlayArtifact = {
	readonly kind: 'overlay';
	readonly id: string;
	readonly target: string;
	readonly artifactPath: string;
	readonly overlays: readonly Overlay[];
};

type Artifact = PatchArtifact | ResourceArtifact | OverlayArtifact;

const NO_OWN: OwnSyncReport = { copied: 0, removed: 0, total: 0 };

/**
 * One `sync`. The caller holds the lock and owns the output envelope; this
 * function does the work and reports what happened.
 */
export function runSync(options: SyncEngineOptions): SyncResult {
	const { patchesDir, resolution, config, out, dryRun } = options;
	const tree = resolution.path;
	const branch = `${config.generatedBranchPrefix}${config.pin.tag}`;
	let generatedBranch = options.generatedBranch === true;
	let materializeOverlays = generatedBranch || options.materializeOverlays === true;
	let completedRebase: ReturnType<typeof completedRebaseMoveForSync> = null;

	// 1. Is this the tree we think it is, and may we write to it?
	const identity = checkTree(resolution, config, { mode: dryRun ? 'read' : 'write' });
	if (options.verbose) {
		for (const check of identity.checks) {
			out.diag(formatCheckLine(check));
		}
	}
	if (identity.fatal !== null) {
		out.addError(identity.fatal.toPayload());
		return result('unfit', 2, { branch });
	}
	if (options.forceApply === true && driftDirty(tree, config.ownDirName, patchesDir).dirty) {
		throw ckError('DIRTY-TREE', 'forced sync recovery requires a completely clean fork tree');
	}
	if (!dryRun && !hasRebasePendingRecords(patchesDir)) {
		completedRebase = completedRebaseMoveForSync(patchesDir, tree);
		if (completedRebase !== null) {
			generatedBranch = true;
			materializeOverlays = true;
		}
	}

	// A shared file is classified before any mutation. A malformed managed
	// block is a human decision: sync must not repair it after moving refs or
	// rewriting work-tree files.
	let excludePlan: ExcludePlan;
	try {
		excludePlan = planExclude(tree, config.ownDirName);
	} catch (error) {
		return reportBroken(out, error, branch);
	}
	// 2. The config-overlay layer states what it expects the pin to look like,
	// and that expectation is checked on every sync (##OVERLAY-DRIFT-DETECTOR):
	// upstream moving a key an intervention is written against must be loud here,
	// not at packaging time. Every mismatch is reported, not only the first.
	let overlays: readonly Overlay[];
	try {
		overlays = loadOverlays(patchesDir);
		const drift = overlays.flatMap((overlay) => checkOverlay(overlay, { treeDir: tree, pinSha: config.pin.sha, pinOnly: true }).drift);
		if (drift.length > 0) {
			for (const error of overlayDriftErrors(drift)) {
				out.addError(error.toPayload());
			}
			return result('broken', 1, { branch, broken: [...new Set(drift.map((entry) => entry.artifactPath))] });
		}
	} catch (error) {
		return reportBroken(out, error, branch);
	}
	let prebuiltPlan: readonly Artifact[];
	let prebuiltConventions: Conventions;
	let ownershipEvidence: GeneratedOwnEvidence;
	try {
		prebuiltConventions = loadConventions(patchesDir);
		prebuiltPlan = buildPlan(patchesDir, prebuiltConventions, overlays, warnFrom(out));
		ownershipEvidence = assertGeneratedTargetOwnership(patchesDir, config.ownDirName, layerTargets(prebuiltPlan));
	} catch (error) {
		return reportBroken(out, error, branch);
	}

	// 3. What patchset asks for, and what this tree was last brought to. Reading
	// them is free of effects, and the guard below needs to know which side of
	// an own-code difference moved.
	const delta = deltaFingerprint(patchesDir, config.pin.sha);
	const fingerprint = generatedBranch ? generatedHistoryFingerprint(delta, patchesDir) : delta;
	const id = treeId(tree);
	const warn = (text: string): void => {
		out.warn(text);
	};
	const cache = readTreeCache(patchesDir, id, warn);
	const mark = readTreeMark(tree, warn);

	// 4. Drift guard: never overwrite work that was not extracted back to patchset.
	if (!dryRun && options.skipDriftGuard !== true && completedRebase === null) {
		// --fresh is about to remove untracked paths by the whitelist, so they
		// are not counted as unextracted work in that run.
		const drift = driftDirty(tree, config.ownDirName, patchesDir, { untrackedIsDirt: !options.fresh });
		if (drift.dirty) {
			const verdict = judgeOwnSides(drift, patchesDir, tree, config.ownDirName, mark, fingerprint);
			if (verdict.kind === 'both-sides') {
				out.addError(verdict.error.toPayload());
				return result('dirty', 1, { branch, dirtyFiles: drift.files });
			}
			if (verdict.kind === 'unextracted') {
				for (const path of drift.files.slice(0, DIRTY_LIST_LIMIT)) {
					out.info(`  dirty: ${path}`);
				}
				if (drift.files.length > DIRTY_LIST_LIMIT) {
					out.info(`  ... and ${drift.files.length - DIRTY_LIST_LIMIT} more`);
				}
				out.addError({
					code: 'DIRTY-TREE',
					message: `${drift.files.length} path(s) in the fork tree carry changes that are not in patchset yet`,
					hint: 'run codkit save, or codkit status'
				});
				return result('dirty', 1, { branch, dirtyFiles: drift.files });
			}
			out.warn(verdict.text, 'PATCHSET-SIDE-EDIT');
		}
	}

	// 5. The fast path.
	// --fresh is an explicit request for a from-scratch pass: it must not be
	// answered with "up to date", or the cleanup it asks for would never run.
	const verdict =
		completedRebase !== null
			? ({ ok: false, reason: 'completed rebase receipt requires exact reconciliation' } as const)
			: options.forceApply === true
				? ({ ok: false, reason: 'post-checkout recovery was requested' } as const)
				: options.fresh
					? ({ ok: false, reason: '--fresh was requested' } as const)
					: fastPathOk({ treeDir: tree, branch, cache, mark, pinSha: config.pin.sha, deltaFingerprint: fingerprint });
	if (verdict.ok) {
		if (dryRun) {
			out.info('up to date');
			return result('up-to-date', 0, {
				branch,
				branchTip: cache?.branchTip ?? null,
				generatedOwnPaths: generatedBranch ? ownershipEvidence.ownTargets : []
			});
		}
		// Own code is verified on every run: locally it is not part of the
		// branch commits, so the branch cannot vouch for it.
		const own = syncOwnCode(patchesDir, tree, config.ownDirName);
		writeExcludePlan(excludePlan);
		writeTreeHook(tree, out);
		reportOwn(out, own);
		out.info('up to date');
		return result('up-to-date', 0, {
			branch,
			branchTip: cache?.branchTip ?? null,
			own,
			generatedOwnPaths: generatedBranch ? ownershipEvidence.ownTargets : []
		});
	}
	if (options.verbose) {
		out.diag(`full apply: ${verdict.reason}`);
	}

	const conventions = prebuiltConventions;

	// 6. --fresh: untracked content that the whitelist does not protect.
	let cleaned = 0;
	if (options.fresh && !dryRun) {
		cleaned = cleanUntracked(tree, config, conventions);
		out.info(`fresh: removed ${cleaned} untracked path(s), kept everything the cleanup whitelist protects`);
	}

	// 7. The artifacts, in the order PROP-008 sec. 3 fixes: patches by file name,
	// then the overlay targets (CI and publish only), then the resource map by
	// target. Full generated history inserts its one aggregate own-code atom at
	// the patch/overlay boundary. The order is part of the resulting commit ids.
	const context = overlayVarContext(config, pinCommitDate(tree, config.pin.sha), options.patchSetCommit ?? patchSetCommitId(patchesDir));
	let plan: readonly Artifact[];
	try {
		plan = materializeOverlays ? prebuiltPlan : prebuiltPlan.filter((artifact) => artifact.kind !== 'overlay');
	} catch (error) {
		return reportBroken(out, error, branch);
	}

	if (dryRun) {
		return dryRunPlan(options, plan, context, branch);
	}

	// 8. Build the commits in a temporary index; the work tree is not touched.
	let built: BuildOutcome;
	try {
		built = buildBranch(
			completedRebase === null ? options : { ...options, generatedBranch: true, materializeOverlays: true },
			plan,
			context,
			id
		);
	} catch (error) {
		return reportBroken(out, error, branch);
	}
	if (completedRebase !== null) {
		const builtTree = runGit({ args: ['rev-parse', '--verify', `${built.top}^{tree}`], cwd: tree });
		const treeSha = builtTree.stdout.trim();
		if (builtTree.status !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) {
			throw ckError('ARTIFACT-BROKEN', 'cannot preflight generated tree while consuming completed rebase receipt');
		}
		assertCompletedRebaseMoveSyncTree(patchesDir, tree, completedRebase.desiredTree, treeSha);
	}

	// 9. Move the tree to the new tip, rewriting only what differs.
	updateRef(tree, branch, built.top);
	const changedPaths = moveWorkTree(tree, branch);
	options.checkpoint?.('worktree-moved');

	// 10. Own code, dev overlay, exclude, hook, mark, cache.
	const own = syncOwnCode(patchesDir, tree, config.ownDirName);
	// The two channels of the config-overlay layer are alternatives, not layers
	// on top of each other: when the targets are materialized into the branch,
	// the dev-channel file has nothing left to say.
	if (!materializeOverlays) {
		writeProductOverridesDev(patchesDir, tree, overlays, context, config.pin.sha, warn);
	}
	writeExcludePlan(excludePlan);
	writeTreeHook(tree, out);
	// The own state is recorded after the copy, when both sides are identical by
	// construction: that is what makes the map usable as "who moved" evidence.
	const ownState = ownStateOfPatchSet(patchesDir);
	writeTreeMark(
		tree,
		{
			codkitTreeMark: TREE_MARK_SCHEMA_VERSION,
			pinSha: config.pin.sha,
			deltaFingerprint: fingerprint,
			branchTip: built.top,
			ownFingerprint: ownState.fingerprint,
			ownFiles: ownState.files
		},
		(text) => {
			out.warn(text, 'MARK-RO');
		}
	);
	options.checkpoint?.('mark-written');
	writeTreeCache(patchesDir, id, {
		codkitTreeCache: TREE_CACHE_SCHEMA_VERSION,
		treePath: tree,
		treeRepoAnchor: config.upstreamAnchorCommit,
		pinSha: config.pin.sha,
		deltaFingerprint: fingerprint,
		branchTip: built.top,
		updatedAt: new Date().toISOString()
	});
	if (completedRebase !== null) {
		const builtTree = runGit({ args: ['rev-parse', '--verify', `${built.top}^{tree}`], cwd: tree });
		const treeSha = builtTree.stdout.trim();
		if (builtTree.status !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) {
			throw ckError('ARTIFACT-BROKEN', 'cannot verify generated tree while consuming completed rebase receipt');
		}
		finishCompletedRebaseMoveSync(patchesDir, tree, completedRebase.desiredTree, treeSha);
	}

	out.info(`applied ${plan.length} artifact(s) on ${branch} at ${built.top.slice(0, 8)}`);
	out.info(`updated ${changedPaths.length} file(s) in the work tree`);
	reportOwn(out, own);
	return result('applied', 0, {
		branch,
		branchTip: built.top,
		artifacts: plan.length,
		own,
		cleaned,
		changedPaths,
		nonPatchTargets: saveMaterializationTargets(prebuiltPlan, ownershipEvidence.ownTargets),
		generatedOwnPaths: generatedBranch ? ownershipEvidence.ownTargets : [],
		fastPathReason: verdict.reason
	});
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function buildPlan(
	patchesDir: string,
	conventions: Conventions,
	overlays: readonly Overlay[],
	onWarn: (text: string) => void
): readonly Artifact[] {
	const artifacts: Artifact[] = [];
	for (const name of listPatchFiles(patchesDir)) {
		const artifactPath = `${PATCHES_DIR}/${name}`;
		const patch = parseCkpatch(readFileSync(join(patchesDir, ...PATCHES_DIR.split('/'), name)), conventions, artifactPath);
		artifacts.push({ kind: 'patch', id: patch.header.id, target: patch.targetPath, artifactPath, patch });
	}
	artifacts.push(...overlayArtifacts(overlays));
	const map = loadResourceMap(patchesDir);
	if (map !== null) {
		if (!map.wasSorted) {
			// The order of the file is part of its review value; applying it is
			// still deterministic, because it is sorted on read.
			onWarn(`${RESOURCE_MAP_PATH}: entries are not sorted by target; they are applied in target order anyway`);
		}
		for (const entry of map.entries) {
			artifacts.push({ kind: 'resource', id: entry.id, target: entry.target, artifactPath: entry.source, entry });
		}
	}
	return artifacts;
}

/**
 * One artifact per overlay target, in target order. Several overlay files may
 * name one target - the layer composes them - and they then share a commit,
 * because the commit is the target file, not the artifact that changed it.
 */
function overlayArtifacts(overlays: readonly Overlay[]): readonly OverlayArtifact[] {
	const byTarget = new Map<string, Overlay[]>();
	for (const overlay of overlays) {
		const bucket = byTarget.get(overlay.target);
		if (bucket === undefined) {
			byTarget.set(overlay.target, [overlay]);
			continue;
		}
		bucket.push(overlay);
	}
	const targets = [...byTarget.keys()].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
	return targets.map((target) => {
		const group = byTarget.get(target) ?? [];
		return {
			kind: 'overlay',
			id: group[0]?.id ?? target,
			target,
			artifactPath: group[0]?.artifactPath ?? `${OVERLAYS_DIR}/${target}`,
			overlays: group
		};
	});
}

/**
 * Which targets of a plan come from a layer other than the patch layer. Every
 * such target is a file the tree receives from patchset without anyone editing it
 * in the tree, which is exactly what makes it explainable when a rebuild has to
 * write it (see the assertion of `save`, PROP-008 sec. 4).
 */
function nonPatchTargets(plan: readonly Artifact[]): readonly string[] {
	return [...new Set(plan.filter((artifact) => artifact.kind !== 'patch').map((artifact) => artifact.target))];
}

function saveMaterializationTargets(plan: readonly Artifact[], ownTargets: readonly string[]): readonly string[] {
	return [...new Set([...nonPatchTargets(plan), ...ownTargets])];
}

function layerTargets(plan: readonly Artifact[]): readonly GeneratedLayerTarget[] {
	return plan.map((artifact) => {
		if (artifact.kind === 'patch') {
			let expected: string;
			try {
				expected = `${PATCHES_DIR}/${encodePatchName(artifact.target)}`;
			} catch {
				throw ckError(
					'ARTIFACT-BROKEN',
					`${artifact.artifactPath}: patch target cannot be represented by the canonical artifact encoding: ${artifact.target}`,
					'move the intervention to an encodable repository path',
					artifact.artifactPath
				);
			}
			if (artifact.artifactPath !== expected) {
				throw ckError(
					'ARTIFACT-BROKEN',
					`${artifact.artifactPath}: patch file name does not canonically encode target ${artifact.target}; expected ${expected}`,
					'rename the artifact to the canonical encoded target name',
					artifact.artifactPath
				);
			}
			return { layer: artifact.kind, target: toPosix(artifact.target), artifactPaths: [artifact.artifactPath], ids: [artifact.id] };
		}
		if (artifact.kind === 'overlay') {
			return {
				layer: artifact.kind,
				target: toPosix(artifact.target),
				artifactPaths: artifact.overlays.map((overlay) => overlay.artifactPath),
				ids: artifact.overlays.map((overlay) => overlay.id)
			};
		}
		return { layer: artifact.kind, target: toPosix(artifact.target), artifactPaths: [artifact.artifactPath], ids: [artifact.id] };
	});
}

function warnFrom(out: Output): (text: string) => void {
	return (text) => out.warn(text);
}

/** Patch file names, sorted by their UTF-8 bytes so the order is locale-free. */
function listPatchFiles(patchesDir: string): readonly string[] {
	let names: string[];
	try {
		names = readdirSync(join(patchesDir, ...PATCHES_DIR.split('/')));
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(PATCH_FILE_SUFFIX))
		.sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}

// ---------------------------------------------------------------------------
// Building the generated branch
// ---------------------------------------------------------------------------

type BuildOutcome = {
	readonly top: string;
	readonly pinDateIso: string;
	readonly patchSetCommit: string;
};

function buildBranch(options: SyncEngineOptions, plan: readonly Artifact[], context: OverlayVarContext, id: string): BuildOutcome {
	const { patchesDir, config, out } = options;
	assertGeneratedTargetOwnership(patchesDir, config.ownDirName, layerTargets(plan));
	const tree = options.resolution.path;
	const scratch = join(patchesDir, '.codkit', 'tmp');
	mkdirSync(scratch, { recursive: true });
	const indexFile = join(scratch, `${id}.index`);
	const blobFile = join(scratch, `${id}.blob`);
	rmSync(indexFile, { force: true });

	const pinDateIso = context.buildDate;
	const patchSetCommit = context.patchSetCommit;
	const indexEnv: GitEnv = { GIT_INDEX_FILE: indexFile };
	const commitEnv: GitEnv = {
		GIT_INDEX_FILE: indexFile,
		GIT_AUTHOR_DATE: pinDateIso,
		GIT_COMMITTER_DATE: pinDateIso,
		GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
		GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
		GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL
	};

	try {
		gitOk(
			{ args: ['read-tree', config.pin.sha], cwd: tree, env: indexEnv },
			{
				code: 'ARTIFACT-BROKEN',
				message: `cannot read the tree of pin ${config.pin.tag} into a temporary index`,
				hint: 'the pin is reachable but its tree is not readable; check the tree with git fsck'
			}
		);

		let parent = config.pin.sha;
		let ownCommitted = false;
		const appendOwn = (): void => {
			const own = appendGeneratedOwnCommit({
				patchesDir,
				treeDir: tree,
				indexFile,
				parent,
				ownDirName: config.ownDirName,
				pinTag: config.pin.tag,
				pinSha: config.pin.sha,
				pinDateIso,
				patchSetCommit,
				authorName: COMMIT_AUTHOR_NAME,
				authorEmail: COMMIT_AUTHOR_EMAIL,
				...(options.generatedModeSource === undefined ? {} : { modeSource: options.generatedModeSource })
			});
			ownCommitted = true;
			if (own.sha === null) {
				if (options.verbose) out.diag('  own empty; commit skipped');
				return;
			}
			parent = own.sha;
			if (options.verbose) out.diag(`  own ${own.files.length} file(s) -> ${parent.slice(0, 8)}`);
		};
		for (const artifact of plan) {
			if (options.generatedBranch === true && !ownCommitted && artifact.kind !== 'patch') appendOwn();
			const blobSha = stageArtifact(artifact, options, context, blobFile, indexEnv);
			const mode = modeAtPin(tree, config.pin.sha, artifact.target) ?? '100644';
			gitOk(
				{ args: ['update-index', '--add', '--cacheinfo', `${mode},${blobSha},${toPosix(artifact.target)}`], cwd: tree, env: indexEnv },
				{
					code: 'ARTIFACT-BROKEN',
					message: `${artifact.artifactPath}: cannot stage ${artifact.target}`,
					hint: 'this is a bug in codkit unless the tree is damaged; re-run with --verbose'
				}
			);
			const treeSha = gitOk(
				{ args: ['write-tree'], cwd: tree, env: indexEnv },
				{
					code: 'ARTIFACT-BROKEN',
					message: `${artifact.artifactPath}: cannot write the tree after staging ${artifact.target}`,
					hint: 're-run with --verbose'
				}
			).stdout.trim();
			parent = gitOk(
				{ args: ['commit-tree', treeSha, '-p', parent, '-m', commitMessage(artifact, config, patchSetCommit)], cwd: tree, env: commitEnv },
				{
					code: 'ARTIFACT-BROKEN',
					message: `${artifact.artifactPath}: cannot create the commit for ${artifact.target}`,
					hint: 're-run with --verbose'
				}
			).stdout.trim();
			if (options.verbose) {
				out.diag(`  ${artifact.id} ${artifact.target} -> ${parent.slice(0, 8)}`);
			}
		}
		if (options.generatedBranch === true && !ownCommitted) appendOwn();
		return { top: parent, pinDateIso, patchSetCommit };
	} finally {
		rmSync(indexFile, { force: true });
		rmSync(blobFile, { force: true });
	}
}

export type AppliedTipOptions = {
	/** The state of patchset to apply; a scratch checkout of a ref is a legal one. */
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	/** The config of THAT state of patchset: its pin is the base of the commits. */
	readonly config: CodkitConfig;
	readonly out: Output;
	readonly verbose?: boolean;
	readonly materializeOverlays?: boolean;
	readonly generatedBranch?: boolean;
	/** Exact patchset commit represented by a non-repository scratch checkout. */
	readonly patchSetCommit?: string;
	/** Repository that owns patchSetCommit when patchesDir is a scratch export. */
	readonly patchesRepositoryRoot?: string;
};

/**
 * Build the generated commits of one state of patchset and return their tip,
 * without touching the work tree, any ref, the mark or the cache.
 *
 * `ci --effective-diff` needs it (PROP-011 sec. 6, the effective-diff rule): the diff a
 * reviewer reads is `git diff <base-top> <pr-top>` inside the tree, so the tip of
 * the base state has to exist as objects of that tree - and building it must not
 * disturb the tree that the run has just brought to the PR state. Everything the
 * commits are made of comes from git objects and from the given patchset root, so
 * the only thing that reaches the tree is `hash-object -w`.
 */
export function buildAppliedTip(options: AppliedTipOptions): string {
	const tree = options.resolution.path;
	const engine: SyncEngineOptions = {
		patchesDir: options.patchesDir,
		resolution: options.resolution,
		config: options.config,
		out: options.out,
		fresh: false,
		dryRun: false,
		verbose: options.verbose === true,
		materializeOverlays: options.materializeOverlays === true,
		generatedBranch: options.generatedBranch === true,
		...(options.patchSetCommit === undefined ? {} : { patchSetCommit: options.patchSetCommit }),
		...(options.patchesRepositoryRoot === undefined || options.patchSetCommit === undefined
			? {}
			: { generatedModeSource: { repositoryRoot: options.patchesRepositoryRoot, ref: options.patchSetCommit } })
	};
	const warn = (text: string): void => {
		options.out.warn(text);
	};
	const conventions = loadConventions(options.patchesDir);
	const overlays = options.generatedBranch === true || options.materializeOverlays === true ? loadOverlays(options.patchesDir) : [];
	const plan = buildPlan(options.patchesDir, conventions, overlays, warn);
	assertGeneratedTargetOwnership(options.patchesDir, options.config.ownDirName, layerTargets(plan));
	const context = overlayVarContext(
		options.config,
		pinCommitDate(tree, options.config.pin.sha),
		options.patchSetCommit ?? patchSetCommitId(options.patchesDir)
	);
	return buildBranch(engine, plan, context, treeId(tree)).top;
}

/** Complete object-only tip for CI today and publish later. */
export function buildGeneratedTip(options: Omit<AppliedTipOptions, 'materializeOverlays' | 'generatedBranch'>): string {
	return buildAppliedTip({ ...options, generatedBranch: true });
}

/** Materialize one artifact into the temporary index; returns the blob sha. */
function stageArtifact(
	artifact: Artifact,
	options: SyncEngineOptions,
	context: OverlayVarContext,
	blobFile: string,
	indexEnv: GitEnv
): string {
	const tree = options.resolution.path;
	if (artifact.kind === 'resource') {
		assertTargetAtPin(tree, options.config.pin.sha, artifact.entry);
		return hashObject(tree, resourceSourcePath(options.patchesDir, artifact.entry), indexEnv);
	}
	if (artifact.kind === 'overlay') {
		// Channel 2: the base is the clean pin file, never the tree, so the commit
		// is the same whatever state the work tree happens to be in.
		const rendered = renderOverlayTarget(artifact.overlays, tree, options.config.pin.sha, context);
		writeFileSync(blobFile, rendered.bytes);
		return hashObject(tree, blobFile, indexEnv);
	}
	const applied = applyPatchAtPin(artifact, options);
	writeFileSync(blobFile, applied);
	return hashObject(tree, blobFile, indexEnv);
}

/**
 * A codkit patch is regenerated against its own pin, so it must apply with
 * exact context. When it does not, the artifact is broken - not the tree.
 */
function applyPatchAtPin(artifact: PatchArtifact, options: SyncEngineOptions): Uint8Array {
	const tree = options.resolution.path;
	const pinSha = options.config.pin.sha;
	let base: Uint8Array = new Uint8Array(0);
	if (!artifact.patch.isAddFile) {
		const shown = runGit({ args: ['show', `${pinSha}:${toPosix(artifact.target)}`], cwd: tree });
		if (shown.status !== 0) {
			throw ckError(
				'ARTIFACT-BROKEN',
				`${artifact.artifactPath}: ${artifact.target} does not exist at pin ${options.config.pin.tag}`,
				'regenerate the patch against the current pin with codkit save, or resolve it in an upgrade cycle',
				artifact.artifactPath
			);
		}
		base = encodeUtf8(shown.stdout);
	}
	try {
		return applyUnified(base, artifact.patch);
	} catch (error) {
		if (isCkError(error)) {
			throw ckError('ARTIFACT-BROKEN', `${artifact.artifactPath}: ${error.message}`, error.hint, artifact.artifactPath, error.line);
		}
		throw error;
	}
}

function hashObject(treeDir: string, filePath: string, indexEnv: GitEnv): string {
	// --no-filters: the bytes we computed are the bytes that must be stored, and
	// no .gitattributes rule of the tree may reinterpret them.
	const result = gitOk(
		{ args: ['hash-object', '-w', '--no-filters', '--', filePath], cwd: treeDir, env: indexEnv },
		{
			code: 'ARTIFACT-BROKEN',
			message: `cannot store ${filePath} in the object database of ${treeDir}`,
			hint: 'check that the fork tree is writable'
		}
	);
	return result.stdout.trim();
}

/** File mode of a path at the pin, so an executable file stays executable. */
function modeAtPin(treeDir: string, pinSha: string, target: string): string | null {
	const result = runGit({ args: ['ls-tree', '--full-tree', pinSha, '--', toPosix(target)], cwd: treeDir });
	if (result.status !== 0) {
		return null;
	}
	const [line] = result.stdout.split('\n');
	if (line === undefined || line === '') {
		return null;
	}
	const [mode] = line.split(' ');
	return mode === undefined || mode === '' ? null : mode;
}

function commitMessage(artifact: Artifact, config: CodkitConfig, patchSetCommit: string): string {
	// One Codkit-Artifact trailer per artifact that shaped the commit: an overlay
	// target composed from two overlay files names both of them.
	const ids = artifact.kind === 'overlay' ? artifact.overlays.map((overlay) => overlay.id) : [artifact.id];
	return [
		`codkit: ${artifact.id} ${artifact.target}`,
		'',
		...ids.map((id) => `Codkit-Artifact: ${id}`),
		`Codkit-Patchset-Commit: ${patchSetCommit}`,
		`Codkit-Upstream-Pin: ${config.pin.tag}@${config.pin.sha}`
	].join('\n');
}

/** Commit date of the pin, ISO-8601; the date every generated commit carries. */
export function pinCommitDate(treeDir: string, pinSha: string): string {
	const result = gitOk(
		{ args: ['log', '-1', '--format=%cI', pinSha], cwd: treeDir },
		{ code: 'PIN-UNREACHABLE', message: `cannot read the commit date of pin ${pinSha}`, hint: 'the pin must be present in the fork tree' }
	);
	return result.stdout.trim();
}

/**
 * What patchset looked like when this branch was generated. A patchset checkout with
 * uncommitted work cannot be named by a sha, and says so.
 */
export function patchSetCommitId(patchesDir: string): string {
	const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: patchesDir });
	if (head.status !== 0) {
		return 'none';
	}
	const status = runGit({ args: ['status', '--porcelain'], cwd: patchesDir });
	if (status.status === 0) {
		// .codkit/ is codkit's own scratch state, not content of the repository.
		const dirty = porcelainPaths(status.stdout).some((path) => !path.startsWith('.codkit/'));
		if (dirty) {
			return 'dirty';
		}
	}
	return head.stdout.trim();
}

// ---------------------------------------------------------------------------
// Moving the work tree
// ---------------------------------------------------------------------------

function updateRef(treeDir: string, branch: string, top: string): void {
	gitOk(
		{ args: ['update-ref', `refs/heads/${branch}`, top], cwd: treeDir },
		{ code: 'ARTIFACT-BROKEN', message: `cannot update refs/heads/${branch}`, hint: 'check that the fork tree is writable' }
	);
	gitOk(
		{ args: ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], cwd: treeDir },
		{ code: 'ARTIFACT-BROKEN', message: `cannot point HEAD at ${branch}`, hint: 'check that the fork tree is writable' }
	);
}

/**
 * Move the work tree onto the new tip in three steps, rewriting only the files
 * that actually differ (##MTIME-DISCIPLINE): remove what the tip does not have,
 * bring the index in line with the tip, and check out what is left. Returns the
 * paths that were touched.
 *
 * Paths that exist in the work tree but not at the tip are removed: they belong
 * to a different upstream state, and the guard has already proved there is no
 * unsaved work in them.
 */
function moveWorkTree(treeDir: string, branch: string): readonly string[] {
	// 1. Paths the tree has and the new tip does not. They are removed first,
	// while the index still remembers that git tracks them.
	const drop = diffAgainstHead(treeDir, branch)
		.filter((entry) => entry.status.startsWith('A'))
		.map((entry) => entry.path);
	for (const batch of batches(drop)) {
		gitOk(
			{ args: ['rm', '--quiet', '--force', '--ignore-unmatch', '--', ...batch], cwd: treeDir },
			{
				code: 'ARTIFACT-BROKEN',
				message: `cannot remove ${batch.length} path(s) that do not exist at ${branch}`,
				hint: 're-run with --verbose'
			}
		);
	}

	// 2. Make the index agree with the new tip without touching a single file.
	// Moving HEAD leaves the index describing the previous tip, and a stale
	// index makes `git status` report content that is in fact identical - which
	// the drift guard would then read as unextracted work. `git reset` on named
	// paths rewrites index entries only, so no mtime moves.
	reconcileIndex(treeDir, branch);

	// 3. Now the difference is a real difference of content: rewrite exactly
	// those files (##MTIME-DISCIPLINE).
	const restore = diffAgainstHead(treeDir, branch).map((entry) => entry.path);
	for (const batch of batches(restore)) {
		gitOk(
			{ args: ['checkout', 'HEAD', '--', ...batch], cwd: treeDir },
			{ code: 'ARTIFACT-BROKEN', message: `cannot check out ${batch.length} path(s) of ${branch}`, hint: 're-run with --verbose' }
		);
	}
	return [...restore, ...drop];
}

type DiffEntry = { readonly status: string; readonly path: string };

/** `git diff --name-status HEAD`: the work tree against the current tip. */
function diffAgainstHead(treeDir: string, branch: string): readonly DiffEntry[] {
	const diff = gitOk(
		{ args: ['diff', '--name-status', '--no-renames', '-z', 'HEAD'], cwd: treeDir },
		{ code: 'ARTIFACT-BROKEN', message: `cannot compare the work tree with ${branch}`, hint: 're-run with --verbose' }
	);
	const entries: DiffEntry[] = [];
	const fields = diff.stdout.split('\0');
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const status = fields[index];
		const path = fields[index + 1];
		if (status === undefined || path === undefined || path === '') {
			continue;
		}
		entries.push({ status, path });
	}
	return entries;
}

/** Index entries that disagree with HEAD, reset to HEAD. Files are not read. */
function reconcileIndex(treeDir: string, branch: string): void {
	const staged = gitOk(
		{ args: ['diff-index', '--cached', '--name-only', '-z', 'HEAD'], cwd: treeDir },
		{ code: 'ARTIFACT-BROKEN', message: `cannot compare the index with ${branch}`, hint: 're-run with --verbose' }
	);
	const paths = staged.stdout.split('\0').filter((path) => path !== '');
	for (const batch of batches(paths)) {
		gitOk(
			{ args: ['reset', '--quiet', 'HEAD', '--', ...batch], cwd: treeDir },
			{ code: 'ARTIFACT-BROKEN', message: `cannot bring the index of ${treeDir} in line with ${branch}`, hint: 're-run with --verbose' }
		);
	}
}

function* batches(paths: readonly string[]): Generator<readonly string[]> {
	for (let index = 0; index < paths.length; index += PATH_BATCH) {
		yield paths.slice(index, index + PATH_BATCH);
	}
}

// ---------------------------------------------------------------------------
// --fresh: cleaning untracked content by the whitelist
// ---------------------------------------------------------------------------

/**
 * PROP-011 ##CLEANUP-WHITELIST-CONTENT: `git clean -fdx` is not used. The list of
 * untracked paths (ignored ones included - that is where the build caches are)
 * minus the whitelist is what gets removed. Discipline: what is not on the list
 * goes away.
 */
export function cleanUntracked(treeDir: string, config: CodkitConfig, conventions: Conventions): number {
	// File by file, never `--directory`: a collapsed directory entry would hide
	// whitelisted content nested inside an untracked one (extensions/*/out/
	// under an untracked extensions/, for instance) and take it down with it.
	const listed = new Set<string>([
		...listUntracked(treeDir, ['--others', '--exclude-standard', '-z']),
		...listUntracked(treeDir, ['--others', '--ignored', '--exclude-standard', '-z'])
	]);
	const ownDir = ownTargetRelativeDir(config.ownDirName);
	const emptied = new Set<string>();
	let removed = 0;

	for (const path of [...listed].sort()) {
		if (path === '' || path.startsWith('.git/')) {
			continue;
		}
		// Own code is not litter: it is the materialization of delta/own/.
		if (path === `${ownDir}/` || path === ownDir || path.startsWith(`${ownDir}/`)) {
			continue;
		}
		if (matchesCleanupWhitelist(path, conventions.cleanupWhitelist)) {
			continue;
		}
		rmSync(join(treeDir, ...path.split('/')), { recursive: true, force: true });
		removed += 1;
		collectAncestors(path, emptied);
	}
	pruneEmptyDirectories(treeDir, emptied);
	return removed;
}

function listUntracked(treeDir: string, args: readonly string[]): readonly string[] {
	const result = gitOk(
		{ args: ['ls-files', ...args], cwd: treeDir },
		{ code: 'ARTIFACT-BROKEN', message: `cannot list untracked paths in ${treeDir}`, hint: 're-run with --verbose' }
	);
	return result.stdout.split('\0').filter((path) => path !== '');
}

/**
 * The whitelist is read with the shared gitignore-style matcher of
 * conventions.json (##CLEANUP-WHITELIST-CONTENT). Kept as a named export because
 * the whitelist is what the tests and the callers talk about, not the matcher.
 */
export function matchesCleanupWhitelist(path: string, patterns: readonly string[]): boolean {
	return matchesPatternList(path, patterns);
}

function collectAncestors(relative: string, into: Set<string>): void {
	let at = relative.endsWith('/') ? relative.slice(0, -1) : relative;
	for (;;) {
		const slash = at.lastIndexOf('/');
		if (slash === -1) {
			return;
		}
		at = at.slice(0, slash);
		into.add(at);
	}
}

function pruneEmptyDirectories(root: string, candidates: ReadonlySet<string>): void {
	const ordered = [...candidates].sort((left, right) => right.split('/').length - left.split('/').length);
	for (const relative of ordered) {
		const absolute = join(root, ...relative.split('/'));
		try {
			if (statSync(absolute).isDirectory() && readdirSync(absolute).length === 0) {
				rmdirSync(absolute);
			}
		} catch {
			// Already gone, or not empty: nothing to report.
		}
	}
}

// ---------------------------------------------------------------------------
// Files codkit owns inside the tree
// ---------------------------------------------------------------------------

/**
 * The managed block of .git/info/exclude. Rewritten on every sync and never
 * larger than these three lines; other people's lines in the file are left
 * exactly where they are.
 */
export function writeExclude(treeDir: string, ownDirName: string): void {
	writeExcludePlan(planExclude(treeDir, ownDirName));
}

function planExclude(treeDir: string, ownDirName: string): ExcludePlan {
	const path = join(gitDirOf(treeDir), 'info', 'exclude');
	const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const openers = markerLines(existing, EXCLUDE_BEGIN);
	const closers = markerLines(existing, EXCLUDE_END);
	const eol = preferredEol(existing);
	const body = `/${ownTargetRelativeDir(ownDirName)}/`;

	let next: string;
	if (openers.length === 0 && closers.length === 0) {
		const separation = existing === '' ? '' : endsWithEol(existing) ? eol : `${eol}${eol}`;
		next = `${existing}${separation}${EXCLUDE_BEGIN}${eol}${body}${eol}${EXCLUDE_END}${eol}`;
	} else if (openers.length === 1 && closers.length === 1) {
		const opener = openers[0];
		const closer = closers[0];
		if (opener === undefined || closer === undefined || opener.end > closer.start) {
			throw malformedExclude(path, 'the closing marker appears before the opening marker');
		}
		const blockEol = opener.eol === '' ? eol : opener.eol;
		next = `${existing.slice(0, opener.end)}${body}${blockEol}${existing.slice(closer.start)}`;
	} else {
		throw malformedExclude(
			path,
			`expected zero markers or one ordered pair, found ${openers.length} opening and ${closers.length} closing marker(s)`
		);
	}
	return { path, existing, next };
}

function writeExcludePlan(plan: ExcludePlan): void {
	const current = existsSync(plan.path) ? readFileSync(plan.path, 'utf8') : '';
	if (current !== plan.existing) {
		throw malformedExclude(plan.path, 'the file changed after the preflight scan');
	}
	if (plan.next === plan.existing) {
		return;
	}
	mkdirSync(dirname(plan.path), { recursive: true });
	writeFileSync(plan.path, plan.next, 'utf8');
}

type MarkerLine = { readonly start: number; readonly end: number; readonly eol: string };

function markerLines(text: string, marker: string): readonly MarkerLine[] {
	const found: MarkerLine[] = [];
	let start = 0;
	while (start < text.length) {
		let contentEnd = start;
		while (contentEnd < text.length && text[contentEnd] !== '\n' && text[contentEnd] !== '\r') {
			contentEnd += 1;
		}
		let end = contentEnd;
		let eol = '';
		if (text[contentEnd] === '\r' && text[contentEnd + 1] === '\n') {
			end = contentEnd + 2;
			eol = '\r\n';
		} else if (text[contentEnd] === '\r' || text[contentEnd] === '\n') {
			end = contentEnd + 1;
			eol = text[contentEnd] ?? '';
		}
		if (text.slice(start, contentEnd) === marker) {
			found.push({ start, end, eol });
		}
		if (end === start) {
			break;
		}
		start = end;
	}
	return found;
}

function preferredEol(text: string): string {
	const crlf = text.indexOf('\r\n');
	const lf = text.indexOf('\n');
	const cr = text.indexOf('\r');
	if (crlf !== -1 && (lf === -1 || crlf <= lf) && (cr === -1 || crlf <= cr)) {
		return '\r\n';
	}
	if (lf !== -1 && (cr === -1 || lf < cr)) {
		return '\n';
	}
	return cr === -1 ? '\n' : '\r';
}

function endsWithEol(text: string): boolean {
	return text.endsWith('\n') || text.endsWith('\r');
}

function malformedExclude(path: string, detail: string): CkError {
	return ckError(
		'CONFIG',
		`${path}: malformed codkit managed block: ${detail}`,
		`restore exactly one ${EXCLUDE_BEGIN} / ${EXCLUDE_END} pair or remove both markers, then retry`,
		path
	);
}

/** The hook body; regenerated by every sync, so it cannot drift (PROP-012 sec. 5). */
export const TREE_PRE_COMMIT_HOOK = [
	'#!/bin/sh',
	'# Installed by codkit. Commits in this fork tree are made by codkit only.',
	`if [ "$${INTERNAL_COMMIT_ENV}" != "1" ]; then`,
	'\techo "codkit: manual commits in the fork tree are forbidden;" >&2',
	'\techo "codkit: save your work with: codkit save (from the patchset repo)." >&2',
	'\techo "codkit: This tree is managed by codkit." >&2',
	'\texit 1',
	'fi',
	'exit 0',
	''
].join('\n');

export function writeTreeHook(treeDir: string, out: Output): boolean {
	const path = join(gitDirOf(treeDir), 'hooks', 'pre-commit');
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, TREE_PRE_COMMIT_HOOK, 'utf8');
		chmodSync(path, 0o755);
		return true;
	} catch (error) {
		out.warn(
			`cannot install the fork-tree pre-commit hook ${path}: ${error instanceof Error ? error.message : String(error)}; ` +
				'manual commits in the tree will not be refused',
			'MARK-RO'
		);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function dryRunPlan(options: SyncEngineOptions, plan: readonly Artifact[], context: OverlayVarContext, branch: string): SyncResult {
	const { out } = options;
	const broken: string[] = [];
	for (const artifact of plan) {
		try {
			if (artifact.kind === 'patch') {
				applyPatchAtPin(artifact, options);
			} else if (artifact.kind === 'overlay') {
				renderOverlayTarget(artifact.overlays, options.resolution.path, options.config.pin.sha, context);
			} else {
				assertTargetAtPin(options.resolution.path, options.config.pin.sha, artifact.entry);
			}
		} catch (error) {
			if (!isCkError(error)) {
				throw error;
			}
			broken.push(artifact.artifactPath);
			out.addError(error.toPayload());
		}
	}
	if (broken.length > 0) {
		out.info(`dry run: ${broken.length} of ${plan.length} artifact(s) do not apply at the pin`);
		return result('broken', 1, { branch, artifacts: plan.length, broken });
	}
	out.info(`dry run: ${plan.length} artifact(s), all applicable`);
	return result('dry-run', 0, { branch, artifacts: plan.length });
}

function reportBroken(out: Output, error: unknown, branch: string): SyncResult {
	if (!isCkError(error) || error.code !== 'ARTIFACT-BROKEN') {
		throw error;
	}
	out.addError(error.toPayload());
	return result('broken', 1, { branch, broken: [error.file ?? 'unknown artifact'] });
}

/** What the guard decides about a dirty tree. */
type OwnSideVerdict =
	/** Unextracted work in the tree: CK-E-DIRTY-TREE. */
	| { readonly kind: 'unextracted' }
	/** Both sides edited the same own file: CK-E-BOTH-SIDES-EDITED. */
	| { readonly kind: 'both-sides'; readonly error: CkError }
	/** Only patchset moved: announce it and apply the patchset version. */
	| { readonly kind: 'patchset-side'; readonly text: string };

/**
 * ##PATCHSET-SIDE-EDIT-RULE: own code edited in patchset while the tree is otherwise
 * clean is not "unextracted work" - at sync time patchset is the direction of
 * truth, so the difference is announced and then applied.
 *
 * The sides are told apart file by file, against the own map of the mark
 * (PROP-006 ##TREE-MARK): a file that still equals the mark did not move on that
 * side. When both sides moved away from the mark and from each other, no
 * direction of truth exists and the run stops with CK-E-BOTH-SIDES-EDITED.
 *
 * Without a map - a mark from before it existed, or no mark at all - the classes
 * come out `unknown` and the guard stays strict, exactly as it did before the
 * map: the fingerprint is then the only evidence that patchset is the side that
 * moved.
 */
function judgeOwnSides(
	drift: { readonly upstream: readonly string[]; readonly own: readonly OwnDivergence[] },
	patchesDir: string,
	treeDir: string,
	ownDirName: string,
	mark: TreeMark | null,
	fingerprint: string
): OwnSideVerdict {
	if (drift.upstream.length > 0) {
		return { kind: 'unextracted' };
	}
	const map = mark?.ownFiles ?? null;
	const classes = classifyOwn(patchesDir, treeDir, ownDirName, map).filter((entry) => entry.kind !== 'same');
	const bothSides = classes.find((entry) => entry.kind === 'both-edited');
	if (bothSides !== undefined) {
		return { kind: 'both-sides', error: bothSidesError(bothSides.relative) };
	}
	if (classes.some((entry) => entry.kind === 'tree-edited')) {
		return { kind: 'unextracted' };
	}
	const changed = classes.filter((entry) => entry.kind === 'patchset-edited');
	if (changed.length > 0) {
		return { kind: 'patchset-side', text: patchsetSideText(changed.map((entry) => entry.relative)) };
	}
	// No map: fall back to the evidence the fingerprint gives (a tree file that
	// exists only in the tree is unextracted work whatever the fingerprint says).
	if (mark === null || mark.deltaFingerprint === fingerprint) {
		return { kind: 'unextracted' };
	}
	if (drift.own.some((divergence) => divergence.kind === 'tree-only')) {
		return { kind: 'unextracted' };
	}
	const unknown = drift.own.filter((divergence) => divergence.kind === 'both');
	if (unknown.length === 0) {
		return { kind: 'unextracted' };
	}
	return { kind: 'patchset-side', text: patchsetSideText(unknown.map((divergence) => divergence.relative)) };
}

function patchsetSideText(relatives: readonly string[]): string {
	const names = relatives.map((relative) => `${OWN_SOURCE_DIR}/${relative}`).join(', ');
	return `own code was edited in patchset since this tree was last synced (${names}); the patchset version is being applied over the tree`;
}

/** The one diagnostic both `sync` and `save` raise for a two-sided own edit. */
export function bothSidesError(relative: string): CkError {
	return ckError(
		'BOTH-SIDES-EDITED',
		'own code was edited in patchset and in the fork tree, in different ways',
		'resolve manually: keep one side, then codkit sync/save',
		`${OWN_SOURCE_DIR}/${relative}`
	);
}

function reportOwn(out: Output, own: OwnSyncReport): void {
	out.info(`own code: ${own.total} file(s), ${own.copied} copied, ${own.removed} removed`);
}

/**
 * The variable context of the config-overlay layer (PROP-005 ##OVERLAY-VARS).
 * Exported because `overlay apply|check` materializes the same values outside a
 * sync, and two definitions of `build.date` would be one too many.
 */
export function overlayVarContext(config: CodkitConfig, pinDateIso: string, patchSetCommit: string): OverlayVarContext {
	return {
		pinTag: config.pin.tag,
		pinSha: config.pin.sha,
		pinDate: config.pin.date,
		patchSetCommit,
		// Deterministic by construction: the wall clock would make the dev
		// channel differ between two runs of the same sync.
		buildDate: pinDateIso
	};
}

type ResultParts = {
	readonly branch: string;
	readonly branchTip?: string | null;
	readonly artifacts?: number;
	readonly own?: OwnSyncReport;
	readonly cleaned?: number;
	readonly changedPaths?: readonly string[];
	readonly nonPatchTargets?: readonly string[];
	readonly generatedOwnPaths?: readonly string[];
	readonly dirtyFiles?: readonly string[];
	readonly broken?: readonly string[];
	readonly fastPathReason?: string;
};

function result(status: SyncStatus, exitCode: number, parts: ResultParts): SyncResult {
	const changedPaths = parts.changedPaths ?? [];
	return {
		exitCode,
		status,
		branch: parts.branch,
		branchTip: parts.branchTip ?? null,
		artifacts: parts.artifacts ?? 0,
		own: parts.own ?? NO_OWN,
		cleaned: parts.cleaned ?? 0,
		changedFiles: changedPaths.length,
		changedPaths,
		nonPatchTargets: parts.nonPatchTargets ?? [],
		generatedOwnPaths: parts.generatedOwnPaths ?? [],
		dirtyFiles: parts.dirtyFiles ?? [],
		broken: parts.broken ?? [],
		fastPathReason: parts.fastPathReason ?? null
	};
}

/** git takes forward slashes on every platform; paths in argv are converted. */
export function toPosix(path: string): string {
	return path.split('\\').join('/');
}

/** The generated branch of a pin; the command names it in its output. */
export function generatedBranchName(config: CodkitConfig): string {
	return `${config.generatedBranchPrefix}${config.pin.tag}`;
}
