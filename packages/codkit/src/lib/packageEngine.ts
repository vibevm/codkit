/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE */
// The package engine: build the product's distributable out of the managed
// tree, and put the tree back the way it was found.
// Contract: PROP-007 sec. 27 (##CMD-PACKAGE); the answers it runs: PROP-016
// ##TYPE-AREA-BUILD.
//
// `ci --profile build` stops at the compile channels and the tests, so until
// this engine existed the `packageBuild` of every type was a field nothing read
// and the packaging of a fork was a sequence of commands typed by hand. The
// sequence is short and its two ends are what people got wrong:
//
//   * before the build, the overlay targets have to be materialized - a packaged
//     product reads the target file itself, not the dev-channel sidecar
//     (PROP-005 sec. 5) - and the stamps the family names have to be in the
//     environment;
//   * after the build, the tree has to come back to dev mode, or the next
//     ordinary `load` refuses over bytes codkit itself wrote.
//
// Both ends are this engine's, and the second one runs in a `finally`: a build
// that fails halfway is exactly the run whose tree nobody wants to repair by
// hand. What it puts back is only what it materialized itself - a target that
// was already materialized when the run started belongs to whoever left it
// there - and it never touches a build output or a dependency directory: this
// is not a fresh pass, and the artifact it just produced is the point of it.
//
// The drift guard is the one `load` uses, with the one exemption `load --fresh`
// makes (##OVERLAY-KNOWN-MATERIALIZATION): unextracted work still stops the run,
// and `--discard` is not a flag of this command - giving up somebody's edits is
// never a side effect of packaging.
//
// A target of a catalog runs on the route its type answers for this host
// (##CMD-PACKAGE-HOST-ROUTES): natively in the tree, or in the type's container
// over a read-only view of it (packageContainer.ts). What its build downloads is
// checked first, before any write, so that an offline run with a missing input
// is refused while nothing has happened yet (packageInputs.ts).

import { packageTargetsFor, routedTarget, containerPreflight, runRoutedTargets } from './packageRoutes.ts';
import { runCommands } from './packageRuntime.ts';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildCommand, BuildStamp, PackageHost, PackageTarget, ProjectType } from '@codkit/type-api';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './command.ts';
import type { CodkitConfig } from './configFile.ts';
import { driftDirty } from './driftGuard.ts';

import type { CkErrorPayload } from './messages.ts';
import type { Output } from './jsonOut.ts';
import { applyOverlaysToTree, loadOverlays, writeDevChannel } from './layers/overlay.ts';
import type { Overlay } from './layers/overlay.ts';
import { materializerOf } from './layers/ownExtensions.ts';
import { ownedRootsOf } from './ownedRoots.ts';

import { checkInputs, inputLines, inputsOf, missingInputsRefusal, nativeInputEnvironment } from './packageInputs.ts';

import { packageOutputPaths, packageScratchPaths } from './packagePaths.ts';
import type { ForkDirResolution } from './paths.ts';

import { overlayMaterializationClassifier, overlayVarContext, pinCommitDate, patchSetCommitId, restoreToTip } from './syncEngine.ts';
import { revParse } from './treeCache.ts';
import { treeHeadError } from './treeCommits.ts';

/** How many dirty paths the guard lists before summarizing. */
const DIRTY_LIST_LIMIT = 20;

/** Output of one packaging command that is kept for the diagnostic. */

/** The steps of one run, in the order they happen. */
export type PackageStepName =
	| 'inputs'
	| 'drift guard'
	| 'overlay apply'
	| 'stamps'
	| 'package build'
	| 'package distributable'
	| 'outputs'
	| 'scratch restore'
	| 'restore';

export type PackageStep = {
	readonly name: PackageStepName;
	readonly state: 'ok' | 'skipped' | 'failed';
	readonly detail: string;
};

/** One stamp of the run, resolved to the value the packaging will see. */
export type ResolvedStamp = {
	readonly name: string;
	readonly value: string;
	/** True when the value is the operator's own, not the one the type answers. */
	readonly fromEnvironment: boolean;
};

export type PackageFlags = {
	/** `--keep-overlay`: leave the materialized targets in the tree. */
	readonly keepOverlay: boolean;
	/** `--skip-type-build`: run only the product's own packaging step. */
	readonly skipTypeBuild: boolean;
};

/**
 * The steps a run with these flags will take, before it takes any of them.
 *
 * The order is the contract, and it is stated here rather than being implicit
 * in the control flow of `runPackage` so that a test can read it: the guard
 * before any write, the overlay before the build (a packaged product reads the
 * target), the stamps before the commands that need them, and the restore last
 * and unconditionally - `--keep-overlay` is the one thing that removes it. The
 * inputs come before all of it when the selected targets declare any
 * (##CMD-PACKAGE-INPUTS): the check only reads, and an offline run that misses
 * one is refused before the guard has even looked at the tree.
 */
export function packageStepPlan(
	type: ProjectType,
	flags: PackageFlags,
	packageBuild: readonly BuildCommand[] = type.build.packageBuild,
	hasInputs = false
): readonly PackageStepName[] {
	const steps: PackageStepName[] = [...(hasInputs ? (['inputs'] as const) : []), 'drift guard', 'overlay apply', 'stamps'];
	if (!flags.skipTypeBuild && packageBuild.length > 0) {
		steps.push('package build');
	}
	if (type.build.packageDistributable.length > 0) {
		steps.push('package distributable');
	}
	steps.push('outputs');
	// The residue of the packager is not the overlay, so `--keep-overlay` does
	// not keep it: nobody asked for those bytes, and the flag was asked to keep
	// the materialization for a hand check of the package.
	if (type.build.packageScratch.length > 0) {
		steps.push('scratch restore');
	}
	if (!flags.keepOverlay) {
		steps.push('restore');
	}
	return steps;
}

export type PackageCommand = {
	readonly label: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** The stamps of the type, added to the environment of the child. */
	readonly env: Readonly<Record<string, string>>;
	/** `--timeout <seconds>`, in milliseconds; null leaves the command unbounded. */
	readonly timeoutMs: number | null;
};

export type PackageCommandResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: Error;
};

/** The process seam: a test drives the plan without starting a packager. */
export type PackageCommandRunner = (command: PackageCommand) => PackageCommandResult;

export type PackageOptions = {
	readonly patchesDir: string;
	readonly resolution: ForkDirResolution;
	readonly config: CodkitConfig;
	readonly type: ProjectType;
	readonly out: Output;
	readonly flags: PackageFlags;
	readonly timeoutMs: number | null;
	readonly targetSelector?: string | null;
	readonly runCommand?: PackageCommandRunner;
	/** The operator's environment; a test hands its own instead of the process's. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** `--inputs <dir>`: the pre-provisioned inputs, as an absolute path (##CMD-PACKAGE-INPUTS). */
	readonly inputsDir?: string | null;
	/** The global `--ci`: an offline run fetches nothing. */
	readonly offline?: boolean;
	/** `--container-prefix <name>`: the first word of the names of the container route. */
	readonly containerPrefix?: string;
	/** The host the run is on; a test names one instead of the process's. */
	readonly host?: PackageHost;
};

/** Where one selected target is built (##CMD-PACKAGE-HOST-ROUTES). */
export type PackageRoute = {
	readonly target: string;
	readonly route: 'native' | 'container';
	/** The image and the volume of the container route; null for a native target. */
	readonly image: string | null;
	readonly volume: string | null;
};

export type PackageResult = {
	readonly exitCode: number;
	readonly steps: readonly PackageStep[];
	/** Overlay targets this run materialized itself, in target order. */
	readonly materialized: readonly string[];
	/** Of those, the ones it put back; empty under `--keep-overlay`. */
	readonly restored: readonly string[];
	/** Paths the packager rewrote as a side effect and this run put back. */
	readonly scratchRestored: readonly string[];
	readonly stamps: Readonly<Record<string, string>>;
	/** Of those, the names the operator's own environment already carried. */
	readonly stampsFromEnvironment: readonly string[];
	readonly commands: readonly string[];
	readonly outputs: readonly string[];
	readonly targets: readonly string[];
	readonly routes: readonly PackageRoute[];
	/** Every input the selected targets declare, and whether it was pre-provisioned. */
	readonly inputs: readonly { readonly name: string; readonly path: string; readonly from: string; readonly state: string }[];
};

/** One package run over an already loaded tree. The caller holds the tree lock. */
export function runPackage(options: PackageOptions): PackageResult {
	const { out, config, patchesDir, type } = options;
	const tree = options.resolution.path;
	const env = options.env ?? process.env;
	const offline = options.offline ?? false;
	const inputsDir = options.inputsDir ?? null;
	const host = options.host ?? (process.platform as PackageHost);
	const steps: PackageStep[] = [];
	const materialized: string[] = [];
	const commands: string[] = [];
	let restored: readonly string[] = [];
	let scratchRestored: readonly string[] = [];
	let outputs: readonly string[] = [];
	const selectedTargets = packageTargetsFor(type, options.targetSelector ?? null, host);
	const routed = selectedTargets.map((target) => routedTarget(options, target, host));
	const packageBuild = selectedTargets.length === 0 ? type.build.packageBuild : selectedTargets.flatMap((target) => target.build);
	const targets = selectedTargets.map((target) => target.id);
	const routes: readonly PackageRoute[] = routed.map((entry) => ({
		target: entry.target.id,
		route: entry.route,
		image: entry.container?.names.image ?? null,
		volume: entry.container?.names.volume ?? null
	}));
	const checked = checkInputs(inputsOf(selectedTargets, tree), inputsDir);
	const inputs = checked.map((entry) => ({ name: entry.input.name, path: entry.input.path, from: entry.input.from, state: entry.state }));
	const record = (name: PackageStepName, state: PackageStep['state'], detail: string): void => {
		steps.push({ name, state, detail });
		out.info(`package ${name}: ${state}${detail === '' ? '' : ` (${detail})`}`);
	};

	out.info(`package targets: ${targets.length === 0 ? 'legacy' : routed.map((entry) => `${entry.target.id} (${entry.route})`).join(', ')}`);
	out.info(`package plan: ${packageStepPlan(type, options.flags, packageBuild, checked.length > 0).join(' -> ')}`);
	const overlays = loadOverlays(patchesDir, type);
	const context = overlayVarContext(config, pinCommitDate(tree, config.pin.sha), patchSetCommitId(patchesDir));
	const stamps = packageStamps(type, config, tree, env);
	const stampValues = Object.fromEntries(stamps.map((stamp) => [stamp.name, stamp.value]));
	const stampsFromEnvironment = stamps.filter((stamp) => stamp.fromEnvironment).map((stamp) => stamp.name);
	const result = (exitCode: number): PackageResult => ({
		exitCode,
		steps,
		materialized,
		restored,
		scratchRestored,
		stamps: stampValues,
		stampsFromEnvironment,
		commands,
		outputs,
		targets,
		routes,
		inputs
	});

	// The checks that only read come before any write: the inputs, and what the
	// container route needs of the host (##CMD-PACKAGE-INPUTS,
	// ##CMD-PACKAGE-CONTAINER).
	if (checked.length > 0) {
		for (const line of inputLines(checked)) {
			out.info(line);
		}
		const missing = checked.filter((entry) => entry.state === 'missing');
		if (offline && missing.length > 0) {
			record('inputs', 'failed', `${missing.length} of ${checked.length} input(s) are not pre-provisioned`);
			out.addError(missingInputsRefusal(missing, inputsDir).toPayload());
			return result(EXIT_ENVIRONMENT);
		}
		record('inputs', 'ok', `${checked.length - missing.length} of ${checked.length} input(s) pre-provisioned${offline ? ', offline' : ''}`);
	}
	const preflight = containerPreflight(options, routed, offline);
	if (preflight !== null) {
		out.addError(preflight.error);
		return result(preflight.exitCode);
	}

	const guard = guardStep(options, overlays, context);
	if (guard !== null) {
		record('drift guard', 'failed', guard.detail);
		out.addError(guard.error);
		return result(guard.exitCode);
	}
	record('drift guard', 'ok', 'the fork tree carries no unextracted work');

	// From here on the tree carries bytes this run wrote, so the restore is a
	// `finally`: a build that fails halfway must not leave a developer's tree in
	// packaging state (R14 - what was announced is what happens).
	let exitCode = EXIT_OK;
	let runDir: string | null = null;
	try {
		for (const group of overlayTargets(overlays)) {
			if (applyOverlaysToTree(group.overlays, tree, config.pin.sha, context).changed) {
				materialized.push(group.target);
			}
		}
		record('overlay apply', 'ok', materialized.length === 0 ? 'every target was already materialized' : materialized.join(', '));

		record(
			'stamps',
			'ok',
			stamps.length === 0 ? `the project type ${type.id} stamps nothing` : stamps.map((stamp) => stamp.name).join(', ')
		);
		for (const stamp of stamps) {
			out.info(`stamp ${stamp.name}=${stamp.value}${stamp.fromEnvironment ? ' (from environment)' : ''}`);
		}
		if (options.flags.skipTypeBuild) {
			out.info(`skip-type-build: the application build of ${type.id} is not run; the tree is taken as already built`);
		}

		if (!options.flags.skipTypeBuild && packageBuild.length > 0) {
			// The inputs are wired once per run, and only for a native target that
			// runs: the container route wires them inside its container.
			let wired: Readonly<Record<string, string>> | null = null;
			const nativeEnvironment = (): Readonly<Record<string, string>> => {
				if (!offline && !checked.some((entry) => entry.state === 'provisioned')) {
					return stampValues;
				}
				if (wired === null) {
					runDir = mkdtempSync(join(tmpdir(), 'codkit-package-'));
					wired = { ...stampValues, ...nativeInputEnvironment(checked, runDir, tree, offline, env['PATH'] ?? env['Path'] ?? '') };
				}
				return wired;
			};
			const outcome =
				routed.length === 0
					? runCommands(options, packageBuild, stampValues, commands)
					: runRoutedTargets(options, routed, stampValues, nativeEnvironment, checked, commands);
			record('package build', outcome.state, outcome.detail);
			if (outcome.error !== null) {
				out.addError(outcome.error);
				exitCode = outcome.exitCode;
			}
		}
		if (exitCode === EXIT_OK && type.build.packageDistributable.length > 0) {
			const outcome = runCommands(options, type.build.packageDistributable, stampValues, commands);
			record('package distributable', outcome.state, outcome.detail);
			if (outcome.error !== null) {
				out.addError(outcome.error);
				exitCode = outcome.exitCode;
			}
		}

		if (exitCode === EXIT_OK) {
			const patterns = outputPatterns(type, selectedTargets);
			outputs = packageOutputPaths(tree, patterns, (text) => {
				out.warn(text);
			});
			record('outputs', 'ok', outputsDetail(type, patterns, outputs));
			for (const path of outputs) {
				out.info(`artifact ${path}`);
			}
		}
	} finally {
		// The packager's own leftovers first, the overlay after it: the overlay
		// restore is what rewrites the dev channel, and it has to be the last
		// thing that touches the tree.
		const scratch = restoreScratch(options);
		scratchRestored = scratch.paths;
		if (type.build.packageScratch.length > 0) {
			record('scratch restore', 'ok', scratch.detail);
		}
		restored = restoreOverlayTargets(options, overlays, context, materialized);
		if (options.flags.keepOverlay) {
			out.info(`keep-overlay: ${materialized.length} materialized target(s) stay in the fork tree; codkit load --fresh returns them`);
		} else {
			record('restore', 'ok', restored.length === 0 ? 'this run materialized nothing to put back' : restored.join(', '));
		}
		if (runDir !== null) {
			rmSync(runDir, { recursive: true, force: true });
		}
	}
	return result(exitCode);
}

/** The route of a selected target and, for the container route, the names of its image and volume. */
function outputPatterns(type: ProjectType, targets: readonly PackageTarget[]): readonly string[] {
	return [...new Set([...targets.flatMap((target) => target.outputs ?? []), ...type.build.packageOutputs])];
}

/** What the outputs step says when it found something, and when it did not. */
function outputsDetail(type: ProjectType, patterns: readonly string[], outputs: readonly string[]): string {
	if (outputs.length > 0) {
		return outputs.join(', ');
	}
	return patterns.length === 0
		? `the project type ${type.id} names no package output inside the tree`
		: 'no declared output exists in the tree';
}

/** The drift guard of `load`, with the exemption `load --fresh` makes. */
function guardStep(
	options: PackageOptions,
	overlays: readonly Overlay[],
	context: ReturnType<typeof overlayVarContext>
): { readonly detail: string; readonly error: CkErrorPayload; readonly exitCode: number } | null {
	const { config, out, patchesDir, type } = options;
	const tree = options.resolution.path;
	const branch = `${config.generatedBranchPrefix}${config.pin.tag}`;
	const known: string[] = [];
	const drift = driftDirty(
		materializerOf(type),
		tree,
		ownedRootsOf(type, config.typeConfig, { treeDir: tree, pinSha: config.pin.sha }),
		patchesDir,
		{
			generated: { pinSha: config.pin.sha, branch },
			isKnownMaterialization: overlayMaterializationClassifier(overlays, tree, config.pin.sha, context, known)
		}
	);
	const head = treeHeadError(drift.treeCommits, branch);
	if (head !== null) {
		return {
			detail: 'HEAD of the tree is not on the generated branch while it carries commits',
			error: head.toPayload(),
			exitCode: EXIT_CHECK_FAILED
		};
	}
	if (known.length > 0) {
		out.info(`${known.join(', ')} already carries the exact overlay materialization; this run keeps it`);
	}
	if (!drift.dirty) {
		return null;
	}
	for (const path of drift.files.slice(0, DIRTY_LIST_LIMIT)) {
		out.info(`  dirty: ${path}`);
	}
	if (drift.files.length > DIRTY_LIST_LIMIT) {
		out.info(`  ... and ${drift.files.length - DIRTY_LIST_LIMIT} more`);
	}
	const commits = drift.commits.length;
	return {
		detail:
			commits > 0
				? `${commits} commit(s) in the fork tree are not in patchset`
				: `${drift.files.length} path(s) differ from what patchset carries`,
		error: {
			code: 'DIRTY-TREE',
			message:
				commits > 0
					? `${commits} commit(s) in the fork tree since the last codkit apply are not in patchset yet`
					: `${drift.files.length} path(s) in the fork tree carry changes that are not in patchset yet`,
			hint: 'run codkit save, or codkit status; packaging never gives up work of the tree on its own'
		},
		exitCode: EXIT_CHECK_FAILED
	};
}

type OverlayTargetGroup = { readonly target: string; readonly overlays: readonly Overlay[] };

/** The overlays of the delta, grouped by target, in target order. */
function overlayTargets(overlays: readonly Overlay[]): readonly OverlayTargetGroup[] {
	const byTarget = new Map<string, Overlay[]>();
	for (const overlay of overlays) {
		const bucket = byTarget.get(overlay.target);
		if (bucket === undefined) {
			byTarget.set(overlay.target, [overlay]);
			continue;
		}
		bucket.push(overlay);
	}
	return [...byTarget.keys()].sort().map((target) => ({ target, overlays: byTarget.get(target) ?? [] }));
}

/**
 * Put back exactly the targets this run materialized, and rewrite the dev
 * channel over them - which is what a tree in dev mode carries
 * (PROP-005 ##OVERLAY-TWO-CHANNELS). A target somebody else materialized is
 * left alone: this run did not write it, and `load --fresh` is the command that
 * owns that state.
 */
function restoreOverlayTargets(
	options: PackageOptions,
	overlays: readonly Overlay[],
	context: ReturnType<typeof overlayVarContext>,
	materialized: readonly string[]
): readonly string[] {
	if (options.flags.keepOverlay || materialized.length === 0) {
		return [];
	}
	const tree = options.resolution.path;
	restoreToTip(tree, materialized);
	writeDevChannel(options.type, tree, overlays, context, options.config.pin.sha, (text) => {
		options.out.warn(text);
	});
	return [...materialized];
}

/**
 * Put back the paths the packager rewrote as a side effect of running.
 *
 * Only the paths the type named, and only to the tip of the loaded tree - the
 * same `git checkout HEAD --` the overlay restore uses. The guard at the start
 * of the run proved the tree carried no unextracted work, so a named path that
 * differs now differs because the packaging changed it; a path nothing changed
 * is not touched and is not reported. Untracked files are left alone: removing
 * a file nobody tracked is what `load --fresh` does, and it is not a side
 * effect of packaging.
 */
function restoreScratch(options: PackageOptions): { readonly paths: readonly string[]; readonly detail: string } {
	const tree = options.resolution.path;
	const paths = packageScratchPaths(tree, options.type.build.packageScratch, (text) => {
		options.out.warn(text);
	});
	if (paths.length === 0) {
		return { paths, detail: 'the packaging changed none of the paths the project type names' };
	}
	restoreToTip(tree, paths);
	return { paths, detail: paths.join(', ') };
}

/**
 * The environment the family asks for, and where each value came from.
 *
 * A name the operator already exported keeps the operator's value
 * (##TYPE-STAMPS-FILL-A-GAP): the stamps of a type exist because a packager
 * reads a variable nobody remembers to set, not because the tool has an opinion
 * about a variable somebody set deliberately. An exported name whose value is
 * empty is an empty value and not an answer, so the type still fills it - which
 * is also what keeps `FOO= codkit package` from silently packaging with an
 * empty channel.
 */
export function packageStamps(
	type: ProjectType,
	config: CodkitConfig,
	treeDir: string,
	env: Readonly<Record<string, string | undefined>> = process.env
): readonly ResolvedStamp[] {
	return type.build.packageStamps.map((stamp) => {
		const exported = env[stamp.name];
		if (exported !== undefined && exported !== '') {
			return { name: stamp.name, value: exported, fromEnvironment: true };
		}
		return { name: stamp.name, value: valueOfStamp(stamp, config, treeDir), fromEnvironment: false };
	});
}

/** What the run itself, or the type's own configuration, fills a stamp with. */
function valueOfStamp(stamp: BuildStamp, config: CodkitConfig, treeDir: string): string {
	switch (stamp.source) {
		case 'tree-head':
			return revParse(treeDir, 'HEAD') ?? '';
		case 'pin-tag':
			return config.pin.tag;
		case 'pin-date':
			return config.pin.date;
		default:
			return stamp.value;
	}
}

export { packageTargetsFor, routeOf } from './packageRoutes.ts';
