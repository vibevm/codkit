/** @scope spec://codkit/modules/codkit/PROP-011#root */
// The ci engine: one container run of the whole threshold, from scratch.
// Contract: PROP-011 (the job, the air gap, the profiles, the rights, the
// effective diff) and PROP-007 sec. 17 (the ci command).
//
// Four properties shape it:
//
//   * no network, ever. Nothing here passes `netAllowed`, so every git call goes
//     through the zero-network refusal of PROP-011 sec. 2, and the run says what CI itself
//     must fetch instead of fetching it;
//   * the tree is disposable. `ci` brings it to the pin from scratch and
//     materializes the overlay targets into the generated branch - the one-shot
//     variant of the config-overlay layer - so a tree it finds dirty is a
//     mistake in the job, not work to protect;
//   * the steps are printed as they run and summarized at the end, because the
//     only reader of a CI log is somebody looking for the step that broke;
//   * it installs nothing. Dependencies arrive with the supply kit (PROP-011
//     sec. 7); `ci` checks them and refuses, but never reaches out for them.
//
// The exit codes are the ones every codkit command uses: 0, 1 for a check that
// did not pass (verify, the pin guard, compilation errors) and 2 for the
// environment (an unusable tree, missing dependencies, a forbidden network
// call).

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
	DEFAULT_ERRORS_TIMEOUT_MS,
	DEFAULT_UP_CHANNELS,
	downChannel,
	foreignWatchers,
	inotifyWarning,
	loadBuildWatch,
	logPath,
	readPass,
	selectChannels,
	statusOf,
	upChannel
} from './buildWrap.ts';
import type { ChannelConfig } from './buildWrap.ts';
import { encodeUtf8 } from './bytes.ts';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './command.ts';
import { CONFIG_FILE_NAME, loadConfig } from './configFile.ts';
import type { CodkitConfig } from './configFile.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { driftDirty } from './driftGuard.ts';
import { treeId } from './fingerprint.ts';
import { runGit, useGitConfigGlobal } from './gitx.ts';
import { buildInventory, checkoutPatchSetRef, diffInventories, renderInventoryDiffMarkdown } from './inventory.ts';
import type { PatchSetRefCheckout } from './inventory.ts';
import type { Output } from './jsonOut.ts';
import { isCkError } from './messages.ts';
import type { CkErrorPayload } from './messages.ts';
import { listOwnFiles, ownSourceRoot } from './ownCopy.ts';
import type { ForkDirResolution } from './paths.ts';
import { buildGeneratedTip, runSync } from './syncEngine.ts';
import { checkTree, formatCheckLine } from './treeIdentity.ts';
import { runVerify } from './verifyEngine.ts';

export type CiProfile = 'verify' | 'build';

export const CI_PROFILES: readonly CiProfile[] = ['verify', 'build'];

/** The safe.directory file of the container (PROP-011 sec. 5). */
export const CI_GITCONFIG_PATH = '.codkit/gitconfig-ci';

/** Artifacts a CI job collects, relative to the patchset root. */
export const EFFECTIVE_DIFF_PATH = '.codkit/out/effective-diff.patch';
export const INVENTORY_DIFF_PATH = '.codkit/out/inventory-diff.md';

/** What the dependency fast path remembers about a tree. */
export const DEPS_HASH_PATH = '.codkit/build/deps-hash.json';
export const DEPS_HASH_SCHEMA_VERSION = 1;

/** Files whose content decides whether the tree's dependencies are current. */
export const DEPS_MANIFESTS: readonly string[] = ['package-lock.json', '.nvmrc'];

/** Dependency roots that a build/publish supply kit must preserve together. */
export const DEPS_REQUIRED_ROOTS: readonly string[] = ['node_modules', 'build/node_modules'];

/**
 * npm install receipts whose presence proves that both dependency roots were
 * actually restored. Checking the directory alone is insufficient for bind
 * mounts: Docker commonly leaves an empty mountpoint behind, and a stale
 * deps-hash record must never turn that empty directory green.
 */
export const DEPS_REQUIRED_RECEIPTS: readonly string[] = DEPS_REQUIRED_ROOTS.map((root) => `${root}/.package-lock.json`);

/** How many dirty paths the disposable-tree guard lists before summarizing. */
const DIRTY_LIST_LIMIT = 20;

const VERIFY_STEP_COUNT = 7;
const BUILD_STEP_COUNT = 12;

export type CiStepState = 'ok' | 'warned' | 'skipped' | 'failed';

export type CiStep = {
	readonly name: string;
	readonly state: CiStepState;
	/** What was observed; printed in parentheses after the verdict. */
	readonly detail: string;
};

export type CiOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	readonly out: Output;
	readonly profile: CiProfile;
	/** `--effective-diff <base-ref>`; null when the flag was not given. */
	readonly effectiveDiffBase: string | null;
	/** `--pin-guard-base <ref>`; null when the flag was not given. */
	readonly pinGuardBase: string | null;
	readonly verbose: boolean;
	/** Immutable patchset snapshot identity used by publish. */
	readonly patchSetCommit?: string;
	/** Repository owning patchSetCommit when patchesDir is a scratch export. */
	readonly patchesRepositoryRoot?: string;
	/** How long one compilation pass may take, in milliseconds. */
	readonly passTimeoutMs?: number;
	/** Injectable seam for the synchronous upstream checks; production uses spawnSync. */
	readonly runCommand?: CiCommandRunner;
};

export type CiCommand = {
	/** Stable name used in the CI log, independent of the platform executable name. */
	readonly label: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
};

export type CiCommandResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: Error;
};

/** A deliberately small process seam: tests can exercise gates without starting native tools. */
export type CiCommandRunner = (command: CiCommand) => CiCommandResult;

export type EffectiveDiffReport = {
	readonly base: string;
	readonly baseSha: string;
	/** Tip of the generated branch of the base state, in the tree's objects. */
	readonly baseTip: string;
	readonly tip: string;
	readonly patchPath: string;
	readonly inventoryDiffPath: string;
	readonly stat: string;
};

export type CiResult = {
	readonly exitCode: number;
	readonly profile: CiProfile;
	readonly steps: readonly CiStep[];
	/** Tip of the generated branch this run produced, when it got that far. */
	readonly branchTip: string | null;
	readonly effectiveDiff: EffectiveDiffReport | null;
};

/** Prints each step as it finishes and keeps the list for the summary. */
class StepReporter {
	readonly steps: CiStep[] = [];

	private readonly out: Output;
	private readonly total: number;

	constructor(out: Output, total: number) {
		this.out = out;
		this.total = total;
	}

	record(name: string, state: CiStepState, detail: string): void {
		this.steps.push({ name, state, detail });
		const suffix = detail === '' ? '' : ` (${detail})`;
		this.out.info(`step ${this.steps.length}/${this.total} ${name}: ${state}${suffix}`);
	}
}

/**
 * One `ci` run. The caller holds the per-tree lock and owns the envelope; this
 * function performs the steps in the order PROP-011 sec. 3 fixes and stops at
 * the first one that fails.
 */
export async function runCi(options: CiOptions): Promise<CiResult> {
	const { out, config, patchesDir, resolution, profile } = options;
	const tree = resolution.path;
	const steps = new StepReporter(out, profile === 'build' ? BUILD_STEP_COUNT : VERIFY_STEP_COUNT);
	let branchTip: string | null = null;
	let effectiveDiff: EffectiveDiffReport | null = null;
	let generatedOwnPaths: readonly string[] = [];
	const immutableSource =
		options.patchSetCommit === undefined
			? {}
			: {
					patchSetCommit: options.patchSetCommit,
					...(options.patchesRepositoryRoot === undefined
						? {}
						: { generatedModeSource: { repositoryRoot: options.patchesRepositoryRoot, ref: options.patchSetCommit } })
				};

	const done = (exitCode: number): CiResult => {
		summarize(out, profile, steps.steps, exitCode);
		return { exitCode, profile, steps: steps.steps, branchTip, effectiveDiff };
	};

	// 1. Where the tree came from. A container run has three plausible sources
	// for it and picking the wrong one is the classic broken job.
	steps.record('fork tree', 'ok', `${tree} (source: ${resolution.source})`);

	// 2. Rights: a mounted tree usually belongs to another uid.
	const safe = ensureSafeDirectory(patchesDir, tree);
	steps.record('safe.directory', safe.state, safe.detail);
	if (safe.error !== null) {
		out.addError(safe.error);
		return done(EXIT_ENVIRONMENT);
	}

	// 3. Is this the tree the delta is written against?
	const identity = checkTree(resolution, config, { mode: 'write' });
	if (options.verbose) {
		for (const check of identity.checks) {
			out.diag(formatCheckLine(check));
		}
	}
	if (identity.fatal !== null) {
		steps.record('check-tree', 'failed', identity.fatal.message);
		out.addError(identity.fatal.toPayload());
		return done(EXIT_ENVIRONMENT);
	}
	steps.record('check-tree', 'ok', `${identity.checks.length} check(s) passed`);

	// 4. From scratch. The drift guard speaks with the voice of this command: a
	// ci tree that carries unextracted work is a job that reused a developer's
	// tree. Build deliberately applies the non-overlay state first; upstream
	// hygiene must see that state before strict overlay targets are materialized.
	//
	// No known-materialization classifier is passed here (REPAIR-005 decision):
	// ci materializes overlay targets only through commits of the generated
	// branch, so its own runs leave the tree clean against its own HEAD and can
	// never produce the state the classifier exists for. The only way those bytes
	// reach a ci tree is an out-of-band `overlay apply` - a developer tree reused
	// by a job, which is exactly what this guard exists to name loudly - and its
	// way out is codkit's own (`load --fresh` on that tree) or the disposable-tree
	// contract itself (mount a fresh tree), not a direct git restore.
	const drift = driftDirty(tree, config.ownDirName, patchesDir, { untrackedIsDirt: false });
	if (drift.dirty) {
		for (const path of drift.files.slice(0, DIRTY_LIST_LIMIT)) {
			out.info(`  dirty: ${path}`);
		}
		if (drift.files.length > DIRTY_LIST_LIMIT) {
			out.info(`  ... and ${drift.files.length - DIRTY_LIST_LIMIT} more`);
		}
		steps.record('fresh apply', 'failed', `${drift.files.length} path(s) differ from what patchset carries`);
		out.addError({
			code: 'DIRTY-TREE',
			message: `${drift.files.length} path(s) in the fork tree carry changes that are not in patchset`,
			hint:
				'ci trees must be disposable: mount or check out a fresh tree for the job, or reset this one ' +
				`(git -C ${tree} checkout -- .), then re-run`
		});
		return done(EXIT_CHECK_FAILED);
	}
	let applied = runSync({
		patchesDir,
		resolution,
		config,
		out,
		fresh: true,
		dryRun: false,
		verbose: options.verbose,
		generatedBranch: profile !== 'build',
		...immutableSource
	});
	branchTip = applied.branchTip;
	generatedOwnPaths = applied.generatedOwnPaths;
	if (applied.exitCode !== EXIT_OK) {
		steps.record('fresh apply', 'failed', `load: ${applied.status}`);
		return done(applied.exitCode);
	}
	steps.record(
		'fresh apply',
		'ok',
		`${applied.artifacts} ${profile === 'build' ? 'non-overlay ' : ''}artifact(s) on ${applied.branch}, ` +
			`${applied.cleaned} untracked path(s) removed`
	);

	if (profile === 'build') {
		// 5. Dependencies of the tree. `ci` never installs them: the air gap makes
		// that a step of the job outside the container (PROP-011 sec. 7).
		const deps = checkDeps(patchesDir, tree);
		if (deps.kind === 'missing') {
			steps.record('dependencies', 'failed', 'no node_modules in the fork tree');
			out.addError({
				code: 'DEPS-MISSING',
				message: 'dependencies missing; provide node_modules via cache/mount (air-gapped supply kit)',
				hint:
					`install them outside the container and mount them into ${tree}, or restore the CI cache keyed by ` +
					'pin.sha and the lock files (PROP-011 sec. 7)'
			});
			return done(EXIT_ENVIRONMENT);
		}
		if (deps.kind === 'changed') {
			out.warn('lock changed; refresh node_modules out of band');
			steps.record('dependencies', 'warned', `${DEPS_MANIFESTS.join(' + ')} moved since the last run over this tree`);
		} else {
			steps.record('dependencies', 'ok', deps.kind === 'fresh' ? 'lock unchanged; node_modules kept' : 'lock state recorded');
		}

		// 6. Both upstream static gates run against the non-overlay state. This is
		// the executable form of hygiene -> overlay apply from PROP-011 sec. 3.
		const hygiene = upstreamHygieneStep(tree, out, options.runCommand);
		steps.record('upstream hygiene', hygiene.state, hygiene.detail);
		if (hygiene.error !== null) {
			out.addError(hygiene.error);
		}
		if (hygiene.exitCode !== EXIT_OK) {
			return done(hygiene.exitCode);
		}

		// 7. Rebuild the complete generated branch after hygiene: patch commits,
		// aggregate own code, overlay targets and resources. --fresh also removes
		// the temporary dev-channel override.
		applied = runSync({
			patchesDir,
			resolution,
			config,
			out,
			fresh: true,
			dryRun: false,
			verbose: options.verbose,
			generatedBranch: true,
			...immutableSource
		});
		branchTip = applied.branchTip;
		generatedOwnPaths = applied.generatedOwnPaths;
		if (applied.exitCode !== EXIT_OK) {
			steps.record('overlay apply', 'failed', `load: ${applied.status}`);
			return done(applied.exitCode);
		}
		steps.record('overlay apply', 'ok', `${applied.artifacts} artifact(s) on ${applied.branch}, overlay targets materialized`);
	}

	// Every integrity check of the materialized delta. In the build profile this
	// is deliberately after upstream hygiene and overlay application.
	const verified = runVerify({ patchesDir, resolution, config });
	const generatedOwnEvidence = new Set(generatedOwnPaths);
	const verifyFindings = verified.findings.filter((finding) => !isGeneratedOwnFinding(finding, generatedOwnEvidence, config));
	for (const warning of verified.warnings) {
		out.warn(warning);
	}
	for (const finding of verifyFindings) {
		out.addError(finding);
	}
	if (verifyFindings.length > 0) {
		steps.record('verify', 'failed', `${verifyFindings.length} violation(s) in ${verified.checked} intervention(s)`);
		return done(EXIT_CHECK_FAILED);
	}
	steps.record('verify', 'ok', `${verified.checked} intervention(s) checked`);

	// The race guard of PROP-011 sec. 3: this branch and the branch it will
	// merge into must be written against the same pin.
	const guard = pinGuard(patchesDir, config, options.pinGuardBase);
	steps.record('pin guard', guard.state, guard.detail);
	if (guard.error !== null) {
		out.addError(guard.error);
		return done(guard.exitCode);
	}

	// What a reviewer actually reads (PROP-011 sec. 6).
	if (options.effectiveDiffBase === null) {
		steps.record('effective diff', 'skipped', 'no --effective-diff <base-ref> given');
	} else {
		const report = effectiveDiffStep(options, branchTip);
		steps.record('effective diff', report.state, report.detail);
		effectiveDiff = report.diff;
		if (report.error !== null) {
			out.addError(report.error);
			return done(EXIT_ENVIRONMENT);
		}
	}

	if (profile !== 'build') {
		return done(EXIT_OK);
	}

	// One compilation pass through the daemons, then they are stopped.
	const compiled = await compileOnce(options, steps);
	if (compiled !== EXIT_OK) {
		return done(compiled);
	}

	// Own product and contract tests, through the upstream node runner and the
	// same runGlob that was verified on the real polygon in FEAT-001.
	const tests = productTestsStep(patchesDir, tree, config.ownDirName, out, options.runCommand);
	steps.record('product tests', tests.state, tests.detail);
	if (tests.error !== null) {
		out.addError(tests.error);
	}
	if (tests.exitCode !== EXIT_OK) {
		return done(tests.exitCode);
	}

	return done(EXIT_OK);
}

/** CI has just built this exact branch in full mode; these own paths are expected. */
function isGeneratedOwnFinding(finding: CkErrorPayload, generatedOwnPaths: ReadonlySet<string>, config: CodkitConfig): boolean {
	const path = finding.file;
	const branch = `${config.generatedBranchPrefix}${config.pin.tag}`;
	return (
		finding.code === 'UNTRACKED-INTERVENTION' &&
		path !== undefined &&
		generatedOwnPaths.has(path) &&
		finding.message === `${path} is committed on ${branch}, but own code is only committed on a branch built by ci or publish`
	);
}

// ---------------------------------------------------------------------------
// 2. safe.directory
// ---------------------------------------------------------------------------

type StepOutcome = {
	readonly state: CiStepState;
	readonly detail: string;
	readonly error: CkErrorPayload | null;
};

type RunnableStepOutcome = StepOutcome & {
	readonly exitCode: number;
};

/**
 * Probe the tree with a plain `git status`. The characteristic refusal - git
 * declining a repository whose owner is not the current user - is answered by
 * writing the two paths into a configuration file of the container and pointing
 * every later git call of this run at it. The machine is not touched.
 */
function ensureSafeDirectory(patchesDir: string, treeDir: string): StepOutcome {
	const probe = runGit({ args: ['status', '--porcelain'], cwd: treeDir });
	if (probe.status === 0) {
		return { state: 'ok', detail: 'the tree is usable as it is', error: null };
	}
	if (!/dubious ownership/i.test(probe.stderr)) {
		// Something else is wrong with the tree; check-tree diagnoses it next,
		// with the vocabulary made for it.
		return { state: 'warned', detail: `git status failed: ${firstLine(probe.stderr)}`, error: null };
	}

	const path = writeCiGitConfig(patchesDir, treeDir);
	useGitConfigGlobal(path);
	const again = runGit({ args: ['status', '--porcelain'], cwd: treeDir });
	if (again.status !== 0) {
		return {
			state: 'failed',
			detail: 'git still refuses the tree',
			error: {
				code: 'TREE-READONLY',
				message: `git refuses to work in ${treeDir} even with safe.directory in ${CI_GITCONFIG_PATH}: ${firstLine(again.stderr)}`,
				hint: 'run the container as the owner of the mounted tree, or align uid/gid between the host and the container'
			}
		};
	}
	return { state: 'ok', detail: `dubious ownership; safe.directory written to ${CI_GITCONFIG_PATH}`, error: null };
}

/**
 * Create or extend `.codkit/gitconfig-ci` with a safe.directory entry for the
 * tree and for patchset. The file belongs to codkit and carries nothing but that
 * one section, so it is rewritten from the union of what it already lists and
 * what this run needs - which is both "create" and "extend", without having to
 * guess where a foreign section would end.
 */
export function writeCiGitConfig(patchesDir: string, treeDir: string): string {
	const path = join(patchesDir, ...CI_GITCONFIG_PATH.split('/'));
	mkdirSync(dirname(path), { recursive: true });

	const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const listed: string[] = [];
	for (const line of existing.split('\n')) {
		const match = /^\s*directory\s*=\s*(.+?)\s*$/.exec(line);
		const value = match?.[1];
		if (value !== undefined && value !== '') {
			listed.push(value);
		}
	}
	const directories = [...new Set([...listed, treeDir, patchesDir])];
	const lines = [
		'# Written by codkit ci (PROP-011 sec. 5). Used through GIT_CONFIG_GLOBAL for',
		'# this run only; the machine configuration is never touched.',
		'[safe]',
		...directories.map((directory) => `\tdirectory = ${directory}`),
		''
	];
	writeFileSync(path, lines.join('\n'), 'utf8');
	return path;
}

// ---------------------------------------------------------------------------
// 6. The pin guard
// ---------------------------------------------------------------------------

/** A step that decides an exit code of its own when it fails. */
type GuardOutcome = StepOutcome & { readonly exitCode: number };

/**
 * The pin of this checkout against the pin of the base ref. CI knows which
 * branch the change will merge into; codkit does not, so the ref is a flag and
 * an absent one means the guard did not run - stated, never assumed.
 *
 * A ref that cannot be read is the environment (2); a pin that does not match is
 * the guard doing its job (1), and the answer to it is one command.
 */
function pinGuard(patchesDir: string, config: CodkitConfig, base: string | null): GuardOutcome {
	if (base === null) {
		return {
			state: 'skipped',
			detail: 'no --pin-guard-base <ref> given; CI passes the base branch of the change here',
			error: null,
			exitCode: EXIT_OK
		};
	}
	const shown = runGit({ args: ['show', `${base}:${CONFIG_FILE_NAME}`], cwd: patchesDir });
	if (shown.status !== 0) {
		return {
			state: 'failed',
			detail: `cannot read ${CONFIG_FILE_NAME} at ${base}`,
			error: {
				code: 'CONFIG',
				message: `cannot read ${CONFIG_FILE_NAME} at ${base}: ${firstLine(shown.stderr)}`,
				hint: `name a ref this repository carries; codkit reads it with git show ${base}:${CONFIG_FILE_NAME}`
			},
			exitCode: EXIT_ENVIRONMENT
		};
	}
	const basePin = pinOfConfigText(shown.stdout);
	if (basePin === null) {
		return {
			state: 'failed',
			detail: `${CONFIG_FILE_NAME} at ${base} has no readable pin`,
			error: {
				code: 'CONFIG',
				message: `${CONFIG_FILE_NAME} at ${base} carries no readable pin.sha`,
				hint: 'the base ref must be a state of this repository whose codkit.json is valid',
				file: CONFIG_FILE_NAME
			},
			exitCode: EXIT_ENVIRONMENT
		};
	}
	if (basePin.sha === config.pin.sha) {
		return {
			state: 'ok',
			detail: `same pin as ${base} (${config.pin.tag}@${config.pin.sha.slice(0, 8)})`,
			error: null,
			exitCode: EXIT_OK
		};
	}
	return {
		state: 'failed',
		detail: `pin ${config.pin.tag}@${config.pin.sha.slice(0, 8)} against ${basePin.tag}@${basePin.sha.slice(0, 8)} at ${base}`,
		error: {
			code: 'CONFIG',
			message:
				`branch pin ${config.pin.tag} != target branch pin ${basePin.tag}: this branch carries ${config.pin.tag}@${config.pin.sha} while ${base} carries ` +
				`${basePin.tag}@${basePin.sha}: the delta of this change is written against an upstream state the target ` +
				'branch has moved away from',
			hint: 'merge the base branch, then re-pin the delta: codkit rebase-onto-pin',
			file: CONFIG_FILE_NAME
		},
		exitCode: EXIT_CHECK_FAILED
	};
}

/** pin.tag and pin.sha out of a codkit.json text, or null when it has none. */
function pinOfConfigText(text: string): { readonly tag: string; readonly sha: string } | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = z.object({ pin: z.object({ tag: z.string().min(1), sha: z.string().min(1) }) }).safeParse(raw);
	return parsed.success ? parsed.data.pin : null;
}

// ---------------------------------------------------------------------------
// 7. The effective diff
// ---------------------------------------------------------------------------

type EffectiveDiffOutcome = StepOutcome & { readonly diff: EffectiveDiffReport | null };

/**
 * The diff of applied states: the generated tip of the base state of patchset
 * against the tip this run produced, plus the inventory diff. The base tip is
 * built from a scratch checkout of the base ref through the same engine, into
 * the object database of the tree - so `git diff` has both sides without a
 * second clone and without the work tree moving.
 */
function effectiveDiffStep(options: CiOptions, tip: string | null): EffectiveDiffOutcome {
	const base = options.effectiveDiffBase;
	if (base === null) {
		return { state: 'skipped', detail: '', error: null, diff: null };
	}
	const { out, patchesDir, resolution } = options;
	const currentTip = tip ?? headOf(resolution.path);
	if (currentTip === null) {
		return {
			state: 'warned',
			detail: 'this run produced no branch tip to compare against',
			error: null,
			diff: null
		};
	}

	let checkout: PatchSetRefCheckout;
	try {
		checkout = checkoutPatchSetRef(patchesDir, base);
	} catch (error) {
		if (!isCkError(error)) {
			throw error;
		}
		return { state: 'failed', detail: `cannot read ${base}`, error: error.toPayload(), diff: null };
	}

	try {
		// The inventory diff first: it needs no tree and is worth having even when
		// the base state turns out not to apply.
		const inventoryDiff = diffInventories(
			buildInventory(checkout.dir, { patchSetCommit: checkout.sha }),
			buildInventory(patchesDir, { config: options.config })
		);
		const inventoryPath = writeOut(patchesDir, INVENTORY_DIFF_PATH, renderInventoryDiffMarkdown(base, inventoryDiff));
		out.info(
			`inventory diff against ${base}: +${inventoryDiff.added.length} -${inventoryDiff.removed.length} ` +
				`~${inventoryDiff.changed.length} -> ${INVENTORY_DIFF_PATH}`
		);

		const baseConfig = loadConfig(checkout.dir);
		if (baseConfig === null) {
			return {
				state: 'warned',
				detail: `${base} carries no ${CONFIG_FILE_NAME}; only the inventory diff was written`,
				error: null,
				diff: null
			};
		}

		let baseTip: string;
		try {
			baseTip = buildGeneratedTip({
				patchesDir: checkout.dir,
				resolution,
				config: baseConfig,
				out,
				verbose: options.verbose,
				patchSetCommit: checkout.sha,
				patchesRepositoryRoot: patchesDir
			});
		} catch (error) {
			if (!isCkError(error)) {
				throw error;
			}
			out.warn(`the delta of ${base} does not apply at its own pin, so no code diff was built: ${error.message}`);
			return {
				state: 'warned',
				detail: `${base} does not apply at its pin; only the inventory diff was written`,
				error: null,
				diff: null
			};
		}

		const patch = gitOutput(resolution.path, ['diff', baseTip, currentTip]);
		if (patch === null) {
			return {
				state: 'warned',
				detail: `git could not diff ${baseTip.slice(0, 8)}..${currentTip.slice(0, 8)}; only the inventory diff was written`,
				error: null,
				diff: null
			};
		}
		const stat = gitOutput(resolution.path, ['diff', '--stat', baseTip, currentTip]) ?? '';
		const patchPath = writeOut(patchesDir, EFFECTIVE_DIFF_PATH, patch);
		out.info(`effective diff ${baseTip.slice(0, 8)}..${currentTip.slice(0, 8)} -> ${EFFECTIVE_DIFF_PATH}`);
		for (const line of stat.split('\n')) {
			if (line !== '') {
				out.info(`  ${line}`);
			}
		}
		return {
			state: 'ok',
			detail: `${base} (${checkout.sha.slice(0, 8)}) against this run; ${EFFECTIVE_DIFF_PATH}, ${INVENTORY_DIFF_PATH}`,
			error: null,
			diff: {
				base,
				baseSha: checkout.sha,
				baseTip,
				tip: currentTip,
				patchPath,
				inventoryDiffPath: inventoryPath,
				stat
			}
		};
	} finally {
		checkout.release();
	}
}

function writeOut(patchesDir: string, relative: string, content: string): string {
	const path = join(patchesDir, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, 'utf8');
	return path;
}

function headOf(treeDir: string): string | null {
	const result = runGit({ args: ['rev-parse', 'HEAD'], cwd: treeDir });
	const sha = result.stdout.trim();
	return result.status === 0 && sha !== '' ? sha : null;
}

/**
 * stdout of a git command, or null when it failed. `git diff` without
 * `--exit-code` exits 0 whether or not there are differences, so a non-zero
 * status here is a real failure - and half a diff must never be written to a
 * file a reviewer is meant to trust.
 */
function gitOutput(treeDir: string, args: readonly string[]): string | null {
	const result = runGit({ args, cwd: treeDir });
	return result.status === 0 ? result.stdout : null;
}

// ---------------------------------------------------------------------------
// 8. Dependencies of the fork tree
// ---------------------------------------------------------------------------

export type DepsVerdictKind =
	/** No node_modules at all: the supply kit did not reach the container. */
	| 'missing'
	/** Nothing was recorded for this tree before; the lock state is now on file. */
	| 'recorded'
	/** The manifests are the ones the last run over this tree saw. */
	| 'fresh'
	/** The manifests moved; the tree's node_modules is stale. */
	| 'changed';

export type DepsVerdict = {
	readonly kind: DepsVerdictKind;
	/** Hash of the manifests; empty when there was nothing to hash. */
	readonly hash: string;
};

const depsRecordSchema = z.object({
	codkitDepsHash: z.literal(DEPS_HASH_SCHEMA_VERSION),
	treeId: z.string().min(1),
	treePath: z.string().min(1),
	hash: z.string().min(1),
	updatedAt: z.string().min(1)
});

/**
 * The dependency fast path of PROP-011 sec. 4, as far as an air-gapped run may take it:
 * codkit compares the manifests against what it last saw over this tree and
 * reports. It never installs anything - in `--ci` that would need the network,
 * and the supply kit exists precisely so it does not have to.
 */
export function checkDeps(patchesDir: string, treeDir: string): DepsVerdict {
	if (DEPS_REQUIRED_RECEIPTS.some((relative) => !existsSync(join(treeDir, ...relative.split('/'))))) {
		return { kind: 'missing', hash: '' };
	}
	const hash = depsHash(treeDir);
	const id = treeId(treeDir);
	const record = readDepsRecord(patchesDir, id);
	if (record === null) {
		writeDepsRecord(patchesDir, id, treeDir, hash);
		return { kind: 'recorded', hash };
	}
	if (record.hash === hash) {
		return { kind: 'fresh', hash };
	}
	// Recorded even though nothing was installed: the record says what the last
	// run saw, so the warning is raised once per change of the lock rather than
	// on every run until somebody refreshes the mount.
	writeDepsRecord(patchesDir, id, treeDir, hash);
	return { kind: 'changed', hash };
}

/** sha256 over the manifests that decide whether dependencies are current. */
export function depsHash(treeDir: string): string {
	const hash = createHash('sha256');
	for (const relative of DEPS_MANIFESTS) {
		let digest = 'absent';
		try {
			digest = createHash('sha256')
				.update(readFileSync(join(treeDir, ...relative.split('/'))))
				.digest('hex');
		} catch {
			// A tree without one of them is a legal input; its absence is hashed.
		}
		hash.update(`${relative}\n${digest}\n`, 'utf8');
	}
	hash.update(`schema ${DEPS_HASH_SCHEMA_VERSION}\n`, 'utf8');
	return hash.digest('hex');
}

export function readDepsRecord(patchesDir: string, id: string): { readonly hash: string } | null {
	let raw: unknown;
	try {
		const read = readContainedFile(patchesDir, DEPS_HASH_PATH, { what: DEPS_HASH_PATH });
		if (read.state === 'absent') return null;
		raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
	} catch {
		return null;
	}
	const parsed = depsRecordSchema.safeParse(raw);
	if (!parsed.success || parsed.data.treeId !== id) {
		// A record about another tree is not a record about this one.
		return null;
	}
	return { hash: parsed.data.hash };
}

function writeDepsRecord(patchesDir: string, id: string, treeDir: string, hash: string): void {
	const record = {
		codkitDepsHash: DEPS_HASH_SCHEMA_VERSION,
		treeId: id,
		treePath: treeDir,
		hash,
		updatedAt: new Date().toISOString()
	};
	writeContainedFileAtomic(patchesDir, DEPS_HASH_PATH, { bytes: encodeUtf8(`${JSON.stringify(record, null, 2)}\n`), what: DEPS_HASH_PATH });
}

// ---------------------------------------------------------------------------
// 9. One compilation pass
// ---------------------------------------------------------------------------

/**
 * `build up` for the two compiling channels, one `build errors` each, and
 * `build down` for everything in a finally: a CI container must not outlive its
 * daemons, whatever the verdict. A daemon that died after finishing its pass is
 * not a failure here - the pass in the log is the answer (PROP-007 sec. 13).
 */
async function compileOnce(options: CiOptions, steps: StepReporter): Promise<number> {
	const { out, patchesDir, resolution } = options;
	const tree = resolution.path;
	const watch = loadBuildWatch(patchesDir);
	const channels = selectChannels(watch, null, DEFAULT_UP_CHANNELS);
	const timeoutMs = options.passTimeoutMs ?? DEFAULT_ERRORS_TIMEOUT_MS;

	const inotify = inotifyWarning();
	if (inotify !== null) {
		out.warn(inotify);
	}

	const ourGroups = new Set<number>();
	for (const known of watch.channels) {
		const state = statusOf(patchesDir, known.name, { expectedTreeId: treeId(tree), expectedTreePath: tree });
		if (state.state === 'living' && state.record !== null) {
			ourGroups.add(state.record.pid);
		}
	}
	const foreign = foreignWatchers(tree, ourGroups);
	if (foreign.length > 0) {
		for (const watcher of foreign) {
			out.warn(`foreign watcher over ${tree}: pid ${watcher.pid} (${watcher.commandLine})`);
		}
		// Codeless, like the same refusal in `build up` (PROP-007 sec. 13): this is
		// a condition of the environment around the command, not a state of the
		// delta, and the exit code carries the verdict.
		out.warn(
			`a watch process codkit did not start is running over ${tree}; two watchers over one tree fight over out/. ` +
				'Stop the process(es) above; a CI container should have no watcher of its own'
		);
		steps.record('compile', 'failed', `${foreign.length} watcher(s) somebody else started over this tree`);
		return EXIT_ENVIRONMENT;
	}

	const id = treeId(tree);
	const started: ChannelConfig[] = [];
	try {
		for (const channel of channels) {
			const result = upChannel({ patchesDir, treeDir: tree, treeId: id, onWarn: (text) => out.warn(text) }, channel);
			if (!result.ok) {
				out.warn(
					`cannot start the ${channel.name} daemon: ${result.reason}. ` +
						'The container must carry the tree, its dependencies and npm (PROP-011 sec. 7)'
				);
				steps.record('compile', 'failed', result.reason);
				return EXIT_ENVIRONMENT;
			}
			started.push(channel);
			out.info(`${channel.name}: ${result.action} (pid ${result.pid}), log ${result.log}`);
		}

		let errors = 0;
		for (const channel of started) {
			const outcome = await readPass(patchesDir, channel, {
				timeoutMs,
				probe: { expectedTreeId: id, expectedTreePath: tree }
			});
			if (outcome.state !== 'ok') {
				const why =
					outcome.state === 'timeout'
						? `the pass did not finish within ${Math.round(timeoutMs / 1000)}s`
						: 'the daemon stopped before finishing a pass';
				steps.record('compile', 'failed', `${channel.name}: ${why}`);
				out.addError({
					code: 'LOG-INCOMPLETE',
					message: `${channel.name}: ${why} (log ${logPath(patchesDir, channel.name)})`,
					hint: 'read the log named above; a single CI pass needs the daemon to reach its end marker once'
				});
				return EXIT_ENVIRONMENT;
			}
			// The whole pass, as PROP-010 sec. 2 prescribes for a one-shot run.
			out.info(`--- ${channel.name}: pass (${outcome.report.lines.length} line(s))`);
			for (const line of outcome.report.lines) {
				out.info(line);
			}
			out.info(`--- ${channel.name}: ${outcome.report.errorCount} error(s)`);
			errors += outcome.report.errorCount;
		}

		if (errors > 0) {
			steps.record('compile', 'failed', `${errors} compilation error(s) over ${started.length} channel(s)`);
			return EXIT_CHECK_FAILED;
		}
		steps.record('compile', 'ok', `${started.length} channel(s), one pass each, no errors`);
		return EXIT_OK;
	} finally {
		// Every channel of the configuration, not only the ones this run started:
		// a container that leaves a daemon behind leaks a process group. The
		// teardown is bound to this tree - an unbound stop would signal and delete
		// a daemon belonging to another fork tree sharing this patch set - and one
		// unstoppable channel must not abort the sweep or replace the verdict this
		// block exists to protect.
		for (const channel of watch.channels) {
			try {
				const result = await downChannel(patchesDir, channel.name, {
					expectedTreeId: id,
					expectedTreePath: tree,
					onWarn: (text) => out.warn(text)
				});
				if (result.action !== 'not-running') {
					out.info(`${channel.name}: ${result.action} (pid ${result.pid} and its process group)`);
				}
			} catch (error) {
				out.warn(`${channel.name}: could not be stopped: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Build-profile native gates
// ---------------------------------------------------------------------------

const COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

/** Run the upstream hygiene and eslint scripts, in that order. */
export function upstreamHygieneStep(treeDir: string, out: Output, run: CiCommandRunner = defaultCiCommandRunner): RunnableStepOutcome {
	return runCommandSequence(
		out,
		[
			{ label: 'hygiene', command: npmCommand(), args: ['run', 'hygiene'], cwd: treeDir },
			{ label: 'eslint', command: npmCommand(), args: ['run', 'eslint'], cwd: treeDir }
		],
		run,
		'hygiene and eslint passed'
	);
}

/**
 * Product tests live below `src/vs/<own>/test/` and run through the upstream
 * node runner over compiled `out/` files (PROP-010 sec. 4). FEAT-001 records the
 * proven selector as `--runGlob vs/patchset/test/**\/*.test.js`; using the tree's
 * `test-node` script preserves the upstream runner's own mandatory flags.
 */
export function productTestsStep(
	patchesDir: string,
	treeDir: string,
	ownDirName: string,
	out: Output,
	run: CiCommandRunner = defaultCiCommandRunner
): RunnableStepOutcome {
	const root = ownSourceRoot(patchesDir);
	const tests = listOwnFiles(root, { refuseSymlinks: true }).filter((relative) => isProductTestFile(relative));
	if (tests.length === 0) {
		return {
			state: 'failed',
			detail: 'no runnable own product/contract tests found',
			error: {
				code: 'LOG-INCOMPLETE',
				message: `the build profile cannot run product tests: ${root} has no test/**/*.test.ts or .js files`,
				hint: 'add the own contract/guard tests required by PROP-010 sec. 4, then re-run the build profile'
			},
			exitCode: EXIT_ENVIRONMENT
		};
	}

	const glob = `vs/${ownDirName}/test/**/*.test.js`;
	const result = runCommandSequence(
		out,
		[
			{
				label: 'product tests',
				command: npmCommand(),
				args: ['run', 'test-node', '--', '--runGlob', glob],
				cwd: treeDir
			}
		],
		run,
		`${tests.length} own test file(s); upstream node runner passed (${glob})`
	);
	return result;
}

function runCommandSequence(out: Output, commands: readonly CiCommand[], run: CiCommandRunner, successDetail: string): RunnableStepOutcome {
	for (const command of commands) {
		out.info(`--- ${command.label}: ${renderCommand(command)}`);
		let result: CiCommandResult;
		try {
			result = run(command);
		} catch (error) {
			result = {
				status: null,
				stdout: '',
				stderr: '',
				error: error instanceof Error ? error : new Error(String(error))
			};
		}
		emitCommandOutput(out, command.label, result.stdout);
		emitCommandOutput(out, command.label, result.stderr);

		if (commandCouldNotRun(result)) {
			const reason = commandFailureReason(result);
			return {
				state: 'failed',
				detail: `${command.label}: required command could not complete (${reason})`,
				error: {
					code: 'LOG-INCOMPLETE',
					message: `${command.label}: required command could not complete: ${reason}`,
					hint: `provide the complete upstream runner and dependencies, then run: ${renderCommand(command)}`
				},
				exitCode: EXIT_ENVIRONMENT
			};
		}
		if (result.status !== EXIT_OK) {
			return {
				state: 'failed',
				detail: `${command.label}: exited ${result.status}`,
				error: null,
				exitCode: EXIT_CHECK_FAILED
			};
		}
	}
	return { state: 'ok', detail: successDetail, error: null, exitCode: EXIT_OK };
}

function defaultCiCommandRunner(command: CiCommand): CiCommandResult {
	const result = spawnSync(command.command, [...command.args], {
		cwd: command.cwd,
		encoding: 'utf8',
		shell: false,
		windowsHide: true,
		maxBuffer: COMMAND_MAX_BUFFER
	});
	const base = {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? ''
	};
	return result.error === undefined ? base : { ...base, error: result.error };
}

function npmCommand(): string {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function commandCouldNotRun(result: CiCommandResult): boolean {
	if (result.error !== undefined || result.status === null || result.status === 126 || result.status === 127) {
		return true;
	}
	const output = `${result.stderr}\n${result.stdout}`;
	return /Missing script:/i.test(output) || /MODULE_NOT_FOUND|Cannot find module/i.test(output);
}

function commandFailureReason(result: CiCommandResult): string {
	if (result.error !== undefined) {
		return result.error.message;
	}
	const line = firstLine(result.stderr) === 'no output' ? firstLine(result.stdout) : firstLine(result.stderr);
	return line === 'no output' ? `exit ${result.status ?? 'unknown'}` : line;
}

function emitCommandOutput(out: Output, label: string, text: string): void {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
	if (lines.length === 1 && lines[0] === '') {
		return;
	}
	for (const line of lines) {
		out.info(`[${label}] ${line ?? ''}`);
	}
}

function renderCommand(command: CiCommand): string {
	return [command.command, ...command.args].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ');
}

function isProductTestFile(relative: string): boolean {
	return /(^|\/)test\/.*\.test\.(ts|js)$/.test(relative);
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

function summarize(out: Output, profile: CiProfile, steps: readonly CiStep[], exitCode: number): void {
	out.info(`ci ${profile}: summary`);
	for (const step of steps) {
		out.info(`  ${step.state.padEnd(7)} ${step.name}${step.detail === '' ? '' : ` - ${step.detail}`}`);
	}
	const counted = (state: CiStepState): number => steps.filter((step) => step.state === state).length;
	out.info(
		`ci ${profile}: ${counted('ok')} ok, ${counted('warned')} warned, ${counted('skipped')} skipped, ` +
			`${counted('failed')} failed; exit ${exitCode}`
	);
}

function firstLine(text: string): string {
	const trimmed = text.trim();
	if (trimmed === '') {
		return 'no output';
	}
	const [line] = trimmed.split('\n');
	return line ?? 'no output';
}
