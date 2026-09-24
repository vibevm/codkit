// The Linux x64 installer targets of this family, their host policy, their
// container recipe and the inputs they declare (modules/vscode/PROP-004
// ##VSCODE-LINUX-INSTALLER-TARGETS, ##VSCODE-LINUX-CONTAINER-RECIPE,
// ##VSCODE-LINUX-CONTAINER-ENTRY, ##VSCODE-LINUX-INPUTS,
// ##DECISION-VSCODE-RAW-LINUX-BUNDLE-IS-LINUX-HOSTED).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PackageTarget } from '@codkit/type-api';
import { projectTypeProblems } from '@codkit/type-api';
import { build, LINUX_CONTAINER_RECIPE, linuxInputs } from '../src/build.ts';
import { configSchema } from '../src/configSchema.ts';
import { projectType } from '../src/index.ts';

/** A path as the POSIX shell of the host reads it: Git's sh on Windows takes /c/... for C:\\... */
function toShellPath(path: string): string {
	if (process.platform !== 'win32') return path;
	const unix = path.split('\\').join('/');
	return unix.replace(/^([A-Za-z]):/u, (_, drive: string) => `/${drive.toLowerCase()}`);
}

function targetOf(id: string): PackageTarget {
	const found = build.packageTargets?.find((target) => target.id === id);
	if (found === undefined) {
		throw new Error(`no package target ${id}`);
	}
	return found;
}

/** The argv of each build command as one line, the way a person reads the recipe. */
function commandsOf(id: string): readonly string[] {
	return targetOf(id).build.map((command) => `${command.label}: ${[command.command, ...command.args].join(' ')}`);
}

/** A tree with just the two files the inputs are read from. */
function treeWithVersions(): string {
	const tree = mkdtempSync(join(tmpdir(), 'codkit-vscode-inputs-'));
	writeFileSync(join(tree, '.npmrc'), 'disturl="https://electronjs.org/headers"\ntarget="42.8.1"\nruntime="electron"\n', 'utf8');
	writeFileSync(
		join(tree, 'cgmanifest.json'),
		JSON.stringify({
			registrations: [
				{ component: { type: 'git', git: { name: 'electron' } }, version: '0000' },
				{ component: { type: 'git', git: { name: 'chromium' } }, version: '148.0.7778.280' }
			]
		}),
		'utf8'
	);
	return tree;
}

describe('the host policy of the Linux targets', () => {
	it('builds the raw Linux bundle only on a Linux host, and refuses elsewhere naming the container', () => {
		const raw = targetOf('linux-x64');
		expect(raw.supportedHosts).toEqual(['linux']);
		expect(raw.container).toBeUndefined();
		expect(raw.hostRefusal?.reason).toContain('19 of its 20 .node files were Windows binaries');
		expect(raw.hostRefusal?.hint).toBe(
			`build linux-x64-tar instead: it builds the same bundle in the Linux container of ${LINUX_CONTAINER_RECIPE} and keeps its modes in the archive; or run linux-x64 on a Linux host`
		);
	});

	it('builds the three installer targets natively on Linux and in the container on Windows and macOS', () => {
		for (const id of ['linux-x64-tar', 'linux-x64-deb', 'linux-x64-rpm']) {
			const target = targetOf(id);
			expect(target.supportedHosts).toEqual(['linux']);
			expect(target.container?.hosts).toEqual(['win32', 'darwin']);
			expect(target.container?.recipe).toBe(LINUX_CONTAINER_RECIPE);
			expect(target.container?.treeArguments).toEqual({ NODE_VERSION: '.nvmrc' });
		}
		expect(projectTypeProblems(projectType)).toEqual([]);
	});

	it('names the artifacts of each installer target inside the tree', () => {
		expect(targetOf('linux-x64-tar').outputs).toEqual(['.build/linux/client/code-*-x64-*.tar.gz']);
		expect(targetOf('linux-x64-deb').outputs).toEqual(['.build/linux/deb/amd64/deb/*.deb']);
		expect(targetOf('linux-x64-rpm').outputs).toEqual(['.build/linux/rpm/x86_64/*.rpm']);
	});

	it('lets a patch set list the installer targets as its defaults', () => {
		expect(
			configSchema.safeParse({ ownRoot: 'src/vs/patchset', packageTargets: ['linux-x64-deb', 'linux-x64-rpm', 'linux-x64-tar'] }).success
		).toBe(true);
	});
});

describe('the commands of the installer targets', () => {
	it('build the raw bundle and check its glibc first, then run what upstream CI runs after it', () => {
		const deb = commandsOf('linux-x64-deb');
		const rpm = commandsOf('linux-x64-rpm');
		const tar = commandsOf('linux-x64-tar');
		for (const commands of [deb, rpm, tar]) {
			expect(commands[0]?.startsWith('bundle linux-x64: bash -c set -e\n')).toBe(true);
			expect(commands[0]?.endsWith('\nfi\nnpm run gulp -- vscode-linux-x64')).toBe(true);
			expect(commands[1]?.startsWith('glibc check: bash -c set -e\n')).toBe(true);
		}
		expect(deb.slice(2).map((line) => line.split(':')[0])).toEqual(['prepare deb', 'build deb', 'check deb']);
		expect(deb[2]).toContain('npm run gulp -- vscode-linux-x64-prepare-deb');
		expect(deb[3]).toBe('build deb: npm run gulp -- vscode-linux-x64-build-deb');
		expect(deb[4]).toContain('*"data compression xz"*');
		expect(rpm.slice(2).map((line) => line.split(':')[0])).toEqual(['prepare rpm', 'build rpm']);
		expect(rpm[2]).toContain('export STRIP="$VSCODE_SYSROOT_DIR/$TRIPLE/$TRIPLE/bin/strip"');
		expect(rpm[3]).toBe('build rpm: npm run gulp -- vscode-linux-x64-build-rpm');
		expect(tar[2]).toContain('ARCHIVE_PATH=".build/linux/client/code-${VSCODE_QUALITY}-x64-$(date +%s).tar.gz"');
		expect(tar[2]).toContain('tar -czf $ARCHIVE_PATH -C .. VSCode-linux-x64');
		expect(tar[2]).toContain('rm -f .build/linux/client/code-*-x64-*.tar.gz');
	});

	it('run upstream glibc check unchanged, and refuse when its objdump is not there', () => {
		const glibc = commandsOf('linux-x64-deb')[1] ?? '';
		expect(glibc).toContain(
			'EXPECTED_GLIBC_VERSION="2.28" EXPECTED_GLIBCXX_VERSION="3.4.25" SEARCH_PATH=../VSCode-linux-x64 VSCODE_ARCH=x64 bash ./build/azure-pipelines/linux/verify-glibc-requirements.sh'
		);
		expect(glibc).toContain('if [ ! -x "$objdump" ]; then');
		expect(glibc).toContain('getVSCodeSysroot(process.env["SYSROOT_ARCH"])');
	});

	it('point the sysroot of the deb and rpm steps at the client sysroot of the tree unless one is exported', () => {
		for (const line of [commandsOf('linux-x64-deb')[2], commandsOf('linux-x64-rpm')[2], commandsOf('linux-x64-tar')[1]]) {
			expect(line).toContain('export VSCODE_SYSROOT_DIR="${VSCODE_SYSROOT_DIR:-$PWD/.build/sysroots/glibc-2.28-gcc-10.5.0}"');
		}
	});
});

describe('the Electron mirror of the bundle', () => {
	const sh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
	// The offline fence of a native run (spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-INPUTS).
	const fence: Readonly<Record<string, string>> = {
		HTTP_PROXY: 'http://127.0.0.1:9',
		HTTPS_PROXY: 'http://127.0.0.1:9',
		NO_PROXY: '',
		NODE_USE_ENV_PROXY: '1'
	};
	// The upstream task stands in for itself: it says which mirror it was given and what that mirror serves.
	const npm = [
		'#!/bin/sh',
		'exec node -e \'const base = process.env.ELECTRON_MIRROR; if (base === undefined) { console.log("no mirror"); process.exit(0); } fetch(base + "v42.8.1/SHASUMS256.txt").then((response) => response.text()).then((text) => console.log("served " + text.trim() + " from " + base), (error) => { console.log("failed: " + (error.cause?.message ?? error.message)); process.exit(1); });\''
	].join('\n');

	/** Run the bundle command of the archive target under the fence, with the task above in place of npm. */
	function runBundle(mirror: string | undefined): { readonly status: number | null; readonly output: string } {
		const root = mkdtempSync(join(tmpdir(), 'codkit-electron-mirror-'));
		const bin = join(root, 'bin');
		mkdirSync(bin);
		writeFileSync(join(bin, 'npm'), `${npm}\n`, { encoding: 'utf8', mode: 0o755 });
		const script = join(root, 'bundle.sh');
		writeFileSync(script, targetOf('linux-x64-tar').build[0]?.args[1] ?? '', 'utf8');
		const own = new Set([...Object.keys(fence), 'CODKIT_ELECTRON_MIRROR_DIR', 'ELECTRON_MIRROR']);
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !own.has(name.toUpperCase())));
		const run = spawnSync('sh', ['-c', 'PATH="$1:$PATH" exec sh "$2"', 'sh', toShellPath(bin), toShellPath(script)], {
			encoding: 'utf8',
			env: { ...inherited, ...fence, ...(mirror === undefined ? {} : { CODKIT_ELECTRON_MIRROR_DIR: mirror }) },
			timeout: 60_000
		});
		return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
	}

	it.runIf(sh)(
		'serves a provisioned Electron on the loopback past the fence, for the run of the task only',
		() => {
			const mirror = mkdtempSync(join(tmpdir(), 'codkit-electron-mirror-copy-'));
			mkdirSync(join(mirror, 'v42.8.1'));
			writeFileSync(join(mirror, 'v42.8.1', 'SHASUMS256.txt'), 'the sums\n', 'utf8');
			const run = runBundle(mirror);
			expect(run.status, run.output).toBe(0);
			const address = /Electron mirror: (http:\/\/127\.0\.0\.1:\d+\/) serves /u.exec(run.output)?.[1] ?? '';
			expect(address).not.toBe('');
			expect(run.output).toContain(`served the sums from ${address}`);
			// The server went with the command: within seconds nothing answers on its port any more.
			const gone = [
				`const deadline = Date.now() + 5000;`,
				`const probe = () => fetch(${JSON.stringify(address)}).then(`,
				`  () => (Date.now() < deadline ? setTimeout(probe, 100) : process.exit(1)),`,
				`  () => process.exit(0)`,
				`);`,
				`probe();`
			].join('\n');
			const after = spawnSync(process.execPath, ['-e', gone], {
				env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().endsWith('_PROXY')))
			});
			expect(after.status).toBe(0);
		},
		120_000
	);

	it.runIf(sh)(
		'leaves the download of the task alone when no Electron is provisioned',
		() => {
			const run = runBundle(undefined);
			expect(run.status, run.output).toBe(0);
			expect(run.output).toContain('no mirror');
			expect(run.output).not.toContain('Electron mirror:');
		},
		120_000
	);
});

describe('the inputs of the Linux targets', () => {
	it('are read from the versions of the tree', () => {
		const tree = treeWithVersions();
		const deb = linuxInputs(tree, true);
		expect(deb.map((input) => [input.path, input.use.kind])).toEqual([
			['electron-mirror', 'environment'],
			['builtInExtensions', 'tree'],
			['vscode-sysroot', 'environment'],
			['tmp', 'directory'],
			['sysroots.json', 'fetch'],
			['dpkg-shlibdeps.pl', 'fetch']
		]);
		expect(deb[0]?.from).toBe(
			'https://github.com/electron/electron/releases/download/ (v42.8.1/electron-v42.8.1-linux-x64.zip and v42.8.1/SHASUMS256.txt)'
		);
		expect(deb[0]?.use).toEqual({ kind: 'environment', variable: 'CODKIT_ELECTRON_MIRROR_DIR' });
		expect(deb[1]?.use).toEqual({ kind: 'tree', target: '.build/builtInExtensions' });
		expect(deb[2]?.use).toEqual({ kind: 'environment', variable: 'VSCODE_SYSROOT_DIR' });
		expect(deb[3]?.use).toEqual({ kind: 'directory', variable: 'TMPDIR' });
		expect(deb[4]?.use).toEqual({ kind: 'fetch', url: 'https://raw.githubusercontent.com/electron/electron/v42.8.1/script/sysroots.json' });
		expect(deb[5]?.use).toEqual({
			kind: 'fetch',
			url: 'https://raw.githubusercontent.com/chromium/chromium/148.0.7778.280/third_party/dpkg-shlibdeps/dpkg-shlibdeps.pl'
		});
	});

	it('are only what the bundle and the glibc check need for the archive and the rpm', () => {
		const tree = treeWithVersions();
		for (const id of ['linux-x64-tar', 'linux-x64-rpm']) {
			expect(
				targetOf(id)
					.inputs?.(tree)
					.map((input) => input.path)
			).toEqual(['electron-mirror', 'builtInExtensions', 'vscode-sysroot']);
		}
		expect(targetOf('linux-x64-deb').inputs?.(tree)).toHaveLength(6);
		expect(targetOf('linux-x64').inputs).toBeUndefined();
	});
});

describe('the container recipe', () => {
	const dockerfile = readFileSync(join(LINUX_CONTAINER_RECIPE, 'Dockerfile'), 'utf8');
	const entry = readFileSync(join(LINUX_CONTAINER_RECIPE, 'entry.sh'), 'utf8');

	it('is a directory of the type package holding the Dockerfile and the entry, both LF', () => {
		expect(isAbsolute(LINUX_CONTAINER_RECIPE)).toBe(true);
		expect(dockerfile.includes('\r')).toBe(false);
		expect(entry.includes('\r')).toBe(false);
		expect(dockerfile).toContain('ENTRYPOINT ["bash", "/codkit/recipe/entry.sh"]');
	});

	it('starts from the public Ubuntu of upstream Linux build pool, with Node of the tree', () => {
		expect(dockerfile).toMatch(/^FROM ubuntu:22\.04$/mu);
		expect(dockerfile).toContain('ARG NODE_VERSION');
		expect(dockerfile).toContain('"${NODEJS_ORG_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"');
		expect(dockerfile).toContain('sha256sum -c -');
	});

	it('installs exactly the prerequisites of upstream, each list where it comes from', () => {
		const install = /apt-get install -y \\\n([\s\S]*?)\t&& rm -rf/u.exec(dockerfile)?.[1] ?? '';
		const packages = install
			.split(/[\s\\]+/u)
			.filter((word) => word !== '')
			.sort();
		expect(packages).toEqual(
			[
				// build/azure-pipelines/linux/steps/product-build-linux-compile.yml, "Setup system services"
				'pkg-config',
				'xvfb',
				'libgtk-3-0',
				'libxkbfile-dev',
				'libkrb5-dev',
				'libgbm1',
				'rpm',
				'bubblewrap',
				'socat',
				// .github/workflows/pr.yml, "Install build tools"
				'build-essential',
				'libx11-dev',
				'libx11-xcb-dev',
				'libnotify-bin',
				// the tools upstream's steps call
				'curl',
				'ca-certificates',
				'python3',
				'python-is-python3',
				'git',
				'fakeroot',
				'dpkg-dev',
				'file',
				// the entry's own mirror of the tree
				'rsync'
			].sort()
		);
	});

	it('mirrors the tree without the dependencies and the build outputs of the host', () => {
		for (const excluded of ["--exclude='node_modules/'", "--exclude='/.build/'", "--exclude='/out*/'", "--exclude='/.git'"]) {
			expect(entry).toContain(excluded);
		}
		expect(entry).toContain('computeNodeModulesCacheKey.ts linux');
		expect(entry).toContain('source ./build/azure-pipelines/linux/setup-env.sh');
		expect(entry).toContain('exit 3');
	});
});
