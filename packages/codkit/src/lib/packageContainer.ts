/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-CONTAINER */
// The container route of `codkit package`: a target built in a container of its
// type's recipe, over a read-only view of the fork tree.
// Contract: PROP-007 sec. 27 (##CMD-PACKAGE-CONTAINER,
// ##CMD-PACKAGE-CONTAINER-PROTOCOL, ##DECISION-PACKAGE-CONTAINER-ROUTE); the
// answers it reads: PROP-016 ##TYPE-PACKAGE-TARGETS.
//
// What this module owns is what any family needs of the host: the names of the
// image and of the volume, the image built only when it is not there, the
// mounts, the files of the protocol - the commands, the output patterns and the
// modes git records, which a tree checked out on a host without POSIX modes
// does not carry - and the artifacts copied back into the tree. What runs inside
// the container is the type's entry, and this module never names one of its
// tools.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BuildCommand, PackageContainer, PackageTarget } from '@codkit/type-api';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import type { CheckedInput } from './packageInputs.ts';
import { fetchAnswerScript, fetchAnswers, needsFetchAnswer } from './packageInputs.ts';
import { packageOutputPaths } from './packagePaths.ts';

/** Where the protocol puts things inside the container. */
export const CONTAINER_TREE = '/codkit/tree';
export const CONTAINER_WORK = '/codkit/work';
export const CONTAINER_IO = '/codkit/io';
export const CONTAINER_INPUTS = '/codkit/inputs';
export const CONTAINER_RUN = '/codkit/run';

/** The first word of the names of the route when the operator gives none. */
export const DEFAULT_CONTAINER_PREFIX = 'codkit';

const PREFIX_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** A `--container-prefix` the names of docker can carry, or a refusal. */
export function requireContainerPrefix(prefix: string): string {
	if (!PREFIX_SHAPE.test(prefix)) {
		throw ckError(
			'CONFIG',
			`--container-prefix ${JSON.stringify(prefix)} is not a name docker takes`,
			'use lowercase letters and digits, with single - between them'
		);
	}
	return prefix;
}

/** The platform docker is asked for, by the architecture of the target. */
export function dockerPlatform(arch: PackageTarget['arch']): string {
	switch (arch) {
		case 'x64':
			return 'linux/amd64';
		case 'arm64':
			return 'linux/arm64';
		default:
			return 'linux/arm/v7';
	}
}

export type TreeArgument = { readonly name: string; readonly value: string };

/** The build arguments the recipe reads from the tree: the first line of each named file. */
export function treeArguments(container: PackageContainer, treeDir: string): readonly TreeArgument[] {
	return Object.entries(container.treeArguments).map(([name, file]) => {
		const path = join(treeDir, ...file.split('/'));
		const value = existsSync(path) ? (readFileSync(path, 'utf8').split(/\r?\n/u)[0] ?? '').trim() : '';
		if (value === '') {
			throw ckError(
				'CONFIG',
				`the container recipe reads its argument ${name} from ${file} of the fork tree, and the tree has no value there`,
				`restore ${file} in the fork tree`
			);
		}
		return { name, value };
	});
}

/**
 * The hash of the image: every file of the recipe - its path relative to the
 * recipe, a NUL, its bytes, a NUL, in path order - and the tree arguments.
 */
export function recipeHash(recipe: string, args: readonly TreeArgument[]): string {
	const hash = createHash('sha256');
	for (const path of recipeFiles(recipe)) {
		hash.update(path, 'utf8');
		hash.update('\0');
		hash.update(readFileSync(join(recipe, ...path.split('/'))));
		hash.update('\0');
	}
	for (const arg of args) {
		hash.update(`${arg.name}=${arg.value}\0`, 'utf8');
	}
	return hash.digest('hex').slice(0, 12);
}

function recipeFiles(directory: string, prefix = ''): readonly string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory).sort()) {
		const path = join(directory, entry);
		const shown = prefix === '' ? entry : `${prefix}/${entry}`;
		if (statSync(path).isDirectory()) {
			found.push(...recipeFiles(path, shown));
			continue;
		}
		found.push(shown);
	}
	return found;
}

export type ContainerNames = {
	/** `<prefix>-<type>-<platform>-<arch>:<hash>`. */
	readonly image: string;
	/** `<prefix>-<type>-<platform>-<arch>-<treeId>`: the volume, and the name of the container. */
	readonly volume: string;
};

export function containerNames(prefix: string, typeId: string, target: PackageTarget, hash: string, tree: string): ContainerNames {
	const base = `${prefix}-${typeId}-${target.platform}-${target.arch}`;
	return { image: `${base}:${hash}`, volume: `${base}-${tree}` };
}

/** The names of the environment that match a list of names and `prefix*` patterns, in the order of the list. */
export function passedEnvironment(patterns: readonly string[], env: Readonly<Record<string, string | undefined>>): readonly string[] {
	const present = Object.keys(env)
		.filter((name) => env[name] !== undefined)
		.sort();
	const names: string[] = [];
	for (const pattern of patterns) {
		const matching = pattern.endsWith('*')
			? present.filter((name) => name.startsWith(pattern.slice(0, -1)))
			: present.filter((name) => name === pattern);
		for (const name of matching) {
			if (!names.includes(name)) {
				names.push(name);
			}
		}
	}
	return names;
}

/** The argv of `docker build` for the recipe; a variable of the environment is passed by name only. */
export function imageBuildArgs(
	container: PackageContainer,
	names: ContainerNames,
	platform: string,
	args: readonly TreeArgument[],
	buildEnvironment: readonly string[]
): readonly string[] {
	return [
		'build',
		'--platform',
		platform,
		'--tag',
		names.image,
		...args.flatMap((arg) => ['--build-arg', `${arg.name}=${arg.value}`]),
		...buildEnvironment.flatMap((name) => ['--build-arg', name]),
		container.recipe
	];
}

/** One bind or volume mount, in the form `--mount` reads. */
export type ContainerMount = {
	readonly kind: 'bind' | 'volume';
	readonly source: string;
	readonly target: string;
	readonly readonly: boolean;
};

export function mountArg(mount: ContainerMount): string {
	const fields = [`type=${mount.kind}`, csvField(`src=${mount.source}`), `dst=${mount.target}`];
	if (mount.readonly) {
		fields.push('readonly');
	}
	return fields.join(',');
}

/** A field of the comma-separated value `--mount` takes, quoted when it has to be. */
function csvField(field: string): string {
	return /[",]/u.test(field) ? `"${field.replace(/"/gu, '""')}"` : field;
}

export type ContainerRun = {
	readonly names: ContainerNames;
	readonly platform: string;
	readonly mounts: readonly ContainerMount[];
	readonly offline: boolean;
	readonly runEnvironment: readonly string[];
};

/** The argv of `docker run` for one run of the route. */
export function containerRunArgs(run: ContainerRun): readonly string[] {
	return [
		'run',
		'--rm',
		'--name',
		run.names.volume,
		'--platform',
		run.platform,
		...(run.offline ? ['--network', 'none'] : []),
		...run.mounts.flatMap((mount) => ['--mount', mountArg(mount)]),
		'--env',
		`CODKIT_OFFLINE=${run.offline ? '1' : '0'}`,
		...run.runEnvironment.flatMap((name) => ['--env', name]),
		run.names.image
	];
}

/** The mounts of one run: the tree read-only, the volume, the run's directory, the inputs and the directory inputs. */
export function containerMounts(
	treeDir: string,
	volume: string,
	ioDir: string,
	inputsDir: string | null,
	checked: readonly CheckedInput[]
): readonly ContainerMount[] {
	const mounts: ContainerMount[] = [
		{ kind: 'bind', source: treeDir, target: CONTAINER_TREE, readonly: true },
		{ kind: 'volume', source: volume, target: CONTAINER_WORK, readonly: false },
		{ kind: 'bind', source: ioDir, target: CONTAINER_IO, readonly: false }
	];
	if (inputsDir !== null) {
		mounts.push({ kind: 'bind', source: inputsDir, target: CONTAINER_INPUTS, readonly: true });
	}
	for (const entry of checked) {
		if (entry.state !== 'provisioned' || entry.copy === null || entry.input.use.kind !== 'directory') {
			continue;
		}
		for (const name of readdirSync(entry.copy).sort()) {
			mounts.push({
				kind: 'bind',
				source: join(entry.copy, name),
				target: `${CONTAINER_RUN}/${entry.input.use.variable}/${name}`,
				readonly: true
			});
		}
	}
	return mounts;
}

/** The environment the provisioned inputs give a command inside the container. */
export function containerInputEnvironment(checked: readonly CheckedInput[]): Readonly<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const entry of checked) {
		if (entry.state !== 'provisioned') {
			continue;
		}
		const use = entry.input.use;
		if (use.kind === 'environment') {
			env[use.variable] = `${CONTAINER_INPUTS}/${entry.input.path}`;
		}
		if (use.kind === 'directory') {
			env[use.variable] = `${CONTAINER_RUN}/${use.variable}`;
		}
	}
	return env;
}

/** A command of `commands.json`. */
export type ContainerCommand = {
	readonly label: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
};

export function containerCommands(build: readonly BuildCommand[], env: Readonly<Record<string, string>>): readonly ContainerCommand[] {
	return build.map((command) => ({ label: command.label, command: command.command, args: [...command.args], env: { ...env } }));
}

/** What git records of the tree that a checkout on a host without POSIX modes does not carry. */
export type TreeModes = {
	readonly executables: readonly string[];
	readonly symlinks: readonly { readonly path: string; readonly target: string }[];
};

export function treeModes(treeDir: string): TreeModes {
	const listed = runGit({ args: ['ls-files', '-s', '-z'], cwd: treeDir });
	if (listed.status !== 0) {
		throw ckError(
			'NOT-A-REPO',
			`git ls-files failed in the fork tree: ${listed.stderr.trim()}`,
			'run the command against a checked-out fork tree'
		);
	}
	const executables: string[] = [];
	const symlinks: { path: string; target: string }[] = [];
	for (const record of listed.stdout.split('\0')) {
		const match = /^(\d{6}) ([0-9a-f]+) \d\t(.+)$/su.exec(record);
		if (match === null) {
			continue;
		}
		const [, mode, blob, path] = match;
		if (mode === '100755' && path !== undefined) {
			executables.push(path);
		}
		if (mode === '120000' && path !== undefined && blob !== undefined) {
			const target = runGit({ args: ['cat-file', 'blob', blob], cwd: treeDir });
			if (target.status === 0) {
				symlinks.push({ path, target: target.stdout });
			}
		}
	}
	return { executables, symlinks };
}

export type ContainerIo = {
	readonly commands: readonly ContainerCommand[];
	readonly outputs: readonly string[];
	readonly modes: TreeModes;
	readonly treeInputs: readonly { readonly source: string; readonly target: string }[];
	/** The fetch answer, or null when the run has none. */
	readonly shim: string | null;
};

/** Write the files of the protocol into the run's directory (##CMD-PACKAGE-CONTAINER-PROTOCOL). */
export function writeContainerIo(ioDir: string, io: ContainerIo): void {
	mkdirSync(join(ioDir, 'out'), { recursive: true });
	writeFileSync(join(ioDir, 'commands.json'), `${JSON.stringify(io.commands, null, 2)}\n`, 'utf8');
	writeFileSync(join(ioDir, 'outputs.json'), `${JSON.stringify(io.outputs, null, 2)}\n`, 'utf8');
	writeFileSync(join(ioDir, 'tree-inputs.json'), `${JSON.stringify(io.treeInputs, null, 2)}\n`, 'utf8');
	writeFileSync(join(ioDir, 'executables'), io.modes.executables.map((path) => `${path}\0`).join(''), 'utf8');
	writeFileSync(join(ioDir, 'symlinks'), io.modes.symlinks.map((link) => `${link.path}\0${link.target}\0`).join(''), 'utf8');
	if (io.shim !== null) {
		mkdirSync(join(ioDir, 'shim'), { recursive: true });
		writeFileSync(join(ioDir, 'shim', 'curl'), io.shim, { encoding: 'utf8', mode: 0o755 });
	}
}

/** The tree inputs of a run as the entry places them into its copy. */
export function containerTreeInputs(checked: readonly CheckedInput[]): readonly { readonly source: string; readonly target: string }[] {
	return checked
		.filter((entry) => entry.state === 'provisioned' && entry.input.use.kind === 'tree')
		.map((entry) => ({
			source: `${CONTAINER_INPUTS}/${entry.input.path}`,
			target: entry.input.use.kind === 'tree' ? entry.input.use.target : ''
		}));
}

/** The fetch answer of a run inside the container, or null when the run needs none. */
export function containerShim(checked: readonly CheckedInput[], offline: boolean): string | null {
	if (!needsFetchAnswer(checked, offline)) {
		return null;
	}
	return fetchAnswerScript(
		fetchAnswers(checked, (entry) => `${CONTAINER_INPUTS}/${entry.input.path}`),
		offline
	);
}

/**
 * Take the artifacts the entry left in `out/` into the tree: first the existing
 * matches of the target's outputs go, so the tree holds this run's artifacts and
 * no earlier one, then every file is copied in at its relative path. The paths
 * that arrived are answered in their order.
 */
export function takeContainerOutputs(
	ioDir: string,
	treeDir: string,
	patterns: readonly string[],
	onWarn: (text: string) => void
): readonly string[] {
	for (const path of packageOutputPaths(treeDir, patterns, onWarn)) {
		rmSync(join(treeDir, ...path.replace(/\/$/u, '').split('/')), { recursive: true, force: true });
	}
	const out = join(ioDir, 'out');
	const arrived: string[] = [];
	for (const file of filesUnder(out)) {
		const shown = relative(out, file).split('\\').join('/');
		const destination = join(treeDir, ...shown.split('/'));
		mkdirSync(join(destination, '..'), { recursive: true });
		cpSync(file, destination);
		arrived.push(shown);
	}
	return arrived;
}

function filesUnder(directory: string): readonly string[] {
	if (!existsSync(directory)) {
		return [];
	}
	const found: string[] = [];
	for (const entry of readdirSync(directory).sort()) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			found.push(...filesUnder(path));
			continue;
		}
		found.push(path);
	}
	return found;
}
