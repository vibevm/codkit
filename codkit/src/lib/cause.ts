/** @scope spec://codkit/modules/codkit/PROP-008#cause */
// Find the upstream commit that made an artifact need adaptation.
//
// Every git operation in this module is read-only. The runner is injectable so
// callers and tests can preserve that boundary without constructing a worktree.

import { runGit } from './gitx.ts';
import type { GitResult, RunGitOptions } from './gitx.ts';
import { ckError } from './messages.ts';

export type Cause = {
	readonly sha: string;
	readonly approx: boolean;
};

/** Inclusive line range in the file at oldPin, derived from a patch hunk. */
export type CauseRange = {
	readonly start: number;
	readonly end: number;
};

export type FindCauseOptions = {
	readonly cwd: string;
	readonly oldPin: string;
	readonly newPin: string;
	/** Repository-relative upstream path at oldPin. */
	readonly target: string;
	/** Affected oldPin ranges, one per relevant artifact hunk. */
	readonly ranges: readonly CauseRange[];
	/** Known lifecycle outcome from classification/rename detection. */
	readonly lifecycle?: { readonly outcome: 'target-deleted' } | { readonly outcome: 'target-renamed'; readonly newTarget: string };
};

export type CauseGitRunner = (options: RunGitOptions) => GitResult;

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * Find a cause between two pins.
 *
 * Git lists commits newest first. Multi-commit histories are tested oldest
 * first against cumulative diffs whose old side is always oldPin, so patch
 * ranges never drift into the line coordinates of a later endpoint.
 */
export function findCause(options: FindCauseOptions, git: CauseGitRunner = runGit): Cause {
	validateOptions(options);
	const revisionRange = `${options.oldPin}..${options.newPin}`;
	if (options.lifecycle !== undefined) {
		return findLifecycleCause(options, revisionRange, git);
	}
	const pathspec = literalPathspec(options.target);
	const fileLog = run(
		git,
		{
			args: ['log', '--format=%H', '--follow', revisionRange, '--', pathspec],
			cwd: options.cwd
		},
		options.target,
		'list commits that touched the target'
	);
	const fileCommits = uniqueShas(fileLog.stdout);

	if (fileCommits.length === 0) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot find a cause for ${options.target}: no commits touched it in ${revisionRange}`,
			'check the old and new pins and make sure the artifact target is the upstream path at the old pin',
			options.target
		);
	}
	if (fileCommits.length === 1) {
		return { sha: requiredAt(fileCommits, 0), approx: false };
	}
	if (options.ranges.length === 0) {
		return { sha: requiredAt(fileCommits, fileCommits.length - 1), approx: true };
	}

	for (const sha of [...fileCommits].reverse()) {
		const diff = run(
			git,
			{
				args: [
					'diff',
					'--unified=0',
					'--inter-hunk-context=0',
					'--diff-algorithm=myers',
					'--no-indent-heuristic',
					'--no-renames',
					'--no-color',
					'--text',
					options.oldPin,
					sha,
					'--',
					pathspec
				],
				cwd: options.cwd
			},
			options.target,
			`compare old-pin ranges with commit ${sha}`
		);
		if (diffTouchesRanges(diff.stdout, options.ranges)) {
			return { sha, approx: false };
		}
	}

	return { sha: requiredAt(fileCommits, fileCommits.length - 1), approx: true };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;

function diffTouchesRanges(diff: string, ranges: readonly CauseRange[]): boolean {
	for (const line of diff.split('\n')) {
		const match = HUNK_HEADER.exec(line);
		if (match === null) {
			continue;
		}
		const start = Number.parseInt(match[1] ?? '', 10);
		const count = Number.parseInt(match[2] ?? '1', 10);
		if (ranges.some((range) => hunkTouchesRange(start, count, range))) {
			return true;
		}
	}
	return false;
}

function hunkTouchesRange(start: number, count: number, range: CauseRange): boolean {
	if (count === 0) {
		// An insertion after old line N touches the old range envelope from
		// immediately before its first line through immediately after its last.
		return start >= range.start - 1 && start <= range.end;
	}
	return start <= range.end && start + count - 1 >= range.start;
}

function findLifecycleCause(options: FindCauseOptions, revisionRange: string, git: CauseGitRunner): Cause {
	const lifecycle = options.lifecycle;
	if (lifecycle === undefined) {
		throw ckError('INTERNAL', 'lifecycle cause selection lost its outcome');
	}
	const target = lifecycle.outcome === 'target-renamed' ? lifecycle.newTarget : options.target;
	const filter = lifecycle.outcome === 'target-renamed' ? 'R' : 'D';
	const lifecycleLog = run(
		git,
		{
			args: ['log', '--format=%H', `--diff-filter=${filter}`, '--follow', revisionRange, '--', literalPathspec(target)],
			cwd: options.cwd
		},
		target,
		`find the ${lifecycle.outcome === 'target-renamed' ? 'rename' : 'deletion'} commit`
	);
	const cause = uniqueShas(lifecycleLog.stdout)[0];
	if (cause === undefined) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot find the ${lifecycle.outcome === 'target-renamed' ? 'rename' : 'deletion'} commit for ${target} in ${revisionRange}`,
			'check that the lifecycle outcome and both pins describe the same upstream history',
			target
		);
	}
	return { sha: cause, approx: false };
}

function literalPathspec(path: string): string {
	return `:(top,literal)${path}`;
}

function run(git: CauseGitRunner, options: RunGitOptions, target: string, action: string): GitResult {
	const result = git(options);
	if (result.status === 0) {
		return result;
	}
	const detail = firstLine(result.stderr) ?? firstLine(result.stdout) ?? `git exited with status ${result.status}`;
	throw ckError(
		'INTERNAL',
		`cannot ${action} while finding a cause for ${target}: ${detail}`,
		'check that both pins exist locally and that the upstream repository is readable',
		target
	);
}

function validateOptions(options: FindCauseOptions): void {
	if (options.lifecycle?.outcome === 'target-renamed' && options.lifecycle.newTarget.trim() === '') {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot find a rename cause for ${options.target}: the new target path is empty`,
			'pass the repository-relative target path selected by rename detection',
			options.target
		);
	}
	for (const range of options.ranges) {
		if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 || range.end < range.start) {
			throw ckError(
				'ARTIFACT-BROKEN',
				`cannot find a cause for ${options.target}: invalid old-pin line range ${range.start}..${range.end}`,
				'affected ranges are inclusive, one-based, and must have end greater than or equal to start',
				options.target
			);
		}
	}
}

function uniqueShas(stdout: string): readonly string[] {
	const seen = new Set<string>();
	const shas: string[] = [];
	for (const line of stdout.split('\n')) {
		const sha = line.trim();
		if (FULL_SHA.test(sha) && !seen.has(sha)) {
			seen.add(sha);
			shas.push(sha);
		}
	}
	return shas;
}

function firstLine(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === '') {
		return null;
	}
	return trimmed.split('\n')[0] ?? null;
}

function requiredAt(values: readonly string[], index: number): string {
	const value = values[index];
	if (value === undefined) {
		throw ckError('INTERNAL', 'cause selection lost the commits returned by git');
	}
	return value;
}
