// Where `codkit package` builds a target and with what (PROP-007
// ##CMD-PACKAGE-HOST-ROUTES, ##CMD-PACKAGE-TARGET-OUTPUTS, ##CMD-PACKAGE-INPUTS,
// ##CMD-PACKAGE-CONTAINER, ##CMD-PACKAGE-CONTAINER-PROTOCOL).
//
// The container route is driven through the process seam of the engine: the
// runner below plays docker, answers the probes it is asked, reads what the
// engine handed the container in the run's directory, and leaves an artifact
// there the way an entry would. The tree, the overlay and the restore around it
// are real.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PackageInput, PackageTarget, ProjectType } from '@codkit/type-api';
import { runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import {
	containerNames,
	mountArg,
	passedEnvironment,
	recipeHash,
	requireContainerPrefix,
	treeModes
} from '../../src/lib/packageContainer.ts';
import { packageTargetsFor, routeOf, runPackage } from '../../src/lib/packageEngine.ts';
import type { PackageCommand, PackageCommandResult, PackageOptions } from '../../src/lib/packageEngine.ts';
import { checkInputs, fetchAnswerScript, nativeInputEnvironment, OFFLINE_PROXY } from '../../src/lib/packageInputs.ts';
import { stubType } from '../fixtures/stubType.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

// One loaded tree serves every run below: a run puts the tree back, and each
// test starts from an empty `.build/`. Loading a tree is the slow part.
let shared: SyncFixture | null = null;

beforeAll(() => {
	shared = makeSyncFixture('package-routes');
	expect(shared.sync().exitCode).toBe(0);
}, 180_000);

afterAll(() => {
	cleanupTempRoots();
});

/** A recipe directory of two files, as a type package would ship one. */
function makeRecipe(label: string): string {
	const recipe = makeTempRoot(label);
	writeFileSync(join(recipe, 'Dockerfile'), 'FROM example:1\nCOPY entry.sh /entry.sh\n', 'utf8');
	writeFileSync(join(recipe, 'entry.sh'), '#!/bin/sh\necho entry\n', 'utf8');
	return recipe;
}

const RECIPE = makeRecipe('package-routes-recipe');

const INPUTS: readonly PackageInput[] = [
	{
		name: 'the runtime archive',
		from: 'https://example.invalid/runtime.zip',
		path: 'runtime',
		use: { kind: 'environment', variable: 'RUNTIME_DIR' }
	},
	{
		name: 'the helper script',
		from: 'https://example.invalid/helper.pl',
		path: 'helper.pl',
		use: { kind: 'fetch', url: 'https://example.invalid/helper.pl' }
	},
	{
		name: 'the cache of downloads',
		from: 'https://example.invalid/cache',
		path: 'cache',
		use: { kind: 'directory', variable: 'CACHE_HOME' }
	},
	{
		name: 'the add-ons of the manifest',
		from: 'https://example.invalid/addons',
		path: 'addons',
		use: { kind: 'tree', target: '.build/addons' }
	}
];

const CONTAINER_TARGET: PackageTarget = {
	id: 'linux-x64-pkg',
	platform: 'linux',
	arch: 'x64',
	supportedHosts: ['linux'],
	container: {
		hosts: ['win32', 'darwin'],
		recipe: RECIPE,
		treeArguments: { NODE_VERSION: '.nvmrc' },
		buildEnvironment: ['MIRROR_URL'],
		runEnvironment: ['PROXY_URL', 'REGISTRY_*']
	},
	outputs: ['.build/out/*.pkg'],
	build: [
		{ label: 'bundle', command: 'npm', args: ['run', 'bundle'] },
		{ label: 'pack', command: 'bash', args: ['-c', 'pack the bundle'] }
	],
	inputs: () => INPUTS
};

const RAW_TARGET: PackageTarget = {
	id: 'linux-x64',
	platform: 'linux',
	arch: 'x64',
	supportedHosts: ['linux'],
	hostRefusal: {
		reason: 'a raw bundle built here carries the modules of this host',
		hint: 'build linux-x64-pkg, which takes the container'
	},
	build: [{ label: 'raw bundle', command: 'npm', args: ['run', 'bundle'] }]
};

const WINDOWS_TARGET: PackageTarget = {
	id: 'windows-x64',
	platform: 'windows',
	arch: 'x64',
	supportedHosts: ['win32'],
	build: [{ label: 'windows bundle', command: 'npm', args: ['run', 'bundle-windows'] }]
};

function catalogType(targets: readonly PackageTarget[] = [WINDOWS_TARGET, RAW_TARGET, CONTAINER_TARGET]): ProjectType {
	const base = stubType({});
	return stubType({
		build: { ...base.build, packageDistributable: [], packageTargets: targets, defaultPackageTargets: [targets[0]?.id ?? ''] }
	});
}

describe('the route of a target on a host', () => {
	it('is native on a supported host, the container on a container host, and none elsewhere', () => {
		expect(routeOf(CONTAINER_TARGET, 'linux')).toBe('native');
		expect(routeOf(CONTAINER_TARGET, 'win32')).toBe('container');
		expect(routeOf(CONTAINER_TARGET, 'darwin')).toBe('container');
		expect(routeOf(RAW_TARGET, 'win32')).toBeNull();
		expect(routeOf(WINDOWS_TARGET, 'linux')).toBeNull();
	});

	it('keeps a container target in a family and in all, and leaves out a target with no route', () => {
		const type = catalogType();
		expect(packageTargetsFor(type, 'linux', 'win32').map((target) => target.id)).toEqual(['linux-x64-pkg']);
		expect(packageTargetsFor(type, 'all', 'win32').map((target) => target.id)).toEqual(['windows-x64', 'linux-x64-pkg']);
		expect(packageTargetsFor(type, 'all', 'linux').map((target) => target.id)).toEqual(['linux-x64', 'linux-x64-pkg']);
	});

	it('refuses an exact target with no route with the reason and the hint of its type', () => {
		const type = catalogType();
		let refusal: unknown = null;
		try {
			packageTargetsFor(type, 'linux-x64', 'win32');
		} catch (error) {
			refusal = error;
		}
		const payload = (refusal as { toPayload(): { code: string; message: string; hint?: string } }).toPayload();
		expect(payload.code).toBe('CONFIG');
		expect(payload.message).toBe(
			'package target linux-x64 is not supported on host win32: a raw bundle built here carries the modules of this host'
		);
		expect(payload.hint).toBe('build linux-x64-pkg, which takes the container');
	});

	it('names the hosts of both routes when the type gives no reason', () => {
		const type = catalogType();
		expect(() => packageTargetsFor(type, 'windows-x64', 'linux')).toThrow(/not supported on host linux$/u);
		let hint: string | undefined;
		try {
			packageTargetsFor(
				catalogType([
					{
						...CONTAINER_TARGET,
						container: { ...(CONTAINER_TARGET.container as NonNullable<PackageTarget['container']>), hosts: ['darwin'] }
					}
				]),
				'linux-x64-pkg',
				'win32'
			);
		} catch (error) {
			hint = (error as { toPayload(): { hint?: string } }).toPayload().hint;
		}
		expect(hint).toBe('run this target on one of: linux, darwin');
	});
});

/** A docker the tests control: the probes it answers, and what it saw of every run. */
type FakeDocker = {
	readonly calls: string[][];
	/** What each `docker run` found in the run's directory, keyed by file. */
	readonly handed: Record<string, string>[];
	readonly run: (command: PackageCommand) => PackageCommandResult;
};

function fakeDocker(
	options: { readonly imagePresent?: boolean; readonly dockerMissing?: boolean; readonly runStatus?: number } = {}
): FakeDocker {
	const calls: string[][] = [];
	const handed: Record<string, string>[] = [];
	const run = (command: PackageCommand): PackageCommandResult => {
		if (command.command !== 'docker') {
			calls.push([command.command, ...command.args]);
			return { status: 0, stdout: '', stderr: '' };
		}
		calls.push(['docker', ...command.args]);
		const [verb, sub] = command.args;
		if (verb === 'version') {
			return options.dockerMissing === true
				? { status: null, stdout: '', stderr: '', error: new Error('spawnSync docker ENOENT') }
				: { status: 0, stdout: '29.2.0\n', stderr: '' };
		}
		if (verb === 'image' && sub === 'inspect') {
			return { status: options.imagePresent === true ? 0 : 1, stdout: '', stderr: '' };
		}
		if (verb === 'run') {
			const io = mountSource(command.args, '/codkit/io');
			const seen: Record<string, string> = {};
			for (const name of readdirSync(io)) {
				const path = join(io, name);
				seen[name] = statSync(path).isDirectory() ? `dir:${readdirSync(path).join(',')}` : readFileSync(path, 'utf8');
			}
			handed.push(seen);
			if ((options.runStatus ?? 0) !== 0) {
				return { status: options.runStatus ?? 1, stdout: 'the entry says why\n', stderr: '' };
			}
			mkdirSync(join(io, 'out', '.build', 'out'), { recursive: true });
			writeFileSync(join(io, 'out', '.build', 'out', 'app-2.pkg'), 'package of this run', 'utf8');
			return { status: 0, stdout: 'entry output\n', stderr: '' };
		}
		return { status: 0, stdout: '', stderr: '' };
	};
	return { calls, handed, run };
}

/** The host directory a `--mount` of the argv binds at a target. */
function mountSource(args: readonly string[], target: string): string {
	for (let at = 0; at < args.length; at += 1) {
		if (args[at] !== '--mount') continue;
		const fields = (args[at + 1] ?? '').split(',');
		if (fields.includes(`dst=${target}`)) {
			const source = fields.find((field) => field.startsWith('src=')) ?? '';
			return source.slice('src='.length);
		}
	}
	throw new Error(`no mount at ${target}`);
}

function packageOptions(fixture: SyncFixture, type: ProjectType, overrides: Partial<PackageOptions>): PackageOptions {
	return {
		patchesDir: fixture.patchesDir,
		resolution: fixture.resolution,
		config: fixture.config,
		type,
		out: silentOutput(),
		flags: { keepOverlay: false, skipTypeBuild: false },
		timeoutMs: null,
		env: {},
		...overrides
	};
}

/** The loaded tree, with an empty `.build/` and the overlay target at the pin. */
function loadedFixture(): SyncFixture {
	if (shared === null) {
		throw new Error('the shared tree was not loaded');
	}
	rmSync(join(shared.treeDir, '.build'), { recursive: true, force: true });
	expect(readFileSync(join(shared.treeDir, 'manifest.json'), 'utf8')).toBe(atPin(shared));
	return shared;
}

function atPin(fixture: SyncFixture): string {
	return runGit({ args: ['show', `${fixture.config.pin.sha}:manifest.json`], cwd: fixture.treeDir }).stdout;
}

/** An inputs directory holding the named inputs of INPUTS. */
function inputsDirWith(label: string, paths: readonly string[]): string {
	const dir = makeTempRoot(label);
	for (const path of paths) {
		if (path === 'runtime' || path === 'cache' || path === 'addons') {
			mkdirSync(join(dir, path), { recursive: true });
			writeFileSync(join(dir, path, 'provided.txt'), `the ${path} copy`, 'utf8');
		} else {
			writeFileSync(join(dir, path), `the ${path} copy`, 'utf8');
		}
	}
	return dir;
}

describe('the inputs of a run', () => {
	it('are provisioned exactly when the inputs directory holds their path', () => {
		const dir = inputsDirWith('package-inputs-state', ['runtime', 'helper.pl']);
		expect(checkInputs(INPUTS, dir).map((entry) => entry.state)).toEqual(['provisioned', 'provisioned', 'missing', 'missing']);
		expect(checkInputs(INPUTS, null).map((entry) => entry.state)).toEqual(['missing', 'missing', 'missing', 'missing']);
	});

	it('refuse an offline run that misses one before any write, naming every missing input', () => {
		const fixture = loadedFixture();
		const docker = fakeDocker();
		const out = collectingOutput();
		const result = runPackage({
			...packageOptions(fixture, catalogType(), { runCommand: docker.run, host: 'linux', targetSelector: 'linux-x64-pkg', offline: true }),
			inputsDir: inputsDirWith('package-offline-missing-inputs', ['runtime', 'helper.pl']),
			out: out.output
		});

		expect(result.exitCode).toBe(2);
		expect(result.steps.map((step) => `${step.name}:${step.state}`)).toEqual(['inputs:failed']);
		expect(docker.calls).toEqual([]);
		expect(readFileSync(join(fixture.treeDir, 'manifest.json'), 'utf8')).toBe(atPin(fixture));
		const error = out.errors[0];
		expect(error?.code).toBe('NET-FORBIDDEN');
		expect(error?.message).toContain('the cache of downloads (cache, fetched from https://example.invalid/cache)');
		expect(error?.message).toContain('the add-ons of the manifest (addons, fetched from https://example.invalid/addons)');
		expect(result.inputs.map((input) => input.state)).toEqual(['provisioned', 'provisioned', 'missing', 'missing']);
	});

	it('let an online run fetch what is missing, and say so', () => {
		const fixture = loadedFixture();
		const docker = fakeDocker();
		const out = collectingOutput();
		const result = runPackage({
			...packageOptions(fixture, catalogType(), { runCommand: docker.run, host: 'linux', targetSelector: 'linux-x64-pkg' }),
			out: out.output
		});

		expect(result.exitCode).toBe(0);
		expect(result.steps[0]).toEqual({ name: 'inputs', state: 'ok', detail: '0 of 4 input(s) pre-provisioned' });
		expect(out.lines).toContain(
			'input the helper script: not pre-provisioned, the build fetches it from https://example.invalid/helper.pl'
		);
		const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
		expect(docker.calls.map((call) => call.slice(0, 3).join(' '))).toEqual([`${npm} run bundle`, 'bash -c pack the bundle']);
	});

	it('are wired into the environment of the native commands, with the fence when the run is offline', () => {
		const fixture = loadedFixture();
		const dir = inputsDirWith('package-native-wiring-inputs', ['runtime', 'helper.pl', 'cache', 'addons']);
		mkdirSync(join(fixture.treeDir, '.build', 'addons'), { recursive: true });
		writeFileSync(join(fixture.treeDir, '.build', 'addons', 'stale.txt'), 'an earlier download', 'utf8');
		const seen: PackageCommand[] = [];
		const result = runPackage({
			...packageOptions(fixture, catalogType(), {
				host: 'linux',
				targetSelector: 'linux-x64-pkg',
				offline: true,
				inputsDir: dir,
				env: { PATH: '/usr/bin' },
				runCommand: (command) => {
					seen.push(command);
					// While the build runs, the directory input is one of the run's own.
					const cache = command.env['CACHE_HOME'] ?? '';
					expect(readFileSync(join(cache, 'provided.txt'), 'utf8')).toBe('the cache copy');
					expect(existsSync(join(command.env['PATH']?.split(delimiter)[0] ?? '', 'curl'))).toBe(true);
					return { status: 0, stdout: '', stderr: '' };
				}
			})
		});

		expect(result.exitCode).toBe(0);
		const env = seen[0]?.env ?? {};
		expect(env['RUNTIME_DIR']).toBe(join(dir, 'runtime'));
		expect(env['CACHE_HOME']).not.toBe(join(dir, 'cache'));
		expect(env['PATH']?.endsWith(`${delimiter}/usr/bin`)).toBe(true);
		expect(env['HTTPS_PROXY']).toBe(OFFLINE_PROXY);
		expect(env['http_proxy']).toBe(OFFLINE_PROXY);
		expect(env['NODE_USE_ENV_PROXY']).toBe('1');
		expect(env['BUILD_QUALITY']).toBe(fixture.config.pin.tag);
		// The tree input replaced the cache of the tree, and the run's own directory is gone.
		expect(readdirSync(join(fixture.treeDir, '.build', 'addons'))).toEqual(['provided.txt']);
		expect(existsSync(dirname(dirname(env['CACHE_HOME'] ?? '')))).toBe(false);
		// The inputs directory was only read.
		expect(readdirSync(dir).sort()).toEqual(['addons', 'cache', 'helper.pl', 'runtime']);
	});

	it('leave the environment of a run that is online and provisions nothing as it was', () => {
		const fixture = loadedFixture();
		const seen: PackageCommand[] = [];
		runPackage(
			packageOptions(fixture, catalogType(), {
				host: 'linux',
				targetSelector: 'linux-x64-pkg',
				runCommand: (command) => {
					seen.push(command);
					return { status: 0, stdout: '', stderr: '' };
				}
			})
		);
		expect(Object.keys(seen[0]?.env ?? {}).sort()).toEqual(['BUILD_QUALITY', 'BUILD_SOURCE_VERSION']);
	});
});

describe('the fetch answer', () => {
	const sh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

	it('serves a provisioned address and refuses any other in an offline run', () => {
		const script = fetchAnswerScript([{ url: "https://example.invalid/it's.pl", file: '/inputs/its.pl' }], true);
		expect(script).toContain(`'https://example.invalid/it'\\''s.pl') copy='/inputs/its.pl' ;;`);
		expect(script).toContain('offline=1');
		expect(script.includes('\r')).toBe(false);
	});

	it.runIf(sh)('answers from the copy to the -o file, refuses offline, and hands anything else to the real curl', () => {
		const root = makeTempRoot('package-fetch-answer');
		const copy = join(root, 'helper.pl');
		writeFileSync(copy, 'the provisioned helper\n', 'utf8');
		const real = join(root, 'real');
		mkdirSync(real);
		writeFileSync(join(real, 'curl'), '#!/bin/sh\necho "real curl $*"\n', { encoding: 'utf8', mode: 0o755 });
		const answer = (offline: boolean): string => {
			const dir = join(root, offline ? 'offline' : 'online');
			mkdirSync(dir);
			writeFileSync(
				join(dir, 'curl'),
				fetchAnswerScript([{ url: 'https://example.invalid/helper.pl', file: copy.split('\\').join('/') }], offline),
				{
					encoding: 'utf8',
					mode: 0o755
				}
			);
			return dir;
		};
		const offline = answer(true);
		const online = answer(false);
		const curl = (dir: string, args: string): ReturnType<typeof spawnSync> =>
			spawnSync('sh', ['-c', `PATH="$1:$2:$PATH" curl ${args}`, 'sh', toShellPath(dir), toShellPath(real)], {
				encoding: 'utf8',
				cwd: root
			});

		const served = curl(offline, 'https://example.invalid/helper.pl -o out.pl');
		expect(served.status).toBe(0);
		expect(readFileSync(join(root, 'out.pl'), 'utf8')).toBe('the provisioned helper\n');
		const refused = curl(offline, 'https://example.invalid/other.json -o other.json');
		expect(refused.status).toBe(7);
		expect(String(refused.stderr)).toContain('https://example.invalid/other.json is not a pre-provisioned input');
		const handed = curl(online, '-s https://example.invalid/other.json');
		expect(handed.status).toBe(0);
		expect(String(handed.stdout)).toBe('real curl -s https://example.invalid/other.json\n');
	});
});

describe('the outputs of the selected targets', () => {
	it('are printed from the targets first and the type after them, each path once', () => {
		const fixture = loadedFixture();
		const base = stubType({});
		const type = stubType({
			build: {
				...base.build,
				packageDistributable: [],
				packageOutputs: ['.build/out/*.pkg', '.build/app-*.tar'],
				packageTargets: [{ ...CONTAINER_TARGET, inputs: () => [] }]
			}
		});
		const result = runPackage(
			packageOptions(fixture, type, {
				host: 'linux',
				targetSelector: 'linux-x64-pkg',
				runCommand: (command) => {
					if (command.label === 'pack') {
						mkdirSync(join(command.cwd, '.build', 'out'), { recursive: true });
						writeFileSync(join(command.cwd, '.build', 'out', 'app-1.pkg'), 'x', 'utf8');
						writeFileSync(join(command.cwd, '.build', 'app-1.tar'), 'x', 'utf8');
					}
					return { status: 0, stdout: '', stderr: '' };
				}
			})
		);

		expect(result.outputs).toEqual(['.build/out/app-1.pkg', '.build/app-1.tar']);
		expect(result.steps.find((step) => step.name === 'outputs')?.detail).toBe('.build/out/app-1.pkg, .build/app-1.tar');
	});
});

describe('the container route', () => {
	it('builds an absent image, runs the target over the read-only tree and takes the artifacts back', () => {
		const fixture = loadedFixture();
		mkdirSync(join(fixture.treeDir, '.build', 'out'), { recursive: true });
		writeFileSync(join(fixture.treeDir, '.build', 'out', 'app-1.pkg'), 'package of an earlier run', 'utf8');
		const docker = fakeDocker();
		const dir = inputsDirWith('package-container-inputs', ['runtime', 'helper.pl', 'cache', 'addons']);
		const result = runPackage({
			...packageOptions(fixture, catalogType(), {
				runCommand: docker.run,
				host: 'win32',
				targetSelector: 'linux-x64-pkg',
				inputsDir: dir,
				containerPrefix: 'ck-test',
				env: {
					MIRROR_URL: 'https://mirror.invalid',
					PROXY_URL: 'http://proxy.invalid',
					REGISTRY_URL: 'https://registry.invalid',
					UNRELATED: 'x'
				}
			})
		});

		expect(result.exitCode).toBe(0);
		const names = containerNames(
			'ck-test',
			'stub',
			CONTAINER_TARGET,
			recipeHash(RECIPE, [{ name: 'NODE_VERSION', value: '24.18.0' }]),
			result.routes[0]?.volume?.slice(-16) ?? ''
		);
		expect(result.routes).toEqual([{ target: 'linux-x64-pkg', route: 'container', image: names.image, volume: names.volume }]);
		expect(names.image).toMatch(/^ck-test-stub-linux-x64:[0-9a-f]{12}$/u);
		expect(docker.calls.map((call) => call.slice(0, 3).join(' '))).toEqual([
			'docker version --format',
			'docker image inspect',
			'docker build --platform',
			'docker volume create',
			'docker run --rm'
		]);
		expect(docker.calls[2]).toEqual([
			'docker',
			'build',
			'--platform',
			'linux/amd64',
			'--tag',
			names.image,
			'--build-arg',
			'NODE_VERSION=24.18.0',
			'--build-arg',
			'MIRROR_URL',
			RECIPE
		]);
		const runArgs = docker.calls[4] ?? [];
		expect(runArgs.slice(0, 7)).toEqual(['docker', 'run', '--rm', '--name', names.volume, '--platform', 'linux/amd64']);
		expect(runArgs).not.toContain('--network');
		expect(runArgs).toContain(`type=bind,src=${fixture.treeDir},dst=/codkit/tree,readonly`);
		expect(runArgs).toContain(`type=volume,src=${names.volume},dst=/codkit/work`);
		expect(runArgs).toContain(`type=bind,src=${dir},dst=/codkit/inputs,readonly`);
		expect(runArgs).toContain(`type=bind,src=${join(dir, 'cache', 'provided.txt')},dst=/codkit/run/CACHE_HOME/provided.txt,readonly`);
		expect(runArgs.slice(-7)).toEqual(['--env', 'CODKIT_OFFLINE=0', '--env', 'PROXY_URL', '--env', 'REGISTRY_URL', names.image]);

		const handed = docker.handed[0] ?? {};
		const commands = JSON.parse(handed['commands.json'] ?? '[]') as {
			label: string;
			command: string;
			args: string[];
			env: Record<string, string>;
		}[];
		expect(commands.map((command) => [command.label, command.command, ...command.args])).toEqual([
			['bundle', 'npm', 'run', 'bundle'],
			['pack', 'bash', '-c', 'pack the bundle']
		]);
		expect(commands[0]?.env).toEqual({
			BUILD_SOURCE_VERSION: runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.treeDir }).stdout.trim(),
			BUILD_QUALITY: fixture.config.pin.tag,
			RUNTIME_DIR: '/codkit/inputs/runtime',
			CACHE_HOME: '/codkit/run/CACHE_HOME'
		});
		expect(JSON.parse(handed['outputs.json'] ?? '[]')).toEqual(['.build/out/*.pkg']);
		expect(JSON.parse(handed['tree-inputs.json'] ?? '[]')).toEqual([{ source: '/codkit/inputs/addons', target: '.build/addons' }]);
		expect(handed['shim']).toBe('dir:curl');
		expect(handed['out']).toBe('dir:');

		// The artifact of this run replaced the one of an earlier run, and nothing else stayed.
		expect(readdirSync(join(fixture.treeDir, '.build', 'out'))).toEqual(['app-2.pkg']);
		expect(result.outputs).toEqual(['.build/out/app-2.pkg']);
		expect(existsSync(mountSource(runArgs, '/codkit/io'))).toBe(false);
		expect(readFileSync(join(fixture.treeDir, 'manifest.json'), 'utf8')).toBe(atPin(fixture));
	});

	it('uses an image that is there, and runs offline without a network', () => {
		const fixture = loadedFixture();
		const docker = fakeDocker({ imagePresent: true });
		const result = runPackage(
			packageOptions(fixture, catalogType([{ ...CONTAINER_TARGET, inputs: () => [] }]), {
				runCommand: docker.run,
				host: 'darwin',
				targetSelector: 'linux-x64-pkg',
				offline: true
			})
		);

		expect(result.exitCode).toBe(0);
		expect(docker.calls.map((call) => call.slice(0, 2).join(' '))).toEqual([
			'docker version',
			'docker image',
			'docker image',
			'docker volume',
			'docker run'
		]);
		const runArgs = docker.calls[4] ?? [];
		expect(runArgs.slice(7, 9)).toEqual(['--network', 'none']);
		expect(runArgs).toContain('CODKIT_OFFLINE=1');
		// An offline run gets the fetch answer even with nothing to serve: it is the fence of curl.
		expect(docker.handed[0]?.['shim']).toBe('dir:curl');
	});

	it('refuses an offline run whose image is not there, before any write', () => {
		const fixture = loadedFixture();
		const docker = fakeDocker({ imagePresent: false });
		const out = collectingOutput();
		const result = runPackage({
			...packageOptions(fixture, catalogType([{ ...CONTAINER_TARGET, inputs: () => [] }]), {
				runCommand: docker.run,
				host: 'win32',
				targetSelector: 'linux-x64-pkg',
				offline: true
			}),
			out: out.output
		});

		expect(result.exitCode).toBe(2);
		expect(out.errors[0]?.code).toBe('NET-FORBIDDEN');
		expect(out.errors[0]?.message).toContain('building it needs the network');
		expect(docker.calls.map((call) => call.slice(0, 2).join(' '))).toEqual(['docker version', 'docker image']);
		expect(result.steps).toEqual([]);
		expect(readFileSync(join(fixture.treeDir, 'manifest.json'), 'utf8')).toBe(atPin(fixture));
	});

	it('refuses before any write when docker cannot be started', () => {
		const fixture = loadedFixture();
		const docker = fakeDocker({ dockerMissing: true });
		const out = collectingOutput();
		const result = runPackage({
			...packageOptions(fixture, catalogType([{ ...CONTAINER_TARGET, inputs: () => [] }]), {
				runCommand: docker.run,
				host: 'win32',
				targetSelector: 'linux-x64-pkg'
			}),
			out: out.output
		});

		expect(result.exitCode).toBe(2);
		expect(out.errors[0]?.code).toBe('PACKAGE-FAILED');
		expect(out.errors[0]?.message).toContain(
			'docker could not be started for the container route of linux-x64-pkg: spawnSync docker ENOENT'
		);
		expect(out.errors[0]?.hint).toBe('the container route needs a running Docker engine and the docker command on PATH');
		expect(docker.calls).toEqual([['docker', 'version', '--format', '{{.Server.Version}}']]);
	});

	it('fails a container that exits non-zero, removes it, and puts the tree back', () => {
		const fixture = loadedFixture();
		const docker = fakeDocker({ imagePresent: true, runStatus: 3 });
		const out = collectingOutput();
		const result = runPackage({
			...packageOptions(fixture, catalogType([{ ...CONTAINER_TARGET, inputs: () => [] }]), {
				runCommand: docker.run,
				host: 'win32',
				targetSelector: 'linux-x64-pkg'
			}),
			out: out.output
		});

		expect(result.exitCode).toBe(1);
		expect(out.errors[0]?.code).toBe('PACKAGE-FAILED');
		expect(out.errors[0]?.message).toContain('package linux-x64-pkg in the container: exited 3; last output: the entry says why');
		expect(docker.calls.at(-1)).toEqual(['docker', 'rm', '--force', result.routes[0]?.volume ?? '']);
		expect(result.restored).toEqual(['manifest.json']);
		expect(readFileSync(join(fixture.treeDir, 'manifest.json'), 'utf8')).toBe(atPin(fixture));
	});
});

describe('what the container is handed', () => {
	it('carries the executables and the symbolic links git records, which a checkout on another OS does not', () => {
		const tree = makeTempRoot('package-tree-modes');
		runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: tree });
		writeFileSync(join(tree, 'tool.sh'), '#!/bin/sh\n', 'utf8');
		writeFileSync(join(tree, 'plain.txt'), 'x\n', 'utf8');
		runGit({ args: ['add', 'tool.sh', 'plain.txt'], cwd: tree });
		runGit({ args: ['update-index', '--chmod=+x', 'tool.sh'], cwd: tree });
		writeFileSync(join(tree, 'link-body'), 'plain.txt', 'utf8');
		const blob = runGit({ args: ['hash-object', '-w', 'link-body'], cwd: tree }).stdout.trim();
		runGit({ args: ['update-index', '--add', '--cacheinfo', `120000,${blob},link-to-plain`], cwd: tree });

		expect(treeModes(tree)).toEqual({ executables: ['tool.sh'], symlinks: [{ path: 'link-to-plain', target: 'plain.txt' }] });
	});

	it('names an image by the bytes of its recipe and by its tree arguments', () => {
		const recipe = makeRecipe('package-recipe-hash');
		const first = recipeHash(recipe, [{ name: 'NODE_VERSION', value: '24.18.0' }]);
		expect(first).toMatch(/^[0-9a-f]{12}$/u);
		expect(recipeHash(recipe, [{ name: 'NODE_VERSION', value: '24.18.1' }])).not.toBe(first);
		writeFileSync(join(recipe, 'entry.sh'), '#!/bin/sh\necho another entry\n', 'utf8');
		expect(recipeHash(recipe, [{ name: 'NODE_VERSION', value: '24.18.0' }])).not.toBe(first);
		expect(containerNames('codkit', 'vscode', CONTAINER_TARGET, first, '0123456789abcdef')).toEqual({
			image: `codkit-vscode-linux-x64:${first}`,
			volume: 'codkit-vscode-linux-x64-0123456789abcdef'
		});
	});

	it('passes a variable by name only, and a pattern by its prefix', () => {
		expect(
			passedEnvironment(['PROXY_URL', 'REGISTRY_*', 'ABSENT'], { REGISTRY_B: '1', REGISTRY_A: '2', PROXY_URL: '3', OTHER: '4' })
		).toEqual(['PROXY_URL', 'REGISTRY_A', 'REGISTRY_B']);
	});

	it('quotes a mount source that carries a comma, and refuses a prefix docker would not take', () => {
		expect(mountArg({ kind: 'bind', source: 'C:\\a,b', target: '/codkit/tree', readonly: true })).toBe(
			'type=bind,"src=C:\\a,b",dst=/codkit/tree,readonly'
		);
		expect(requireContainerPrefix('codkit-deb-rpm')).toBe('codkit-deb-rpm');
		expect(() => requireContainerPrefix('Codkit')).toThrow(/is not a name docker takes/u);
		expect(() => requireContainerPrefix('codkit--x')).toThrow(/is not a name docker takes/u);
	});

	it('wires nothing but the fence into an offline run that provisions nothing', () => {
		const env = nativeInputEnvironment([], makeTempRoot('package-fence-only'), makeTempRoot('package-fence-tree'), true, '/bin');
		expect(env['HTTP_PROXY']).toBe(OFFLINE_PROXY);
		expect(env['NO_PROXY']).toBe('');
		expect(env['PATH']?.endsWith(`${delimiter}/bin`)).toBe(true);
	});
});

/** A path a POSIX shell on this host takes. */
function toShellPath(path: string): string {
	if (process.platform !== 'win32') return path;
	const unix = path.split('\\').join('/');
	return unix.replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`);
}

function silentOutput(): Output {
	return new Output({
		command: 'package',
		version: '0.0.0',
		jsonMode: false,
		streams: { writeOut: () => undefined, writeErr: () => undefined }
	});
}

function collectingOutput(): {
	readonly output: Output;
	readonly lines: string[];
	readonly errors: { code: string; message: string; hint?: string }[];
} {
	const lines: string[] = [];
	const output = new Output({
		command: 'package',
		version: '0.0.0',
		jsonMode: false,
		streams: {
			writeOut: (chunk) => lines.push(...chunk.trimEnd().split('\n')),
			writeErr: (chunk) => lines.push(...chunk.trimEnd().split('\n'))
		}
	});
	const errors: { code: string; message: string; hint?: string }[] = [];
	const addError = output.addError.bind(output);
	output.addError = (payload) => {
		errors.push({ code: payload.code, message: payload.message, ...(payload.hint === undefined ? {} : { hint: payload.hint }) });
		addError(payload);
	};
	return { output, lines, errors };
}
