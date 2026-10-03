/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Target selection and container routes, independent of orchestration.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackageHost, PackageTarget, ProjectType } from '@codkit/type-api';
import { EXIT_ENVIRONMENT, EXIT_OK } from './command.ts';

import { treeId } from './fingerprint.ts';
import { ckError } from './messages.ts';
import type { CkErrorPayload } from './messages.ts';

import {
	DEFAULT_CONTAINER_PREFIX,
	containerCommands,
	containerInputEnvironment,
	containerMounts,
	containerNames,
	containerRunArgs,
	containerShim,
	containerTreeInputs,
	dockerPlatform,
	imageBuildArgs,
	passedEnvironment,
	recipeHash,
	takeContainerOutputs,
	treeArguments,
	treeModes,
	writeContainerIo
} from './packageContainer.ts';
import type { ContainerNames, TreeArgument } from './packageContainer.ts';

import type { CheckedInput } from './packageInputs.ts';

import type { PackageOptions, PackageCommandRunner, PackageCommandResult } from './packageEngine.ts';
import { runCommands, runOne, defaultPackageCommandRunner, outputLines } from './packageRuntime.ts';
import type { CommandsOutcome } from './packageRuntime.ts';
/** The route of a target on a host: native, in the type's container, or none (##CMD-PACKAGE-HOST-ROUTES). */
export function routeOf(target: PackageTarget, host: PackageHost): 'native' | 'container' | null {
	if (target.supportedHosts.includes(host)) {
		return 'native';
	}
	if (target.container?.hosts.includes(host) === true) {
		return 'container';
	}
	return null;
}

export function packageTargetsFor(type: ProjectType, selector: string | null, host: PackageHost): readonly PackageTarget[] {
	const catalog = type.build.packageTargets ?? [];
	if (catalog.length === 0) {
		if (selector !== null)
			throw ckError(
				'CONFIG',
				`the project type ${type.id} has no selectable package target catalog`,
				'omit the selector or choose a type that declares package targets'
			);
		return [];
	}
	const ids =
		selector === null
			? (type.build.defaultPackageTargets ?? [])
			: selector === 'all'
				? catalog.filter((candidate) => routeOf(candidate, host) !== null).map((candidate) => candidate.id)
				: ['windows', 'linux', 'macos'].includes(selector)
					? catalog
							.filter((candidate) => candidate.platform === selector && routeOf(candidate, host) !== null)
							.map((candidate) => candidate.id)
					: [selector];
	const unique = [...new Set(ids)];
	const targets = unique
		.map((id) => catalog.find((candidate) => candidate.id === id))
		.filter((candidate): candidate is PackageTarget => candidate !== undefined);
	if (targets.length !== unique.length)
		throw ckError(
			'CONFIG',
			`unknown package target: ${unique.find((id) => !catalog.some((candidate) => candidate.id === id))}`,
			`choose one of: ${catalog.map((target) => target.id).join(', ')}, a platform family, or all`
		);
	const unsupported = targets.find((candidate) => routeOf(candidate, host) === null);
	if (unsupported !== undefined) {
		const reason = unsupported.hostRefusal?.reason;
		const hosts = [...unsupported.supportedHosts, ...(unsupported.container?.hosts ?? [])];
		throw ckError(
			'CONFIG',
			`package target ${unsupported.id} is not supported on host ${host}${reason === undefined ? '' : `: ${reason}`}`,
			unsupported.hostRefusal?.hint ?? `run this target on one of: ${hosts.join(', ')}`
		);
	}
	if (targets.length === 0)
		throw ckError(
			'CONFIG',
			`package selector ${selector ?? '(default)'} has no targets supported on host ${host}`,
			'choose an exact target supported by this host'
		);
	return targets;
}

/** A selected target with its route and, for the container route, its names. */
type RoutedTarget = {
	readonly target: PackageTarget;
	readonly route: 'native' | 'container';
	readonly container: { readonly names: ContainerNames; readonly args: readonly TreeArgument[] } | null;
};

export function routedTarget(options: PackageOptions, target: PackageTarget, host: PackageHost): RoutedTarget {
	const route = routeOf(target, host) ?? 'native';
	const container = target.container;
	if (route === 'native' || container === undefined) {
		return { target, route: 'native', container: null };
	}
	const tree = options.resolution.path;
	const args = treeArguments(container, tree);
	const names = containerNames(
		options.containerPrefix ?? DEFAULT_CONTAINER_PREFIX,
		options.type.id,
		target,
		recipeHash(container.recipe, args),
		treeId(tree)
	);
	return { target, route: 'container', container: { names, args } };
}

/**
 * What the container route needs of the host, asked before any write: a docker
 * that starts, and - for an offline run, which cannot build one - the image.
 */
export function containerPreflight(
	options: PackageOptions,
	routed: readonly RoutedTarget[],
	offline: boolean
): { readonly error: CkErrorPayload; readonly exitCode: number } | null {
	const inContainer = routed.filter((entry) => entry.container !== null);
	if (inContainer.length === 0) {
		return null;
	}
	const run = options.runCommand ?? defaultPackageCommandRunner;
	const probe = runQuietly(run, options, ['version', '--format', '{{.Server.Version}}']);
	if (probe.status !== EXIT_OK || probe.error !== undefined) {
		return {
			error: {
				code: 'PACKAGE-FAILED',
				message: `docker could not be started for the container route of ${inContainer.map((entry) => entry.target.id).join(', ')}: ${
					probe.error?.message ?? (lastLine(probe.stderr) || `docker version exited ${probe.status}`)
				}`,
				hint: 'the container route needs a running Docker engine and the docker command on PATH'
			},
			exitCode: EXIT_ENVIRONMENT
		};
	}
	if (!offline) {
		return null;
	}
	for (const entry of inContainer) {
		const image = entry.container?.names.image ?? '';
		if (runQuietly(run, options, ['image', 'inspect', image]).status !== EXIT_OK) {
			return {
				error: {
					code: 'NET-FORBIDDEN',
					message: `an offline run fetches nothing, and the image ${image} of the container route of ${entry.target.id} is not there: building it needs the network`,
					hint: 'run the same codkit package once without --ci, or load the image into docker under that name'
				},
				exitCode: EXIT_ENVIRONMENT
			};
		}
	}
	return null;
}

/** The build commands of every selected target, each on its route, stopping at the first that fails. */
export function runRoutedTargets(
	options: PackageOptions,
	routed: readonly RoutedTarget[],
	stamps: Readonly<Record<string, string>>,
	nativeEnvironment: () => Readonly<Record<string, string>>,
	checked: readonly CheckedInput[],
	into: string[]
): CommandsOutcome {
	const details: string[] = [];
	for (const entry of routed) {
		const outcome =
			entry.container === null
				? runCommands(options, entry.target.build, nativeEnvironment(), into)
				: runContainerTarget(options, entry.target, entry.container, stamps, checked, into);
		if (outcome.error !== null) {
			return outcome;
		}
		details.push(`${entry.target.id}: ${outcome.detail}`);
	}
	return { state: 'ok', detail: details.join('; '), error: null, exitCode: EXIT_OK };
}

/**
 * One target on the container route (##CMD-PACKAGE-CONTAINER): the image when it
 * is not there, the volume, the files of the protocol, the run, and the
 * artifacts back into the tree. The run's directory goes whatever the verdict.
 */
function runContainerTarget(
	options: PackageOptions,
	target: PackageTarget,
	container: { readonly names: ContainerNames; readonly args: readonly TreeArgument[] },
	stamps: Readonly<Record<string, string>>,
	checked: readonly CheckedInput[],
	into: string[]
): CommandsOutcome {
	const recipe = target.container;
	if (recipe === undefined) {
		throw new Error(`package target ${target.id} has no container`);
	}
	const env = options.env ?? process.env;
	const tree = options.resolution.path;
	const offline = options.offline ?? false;
	const platform = dockerPlatform(target.arch);
	const run = options.runCommand ?? defaultPackageCommandRunner;
	const { names, args } = container;
	const valuesOf = (namesOfVariables: readonly string[]): Record<string, string> =>
		Object.fromEntries(namesOfVariables.map((name) => [name, env[name] ?? '']));

	if (runQuietly(run, options, ['image', 'inspect', names.image]).status !== EXIT_OK) {
		const buildEnvironment = passedEnvironment(recipe.buildEnvironment, env);
		const buildArgs = imageBuildArgs(recipe, names, platform, args, buildEnvironment);
		const built = runOne(options, `container image ${names.image}`, 'docker', buildArgs, valuesOf(buildEnvironment), into);
		if (built.error !== null) {
			return {
				...built,
				error: {
					...built.error,
					hint: `build the image yourself under the name ${names.image}, with the options your network needs, and run again: docker ${buildArgs.join(' ')}`
				}
			};
		}
	}
	const volume = runOne(options, `container volume ${names.volume}`, 'docker', ['volume', 'create', names.volume], {}, into);
	if (volume.error !== null) {
		return volume;
	}
	const ioDir = mkdtempSync(join(tmpdir(), 'codkit-package-'));
	try {
		writeContainerIo(ioDir, {
			commands: containerCommands(target.build, { ...stamps, ...containerInputEnvironment(checked) }),
			outputs: target.outputs ?? [],
			modes: treeModes(tree),
			treeInputs: containerTreeInputs(checked),
			shim: containerShim(checked, offline)
		});
		const runEnvironment = passedEnvironment(recipe.runEnvironment, env);
		const runArgs = containerRunArgs({
			names,
			platform,
			mounts: containerMounts(tree, names.volume, ioDir, options.inputsDir ?? null, checked),
			offline,
			runEnvironment
		});
		const outcome = runOne(options, `package ${target.id} in the container`, 'docker', runArgs, valuesOf(runEnvironment), into);
		if (outcome.error !== null) {
			// A container that --timeout stopped outlives its docker client.
			runQuietly(run, options, ['rm', '--force', names.volume]);
			return outcome;
		}
		const arrived = takeContainerOutputs(ioDir, tree, target.outputs ?? [], (text) => {
			options.out.warn(text);
		});
		for (const path of arrived) {
			options.out.info(`container artifact ${path} copied into the fork tree`);
		}
		return { ...outcome, detail: `in the container ${names.image}, ${arrived.length} artifact(s) copied into the fork tree` };
	} finally {
		rmSync(ioDir, { recursive: true, force: true });
	}
}

/** A docker command whose output nobody reads: a probe, or a cleanup. */
function runQuietly(run: PackageCommandRunner, options: PackageOptions, args: readonly string[]): PackageCommandResult {
	try {
		return run({ label: 'docker', command: 'docker', args: [...args], cwd: options.resolution.path, env: {}, timeoutMs: null });
	} catch (error) {
		return { status: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) };
	}
}

function lastLine(text: string): string {
	return outputLines(text).at(-1) ?? '';
}

/** The output patterns of the selected targets and then the type's own, each once. */
