import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { processInvocation } from '../../src/lib/processInvocation.ts';

const directory = mkdtempSync(join(tmpdir(), 'ck-invocation-'));
afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('process invocation', () => {
	it('keeps native commands direct on every platform', () => {
		expect(processInvocation('node.exe', ['--version'], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
			command: 'node.exe',
			args: ['--version']
		});
		expect(processInvocation('npm', ['run', 'hygiene'], 'linux')).toEqual({
			command: 'npm',
			args: ['run', 'hygiene']
		});
	});

	it('routes Windows batch launchers through ComSpec without shell mode', () => {
		expect(processInvocation('npm.cmd', ['run', 'hygiene'], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
			command: 'C:\\Windows\\System32\\cmd.exe',
			args: ['/d', '/s', '/c', 'npm.cmd', 'run', 'hygiene']
		});
	});

	it('finds a bare name along PATH with the PATHEXT suffixes on Windows, and leaves an unknown one alone', () => {
		const comspec = 'C:\\Windows\\System32\\cmd.exe';
		const env = { PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
		writeFileSync(join(directory, 'shim.cmd'), '@echo off\r\n', 'utf8');
		writeFileSync(join(directory, 'native.exe'), '', 'utf8');
		expect(processInvocation('shim', ['run', 'build'], 'win32', comspec, env, directory)).toEqual({
			command: comspec,
			args: ['/d', '/s', '/c', join(directory, 'shim.cmd'), 'run', 'build']
		});
		expect(processInvocation('native', ['--version'], 'win32', comspec, env, directory)).toEqual({
			command: join(directory, 'native.exe'),
			args: ['--version']
		});
		expect(processInvocation('absent', [], 'win32', comspec, env, directory)).toEqual({ command: 'absent', args: [] });
		// A name with a known suffix is taken as it is; the lookup is for bare names.
		expect(processInvocation('other.exe', [], 'win32', comspec, env, directory)).toEqual({ command: 'other.exe', args: [] });
	});

	it.runIf(process.platform === 'win32')('executes the installed npm through its bare name', () => {
		const invocation = processInvocation('npm', ['--version']);
		expect(invocation.command.toLowerCase()).toContain('cmd.exe');
		const result = spawnSync(invocation.command, [...invocation.args], { encoding: 'utf8', shell: false, windowsHide: true });
		expect({ status: result.status, error: result.error?.message }).toEqual({ status: 0, error: undefined });
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
	});

	it.runIf(process.platform === 'win32')('executes the installed npm.cmd launcher', () => {
		const invocation = processInvocation('npm.cmd', ['--version']);
		const result = spawnSync(invocation.command, [...invocation.args], {
			encoding: 'utf8',
			shell: false,
			windowsHide: true
		});
		expect({ status: result.status, error: result.error?.message }).toEqual({ status: 0, error: undefined });
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
	});
});
