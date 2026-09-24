// The native proof of the Linux installer targets (modules/vscode/PROP-004
// ##VSCODE-LINUX-INSTALLERS-NATIVE-PROOF), opt-in like the native proofs of the
// build daemons: it needs Docker, a loaded fork tree of this family and its patch
// set, and it takes minutes, so it runs only when CODKIT_LINUX_INSTALLERS_PROOF
// is 1 and the two directories are named:
//
//   CODKIT_PROOF_PATCHES_DIR, CODKIT_PROOF_FORK_DIR  the patch set and its loaded tree;
//   CODKIT_PROOF_CONTAINER_PREFIX                    --container-prefix (default codkit);
//   CODKIT_PROOF_DEB_IMAGE, CODKIT_PROOF_RPM_IMAGE   the clean images the packages are
//                                                    installed in (ubuntu:22.04, fedora:42).
//
// It runs the real CLI - `codkit package linux-x64-deb`, then `linux-x64-rpm` -
// which on a host that is not Linux builds them in the container of the type,
// and then installs each package into a clean container of its distribution:
// the command of the product resolves to a file of the package and prints the
// version of the tree and the commit it was built from, the maintainer fields are
// the ones the patch set writes, no package source is added, and the installed
// text files carry LF. The proxy variables of the environment reach the clean
// containers, which download the dependencies of the packages; a failed download
// is retried twice, and a package the distribution cannot install fails all three
// attempts.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const enabled = process.env['CODKIT_LINUX_INSTALLERS_PROOF'] === '1';
const patchesDir = process.env['CODKIT_PROOF_PATCHES_DIR'] ?? '';
const forkDir = process.env['CODKIT_PROOF_FORK_DIR'] ?? '';
const prefix = process.env['CODKIT_PROOF_CONTAINER_PREFIX'] ?? 'codkit';
const debImage = process.env['CODKIT_PROOF_DEB_IMAGE'] ?? 'ubuntu:22.04';
const rpmImage = process.env['CODKIT_PROOF_RPM_IMAGE'] ?? 'fedora:42';
const codkit = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'codkit', 'bin', 'codkit.mjs');
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/** The one line of a template of the patch set, or of the tree when the patch set does not carry it. */
function templateField(relative: string, field: string): string {
	const own = join(patchesDir, 'delta', 'resources', 'files', ...relative.split('/'));
	const text = readFileSync(existsSync(own) ? own : join(forkDir, ...relative.split('/')), 'utf8');
	const line = text.split('\n').find((candidate) => candidate.startsWith(`${field}:`)) ?? '';
	return line.slice(field.length + 1).trim();
}

/** What `--version` of an installed package prints first: the version of the tree and the commit it was built from. */
function treeVersion(): { readonly version: string; readonly head: string } {
	const manifest = JSON.parse(readFileSync(join(forkDir, 'package.json'), 'utf8')) as { readonly version?: string };
	const head = spawnSync('git', ['-C', forkDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
	return { version: manifest.version ?? '', head };
}

// The bin script of the upstream asks before it runs under a WSL kernel, which
// the virtual machine of Docker Desktop is; this variable of the same script
// skips the question.
const NO_WSL_PROMPT = 'export DONT_PROMPT_WSL_INSTALL=1';

/** Up to three attempts of an install command; the tail of its log after each failure. */
const threeAttempts = (install: string): string =>
	`for attempt in 1 2 3; do ${install} > /tmp/install.log 2>&1 && break; tail -5 /tmp/install.log; [ "$attempt" = 3 ] && exit 1; done`;

function packageOnce(target: string): { readonly status: number | null; readonly output: string } {
	const run = spawnSync(
		process.execPath,
		[codkit, '--patches-dir', patchesDir, '--fork-dir', forkDir, 'package', target, '--container-prefix', prefix],
		{ encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
	);
	const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
	process.stdout.write(
		output
			.split('\n')
			.filter((line) => !line.startsWith('['))
			.join('\n')
	);
	return { status: run.status, output };
}

function onlyArtifact(directory: string, suffix: string): string {
	const found = readdirSync(join(forkDir, ...directory.split('/'))).filter((name) => name.endsWith(suffix));
	expect(found).toHaveLength(1);
	return join(forkDir, ...directory.split('/'), found[0] ?? '');
}

function docker(args: readonly string[]): SpawnSyncReturns<string> {
	return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Run a script in a clean container of an image, the directory of the package
 * copied into it at /pkg. The package is copied, not bind-mounted: on a Windows
 * host apt's read of a bind-mounted package failed with EIO on 2026-09-24, and a
 * copy through the engine does not depend on the host's file sharing.
 */
function inClean(image: string, artifact: string, script: string): string {
	const name = `${prefix}-install-${process.pid}`;
	docker(['rm', '--force', name]);
	try {
		const created = docker([
			'create',
			'--name',
			name,
			...PROXIES.filter((variable) => process.env[variable] !== undefined).flatMap((variable) => ['--env', variable]),
			image,
			'bash',
			'-c',
			script
		]);
		expect(created.status, created.stderr).toBe(0);
		const copied = docker(['cp', dirname(artifact), `${name}:/pkg`]);
		expect(copied.status, copied.stderr).toBe(0);
		const run = docker(['start', '--attach', name]);
		const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
		process.stdout.write(`--- ${image}\n${output}\n`);
		expect(run.status).toBe(0);
		return output;
	} finally {
		docker(['rm', '--force', name]);
	}
}

/** The lines `name=value` the check scripts print, as a map. */
function facts(output: string): ReadonlyMap<string, string> {
	return new Map(
		output
			.split('\n')
			.filter((line) => line.startsWith('fact '))
			.map((line) => {
				const [name, ...value] = line.slice('fact '.length).split('=');
				return [name ?? '', value.join('=')] as const;
			})
	);
}

describe.runIf(enabled)('the Linux installers of a real fork tree, built and installed', () => {
	it('builds a .deb that apt installs into a clean container', () => {
		const run = packageOnce('linux-x64-deb');
		expect(run.status, run.output.slice(-4000)).toBe(0);
		const deb = onlyArtifact('.build/linux/deb/amd64/deb', '.deb');
		const name = readdirSync(dirname(deb))[0]?.split('_')[0] ?? '';
		const found = facts(
			inClean(
				debImage,
				deb,
				[
					'set -e',
					'export DEBIAN_FRONTEND=noninteractive',
					NO_WSL_PROMPT,
					'ls -A /etc/apt/sources.list.d > /tmp/sources.before',
					threeAttempts(`{ apt-get update -qq && apt-get install -y -qq /pkg/${name}_*.deb; }`),
					'ls -A /etc/apt/sources.list.d > /tmp/sources.after',
					'echo "fact sources.before=$(tr "\\n" " " < /tmp/sources.before)"',
					'echo "fact sources.after=$(tr "\\n" " " < /tmp/sources.after)"',
					`echo "fact command=$(command -v ${name})"`,
					`echo "fact owner=$(dpkg -S "$(readlink -f "$(command -v ${name})")" | cut -d: -f1)"`,
					`echo "fact maintainer=$(dpkg-query -W -f='\${Maintainer}' ${name})"`,
					`echo "fact homepage=$(dpkg-query -W -f='\${Homepage}' ${name})"`,
					`${name} --version --no-sandbox --user-data-dir /tmp/u > /tmp/version 2>&1 || true`,
					'echo "fact version=$(sed -n 1p /tmp/version)"',
					'echo "fact commit=$(sed -n 2p /tmp/version)"',
					`echo "fact crlf=$(grep -l $'\\r' /var/lib/dpkg/info/${name}.* /usr/share/applications/${name}*.desktop /usr/share/appdata/${name}.appdata.xml /usr/share/bash-completion/completions/${name} 2>/dev/null | wc -l)"`
				].join('\n')
			)
		);
		expect(found.get('command')).toMatch(new RegExp(`/${name}$`, 'u'));
		expect(found.get('owner')).toBe(name);
		expect(found.get('version')).toBe(treeVersion().version);
		expect(found.get('commit')).toBe(treeVersion().head);
		expect(found.get('maintainer')).toBe(templateField('resources/linux/debian/control.template', 'Maintainer'));
		expect(found.get('sources.after')).toBe(found.get('sources.before'));
		expect(found.get('crlf')).toBe('0');
	}, 3_600_000);

	it('builds an .rpm that dnf installs into a clean container', () => {
		const run = packageOnce('linux-x64-rpm');
		expect(run.status, run.output.slice(-4000)).toBe(0);
		const rpm = onlyArtifact('.build/linux/rpm/x86_64', '.rpm');
		const found = facts(
			inClean(
				rpmImage,
				rpm,
				[
					'set -e',
					NO_WSL_PROMPT,
					'ls -A /etc/yum.repos.d > /tmp/repos.before',
					'name=$(rpm -qp --qf "%{NAME}" /pkg/*.rpm)',
					threeAttempts('dnf install -y -q /pkg/*.rpm'),
					'ls -A /etc/yum.repos.d > /tmp/repos.after',
					'echo "fact repos.before=$(tr "\\n" " " < /tmp/repos.before)"',
					'echo "fact repos.after=$(tr "\\n" " " < /tmp/repos.after)"',
					'echo "fact name=$name"',
					'echo "fact command=$(command -v "$name")"',
					'echo "fact owner=$(rpm -qf --qf "%{NAME}" "$(readlink -f "$(command -v "$name")")")"',
					'"$name" --version --no-sandbox --user-data-dir /tmp/u > /tmp/version 2>&1 || true',
					'echo "fact version=$(sed -n 1p /tmp/version)"',
					'echo "fact commit=$(sed -n 2p /tmp/version)"',
					'echo "fact vendor=$(rpm -q --qf "%{VENDOR}" "$name")"',
					'echo "fact packager=$(rpm -q --qf "%{PACKAGER}" "$name")"',
					'echo "fact crlf=$({ rpm -q --scripts "$name"; cat /usr/share/applications/"$name"*.desktop /usr/share/appdata/"$name".appdata.xml; } | grep -c $\'\\r\' || true)"'
				].join('\n')
			)
		);
		const name = found.get('name') ?? '';
		expect(name).not.toBe('');
		expect(found.get('command')).toMatch(new RegExp(`/${name}$`, 'u'));
		expect(found.get('owner')).toBe(name);
		expect(found.get('version')).toBe(treeVersion().version);
		expect(found.get('commit')).toBe(treeVersion().head);
		expect(found.get('vendor')).toBe(templateField('resources/linux/rpm/code.spec.template', 'Vendor'));
		expect(found.get('packager')).toBe(templateField('resources/linux/rpm/code.spec.template', 'Packager'));
		expect(found.get('repos.after')).toBe(found.get('repos.before'));
		expect(found.get('crlf')).toBe('0');
	}, 3_600_000);
});
