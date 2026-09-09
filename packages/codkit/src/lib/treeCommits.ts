/** @scope spec://codkit/modules/codkit/PROP-008#TREE-COMMITS-ARE-WORK */
// Commits made in the fork tree are work (PROP-008 ##TREE-COMMITS-ARE-WORK):
// both other halves of the drift guard are blind to them, and before this
// detector existed the next `load` rebuilt the branch over such a commit and
// left the work reachable only through the reflog. The walk is first-parent
// only, from HEAD and from the generated branch, with the topmost generated
// commit as the base (##TREE-IS-TRUTH: read from the line itself, never from
// the cache or the mark) and the pin as the lower boundary.

import { gitOk, runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import type { CkError } from './messages.ts';
import { revParse, symbolicHead } from './treeCache.ts';
import { acquireCommonRepositoryLock } from './worktrees.ts';

/** Identity of every generated commit; fixed, so the shas are reproducible. */
export const COMMIT_AUTHOR_NAME = 'codkit';
export const COMMIT_AUTHOR_EMAIL = 'codkit@patchset.invalid';

/** Namespace that keeps consumed tree commits reachable (PROP-006 ##CONSUMED-REFS). */
export const CONSUMED_REF_PREFIX = 'refs/codkit/consumed/';

/** One commit of the tree's first-parent line that patchset does not carry. */
export type TreeCommit = {
	readonly sha: string;
	readonly subject: string;
	readonly authorName: string;
	readonly authorEmail: string;
	/** Author date, ISO-8601, as the commit records it. */
	readonly authorDate: string;
};

/** A foreign commit below the topmost generated one: the line was rewritten. */
export type TreeAnomaly = {
	readonly line: 'branch' | 'head';
	readonly commit: TreeCommit;
	/** Generated tip below which the foreign commit sits. */
	readonly base: string;
};

/** The D2 state of one tree: what is work and where HEAD stands relative to it. */
export type TreeCommits = {
	/** Topmost generated commit of the defining line; the pin when there is none. */
	readonly base: string;
	readonly head: string;
	/** Ref HEAD points at; null while detached. */
	readonly headRef: string | null;
	readonly onGeneratedBranch: boolean;
	readonly branchExists: boolean;
	/** Foreign commits of the HEAD line, oldest to newest. */
	readonly headCommits: readonly TreeCommit[];
	/** Foreign commits on the generated branch line; empty while HEAD is on it. */
	readonly branchCommits: readonly TreeCommit[];
	/** Everything the guard reports: the branch line first, then the HEAD line. */
	readonly commits: readonly TreeCommit[];
	readonly anomaly: TreeAnomaly | null;
};

/**
 * Find the foreign commits of a tree (D2). Reads only; the anomaly is returned
 * as data because the refusal is the caller's to phrase - `load`, `save` and
 * `ci` all speak with their own voice - and because `status` reports the same
 * state without refusing.
 */
export function foreignCommits(treeDir: string, pinSha: string, branch: string): TreeCommits {
	const ref = `refs/heads/${branch}`;
	const branchTip = revParse(treeDir, ref);
	const head = revParse(treeDir, 'HEAD');
	if (head === null) {
		throw ckError('NOT-A-REPO', `cannot resolve HEAD in ${treeDir}`, 'check that the fork tree is a healthy git work tree');
	}
	const headRef = symbolicHead(treeDir);
	const headLine = walkLine(treeDir, 'HEAD', pinSha, 'head');
	// On the generated branch HEAD *is* the branch tip: one walk answers both
	// questions, and counting the line twice would double every commit.
	const branchLine = branchTip === null ? null : walkLine(treeDir, ref, pinSha, 'branch');
	const onGeneratedBranch = headRef === ref;
	const branchCommits = branchLine?.commits ?? [];
	const headCommits = onGeneratedBranch ? branchCommits : headLine.commits;
	const commits = onGeneratedBranch
		? branchCommits
		: [...branchCommits, ...headCommits.filter((commit) => !branchCommits.some((other) => other.sha === commit.sha))];
	return {
		base: branchLine?.base ?? headLine.base,
		head,
		headRef,
		onGeneratedBranch,
		branchExists: branchTip !== null,
		headCommits,
		branchCommits,
		commits,
		anomaly: branchLine?.anomaly ?? headLine.anomaly
	};
}

/**
 * The D8 refusals, as one diagnosable value: a rewritten line below the
 * generated tip (the anomaly of D2 item 4), or a HEAD that sits outside the
 * generated branch while carrying work. Null when the state needs no refusal.
 */
export function treeHeadError(state: TreeCommits, branch: string): CkError | null {
	if (state.anomaly !== null) {
		return ckError(
			'TREE-HEAD',
			`history of ${branch} below the generated tip was rewritten: ${short(state.anomaly.commit.sha)} sits below ${short(state.anomaly.base)}`,
			`reset the branch to ${short(state.anomaly.base)} or restore it from ${CONSUMED_REF_PREFIX}...`
		);
	}
	if (state.branchExists && !state.onGeneratedBranch && state.headCommits.length > 0) {
		return ckError(
			'TREE-HEAD',
			`HEAD is on ${state.headRef ?? 'detached'} with ${state.headCommits.length} commit(s) not in patchset`,
			`switch to ${branch} (git switch ${branch}) or merge them there, then run codkit save`
		);
	}
	return null;
}

/**
 * Keep consumed or discarded tree commits reachable (PROP-006 ##CONSUMED-REFS):
 * `refs/codkit/consumed/<UTC yyyymmddThhmmssZ>-<short7>` pointing at the tree's
 * former HEAD. The refs are shared by every worktree of the repository, so the
 * update runs under the common-repository lock like every shared-ref write.
 * Returns the full ref name for the caller's report.
 */
export function recordConsumedRef(treeDir: string, sha: string, now: () => Date = () => new Date()): string {
	const coordination = acquireCommonRepositoryLock(treeDir, `consumed ref for ${sha.slice(0, 7)}`);
	try {
		return writeConsumedRef(treeDir, sha, now);
	} finally {
		coordination.release();
	}
}

/**
 * The ref write itself, for a caller already holding the common-repository
 * lock (`load --discard` writes it inside its guarded generated-ref section,
 * before the rebuild makes the commits unreachable - there the ref is the only
 * keeper, and taking the lock twice for one mutation would deadlock the
 * protocol). Everyone else uses `recordConsumedRef`.
 */
export function writeConsumedRef(treeDir: string, sha: string, now: () => Date = () => new Date()): string {
	const stamp = now()
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
	const ref = `${CONSUMED_REF_PREFIX}${stamp}-${sha.slice(0, 7)}`;
	gitOk(
		{ args: ['update-ref', ref, sha], cwd: treeDir },
		{
			code: 'INTERNAL',
			message: `cannot record consumed ref ${ref}`,
			hint: 'check that the fork repository is writable'
		}
	);
	return ref;
}

// ---------------------------------------------------------------------------
// The rev-list walk
// ---------------------------------------------------------------------------

type LineWalk = {
	readonly base: string;
	readonly commits: readonly TreeCommit[];
	readonly anomaly: TreeAnomaly | null;
};

/**
 * D2's field list. The format is not NUL-clean (finding S0.2): every record is
 * preceded by its own `commit <sha>` line, and the trailers placeholder adds a
 * newline of its own, so records are cut on the separator line and only then
 * split on NUL. `%ae` is the recorded author the generated check reads; `%aN`
 * and `%aE` are the names the record shows a human.
 */
const REV_LIST_FORMAT = '%H%x00%ae%x00%(trailers:key=Codkit-Upstream-Pin,valueonly)%x00%aN%x00%aE%x00%aI%x00%s';

const REV_LIST_SEPARATOR = /^commit ([0-9a-f]{40})\n/m;

export type RevListRecord = {
	readonly sha: string;
	/** %ae: the recorded author email, untouched by mailmap. */
	readonly recordedAuthorEmail: string;
	/** Value of the Codkit-Upstream-Pin trailer; empty when the commit has none. */
	readonly pinTrailer: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly authorDate: string;
	readonly subject: string;
};

function walkLine(treeDir: string, ref: string, pinSha: string, line: 'branch' | 'head'): LineWalk {
	const result = runGit({ args: ['rev-list', '--first-parent', `--format=${REV_LIST_FORMAT}`, ref, `^${pinSha}`], cwd: treeDir });
	if (result.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`git rev-list failed in ${treeDir}: ${firstLine(result.stderr)}`,
			'check that the fork tree is a healthy git work tree'
		);
	}
	const records = parseRevListRecords(result.stdout);
	const baseIndex = records.findIndex((record) => isGenerated(record));
	// No generated commit on the line: the pin is the base (the empty-patchset
	// state of a tree that was never loaded, or a branch that does not exist).
	const base = baseIndex === -1 ? pinSha : (records[baseIndex]?.sha ?? pinSha);
	const foreign = baseIndex === -1 ? records : records.slice(0, baseIndex);
	// Without a generated commit on the line the pin is the base and everything
	// walked is above it; "below the base" starts only at a real base.
	const below = baseIndex === -1 ? [] : records.slice(baseIndex + 1);
	const stray = below.find((record) => !isGenerated(record));
	return {
		base,
		// rev-list answers newest first; work is reported oldest first.
		commits: foreign.map(toTreeCommit).reverse(),
		anomaly: stray === undefined ? null : { line, commit: toTreeCommit(stray), base }
	};
}

/** Parse `rev-list --format` output as S0.2 established it (see REV_LIST_FORMAT). */
export function parseRevListRecords(stdout: string): readonly RevListRecord[] {
	if (stdout === '') {
		return [];
	}
	// The capturing group makes split() yield [preamble, sha, body, sha, body...].
	const parts = stdout.split(REV_LIST_SEPARATOR);
	const records: RevListRecord[] = [];
	for (let index = 1; index < parts.length; index += 2) {
		const sha = parts[index];
		const body = parts[index + 1];
		if (sha === undefined || body === undefined) {
			continue;
		}
		// fields[0] is %H again - the separator already carried the sha - so the
		// record reads the remaining six: %ae, trailer, %aN, %aE, %aI, %s.
		const fields = body.split('\0');
		if (fields.length !== 7) {
			throw ckError('INTERNAL', `malformed git rev-list record for ${sha}: ${fields.length} field(s)`, 're-run with --verbose');
		}
		records.push({
			sha,
			recordedAuthorEmail: fields[1] ?? '',
			pinTrailer: stripTrailingNewlines(fields[2] ?? ''),
			authorName: fields[3] ?? '',
			authorEmail: fields[4] ?? '',
			authorDate: fields[5] ?? '',
			subject: stripTrailingNewlines(fields[6] ?? '')
		});
	}
	return records;
}

/** Generated means both markers of F13: the fixed author and the pin trailer. */
function isGenerated(record: RevListRecord): boolean {
	return record.recordedAuthorEmail === COMMIT_AUTHOR_EMAIL && record.pinTrailer.trim() !== '';
}

function toTreeCommit(record: RevListRecord): TreeCommit {
	return {
		sha: record.sha,
		subject: record.subject,
		authorName: record.authorName,
		authorEmail: record.authorEmail,
		authorDate: record.authorDate
	};
}

function stripTrailingNewlines(field: string): string {
	return field.replace(/\n+$/, '');
}

function short(sha: string): string {
	return sha.slice(0, 8);
}

function firstLine(text: string): string {
	const trimmed = text.trim();
	if (trimmed === '') {
		return 'no output';
	}
	const [line] = trimmed.split('\n');
	return line ?? 'no output';
}
