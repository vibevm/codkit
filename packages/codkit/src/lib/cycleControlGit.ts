/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { pinKey } from './pinIdentity.ts';
import { treeId } from './fingerprint.ts';
import { acquireLock } from './lock.ts';
import type { LockHandle } from './lock.ts';
// Git/ref/object-database side of cycle control. Keeping this seam separate
// makes the transaction orchestrator small and lets tests inject every Git
// result without weakening the production wrapper's isolation rules.

import { realpathSync } from 'node:fs';
import type { CodkitConfig, PinConfig } from './configFile.ts';
import { CONFIG_FILE_NAME, parseBaseConfig, serializeBaseConfig } from './configFile.ts';
import type { CycleState } from './cycleState.ts';
import type { GitResult, RunGitOptions } from './gitx.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { safeBasenameProblem } from './pathSafety.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { verifyReceipt } from './workspaceReceipt.ts';

const FULL_SHA = /^[0-9a-f]{40}$/;
const PIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CycleGitRunner = (options: RunGitOptions) => GitResult;

export type RecognizedBump = {
	readonly commit: string;
	readonly parent: string;
	readonly sourcePin: PinConfig;
};

export type PatchSetStatusEntry = {
	readonly code: string;
	readonly path: string;
};

/** Resolve a tag or raw SHA to the portable pin identity recorded on disk. */
export function resolveTargetPin(
	forkDir: string,
	upstreamAnchorCommit: string,
	target: string,
	git: CycleGitRunner = runGit,
	configVersion = 2,
	resolvedAt = new Date().toISOString()
): PinConfig {
	if (target === '') {
		throw ckError('CONFIG', 'cycle target must not be empty', 'name an upstream tag or full 40-hex commit sha');
	}
	let sha: string;
	let tag: string | null;
	if (FULL_SHA.test(target)) {
		sha = resolveCommit(forkDir, target, git);
		tag = configVersion >= 4 ? null : (exactPortableTags(forkDir, sha, git)[0] ?? `sha-${sha.slice(0, 12)}`);
	} else {
		if (safeBasenameProblem(target) !== null) {
			throw ckError(
				'CONFIG',
				`cycle target tag is not one portable basename: ${target}`,
				'use a portable tag name or the full target commit sha'
			);
		}
		tag = target;
		sha = resolveCommit(forkDir, `refs/tags/${target}`, git);
	}
	assertAncestor(forkDir, upstreamAnchorCommit, sha, `cycle target ${target}`, git);
	const dateResult = mustGit(
		git,
		{ args: ['show', '-s', '--format=%cs', sha], cwd: forkDir },
		'PIN-UNREACHABLE',
		`cannot read the commit date of cycle target ${target}`,
		fetchHint(forkDir, target)
	);
	const date = dateResult.stdout.trim();
	if (!PIN_DATE.test(date)) {
		throw ckError('INTERNAL', `git returned a non-portable commit date for ${sha}: ${JSON.stringify(date)}`, 'upgrade git and retry');
	}
	return { tag, sha, date, ...(configVersion >= 4 ? { resolvedAt } : {}) };
}

/** Both source and target must be local commits, and the upgrade must move forward in that history. */
export function assertSourceToTargetAncestry(forkDir: string, sourcePin: PinConfig, targetPin: PinConfig, git: CycleGitRunner): void {
	const source = resolveCommit(forkDir, sourcePin.sha, git);
	if (source !== sourcePin.sha) {
		throw ckError(
			'PIN-UNREACHABLE',
			`source pin ${sourcePin.sha} does not name its commit directly`,
			'restore the exact source commit sha'
		);
	}
	if (sourcePin.sha === targetPin.sha) {
		throw ckError('CONFIG', 'cycle source and target pins are the same commit', 'choose a later upstream target');
	}
	assertAncestor(forkDir, sourcePin.sha, targetPin.sha, `target pin ${pinKey(targetPin)}`, git);
}

export function assertPatchSetRepositoryClean(patchesDir: string, git: CycleGitRunner, workspace?: WorkspaceRecord): void {
	let expectedRoot: string;
	try {
		expectedRoot = realpathSync(patchesDir);
	} catch (error) {
		throw ckError('NOT-A-REPO', `cannot resolve the patchset root: ${messageOf(error)}`, 'run the command from a patchset checkout');
	}
	const top = mustGit(
		git,
		{ args: ['rev-parse', '--show-toplevel'], cwd: patchesDir },
		'NOT-A-REPO',
		`${patchesDir} is not a Git work tree`,
		'run cycle start from a patchset checkout'
	).stdout.trim();
	let actualRoot: string;
	try {
		actualRoot = realpathSync(top);
	} catch {
		actualRoot = top;
	}
	if (actualRoot !== expectedRoot) {
		throw ckError('NOT-A-REPO', `${patchesDir} is not the root of its Git work tree`, `use the repository root ${actualRoot}`);
	}
	if (readPatchSetStatus(patchesDir, git, workspace).length !== 0) {
		throw ckError(
			'DIRTY-TREE',
			'the patchset work tree is dirty; cycle start will not build on uncommitted work',
			'commit or stash the patchset changes, then retry cycle start'
		);
	}
}

export function readPatchSetStatus(patchesDir: string, git: CycleGitRunner, workspace?: WorkspaceRecord): readonly PatchSetStatusEntry[] {
	if (workspace !== undefined) {
		if (realpathSync(patchesDir) !== workspace.patchset.path) throw ckError('CONFIG', 'workspace cycle patchset custody differs');
		verifyReceipt(workspace, 'patchset');
	}
	const output = mustGit(
		git,
		{ args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd: patchesDir },
		'NOT-A-REPO',
		'cannot inspect the patchset work tree',
		'repair the repository and retry'
	).stdout;
	if (output === '') {
		return [];
	}
	if (!output.endsWith('\0')) {
		throw ckError('INTERNAL', 'git status porcelain output is not NUL-terminated', 'upgrade git and retry');
	}
	const fields = output.split('\0');
	fields.pop();
	const entries: PatchSetStatusEntry[] = [];
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index] ?? '';
		if (field.length < 4 || field[2] !== ' ') {
			throw ckError('INTERNAL', `malformed git status record: ${JSON.stringify(field)}`, 'upgrade git and retry');
		}
		const code = field.slice(0, 2);
		const path = field.slice(3);
		entries.push({ code, path });
		if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') {
			index += 1;
			if (fields[index] === undefined) {
				throw ckError('INTERNAL', 'git status rename record has no source path', 'upgrade git and retry');
			}
		}
	}
	return workspace === undefined ? entries : entries.filter((entry) => entry.code !== '??' || !entry.path.startsWith('.codkit/'));
}

export function assertOnlyCycleStatus(entries: readonly PatchSetStatusEntry[], configCode: 'none' | 'unstaged' | 'staged'): void {
	let seenConfig = false;
	for (const entry of entries) {
		if (entry.path === 'cycle/state.json' && entry.code === '??') {
			continue;
		}
		if (entry.path === CONFIG_FILE_NAME) {
			const expected = configCode === 'unstaged' ? ' M' : configCode === 'staged' ? 'M ' : null;
			if (expected !== null && entry.code === expected && !seenConfig) {
				seenConfig = true;
				continue;
			}
		}
		throw ckError(
			'DIRTY-TREE',
			`cycle transaction found unexpected patchset dirt: ${entry.code} ${entry.path}`,
			'leave only cycle/state.json and the exact expected codkit.json update, then retry'
		);
	}
	if (configCode !== 'none' && !seenConfig) {
		throw ckError(
			'CONFIG',
			`cycle transaction expected ${configCode} ${CONFIG_FILE_NAME}, but that exact change is absent`,
			'restore the transaction checkpoint and retry'
		);
	}
}

export function headCommit(patchesDir: string, git: CycleGitRunner): string {
	return mustSha(patchesDir, 'HEAD', git, 'cannot resolve patchset HEAD');
}

export function currentBranchName(patchesDir: string, git: CycleGitRunner): string {
	return mustGit(
		git,
		{ args: ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd: patchesDir },
		'CONFIG',
		'cycle control requires a named patchset branch, but HEAD is detached',
		'switch to the intended patchset branch and retry'
	).stdout.trim();
}

export function branchTip(patchesDir: string, branch: string, git: CycleGitRunner): string | null {
	const result = git({ args: ['show-ref', '--verify', '--hash', `refs/heads/${branch}`], cwd: patchesDir });
	const sha = result.stdout.trim();
	return result.status === 0 && FULL_SHA.test(sha) ? sha : null;
}

export function assertValidBranch(patchesDir: string, branch: string, git: CycleGitRunner): void {
	const checked = git({ args: ['check-ref-format', '--branch', branch], cwd: patchesDir });
	if (checked.status !== 0 || checked.stdout.trim() !== branch) {
		throw ckError(
			'CONFIG',
			`cycle branch name is not valid for Git: ${branch}`,
			'fix cycleBranchPrefix in codkit.json before starting the cycle'
		);
	}
}

export function configAt(patchesDir: string, commit: string, git: CycleGitRunner): CodkitConfig | null {
	const shown = git({ args: ['show', `${commit}:${CONFIG_FILE_NAME}`], cwd: patchesDir });
	if (shown.status !== 0) {
		return null;
	}
	try {
		return parseBaseConfig(JSON.parse(shown.stdout) as unknown, `${commit}:${CONFIG_FILE_NAME}`);
	} catch {
		return null;
	}
}

export function recognizeBump(patchesDir: string, ref: string, targetPin: PinConfig, git: CycleGitRunner): RecognizedBump | null {
	const commitResult = git({ args: ['rev-parse', '--verify', `${ref}^{commit}`], cwd: patchesDir });
	const commit = commitResult.stdout.trim();
	if (commitResult.status !== 0 || !FULL_SHA.test(commit)) {
		return null;
	}
	const object = git({ args: ['cat-file', 'commit', commit], cwd: patchesDir });
	if (
		object.status !== 0 ||
		commitMessageBody(object.stdout) !== `${bumpSubject(pinKey(targetPin))}\n\n${bumpTrailer(pinKey(targetPin))}\n`
	) {
		return null;
	}
	const parentResult = git({ args: ['rev-parse', '--verify', `${commit}^`], cwd: patchesDir });
	const parent = parentResult.stdout.trim();
	if (parentResult.status !== 0 || !FULL_SHA.test(parent)) {
		return null;
	}
	const names = git({ args: ['diff-tree', '--no-commit-id', '--name-only', '-r', commit], cwd: patchesDir });
	if (names.status !== 0 || names.stdout !== `${CONFIG_FILE_NAME}\n`) {
		return null;
	}
	const before = configAt(patchesDir, parent, git);
	const after = configAt(patchesDir, commit, git);
	if (before === null || after === null || !samePin(after.pin, targetPin)) {
		return null;
	}
	if (serializeBaseConfig({ ...before, pin: targetPin }) !== serializeBaseConfig(after)) {
		return null;
	}
	const bytes = git({ args: ['show', `${commit}:${CONFIG_FILE_NAME}`], cwd: patchesDir });
	if (bytes.status !== 0 || bytes.stdout !== serializeBaseConfig(after)) {
		return null;
	}
	return { commit, parent, sourcePin: before.pin };
}

export function findCycleBump(patchesDir: string, state: CycleState, git: CycleGitRunner): RecognizedBump {
	return findCycleBumpTo(patchesDir, state, 'HEAD', git);
}

/** Find the unique canonical bump on one recorded cycle's own first-parent history. */
export function findCycleBumpTo(patchesDir: string, state: CycleState, toInclusive: string, git: CycleGitRunner): RecognizedBump {
	const history = mustGit(
		git,
		{ args: ['rev-list', '--first-parent', toInclusive], cwd: patchesDir },
		'INTERNAL',
		'cannot read the current cycle branch history',
		'repair the repository before restarting the cycle'
	).stdout;
	const matches = history
		.split('\n')
		.filter((line) => FULL_SHA.test(line))
		.map((commit) => recognizeBump(patchesDir, commit, state.targetPin, git))
		.filter((bump): bump is RecognizedBump => bump !== null && samePin(bump.sourcePin, state.sourcePin));
	if (matches.length !== 1) {
		throw ckError(
			'CONFIG',
			`expected exactly one canonical pin-bump commit for ${pinKey(state.targetPin)}, found ${matches.length}`,
			'inspect the cycle branch history; restart refuses an ambiguous reset target'
		);
	}
	return matches[0] as RecognizedBump;
}

export function assertCommitDescends(patchesDir: string, ancestor: string, commit: string, git: CycleGitRunner): void {
	assertAncestor(patchesDir, ancestor, commit, `cycle branch HEAD ${commit}`, git, 'CONFIG');
}

export function mustGit(
	git: CycleGitRunner,
	options: RunGitOptions,
	code: 'CONFIG' | 'INTERNAL' | 'NOT-A-REPO' | 'PIN-UNREACHABLE',
	message: string,
	hint: string
): GitResult {
	const result = git(options);
	if (result.status !== 0) {
		const detail = firstLine(result.stderr) ?? firstLine(result.stdout) ?? `git exited with status ${result.status}`;
		throw ckError(code, `${message}: ${detail}`, hint);
	}
	return result;
}

export function bumpSubject(tag: string): string {
	return `codkit cycle: bump pin to ${tag}`;
}

export function bumpTrailer(tag: string): string {
	return `Codkit-Cycle: ${tag}`;
}

export function samePin(left: PinConfig, right: PinConfig): boolean {
	return left.tag === right.tag && left.sha === right.sha && left.date === right.date;
}

function resolveCommit(forkDir: string, ref: string, git: CycleGitRunner): string {
	const result = git({ args: ['rev-parse', '--verify', `${ref}^{commit}`], cwd: forkDir });
	const sha = result.stdout.trim();
	if (result.status !== 0 || !FULL_SHA.test(sha)) {
		const label = ref.replace(/^refs\/tags\//, '');
		throw ckError('PIN-UNREACHABLE', `cycle pin ${label} is not present as a commit in ${forkDir}`, fetchHint(forkDir, label));
	}
	return sha;
}

function exactPortableTags(forkDir: string, sha: string, git: CycleGitRunner): readonly string[] {
	const result = mustGit(
		git,
		{ args: ['tag', '--points-at', sha], cwd: forkDir },
		'PIN-UNREACHABLE',
		`cannot inspect tags pointing at ${sha}`,
		'check the local fork object database and retry'
	);
	return result.stdout
		.split('\n')
		.filter((tag) => tag !== '' && safeBasenameProblem(tag) === null)
		.sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}

function assertAncestor(
	cwd: string,
	ancestor: string,
	descendant: string,
	label: string,
	git: CycleGitRunner,
	code: 'CONFIG' | 'PIN-UNREACHABLE' = 'PIN-UNREACHABLE'
): void {
	const result = git({ args: ['merge-base', '--is-ancestor', ancestor, descendant], cwd });
	if (result.status === 0) {
		return;
	}
	if (result.status === 1) {
		throw ckError(code, `${label} does not descend from ${ancestor}`, 'choose commits from the same forward history');
	}
	throw ckError(code, `cannot prove ${label} descends from ${ancestor}`, 'make both commit objects available locally and retry');
}

function mustSha(cwd: string, ref: string, git: CycleGitRunner, message: string): string {
	const result = mustGit(
		git,
		{ args: ['rev-parse', '--verify', `${ref}^{commit}`], cwd },
		'CONFIG',
		message,
		'repair the repository and retry'
	);
	const sha = result.stdout.trim();
	if (!FULL_SHA.test(sha)) {
		throw ckError('INTERNAL', `git returned a malformed commit sha for ${ref}`, 'upgrade git and retry');
	}
	return sha;
}

function commitMessageBody(commitObject: string): string | null {
	const separator = commitObject.indexOf('\n\n');
	return separator === -1 ? null : commitObject.slice(separator + 2);
}

function fetchHint(forkDir: string, target: string): string {
	return `fetch the target outside codkit, then retry: git -C ${forkDir} fetch --tags origin ${target}`;
}

function firstLine(text: string): string | null {
	const trimmed = text.trim();
	return trimmed === '' ? null : (trimmed.split('\n')[0] ?? null);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function withCycleLocks<T>(
	patchesDir: string,
	forkDir: string,
	command: string,
	dependencies: { readonly acquireLock: typeof acquireLock },
	body: (cycleLock: LockHandle) => T
): T {
	const patchsetLock = dependencies.acquireLock(patchesDir, 'cycle-global', command);
	try {
		const treeLock = dependencies.acquireLock(patchesDir, treeId(forkDir), command, undefined, patchsetLock);
		try {
			return body(patchsetLock);
		} finally {
			treeLock.release();
		}
	} finally {
		patchsetLock.release();
	}
}

export function provisionalBranch(config: CodkitConfig, tree: string): string {
	const branch = `${config.cycleBranchPrefix}${pinKey(config.pin)}-provisional`;
	const checked = runGit({ args: ['check-ref-format', '--branch', branch], cwd: tree });
	if (branch === `${config.generatedBranchPrefix}${pinKey(config.pin)}` || checked.status !== 0 || checked.stdout.trim() !== branch) {
		throw ckError('CONFIG', `cannot use ${branch} as the provisional cycle branch`, 'choose non-overlapping branch prefixes');
	}
	return branch;
}
