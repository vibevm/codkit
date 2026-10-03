/** @scope spec://codkit/modules/codkit/PROP-007#INPUTS-BUILD */
// Building one input (PROP-007 ##INPUTS-BUILD): the declared commands, run in
// order in a disposable copy of the source with no shell; the output directory
// `from`, read as regular files and directories only; and its blobs, stored in
// the object database of the fork tree, where a load mirrors them from and a
// generated commit takes them. The copy lives in a temporary directory that is
// removed whatever the outcome.
//
// When the content stamp of the source equals the one the tree recorded and the
// tree still holds the blobs, nothing is copied or built: the recorded output is
// the output (##INPUTS-STAMP).

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { InputConfig } from './configFile.ts';
import { runGit } from './gitx.ts';
import type { Output } from './jsonOut.ts';
import { ckError } from './messages.ts';
import { copySource, firstLine, inspectSource } from './inputsSource.ts';
import type { InputMode } from './inputsSource.ts';
import { blobsPresent } from './inputsStore.ts';
import type { StoredInput } from './inputsStore.ts';

/** One file of an input's output: its path under `from`, and the blob it is stored as. */
export type InputFile = { readonly path: string; readonly blob: string };

export type ProducedInput = {
	readonly input: InputConfig;
	readonly mode: InputMode;
	/** The pinned commit; null for a working tree. */
	readonly commit: string | null;
	readonly stamp: string;
	/** In byte order of the path. */
	readonly files: readonly InputFile[];
	/** False when the recorded output of the same stamp was reused. */
	readonly built: boolean;
};

export type ProgramInvocation = {
	readonly command: string;
	readonly args: readonly string[];
	/** The command line is passed as written: a batch launcher under cmd.exe. */
	readonly verbatim: boolean;
};

export type ProgramLookup = {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly cwd: string;
	readonly isFile: (path: string) => boolean;
};

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const BATCH = /\.(?:cmd|bat)$/i;
/** What cmd.exe gives a meaning of its own inside a command line. */
const COMMAND_SHELL_SPECIAL = /[%^&|<>"\r\n]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const OUTPUT_BUFFER = 256 * 1024 * 1024;
const FAILURE_TAIL_LINES = 12;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\n';
const LFS_POINTER_LIMIT = 1024;

/**
 * Build one input, or reuse what the tree recorded for the same content. The
 * blobs of the output are in the tree's object database when this returns.
 */
export function produceInput(options: {
	readonly input: InputConfig;
	readonly mode: InputMode;
	readonly treeDir: string;
	readonly recorded: StoredInput | null;
	readonly out: Output;
	readonly verbose: boolean;
}): ProducedInput {
	const { input, mode, recorded } = options;
	const source = inspectSource(input, mode);
	if (
		recorded !== null &&
		recorded.mode === mode &&
		recorded.stamp === source.stamp &&
		blobsPresent(options.treeDir, Object.values(recorded.files))
	) {
		const files = Object.entries(recorded.files).map(([path, blob]) => ({ path, blob }));
		return { input, mode, commit: source.commit, stamp: source.stamp, files, built: false };
	}
	const scratch = mkdtempSync(join(tmpdir(), `codkit-input-${input.name}-`));
	try {
		const checkout = join(scratch, 'copy');
		copySource(input, source, scratch, checkout, options.out);
		runBuild(input, checkout, options.out, options.verbose);
		const output = collectOutput(input, checkout);
		const blobs = storeBlobs(input, options.treeDir, output);
		const files = output.map((file, index) => ({ path: file.path, blob: blobs[index] ?? '' }));
		return { input, mode, commit: source.commit, stamp: source.stamp, files, built: true };
	} finally {
		try {
			rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (error) {
			options.out.warn(
				`input ${input.name}: the disposable copy ${scratch} could not be removed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}
}

/**
 * ##INPUTS-BUILD-PORTABLE: how the first word of a command names its program.
 * Elsewhere than Windows the words go to the program as they are and the
 * operating system searches PATH. On Windows a name is searched along PATH with
 * each extension of PATHEXT, the way the command prompt finds it, and a word
 * with a directory in it is taken from the copy; an executable runs directly,
 * and a batch launcher (`.cmd`, `.bat`) runs through cmd.exe - which gives
 * `%`, `^`, `&`, `|`, `<`, `>` and `"` a meaning of their own, so an argument
 * that carries one of them is refused rather than handed to it.
 */
export function resolveProgram(argv: readonly string[], lookup: ProgramLookup): ProgramInvocation {
	const [program = '', ...args] = argv;
	if (lookup.platform !== 'win32') return { command: program, args, verbatim: false };
	const found = findOnWindows(program, lookup);
	if (found === null || !BATCH.test(found)) return { command: found ?? program, args, verbatim: false };
	const special = args.find((arg) => COMMAND_SHELL_SPECIAL.test(arg));
	if (special !== undefined) {
		throw ckError(
			'CONFIG',
			`${program} is a batch launcher that runs through cmd.exe, and the argument ${JSON.stringify(special)} carries a character cmd.exe interprets`,
			'call the program the launcher starts directly, or pass the value another way'
		);
	}
	const quoted = [found, ...args].map((word) => (word === '' || /\s/.test(word) ? `"${word}"` : word)).join(' ');
	return {
		command: environmentValue(lookup.env, 'ComSpec', 'win32') ?? 'cmd.exe',
		args: ['/d', '/s', '/c', `"${quoted}"`],
		verbatim: true
	};
}

function findOnWindows(program: string, lookup: ProgramLookup): string | null {
	const extensions = (environmentValue(lookup.env, 'PATHEXT', 'win32') ?? DEFAULT_PATHEXT).split(';').filter((ext) => ext !== '');
	const withExtensions = (base: string): readonly string[] => {
		const known = extensions.some((ext) => ext.toLowerCase() === win32.extname(base).toLowerCase());
		return [...(known ? [base] : []), ...extensions.map((ext) => `${base}${ext.toLowerCase()}`)];
	};
	if (/[\\/]/.test(program) || win32.isAbsolute(program)) {
		return withExtensions(win32.resolve(lookup.cwd, program)).find((path) => lookup.isFile(path)) ?? null;
	}
	const directories = (environmentValue(lookup.env, 'PATH', 'win32') ?? '').split(';').filter((dir) => dir !== '');
	for (const directory of directories) {
		const hit = withExtensions(win32.join(directory, program)).find((path) => lookup.isFile(path));
		if (hit !== undefined) return hit;
	}
	return null;
}

/**
 * The environment of a build: codkit's own, and the variables the input
 * declares over it. On Windows names are one variable whatever their case, so a
 * declared name replaces every spelling of itself.
 */
export function buildEnvironment(
	base: Readonly<Record<string, string | undefined>>,
	declared: Readonly<Record<string, string>>,
	platform: NodeJS.Platform
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value;
	for (const [name, value] of Object.entries(declared)) {
		if (platform === 'win32') {
			for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
		}
		env[name] = value;
	}
	return env;
}

function environmentValue(env: Readonly<Record<string, string | undefined>>, name: string, platform: NodeJS.Platform): string | undefined {
	if (platform !== 'win32') return env[name];
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
	return key === undefined ? undefined : env[key];
}

/** Every command in order; the first that fails stops the input with its output. */
function runBuild(input: InputConfig, checkout: string, out: Output, verbose: boolean): void {
	const env = buildEnvironment(process.env, input.env, process.platform);
	const lookup: ProgramLookup = { platform: process.platform, env, cwd: checkout, isFile };
	input.build.forEach((argv, index) => {
		const label = `input ${input.name} build ${index + 1}/${input.build.length}`;
		const rendered = argv.map((word) => (/\s/.test(word) || word === '' ? JSON.stringify(word) : word)).join(' ');
		out.info(`--- ${label}: ${rendered}`);
		const invocation = resolveProgram(argv, lookup);
		const result = spawnSync(invocation.command, [...invocation.args], {
			cwd: checkout,
			env,
			encoding: 'utf8',
			shell: false,
			windowsHide: true,
			windowsVerbatimArguments: invocation.verbatim,
			maxBuffer: OUTPUT_BUFFER
		});
		const lines = [...outputLines(result.stdout ?? ''), ...outputLines(result.stderr ?? '')];
		if (result.error === undefined && result.status === 0) {
			if (verbose) for (const line of lines) out.diag(`[${label}] ${line}`);
			return;
		}
		for (const line of lines) out.info(`[${label}] ${line}`);
		const why =
			result.error !== undefined
				? `could not run (${result.error.message})`
				: result.status === null
					? 'was killed'
					: `exited ${result.status}`;
		const tail = lines.slice(-FAILURE_TAIL_LINES);
		throw ckError(
			'CONFIG',
			`input ${input.name}: build command ${index + 1} ${why}${tail.length === 0 ? '' : `; last output: ${tail.join(' | ')}`}`,
			`run it in a clone of ${input.repository} to see it fail on its own: ${rendered}`
		);
	});
}

function outputLines(text: string): readonly string[] {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
	return lines.length === 1 && lines[0] === '' ? [] : lines;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

type OutputEntry = { readonly path: string; readonly absolute: string };

/**
 * ##INPUTS-OUTPUT: `from` of the built copy, a directory reached through
 * directories alone, holding at least one file; inside it regular files and
 * directories only, with names git can carry, and no git-lfs pointer in place of
 * content.
 */
export function collectOutput(input: InputConfig, checkout: string): readonly OutputEntry[] {
	let current = checkout;
	for (const segment of input.from.split('/')) {
		current = join(current, segment);
		const stat = statOrNull(current);
		if (stat === null) throw outputError(input, `the build left no ${input.from}`, 'check from against what the build writes');
		if (stat.isSymbolicLink()) throw outputError(input, `${input.from} is reached through a link`, 'make the build write a real directory');
	}
	if (statOrNull(current)?.isDirectory() !== true) {
		throw outputError(input, `${input.from} is not a directory`, 'name the directory the build writes its output to');
	}
	const entries: OutputEntry[] = [];
	walkOutput(input, current, '', entries);
	if (entries.length === 0) throw outputError(input, `${input.from} holds no file`, 'check that the build writes its output there');
	return entries.sort((left, right) => Buffer.from(left.path, 'utf8').compare(Buffer.from(right.path, 'utf8')));
}

function walkOutput(input: InputConfig, absoluteDir: string, relativeDir: string, into: OutputEntry[]): void {
	const listed: Dirent[] = readdirSync(absoluteDir, { withFileTypes: true });
	for (const entry of listed) {
		const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
		const absolute = join(absoluteDir, entry.name);
		if (CONTROL.test(entry.name) || entry.name.includes('\\') || entry.name.toLowerCase() === '.git') {
			throw outputError(input, `${input.from}/${relative} has a name git cannot carry in a tree`, 'rename it in the build');
		}
		if (entry.isSymbolicLink()) {
			throw outputError(input, `${input.from}/${relative} is a link`, 'make the build copy the file instead of linking it');
		}
		if (entry.isDirectory()) {
			walkOutput(input, absolute, relative, into);
			continue;
		}
		if (!entry.isFile()) {
			throw outputError(
				input,
				`${input.from}/${relative} is neither a file nor a directory`,
				'leave only files and directories in the output'
			);
		}
		if (isLfsPointer(absolute)) {
			throw outputError(
				input,
				`${input.from}/${relative} is a git-lfs pointer, not the file it stands for`,
				'inputs take the bytes git stores and never fetch git-lfs content; keep the file in git itself'
			);
		}
		into.push({ path: relative, absolute });
	}
}

function isLfsPointer(absolute: string): boolean {
	if (statSync(absolute).size > LFS_POINTER_LIMIT) return false;
	return readFileSync(absolute).toString('utf8').startsWith(LFS_POINTER);
}

/** The entry itself, never what a link points at; null when there is none. */
function statOrNull(path: string): Stats | null {
	return lstatSync(path, { throwIfNoEntry: false }) ?? null;
}

function outputError(input: InputConfig, problem: string, hint: string): Error {
	return ckError('CONFIG', `input ${input.name}: ${problem}`, hint);
}

/** Every output file stored in the tree's object database as it is, in one git process. */
function storeBlobs(input: InputConfig, treeDir: string, output: readonly OutputEntry[]): readonly string[] {
	const stored = runGit({
		args: ['hash-object', '-w', '--no-filters', '--stdin-paths'],
		cwd: treeDir,
		input: `${output.map((file) => file.absolute).join('\n')}\n`
	});
	const blobs = stored.stdout.split('\n').filter((line) => line !== '');
	if (stored.status !== 0 || blobs.length !== output.length) {
		throw ckError('CONFIG', `input ${input.name}: cannot store the output in the tree: ${firstLine(stored.stderr)}`);
	}
	return blobs;
}
