import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { processInvocation } from '../../src/lib/processInvocation.ts';

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
