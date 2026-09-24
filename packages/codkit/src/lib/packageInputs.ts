/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-INPUTS */
// What a package run downloads, whether a pre-provisioned copy of each input is
// there, and how the run points the build at the copies.
// Contract: PROP-007 sec. 27 (##CMD-PACKAGE-INPUTS); the answers it reads:
// PROP-016 ##TYPE-PACKAGE-TARGETS.
//
// A target declares its inputs - computed from the tree, because the versions in
// the addresses are the tree's - and this module does three things with them:
// it checks, before any write, which of them the inputs directory holds; it
// wires the provisioned ones into the environment of the native commands; and
// it writes the fetch answer, the `curl` that serves a provisioned address from
// its copy and, in an offline run, refuses every other address. The container
// route wires the same inputs its own way (packageContainer.ts), because inside
// the container the copies live under another path.
//
// The inputs directory is read and never written: a copy is linked or copied
// out of it, never into it.

import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { PackageInput, PackageTarget } from '@codkit/type-api';
import { ckError } from './messages.ts';
import type { CkError } from './messages.ts';

export type InputState = 'provisioned' | 'missing';

export type CheckedInput = {
	readonly input: PackageInput;
	readonly state: InputState;
	/** The absolute path of the copy inside the inputs directory, or null without an inputs directory. */
	readonly copy: string | null;
};

/**
 * The port an offline run points every proxy variable at: nothing listens on
 * the discard port of the loopback, so a client that honours the variables
 * fails at once instead of fetching.
 */
export const OFFLINE_PROXY = 'http://127.0.0.1:9';

/** The environment an offline run gives its native commands (##CMD-PACKAGE-INPUTS). */
export const OFFLINE_FENCE: Readonly<Record<string, string>> = {
	HTTP_PROXY: OFFLINE_PROXY,
	HTTPS_PROXY: OFFLINE_PROXY,
	http_proxy: OFFLINE_PROXY,
	https_proxy: OFFLINE_PROXY,
	NO_PROXY: '',
	no_proxy: '',
	NODE_USE_ENV_PROXY: '1'
};

/** The inputs the selected targets declare, each path once, in target order. */
export function inputsOf(targets: readonly PackageTarget[], treeDir: string): readonly PackageInput[] {
	const seen = new Set<string>();
	const inputs: PackageInput[] = [];
	for (const target of targets) {
		for (const input of target.inputs?.(treeDir) ?? []) {
			if (seen.has(input.path)) {
				continue;
			}
			seen.add(input.path);
			inputs.push(input);
		}
	}
	return inputs;
}

/** Each input with its state: provisioned when the inputs directory holds its path. */
export function checkInputs(inputs: readonly PackageInput[], inputsDir: string | null): readonly CheckedInput[] {
	return inputs.map((input) => {
		if (inputsDir === null) {
			return { input, state: 'missing', copy: null };
		}
		const copy = copyPath(inputsDir, input);
		return { input, state: existsSync(copy) ? 'provisioned' : 'missing', copy };
	});
}

/** The refusal of an offline run that misses inputs; it names every one of them. */
export function missingInputsRefusal(missing: readonly CheckedInput[], inputsDir: string | null): CkError {
	const where = inputsDir === null ? 'an inputs directory given with --inputs' : inputsDir;
	const list = missing.map((checked) => `${checked.input.name} (${checked.input.path}, fetched from ${checked.input.from})`).join('; ');
	return ckError(
		'NET-FORBIDDEN',
		`an offline run fetches nothing, and ${missing.length} input(s) of the build are not pre-provisioned: ${list}`,
		`put each of them at its path in ${where}, or run without --ci`
	);
}

/** One line per input for the report of the inputs step. */
export function inputLines(checked: readonly CheckedInput[]): readonly string[] {
	return checked.map((entry) =>
		entry.state === 'provisioned'
			? `input ${entry.input.name}: provisioned (${entry.input.path})`
			: `input ${entry.input.name}: not pre-provisioned, the build fetches it from ${entry.input.from}`
	);
}

/** An address the fetch answer serves, and the file that answers it. */
export type FetchAnswer = { readonly url: string; readonly file: string };

/**
 * The fetch answer: a POSIX `curl` that serves each provisioned address from its
 * copy - to the file `-o` names, or to its standard output - and hands any other
 * address to the real `curl` further along `PATH`, except in an offline run,
 * where it refuses with the address in its message.
 */
export function fetchAnswerScript(answers: readonly FetchAnswer[], offline: boolean): string {
	const cases = answers.map((answer) => `\t${shellQuote(answer.url)}) copy=${shellQuote(answer.file)} ;;`);
	return [
		'#!/bin/sh',
		'# The fetch answer of one codkit package run (spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-INPUTS).',
		`offline=${offline ? '1' : '0'}`,
		"url=''",
		"out=''",
		"previous=''",
		'for argument in "$@"; do',
		'\tcase "$previous" in',
		'\t-o | --output) out="$argument" ;;',
		'\tesac',
		'\tcase "$argument" in',
		'\t--output=*) out="${argument#--output=}" ;;',
		'\thttp://* | https://*) url="$argument" ;;',
		'\tesac',
		'\tprevious="$argument"',
		'done',
		"copy=''",
		'case "$url" in',
		...cases,
		'esac',
		'if [ -n "$copy" ]; then',
		'\tif [ -n "$out" ]; then',
		'\t\trm -f "$out" && cp "$copy" "$out"',
		'\telse',
		'\t\tcat "$copy"',
		'\tfi',
		'\texit $?',
		'fi',
		'if [ "$offline" = 1 ]; then',
		'\techo "codkit: $url is not a pre-provisioned input, and an offline run fetches nothing" >&2',
		'\texit 7',
		'fi',
		'self=$(cd "$(dirname "$0")" && pwd -P)',
		'rest=$PATH',
		'while [ -n "$rest" ]; do',
		'\tdir=${rest%%:*}',
		'\tcase "$rest" in *:*) rest=${rest#*:} ;; *) rest= ;; esac',
		'\tif [ -n "$dir" ] && [ -x "$dir/curl" ] && [ "$(cd "$dir" 2>/dev/null && pwd -P)" != "$self" ]; then',
		'\t\texec "$dir/curl" "$@"',
		'\tfi',
		'done',
		'echo "codkit: no curl was found on PATH beside the fetch answer" >&2',
		'exit 127',
		''
	].join('\n');
}

/** The addresses the provisioned `fetch` inputs answer, each with the file that answers it where the commands run. */
export function fetchAnswers(checked: readonly CheckedInput[], fileOf: (entry: CheckedInput) => string): readonly FetchAnswer[] {
	const answers: FetchAnswer[] = [];
	for (const entry of checked) {
		if (entry.state === 'provisioned' && entry.input.use.kind === 'fetch') {
			answers.push({ url: entry.input.use.url, file: fileOf(entry) });
		}
	}
	return answers;
}

/** Whether a run needs a fetch answer at all: a provisioned address to serve, or an offline run to fence. */
export function needsFetchAnswer(checked: readonly CheckedInput[], offline: boolean): boolean {
	return offline || checked.some((entry) => entry.state === 'provisioned' && entry.input.use.kind === 'fetch');
}

/**
 * Wire the provisioned inputs for the native commands of one run, inside the
 * run's own directory, and answer the environment the commands get. A `tree`
 * input replaces its cache in the fork tree - the one write this module makes
 * outside the run's directory - and the offline fence is added last.
 */
export function nativeInputEnvironment(
	checked: readonly CheckedInput[],
	runDir: string,
	treeDir: string,
	offline: boolean,
	path: string
): Readonly<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const entry of checked) {
		if (entry.state !== 'provisioned' || entry.copy === null) {
			continue;
		}
		const use = entry.input.use;
		switch (use.kind) {
			case 'environment':
				env[use.variable] = entry.copy;
				break;
			case 'directory':
				env[use.variable] = linkedDirectory(join(runDir, 'dirs', use.variable), entry.copy);
				break;
			case 'tree':
				replaceTreeCache(join(treeDir, ...use.target.split('/')), entry.copy);
				break;
			case 'fetch':
				break;
		}
	}
	if (needsFetchAnswer(checked, offline)) {
		const shim = join(runDir, 'shim');
		mkdirSync(shim, { recursive: true });
		const script = join(shim, 'curl');
		writeFileSync(
			script,
			fetchAnswerScript(
				fetchAnswers(checked, (entry) => entry.copy ?? ''),
				offline
			),
			'utf8'
		);
		chmodSync(script, 0o755);
		env['PATH'] = `${shim}${delimiter}${path}`;
	}
	return offline ? { ...env, ...OFFLINE_FENCE } : env;
}

/** The copy of an input inside the inputs directory. */
export function copyPath(inputsDir: string, input: PackageInput): string {
	return join(inputsDir, ...input.path.split('/'));
}

/** A directory of the run holding every entry of the copy, linked; the directory is answered. */
function linkedDirectory(directory: string, copy: string): string {
	mkdirSync(directory, { recursive: true });
	for (const entry of readdirSync(copy)) {
		const source = join(copy, entry);
		const link = join(directory, entry);
		const isDirectory = statSync(source).isDirectory();
		if (process.platform === 'win32') {
			if (isDirectory) {
				symlinkSync(source, link, 'junction');
			} else {
				copyFileSync(source, link);
			}
			continue;
		}
		symlinkSync(source, link, isDirectory ? 'dir' : 'file');
	}
	return directory;
}

function replaceTreeCache(target: string, copy: string): void {
	rmSync(target, { recursive: true, force: true });
	cpSync(copy, target, { recursive: true });
}

/** One word for a POSIX shell: single-quoted, with a single quote spelled '\''. */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/gu, `'\\''`)}'`;
}
