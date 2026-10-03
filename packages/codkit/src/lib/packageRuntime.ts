/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Package process invocation and structured outcomes.
import { spawnSync } from 'node:child_process';

import type { BuildCommand } from '@codkit/type-api';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './command.ts';

import type { CkErrorPayload } from './messages.ts';

import { processInvocation } from './processInvocation.ts';

import type { PackageOptions, PackageCommand, PackageCommandResult, PackageStep } from './packageEngine.ts';
const FAILURE_TAIL_LINES = 20;
export type CommandsOutcome = {
	readonly state: PackageStep['state'];
	readonly detail: string;
	readonly error: CkErrorPayload | null;
	readonly exitCode: number;
};

export function runCommands(
	options: PackageOptions,
	build: readonly BuildCommand[],
	stamps: Readonly<Record<string, string>>,
	into: string[]
): CommandsOutcome {
	for (const declared of build) {
		let targetEnvironment: Readonly<Record<string, string>> = {};
		try {
			targetEnvironment = declared.environment?.({ ...process.env, ...stamps }) ?? {};
		} catch (error) {
			return {
				state: 'failed',
				detail: `${declared.label}: ${error instanceof Error ? error.message : String(error)}`,
				error: {
					code: 'PACKAGE-FAILED',
					message: `${declared.label}: ${error instanceof Error ? error.message : String(error)}`,
					hint: 'install the target toolchain or add its executable directory to PATH'
				},
				exitCode: EXIT_ENVIRONMENT
			};
		}
		const outcome = runOne(
			options,
			declared.label,
			declared.command === 'npm' ? npmCommand() : declared.command,
			declared.args,
			{ ...targetEnvironment, ...stamps },
			into
		);
		if (outcome.error !== null) {
			return outcome;
		}
	}
	return { state: 'ok', detail: `${build.length} command(s) passed`, error: null, exitCode: EXIT_OK };
}

/** One command in the tree: announced, run, its whole output printed, its failure turned into the refusal. */
export function runOne(
	options: PackageOptions,
	label: string,
	executable: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
	into: string[]
): CommandsOutcome {
	const run = options.runCommand ?? defaultPackageCommandRunner;
	const command: PackageCommand = {
		label,
		command: executable,
		args: [...args],
		cwd: options.resolution.path,
		env,
		timeoutMs: options.timeoutMs
	};
	const rendered = renderCommand(command);
	options.out.info(`--- ${command.label}: ${rendered}`);
	into.push(rendered);
	let result: PackageCommandResult;
	try {
		result = run(command);
	} catch (error) {
		result = { status: null, stdout: '', stderr: '', error: error instanceof Error ? error : new Error(String(error)) };
	}
	const lines = [...outputLines(result.stdout), ...outputLines(result.stderr)];
	for (const line of lines) {
		options.out.info(`[${command.label}] ${line}`);
	}
	if (result.status === EXIT_OK && result.error === undefined) {
		return { state: 'ok', detail: '1 command(s) passed', error: null, exitCode: EXIT_OK };
	}
	const couldNotRun = result.status === null || result.error !== undefined;
	const why = couldNotRun ? failureReason(result) : `exited ${result.status}`;
	const tail = lines.slice(-FAILURE_TAIL_LINES);
	return {
		state: 'failed',
		detail: `${command.label}: ${why}`,
		error: {
			code: 'PACKAGE-FAILED',
			message: `${command.label}: ${why}${tail.length === 0 ? '' : `; last output: ${tail.join(' | ')}`}`,
			hint: `run the command in the fork tree to see it fail on its own: ${rendered}`
		},
		exitCode: couldNotRun ? EXIT_ENVIRONMENT : EXIT_CHECK_FAILED
	};
}

export function defaultPackageCommandRunner(command: PackageCommand): PackageCommandResult {
	const invocation = processInvocation(command.command, command.args);
	const result = spawnSync(invocation.command, [...invocation.args], {
		cwd: command.cwd,
		env: { ...process.env, ...command.env },
		encoding: 'utf8',
		shell: false,
		windowsHide: true,
		maxBuffer: 256 * 1024 * 1024,
		...(command.timeoutMs === null ? {} : { timeout: command.timeoutMs })
	});
	const base = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
	return result.error === undefined ? base : { ...base, error: result.error };
}

function npmCommand(): string {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function outputLines(text: string): readonly string[] {
	const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
	const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
	return lines.length === 1 && lines[0] === '' ? [] : lines;
}

function failureReason(result: PackageCommandResult): string {
	if (result.error !== undefined) {
		return result.error.message;
	}
	return 'the command did not finish (killed by a signal or by --timeout)';
}

function renderCommand(command: PackageCommand): string {
	return [command.command, ...command.args].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ');
}
