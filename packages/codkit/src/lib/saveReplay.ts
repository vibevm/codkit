/** @scope spec://codkit/modules/codkit/PROP-008#SAVE-REPLAYS-TREE-COMMITS */
// The replay half of `save` over tree commits (PROP-008 sec. 4, campaign
// decision D5): every foreign commit of the fork tree becomes one patchset
// commit with the original message, author and date plus a `Codkit-Tree-Commit`
// trailer - the "rebase and merge" of a pull request, with `--squash` as the
// "squash and merge".
//
// The planning is two-pass on purpose. Pass 1 (`planStates`) validates every
// state - each commit, then the worktree remainder - over an in-memory
// ArtifactStore that overlays `delta/patches` and `.codkit/pending`, so a file
// planned for S_2 is planned against the artifact S_1 just produced, not
// against the one on disk. A state that cannot be planned refuses the whole
// save naming its sha and subject, and nothing is written: a half-replayed
// delta is worse than one the developer has to fix and re-run. Only pass 2
// (`writeStates`) writes artifacts and commits them, one state at a time, so
// the patchset history holds the state of each tree commit as it stood.
//
// Idempotency is grep-based, not hope-based: a commit whose trailer is already
// in patchset history (a run interrupted after its commit) is skipped rather
// than duplicated, and the remaining ones are replayed on top.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './gitx.ts';
import { badCause } from './hooksPatchSet.ts';
import type { Output } from './jsonOut.ts';
import { ckError, isCkError } from './messages.ts';
import type { CkError } from './messages.ts';
import { readPendingHeader } from './pendingHeader.ts';
import { readRebasePending } from './rebaseOntoPinPending.ts';
import type { RebasePendingOverride } from './rebaseOntoPinPending.ts';
import type { PlannedFile } from './saveEngine.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import type { TreeCommit } from './treeCommits.ts';
import { materializerOf, ownExtensionTreePrefixes } from './layers/ownExtensions.ts';
import { loadOwnManifest } from './layers/ownManifest.ts';
import { changesSince } from './treeState.ts';
import type { StateChange, TreeState } from './treeState.ts';
import type { ProjectType } from '@codkit/type-api';
import type { OwnedRoot } from './ownedRoots.ts';

/** The trailer that ties a patchset commit to the tree commit it replays. */
export const TREE_COMMIT_TRAILER = 'Codkit-Tree-Commit';

/**
 * The artifact layer of one planning pass: an in-memory overlay over
 * `delta/patches` and the pending drafts of the patchset root. Planning a state
 * records what it would write, and the next state reads the recorded bytes
 * instead of the ones on disk - the disk still holds the pre-save state until
 * pass 2 starts. A target whose pending draft (or rebase pending record) was
 * consumed by an earlier state reads as having none, exactly as it will after
 * the writes of that earlier state land.
 */
export class ArtifactStore {
	private readonly patchesDir: string;
	private readonly overlay = new Map<string, Uint8Array | null>();
	private readonly consumedPendingTargets = new Set<string>();

	constructor(patchesDir: string) {
		this.patchesDir = patchesDir;
	}

	/** Artifact bytes relative to the patchset root; null when absent. */
	read(artifact: string): Uint8Array | null {
		const overlaid = this.overlay.get(artifact);
		if (overlaid !== undefined) {
			return overlaid;
		}
		const absolute = join(this.patchesDir, ...artifact.split('/'));
		return existsSync(absolute) ? readFileSync(absolute) : null;
	}

	write(artifact: string, bytes: Uint8Array): void {
		this.overlay.set(artifact, bytes);
	}

	remove(artifact: string): void {
		this.overlay.set(artifact, null);
	}

	/** The draft of `marker new`, hidden once a planned state consumed it. */
	readPendingHeader(target: string) {
		return this.consumedPendingTargets.has(target) ? null : readPendingHeader(this.patchesDir, target);
	}

	/** The rebase pending record, hidden by the same rule. */
	readRebasePending(target: string): RebasePendingOverride | null {
		return this.consumedPendingTargets.has(target) ? null : readRebasePending(this.patchesDir, target);
	}

	/** Record one file's plan: the overlay takes its bytes (or its removal). */
	apply(plan: PlannedFile): void {
		if (plan.action === 'removed') {
			this.remove(plan.artifact);
		} else if (plan.action === 'created' || plan.action === 'updated') {
			if (plan.bytes !== null) {
				this.write(plan.artifact, plan.bytes);
			}
		}
		if (plan.consumesPending) {
			this.consumedPendingTargets.add(plan.target);
		}
	}
}

/** `planFile` of the save engine, bound to one run; the store travels with it. */
export type PlanFileFn = (entry: StateChange, state: TreeState, store: ArtifactStore) => PlannedFile | null;

/** One foreign commit planned for replay: its identity, message and file plans. */
export type PlannedCommitState = {
	readonly commit: TreeCommit;
	/** The tree commit's message verbatim, the base of the patchset commit. */
	readonly message: string;
	readonly plans: readonly PlannedFile[];
};

/** Pass 1 over every state; nothing here has touched the disk. */
export type PlannedReplay = {
	/** Foreign commits not yet in patchset, oldest to newest, all validated. */
	readonly states: readonly PlannedCommitState[];
	/** Foreign commits whose trailer is already in patchset history. */
	readonly skipped: readonly TreeCommit[];
	/** The worktree remainder planned last, over the store the states filled. */
	readonly worktreePlans: readonly PlannedFile[];
	/** Refusals, each naming the state it came from; nonempty blocks pass 2. */
	readonly errors: readonly CkError[];
};

/** Pass 2 outcome for the callers' reports. */
export type ReplayWrites = {
	readonly commits: readonly string[];
	/** States whose staged delta was empty: no patchset commit, said out loud. */
	readonly emptyStates: readonly TreeCommit[];
	readonly written: number;
};

export type PlanStatesInput = {
	readonly patchesDir: string;
	/** The project type of the patch set. */
	readonly type: ProjectType;
	readonly tree: string;
	/** The last applied tip; every state is read as a diff against it (D4). */
	readonly base: string;
	readonly roots: readonly OwnedRoot[];
	readonly forcedPaths: readonly string[];
	readonly commits: readonly TreeCommit[];
	readonly planFile: PlanFileFn;
	readonly workspace?: WorkspaceRecord;
};

/**
 * Pass 1 (D5): plan every state of the run - each foreign commit not already
 * replayed, then the worktree - over one store, collecting every refusal
 * instead of stopping at the first. An error from a commit state is prefixed
 * with that commit's sha and subject, because "line 41" means nothing when the
 * line came from a commit three states back; worktree errors keep today's
 * wording, being about files the caller can see.
 */
export function planStates(input: PlanStatesInput): PlannedReplay {
	const store = new ArtifactStore(input.patchesDir);
	const states: PlannedCommitState[] = [];
	const skipped: TreeCommit[] = [];
	const errors: CkError[] = [];

	for (const commit of input.commits) {
		if (alreadyReplayed(input.patchesDir, commit.sha)) {
			skipped.push(commit);
			continue;
		}
		const message = commitMessageOf(input.tree, commit.sha);
		const cause = badCause(message);
		if (cause !== null) {
			errors.push(causeRefusal(commit, cause));
			continue;
		}
		const plans = planEntriesOf(input, { kind: 'commit', sha: commit.sha }, store, commit, errors);
		states.push({ commit, message, plans });
	}

	const worktreePlans = planEntriesOf(input, { kind: 'worktree' }, store, null, errors);
	return { states, skipped, worktreePlans, errors };
}

function planEntriesOf(
	input: PlanStatesInput,
	state: TreeState,
	store: ArtifactStore,
	commit: TreeCommit | null,
	errors: CkError[]
): PlannedFile[] {
	const plans: PlannedFile[] = [];
	// ##OWN-EXTENSION-UNIT: the replay selects upstream work exactly like the
	// direct path, so the tree roots the own-extension layer supplies are not
	// upstream files here either.
	const materializer = materializerOf(input.type);
	const ownedPrefixes = materializer === null ? [] : ownExtensionTreePrefixes(materializer, loadOwnManifest(input.patchesDir).extensions);
	for (const entry of changesSince(input.tree, input.base, state, input.roots, input.forcedPaths, ownedPrefixes, input.workspace)) {
		try {
			const plan = input.planFile(entry, state, store);
			if (plan !== null) {
				plans.push(plan);
				store.apply(plan);
			}
		} catch (error) {
			if (!isCkError(error)) {
				throw error;
			}
			errors.push(commit === null ? error : namedByState(commit, error));
		}
	}
	return plans;
}

/** Prefix a refusal with the commit it came from, keeping its code and hint. */
function namedByState(commit: TreeCommit, error: CkError): CkError {
	return ckError(
		error.code,
		`tree commit ${commit.sha.slice(0, 8)} "${commit.subject}": ${error.message}`,
		error.hint,
		error.file,
		error.line
	);
}

export type WriteStatesInput = {
	readonly states: readonly PlannedCommitState[];
	readonly out: Output;
	/** Write one state's plans to disk (the engine's `commitArtifacts`). */
	readonly writeArtifacts: (plans: readonly PlannedFile[]) => number;
	/** Stage and commit one state in patchset; null when nothing staged. */
	readonly commitState: (state: PlannedCommitState) => string | null;
	/** Test-only observation point after each durable patchset commit. */
	readonly checkpoint?: (stage: 'state-committed', sha: string) => void;
};

/**
 * Pass 2 (D5): write and commit the planned states, oldest first. A state whose
 * staged delta is empty is skipped with a message - an empty tree commit is
 * still consumed work, but there is nothing to say in patchset history for it.
 */
export function writeStates(input: WriteStatesInput): ReplayWrites {
	const commits: string[] = [];
	const emptyStates: TreeCommit[] = [];
	let written = 0;
	for (const state of input.states) {
		written += input.writeArtifacts(state.plans);
		const sha = input.commitState(state);
		if (sha === null) {
			emptyStates.push(state.commit);
			continue;
		}
		commits.push(sha);
		input.checkpoint?.('state-committed', sha);
	}
	return { commits, emptyStates, written };
}

/**
 * The replay commit message: the tree commit verbatim, a blank line, then the
 * trailer. The separator is unconditional on purpose - `appendTrailer` guesses
 * from the shape of the last line, and a subject like `work: fix the thing`
 * has exactly the shape of a trailer, which would glue the trailer into the
 * subject paragraph where neither git nor a human reads it as a trailer.
 */
export function replayCommitMessage(message: string, sha: string): string {
	return `${message.trimEnd()}\n\n${TREE_COMMIT_TRAILER}: ${sha}\n`;
}

/**
 * Idempotency (D5): a patchset commit carrying this trailer means the state is
 * already replayed - an interrupted run left it behind, and re-running must not
 * duplicate it.
 */
export function alreadyReplayed(patchesDir: string, sha: string): boolean {
	const found = runGit({
		args: ['log', '--fixed-strings', `--grep=${TREE_COMMIT_TRAILER}: ${sha}`, '-1', '--format=%H'],
		cwd: patchesDir
	});
	return found.status === 0 && found.stdout.trim() !== '';
}

/** The full message of a tree commit (`%B`), the verbatim base of the replay. */
export function commitMessageOf(treeDir: string, sha: string): string {
	const shown = runGit({ args: ['show', '--quiet', '--format=%B', sha], cwd: treeDir });
	if (shown.status !== 0) {
		throw ckError(
			'INTERNAL',
			`cannot read the message of tree commit ${sha.slice(0, 8)} in ${treeDir}`,
			're-run with --verbose and attach the output to a bug report'
		);
	}
	return shown.stdout;
}

function causeRefusal(commit: TreeCommit, value: string): CkError {
	return ckError(
		'CONFIG',
		`tree commit ${commit.sha.slice(0, 8)} "${commit.subject}": the Cause: trailer must be a 40-character upstream sha, got "${value}"`,
		'write "Cause: <40 hex>" for the upstream commit that forced this change, or drop the trailer; ' +
			'the message becomes a patchset commit as-is, and the patchset hook never runs for it'
	);
}

// ---------------------------------------------------------------------------
// Test-only crash injection through the real CLI (the shape of
// cycleTestCrash.ts): the environment variable names a stage, the checkpoint
// hard-exits the first time the stage is reached, and both are refused outside
// the test runtime.
// ---------------------------------------------------------------------------

export const SAVE_REPLAY_CRASH_ENV = 'CODKIT_TEST_SAVE_REPLAY_CRASH_AT';
export const SAVE_REPLAY_CRASH_EXIT_CODE = 86;
export const SAVE_REPLAY_CRASH_STAGES = ['state-committed'] as const;

export type SaveReplayCrashStage = (typeof SAVE_REPLAY_CRASH_STAGES)[number];

export function saveReplayCrashCheckpoint(
	crashAt: unknown,
	testBuild: boolean,
	terminate: (exitCode: number) => never = hardExit
): ((stage: SaveReplayCrashStage, sha: string) => void) | undefined {
	if (crashAt === undefined || crashAt === '') {
		return undefined;
	}
	if (!SAVE_REPLAY_CRASH_STAGES.includes(crashAt as SaveReplayCrashStage)) {
		throw ckError(
			'CONFIG',
			`${SAVE_REPLAY_CRASH_ENV} names an unknown save replay stage`,
			`use one of: ${SAVE_REPLAY_CRASH_STAGES.join(', ')}`
		);
	}
	if (!testBuild) {
		throw ckError(
			'CONFIG',
			`${SAVE_REPLAY_CRASH_ENV} is disabled outside the test runtime`,
			'unset the test-only crash injection variable'
		);
	}
	return (stage) => {
		if (stage === crashAt) {
			terminate(SAVE_REPLAY_CRASH_EXIT_CODE);
		}
	};
}

function hardExit(exitCode: number): never {
	// Deliberately bypasses catch/finally, matching an uncatchable process loss
	// at the exact boundary the stage names.
	process.exit(exitCode);
}
