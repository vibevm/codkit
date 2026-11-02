// The Windows x64 targets of this family: the archive of the raw bundle and
// the two Inno Setup installers upstream's own gulp tasks build (modules/vscode
// PROP-004 ##VSCODE-WINDOWS-TARGETS). Nothing here runs gulp: the recipe is
// read as data, the way a person reads it, and the one piece the type adds -
// the bsdtar of Windows first on the PATH of the archive command - is asked
// with a made-up environment.

import { delimiter, join } from 'node:path';
import type { PackageTarget } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import { build } from '../src/build.ts';
import { configSchema } from '../src/configSchema.ts';

const WINDOWS_TARGETS = ['windows-x64-archive', 'windows-x64-setup-system', 'windows-x64-setup-user'];

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

describe('the Windows x64 targets', () => {
	it('are three, Windows-hosted, without a container route', () => {
		for (const id of WINDOWS_TARGETS) {
			const target = targetOf(id);
			expect(target.platform).toBe('windows');
			expect(target.arch).toBe('x64');
			expect(target.supportedHosts).toEqual(['win32']);
			expect(target.container).toBeUndefined();
			expect(target.hostRefusal).toBeUndefined();
		}
	});

	it('each begins with the raw bundle task, resolving signtool the way the raw target does', () => {
		for (const id of WINDOWS_TARGETS) {
			expect(commandsOf(id)[0]).toBe('bundle windows-x64: npm run gulp -- vscode-win32-x64');
			expect(targetOf(id).build[0]?.environment).toBeDefined();
		}
	});

	it('archives the bundle with the bsdtar of Windows into the tree, and proves the bytes are a zip', () => {
		const commands = commandsOf('windows-x64-archive');
		expect(commands).toHaveLength(4);
		const clean = targetOf('windows-x64-archive').build[1];
		expect(clean?.label).toBe('clean archive');
		expect(clean?.command).toBe('node');
		expect(clean?.args[0]).toBe('-e');
		expect(clean?.args[1]).toContain(".build/win32-x64/archive'");
		expect(clean?.args[1]).toContain('rmSync');
		expect(clean?.args[1]).toContain('mkdirSync');
		expect(commands[2]).toBe('archive windows-x64: tar -a -c -f .build/win32-x64/archive/VSCode-win32-x64.zip -C .. VSCode-win32-x64');
		expect(targetOf('windows-x64-archive').outputs).toEqual(['.build/win32-x64/archive/*.zip']);
		// The GNU tar of a Git installation writes a tar under the name with exit 0,
		// so the archive command's exit code proves nothing: the signature does.
		const check = targetOf('windows-x64-archive').build[3];
		expect(check?.label).toBe('check archive');
		expect(check?.command).toBe('node');
		expect(check?.args[0]).toBe('-e');
		expect(check?.args[1]).toContain(".build/win32-x64/archive/VSCode-win32-x64.zip'");
		expect(check?.args[1]).toContain('head[0]!==0x50||head[1]!==0x4b');
		expect(check?.args[1]).toContain('process.exit(1)');
		expect(check?.environment).toBeUndefined();
	});

	it('puts System32 first on the PATH of the archive command, and refuses without SystemRoot', () => {
		const environment = targetOf('windows-x64-archive').build[2]?.environment;
		if (environment === undefined) throw new Error('the archive command resolves no environment');
		const resolved = environment({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Git\\usr\\bin' });
		expect(resolved['PATH']).toBe(`${join('C:\\Windows', 'System32')}${delimiter}C:\\Git\\usr\\bin`);
		expect(environment({ SystemRoot: 'C:\\Windows', Path: 'D:\\tools' })['PATH']).toBe(
			`${join('C:\\Windows', 'System32')}${delimiter}D:\\tools`
		);
		expect(() => environment({ PATH: 'C:\\Git\\usr\\bin' })).toThrow(/SystemRoot/u);
		// A POSIX shell on Windows hands the variables over in upper case.
		expect(environment({ SYSTEMROOT: 'C:\\Windows', PATH: 'C:\\Git\\usr\\bin' })['PATH']).toBe(
			`${join('C:\\Windows', 'System32')}${delimiter}C:\\Git\\usr\\bin`
		);
		expect(environment({ windir: 'C:\\Windows', Path: 'D:\\tools' })['PATH']).toBe(
			`${join('C:\\Windows', 'System32')}${delimiter}D:\\tools`
		);
	});

	it('builds the system and the user setup with the upstream tasks, after the inno updater', () => {
		for (const target of ['system', 'user']) {
			const id = `windows-x64-setup-${target}`;
			expect(commandsOf(id)).toEqual([
				'bundle windows-x64: npm run gulp -- vscode-win32-x64',
				'inno updater: npm run gulp -- vscode-win32-x64-inno-updater',
				`${target} setup: npm run gulp -- vscode-win32-x64-${target}-setup`
			]);
			expect(targetOf(id).build.every((command) => command.environment !== undefined)).toBe(true);
			expect(targetOf(id).outputs).toEqual([`.build/win32-x64/${target}-setup/*.exe`]);
		}
	});

	it('may be chosen in typeConfig.packageTargets', () => {
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', packageTargets: WINDOWS_TARGETS }).success).toBe(true);
	});
});
