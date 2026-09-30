// What the e2e cases of the release forms, the git-lfs switch and the export
// share (PROP-007 ##PUBLISH-FORMS, ##PUBLISH-NO-LFS, ##PUBLISH-EXPORT): publish
// run through its command definition or its library, the remotes it writes
// into, and reads of the repositories it leaves.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { publishCommand } from '../../src/commands/publish.ts';
import type { CommandContext } from '../../src/lib/command.ts';
import { EXIT_ENVIRONMENT } from '../../src/lib/command.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import type { Envelope } from '../../src/lib/jsonOut.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { runPublish } from '../../src/lib/publish.ts';
import type { PublishOptions, PublishResult } from '../../src/lib/publish.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';
import type { CliFixture } from './cliFixture.ts';
import { makeTempRoot } from './tmp.ts';

/** A Cyrillic identity: the name has to reach the commit as it was typed. */
export const RELEASE_AUTHOR = 'Иван Петров <ivan.petrov@example.org>';
const RELEASE_MESSAGE = 'Выпуск 1.0.0\r\n\r\nОдин коммит, собранный инструментом.\r\n\r\n';
/** The message as the squashed commit carries it: LF, blank lines cut at both ends. */
export const RELEASE_MESSAGE_LF = 'Выпуск 1.0.0\n\nОдин коммит, собранный инструментом.\n';

export type PublishFlags = {
	readonly bot?: boolean;
	readonly ci?: boolean;
	readonly profile?: string;
	readonly release?: string;
	readonly args?: readonly string[];
	readonly branch?: string;
	readonly squash?: boolean;
	readonly orphan?: boolean;
	readonly author?: string;
	readonly messageFile?: string;
	readonly scrub?: boolean;
	readonly noLfs?: boolean;
	readonly exportBare?: string;
	readonly exportRepo?: string;
};

export type Invocation = { readonly exitCode: number; readonly envelope: Envelope };

/** `codkit publish` through its command definition, the way main.ts runs it. */
export async function invokePublish(fixture: CliFixture, flags: PublishFlags = {}): Promise<Invocation> {
	const out = output();
	const context: CommandContext = {
		toolRoot: fixture.patchesDir,
		locations: {
			patchesDir: { path: fixture.patchesDir, source: 'flag', exists: true, warning: null },
			forkDir: { path: fixture.treeDir, source: 'flag', exists: true, warning: null }
		},
		patchesDir: fixture.patchesDir,
		args: flags.args ?? ['HEAD'],
		flags: { forkDir: fixture.treeDir, patchesDir: fixture.patchesDir, json: true, ci: flags.ci === true, verbose: false },
		commandFlags: commandFlagsOf(flags),
		env: {},
		config: requiredConfig(fixture),
		type: stubProjectType,
		out
	};
	let exitCode: number;
	try {
		exitCode = await publishCommand.run(context);
	} catch (error) {
		if (!isCkError(error)) throw error;
		out.addError(error.toPayload());
		exitCode = EXIT_ENVIRONMENT;
	}
	return { exitCode, envelope: out.buildEnvelope(exitCode) };
}

/** The publish library itself, for a case that needs a checkpoint. */
export async function invokePublishLibrary(
	fixture: CliFixture,
	extra: Partial<Omit<PublishOptions, 'out'>>
): Promise<Invocation & { readonly result: PublishResult | null }> {
	const out = output();
	let result: PublishResult | null = null;
	let exitCode: number;
	try {
		result = await runPublish({
			patchesDir: fixture.patchesDir,
			resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null },
			config: requiredConfig(fixture),
			type: stubProjectType,
			patchSetRef: 'HEAD',
			profile: 'verify',
			release: null,
			confirmed: true,
			ci: false,
			verbose: false,
			...extra,
			out
		});
		exitCode = result.exitCode;
	} catch (error) {
		if (!isCkError(error)) throw error;
		out.addError(error.toPayload());
		exitCode = EXIT_ENVIRONMENT;
	}
	return { result, exitCode, envelope: out.buildEnvelope(exitCode) };
}

function commandFlagsOf(flags: PublishFlags): Map<string, string | true> {
	const map = new Map<string, string | true>();
	const values: readonly (readonly [string, string | undefined])[] = [
		['--profile', flags.profile],
		['--release', flags.release],
		['--branch', flags.branch],
		['--author', flags.author],
		['--message-file', flags.messageFile],
		['--export-bare', flags.exportBare],
		['--export-repo', flags.exportRepo]
	];
	for (const [name, value] of values) if (value !== undefined) map.set(name, value);
	const booleans: readonly (readonly [string, boolean | undefined])[] = [
		['--yes-i-am-publish-bot', flags.bot],
		['--squash', flags.squash],
		['--orphan', flags.orphan],
		['--scrub', flags.scrub],
		['--no-lfs', flags.noLfs]
	];
	for (const [name, given] of booleans) if (given === true) map.set(name, true);
	return map;
}

function output(): Output {
	return new Output({ command: 'publish', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
}

function requiredConfig(fixture: CliFixture): CodkitConfig {
	const config = loadConfig(fixture.patchesDir);
	if (config === null) throw new Error('fixture config disappeared');
	return config;
}

/** The runtime state of the patch set and its local configuration stay out of its status. */
export function excludeRuntime(fixture: CliFixture): void {
	writeFileSync(join(fixture.patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
}

/**
 * Every fixture of the default kind has the same patchset commit, and a publish
 * names its scratch directory after it; cases of publish.test.ts count those
 * directories while these files run beside them. A case here gives its patch
 * set a commit of its own - a file at its root, which no layer delivers.
 */
export function ownPatchSetCommit(fixture: CliFixture, label: string): void {
	writeFileSync(fixture.patchesPath('PUBLISH-CASE.txt'), `${label}\n`, 'utf8');
	fixtureCommit(fixture.patchesDir, `fixture: the patch set of the case ${label}`, '2026-02-20T00:00:00Z');
}

/** `codkit.local.json` naming the remote; null writes one that names none. */
export function configureRemote(fixture: CliFixture, remote: string | null): void {
	const local = remote === null ? {} : { publishRemoteUrl: remote };
	writeFileSync(fixture.patchesPath('codkit.local.json'), `${JSON.stringify(local, null, 2)}\n`, 'utf8');
}

/** A bare clone of the fixture's upstream: the pin's history is there already. */
export function upstreamRemote(fixture: CliFixture, label: string): string {
	const remote = join(makeTempRoot(`${label}-remote`), 'publish.git');
	const result = runGit({ args: ['clone', '--bare', '--quiet', fixture.upstream.dir, remote], cwd: fixture.patchesDir, netAllowed: true });
	expect(result.status, result.stderr).toBe(0);
	return remote;
}

/** An empty bare repository: whatever a publish leaves in it, the publish brought. */
export function emptyRemote(label: string): string {
	const remote = join(makeTempRoot(`${label}-remote`), 'publish.git');
	const result = runGit({ args: ['init', '--bare', '--quiet', remote], cwd: join(remote, '..') });
	expect(result.status, result.stderr).toBe(0);
	return remote;
}

/** The message file of a squashed release: CRLF and trailing blank lines on purpose. */
export function messageFile(label: string): string {
	const path = join(makeTempRoot(`${label}-message`), 'message-ru.txt');
	writeFileSync(path, RELEASE_MESSAGE, 'utf8');
	return path;
}

export function refSha(repository: string, ref: string): string | null {
	const result = runGit({ args: ['rev-parse', '--verify', '--quiet', ref], cwd: repository });
	return result.status === 0 ? result.stdout.trim() : null;
}

/** codkit's isolated git in a repository; a failure fails the case. */
export function gitOut(repository: string, args: readonly string[], env?: GitEnv): string {
	const result = runGit(env === undefined ? { args, cwd: repository } : { args, cwd: repository, env });
	expect(result.status, `git ${args.join(' ')}: ${result.stderr}`).toBe(0);
	return result.stdout.trimEnd();
}

export type PlainGit = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

/**
 * The git of the machine, with its global and system configuration - what a
 * person runs - and none of the variables of a git that called this process.
 */
export function plainGit(cwd: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): PlainGit {
	const inherited: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) inherited[key] = value;
	const result = spawnSync('git', [...args], { cwd, env: { ...inherited, ...env }, encoding: 'utf8', windowsHide: true });
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Every object the repository stores, sorted. */
export function storedObjects(repository: string): readonly string[] {
	return gitOut(repository, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])
		.split('\n')
		.filter((line) => line !== '')
		.sort();
}

/** Every object a commit reaches, sorted. */
export function reachableObjects(repository: string, commit: string): readonly string[] {
	return gitOut(repository, ['rev-list', '--objects', commit])
		.split('\n')
		.map((line) => line.split(' ')[0] ?? '')
		.filter((sha) => sha !== '')
		.sort();
}

/** The path of every file of a tree, sorted by git. */
export function treeFiles(repository: string, treeish: string): readonly string[] {
	return gitOut(repository, ['ls-tree', '-r', '--name-only', '-z', treeish])
		.split('\0')
		.filter((path) => path !== '');
}

/**
 * What makes a commit need git-lfs, read from its own tree the way the owner's
 * release was accepted: the paths its attributes give to lfs, the blobs that
 * are pointers, and the attribute files that name filter=lfs at all.
 */
export function lfsNeeds(
	repository: string,
	commit: string
): { readonly filtered: readonly string[]; readonly pointers: readonly string[]; readonly rules: readonly string[] } {
	const entries = gitOut(repository, ['ls-tree', '-r', '-l', '-z', commit])
		.split('\0')
		.filter((record) => record !== '')
		.map((record) => {
			const [meta = '', path = ''] = record.split('\t');
			const [, type = '', blob = '', size = ''] = meta.split(/ +/);
			return { type, blob, size: Number(size), path };
		})
		.filter((entry) => entry.type === 'blob');
	const attr = runGit({
		args: ['-c', 'core.attributesFile=/dev/null', 'check-attr', `--source=${commit}`, '-z', '--stdin', 'filter'],
		cwd: repository,
		env: { GIT_ATTR_NOSYSTEM: '1' },
		input: entries.map((entry) => `${entry.path}\0`).join('')
	});
	expect(attr.status, attr.stderr).toBe(0);
	const fields = attr.stdout.split('\0');
	const filtered: string[] = [];
	for (let index = 0; index + 2 < fields.length; index += 3) if (fields[index + 2] === 'lfs') filtered.push(fields[index] ?? '');
	const header = 'version https://git-lfs.github.com/spec/v1\n';
	const pointers = entries
		.filter((entry) => entry.size <= 1024 && gitOut(repository, ['cat-file', 'blob', entry.blob]).startsWith(header))
		.map((entry) => entry.path);
	const rules = entries
		.filter(
			(entry) =>
				entry.path.endsWith('.gitattributes') && /(^|\s)filter=lfs(\s|$)/m.test(gitOut(repository, ['cat-file', 'blob', entry.blob]))
		)
		.map((entry) => entry.path);
	return { filtered, pointers, rules };
}

export function objectData(envelope: Envelope): { [key: string]: unknown } {
	return envelope.data !== null && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
		? (envelope.data as { [key: string]: unknown })
		: {};
}

export function infoLines(envelope: Envelope): readonly string[] {
	return envelope.messages.filter((message) => message.level === 'info').map((message) => message.text);
}

export function releaseTag(fixture: CliFixture, release: string): string {
	return `refs/tags/patchset-v${release}+${fixture.upstream.t1.tag}`;
}
